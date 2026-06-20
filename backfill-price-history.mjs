#!/usr/bin/env node
// Standalone one-shot historical price backfill for the Polkadex Explorer.
//
// Pulls the full daily PDEX/USDT klines from AscendEX (free, public, no API
// key) and writes them into the explorer's SQLite `price_history` table
// tagged with source='ascendex-backfill'. The forward-going price polling
// done by the running indexer (CMC + AscendEX ticker) is untouched — those
// continue to append rows tagged with their own source. This script is
// purely additive.
//
// WHY ASCENDEX
//   PDEX was migrated FROM Ethereum TO the Polkadex Mainnet, so the
//   Ethereum-side ERC20 contract that aggregators like DefiLlama and
//   CoinPaprika track only reflects the residual unmigrated tokens — a
//   thin Uniswap pool that prints stale, manipulated prices. AscendEX
//   trades the native Substrate PDEX (PDEX/USDT pair), so its candles
//   reflect ACTUAL mainnet market reality from March 2022 onwards.
//
// USAGE
//   # Inside the running backend container (recommended — script lives at
//   # /app via the COPY line in Dockerfile.backend, and the DB is right there):
//   docker compose exec backend node --experimental-sqlite \
//       backfill-price-history.mjs
//
//   # Or directly on the host against a known DB path:
//   node --experimental-sqlite backfill-price-history.mjs \
//       --db /opt/pdexplorer/data/explorer.db
//
//   # Override symbol or page-size cap if needed:
//   node --experimental-sqlite backfill-price-history.mjs \
//       --symbol PDEX/USDT --max-pages 20
//
// IDEMPOTENCY
//   `price_history.timestamp` is a PRIMARY KEY and inserts use INSERT OR
//   IGNORE, so re-running this script is safe — already-present rows are
//   silently skipped. The summary tells you how many rows were actually
//   inserted vs. skipped on this run.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import process from 'node:process';

// ---- CLI args ----
function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i > -1 && i + 1 < process.argv.length) return process.argv[i + 1];
    return fallback;
}

const DB_PATH = arg('db', process.env.PRICE_BACKFILL_DB_PATH || '/app/data/explorer.db');
const SYMBOL = arg('symbol', process.env.ASCENDEX_SYMBOL || 'PDEX/USDT');
const PAGE_SIZE = Number(arg('page-size', 500));        // AscendEX caps at 500 per request
const MAX_PAGES = Number(arg('max-pages', 30));         // safety cap on pagination loops
const INTER_REQUEST_DELAY_MS = Number(arg('delay-ms', 250));

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}`);
    console.error(`Tip: pass --db <path> or set PRICE_BACKFILL_DB_PATH.`);
    console.error(`     Inside the backend container the default is /app/data/explorer.db.`);
    process.exit(2);
}

console.log(`[backfill] DB:        ${DB_PATH}`);
console.log(`[backfill] Symbol:    ${SYMBOL}`);
console.log(`[backfill] Page size: ${PAGE_SIZE} bars/request, max ${MAX_PAGES} pages`);

// ---- AscendEX fetch + pagination ----
//
// AscendEX barhist response shape:
//   { code: 0, data: [
//       { m: 'bar', s: 'PDEX/USDT', data: {
//           i: '1d',
//           ts: <ms epoch — start of the bar>,
//           o, c, h, l, v   (all strings — base-asset volume `v`)
//       } },
//       ...
//   ] }
//
// Bars are returned NEWEST-FIRST per page when using `n=<count>&to=<ts>`.
// We walk back via `to = earliestTs` until we get an empty page (= listing
// inception). Total page count is capped by --max-pages so a bug here can't
// hammer AscendEX in a loop.
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOnePage(toMs) {
    const params = new URLSearchParams({ symbol: SYMBOL, interval: '1d', n: String(PAGE_SIZE) });
    if (toMs) params.set('to', String(toMs));
    const url = `https://ascendex.com/api/pro/v1/barhist?${params.toString()}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`AscendEX HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(`AscendEX code=${json.code}`);
    const bars = Array.isArray(json.data) ? json.data : [];
    // Flatten the { m, s, data:{...} } wrapper.
    return bars.map(b => b.data || {});
}

