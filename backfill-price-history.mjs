#!/usr/bin/env node
// Standalone one-shot historical price backfill for the Polkadex Explorer.
//
// Pulls the full daily PDEX/USD series from DefiLlama (free, no API key) and
// writes it into the explorer's SQLite `price_history` table tagged with
// source='defillama-backfill'. The forward-going price polling done by the
// running indexer (CMC + AscendEX) is untouched — those continue to append
// rows tagged with their own source. This script is purely additive.
//
// USAGE
//   # Inside the running backend container (recommended — script lives at /app
//   # via the COPY line in Dockerfile.backend, and the DB is right there):
//   docker compose exec backend node --experimental-sqlite \
//       backfill-price-history.mjs
//
//   # Or directly on the host against a known DB path:
//   node --experimental-sqlite backfill-price-history.mjs \
//       --db /opt/pdexplorer/data/explorer.db
//
//   # Override the start date or coin ID if needed:
//   node --experimental-sqlite backfill-price-history.mjs \
//       --start 2023-01-01 --coin ethereum:0x...
//
// IDEMPOTENCY
//   `price_history.timestamp` is a PRIMARY KEY and inserts use INSERT OR
//   IGNORE, so re-running this script is safe — already-present rows are
//   silently skipped. The summary tells you how many rows were actually
//   inserted vs. skipped on this run.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

// ---- CLI args ----
function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i > -1 && i + 1 < process.argv.length) return process.argv[i + 1];
    return fallback;
}

const DB_PATH = arg('db', process.env.PRICE_BACKFILL_DB_PATH || '/app/data/explorer.db');
const COIN_ID = arg('coin', process.env.DEFILLAMA_PDEX_COIN_ID || 'ethereum:0xf59ae934f6fe444afc309586cc60a84a0f89aaea');
const START_STR = arg('start', process.env.DEFILLAMA_BACKFILL_START || '2022-12-21');

const startSec = Math.floor(new Date(`${START_STR}T00:00:00Z`).getTime() / 1000);
if (!Number.isFinite(startSec) || startSec <= 0) {
    console.error(`Invalid --start: ${START_STR} (expected YYYY-MM-DD)`);
    process.exit(2);
}

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}`);
    console.error(`Tip: pass --db <path> or set PRICE_BACKFILL_DB_PATH.`);
    console.error(`     Inside the backend container the default is /app/data/explorer.db.`);
    process.exit(2);
}

console.log(`[backfill] DB:    ${DB_PATH}`);
console.log(`[backfill] Coin:  ${COIN_ID}`);
console.log(`[backfill] Start: ${START_STR} (epoch ${startSec})`);

// ---- DefiLlama fetch ----
async function fetchDefillamaChart(coinId, startSec) {
    // Span = number of daily points to request, sized to cover from `start`
    // through today, with a small buffer to absorb rounding.
    const nowSec = Math.floor(Date.now() / 1000);
    const span = Math.ceil((nowSec - startSec) / (24 * 3600)) + 10;
    const url = `https://coins.llama.fi/chart/${encodeURIComponent(coinId)}?start=${startSec}&span=${span}&period=1d`;
    console.log(`[backfill] GET ${url}`);
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`DefiLlama HTTP ${resp.status}`);
    const json = await resp.json();
    const entry = json && json.coins && json.coins[coinId];
    const prices = entry && Array.isArray(entry.prices) ? entry.prices : [];
    if (!prices.length) throw new Error('DefiLlama returned no price points');
    return prices;
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

function insertRows(db, prices) {
    // INSERT OR IGNORE: if a row with the same timestamp already exists (e.g.
    // re-running the script, or a forward-poll wrote at the same ms), keep
    // what's there. Wrap the whole loop in one transaction for speed —
    // ~1300 rows × individual fsyncs would take a while otherwise.
    const stmt = db.prepare(
        'INSERT OR IGNORE INTO price_history(timestamp,price,market_cap,volume_24h,pct_change_24h,source) VALUES(?,?,?,?,?,?)'
    );
    const countBefore = db.prepare('SELECT COUNT(*) AS c FROM price_history').get().c;
    db.exec('BEGIN');
    let processed = 0, validRows = 0, skipped = 0;
    let prev = null;
    try {
        for (const p of prices) {
            processed++;
            const ts = Number(p.timestamp);
            const price = Number(p.price);
            if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(price) || price <= 0) {
                skipped++;
                continue;
            }
            // pctChange24h derived from the previous valid day's close.
            const pct = (prev != null && prev > 0) ? ((price - prev) / prev) * 100 : null;
            stmt.run(ts * 1000, price, null, null, pct, 'defillama-backfill');
            validRows++;
            prev = price;
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
    const countAfter = db.prepare('SELECT COUNT(*) AS c FROM price_history').get().c;
    return {
        processed, validRows, skipped,
        inserted: countAfter - countBefore,
        alreadyPresent: validRows - (countAfter - countBefore),
        countBefore, countAfter,
    };
}

// ---- main ----
async function main() {
    const prices = await fetchDefillamaChart(COIN_ID, startSec);
    const firstTs = prices[0]?.timestamp;
    const lastTs  = prices[prices.length - 1]?.timestamp;
    console.log(`[backfill] DefiLlama returned ${prices.length} points`);
    console.log(`[backfill] coverage: ${new Date(firstTs * 1000).toISOString().slice(0,10)} → ${new Date(lastTs * 1000).toISOString().slice(0,10)}`);

    const db = openDb(DB_PATH);
    const stats = insertRows(db, prices);
    db.close();

    console.log('');
    console.log('=== Backfill summary ===');
    console.log(`Points received from DefiLlama: ${stats.processed}`);
    console.log(`Valid (finite + positive):      ${stats.validRows}`);
    console.log(`Malformed / skipped:            ${stats.skipped}`);
    console.log(`Newly inserted into DB:         ${stats.inserted}`);
    console.log(`Already present (no-op):        ${stats.alreadyPresent}`);
    console.log(`price_history row count: ${stats.countBefore} → ${stats.countAfter}`);
    console.log('');
    console.log(`All inserted rows are tagged source='defillama-backfill'.`);
    console.log(`The running indexer's forward-going CMC + AscendEX rows are untouched.`);
}

main().catch(err => {
    console.error('[backfill] FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