async function fetchAllBars() {
    const all = [];
    const seen = new Set();
    let toMs = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
        console.log(`[backfill] page ${page}  to=${toMs ?? '(latest)'}`);
        const bars = await fetchOnePage(toMs);
        if (!bars.length) {
            console.log(`[backfill] page ${page} returned 0 bars — reached listing inception`);
            break;
        }
        // Track the earliest timestamp on this page; next page asks for bars
        // ENDING at that ts (AscendEX includes the boundary bar — we dedup).
        let earliest = Infinity;
        let added = 0;
        for (const b of bars) {
            const ts = Number(b.ts);
            if (!Number.isFinite(ts) || ts <= 0) continue;
            if (seen.has(ts)) continue;
            seen.add(ts);
            all.push(b);
            added++;
            if (ts < earliest) earliest = ts;
        }
        console.log(`[backfill]   ${added} new bars, ${bars.length - added} dedup`);
        if (added === 0) {
            console.log(`[backfill] no new bars on page ${page} — stopping`);
            break;
        }
        toMs = earliest;
        await sleep(INTER_REQUEST_DELAY_MS);
    }
    all.sort((a, b) => Number(a.ts) - Number(b.ts));   // chronological ascending
    return all;
}

// ---- DB write ----
function openDb(dbPath) {
    const db = new DatabaseSync(dbPath);
    // Confirm the price_history table + source column exist. If you're
    // running this against a DB from before the migration, the column won't
    // exist — add it so insertions don't break.
    const cols = db.prepare('PRAGMA table_info(price_history)').all();
    if (!cols.some(c => c.name === 'source')) {
        console.log('[backfill] price_history.source column is missing — adding it');
        db.exec('ALTER TABLE price_history ADD COLUMN source TEXT DEFAULT NULL');
        db.exec("UPDATE price_history SET source = 'cmc' WHERE source IS NULL");
        db.exec('CREATE INDEX IF NOT EXISTS idx_price_source_ts ON price_history(source, timestamp DESC)');
    }
    return db;
}

function insertBars(db, bars) {
    // INSERT OR IGNORE: if a row with the same timestamp already exists (e.g.
    // re-running, or a forward-poll wrote at the same ms), keep what's there.
    // Wrap the whole loop in one transaction so the write is fast.
    const stmt = db.prepare(
        'INSERT OR IGNORE INTO price_history(timestamp,price,market_cap,volume_24h,pct_change_24h,source) VALUES(?,?,?,?,?,?)'
    );
    const countBefore = db.prepare('SELECT COUNT(*) AS c FROM price_history').get().c;
    db.exec('BEGIN');
    let validRows = 0, skipped = 0;
    try {
        for (const b of bars) {
            const ts = Number(b.ts);
            const close = parseFloat(b.c);
            const open = parseFloat(b.o);
            const volBase = parseFloat(b.v);
            if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(close) || close <= 0) {
                skipped++;
                continue;
            }
            // Per-bar 24h % change = (close - open) / open.
            const pct = Number.isFinite(open) && open > 0
                ? ((close - open) / open) * 100
                : null;
            // AscendEX volume is in base asset (PDEX). Multiply by close
            // for an approximate USD volume — exact only at flat-price days,
            // but good enough for the volume column at daily granularity.
            const volUsd = Number.isFinite(volBase) && volBase >= 0
                ? volBase * close
                : null;
            stmt.run(ts, close, null, volUsd, pct, 'ascendex-backfill');
            validRows++;
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
    const countAfter = db.prepare('SELECT COUNT(*) AS c FROM price_history').get().c;
    return {
        validRows, skipped,
        inserted: countAfter - countBefore,
        alreadyPresent: validRows - (countAfter - countBefore),
        countBefore, countAfter,
    };
}

// ---- main ----
async function main() {
    const bars = await fetchAllBars();
    if (!bars.length) {
        console.error('[backfill] FAILED: no bars returned at all — check symbol or network');
        process.exit(1);
    }
    const firstTs = bars[0].ts;
    const lastTs  = bars[bars.length - 1].ts;
    console.log(`[backfill] fetched ${bars.length} unique bars`);
    console.log(`[backfill] coverage: ${new Date(firstTs).toISOString().slice(0,10)} → ${new Date(lastTs).toISOString().slice(0,10)}`);

    const db = openDb(DB_PATH);
    const stats = insertBars(db, bars);
    db.close();

    console.log('');
    console.log('=== Backfill summary ===');
    console.log(`Bars received from AscendEX:   ${bars.length}`);
    console.log(`Valid (finite + positive):     ${stats.validRows}`);
    console.log(`Malformed / skipped:           ${stats.skipped}`);
    console.log(`Newly inserted into DB:        ${stats.inserted}`);
    console.log(`Already present (no-op):       ${stats.alreadyPresent}`);
    console.log(`price_history row count: ${stats.countBefore} → ${stats.countAfter}`);
    console.log('');
    console.log(`Inserted rows are tagged source='ascendex-backfill'.`);
    console.log(`The running indexer's forward-going CMC + AscendEX ticker rows are untouched.`);
}

main().catch(err => {
    console.error('[backfill] FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
