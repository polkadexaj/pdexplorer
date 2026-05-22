// SQLite data layer for the Polkadex explorer.
// Uses Node's built-in node:sqlite (run the backend with --experimental-sqlite).
// Replaces the previous whole-file JSON caches: every write is an indexed
// INSERT/UPSERT and every read is an indexed query, so caches can hold full
// historical data without the cost of rewriting/parsing a growing file.
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS validators (
  address TEXT PRIMARY KEY,
  name TEXT,
  total_stake REAL,
  commission REAL,
  real_apy REAL,
  avg30day_apy REAL,
  position INTEGER
);
CREATE TABLE IF NOT EXISTS holders (
  address TEXT PRIMARY KEY,
  rank INTEGER,
  name TEXT,
  balance REAL,
  share REAL
);
CREATE TABLE IF NOT EXISTS transactions (
  hash TEXT PRIMARY KEY,
  from_addr TEXT,
  to_addr TEXT,
  block INTEGER,
  method TEXT,
  amount TEXT,
  numeric_amount REAL,
  value TEXT,
  status TEXT,
  timestamp INTEGER,
  event_index INTEGER,
  block_hash TEXT,
  event_derived INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(block DESC);
CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_addr);
CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_addr);
CREATE TABLE IF NOT EXISTS blocks (
  number INTEGER PRIMARY KEY,
  hash TEXT,
  author_address TEXT,
  author_name TEXT,
  extrinsics_count INTEGER,
  events_count INTEGER,
  timestamp INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  hash TEXT PRIMARY KEY,
  tx_hash TEXT,
  block_hash TEXT,
  block INTEGER,
  event_index INTEGER,
  extrinsic_index INTEGER,
  section TEXT,
  method TEXT,
  data TEXT,
  signer_address TEXT,
  signer_name TEXT,
  timestamp INTEGER,
  status TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_block ON events(block DESC);
CREATE INDEX IF NOT EXISTS idx_events_signer ON events(signer_address);
CREATE TABLE IF NOT EXISTS validator_history (
  era INTEGER,
  address TEXT,
  commission REAL,
  stake REAL,
  apy REAL,
  PRIMARY KEY (era, address)
);
CREATE INDEX IF NOT EXISTS idx_vh_address ON validator_history(address);
CREATE TABLE IF NOT EXISTS validator_triggers (
  address TEXT,
  era INTEGER,
  prev_commission REAL,
  new_commission REAL,
  timestamp INTEGER,
  PRIMARY KEY (address, era)
);
CREATE TABLE IF NOT EXISTS staking_rewards (
  id TEXT PRIMARY KEY,
  stash TEXT,
  amount REAL,
  era INTEGER,
  validator TEXT,
  block INTEGER,
  block_hash TEXT,
  event_index INTEGER,
  timestamp INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sr_stash ON staking_rewards(stash, block DESC);
CREATE TABLE IF NOT EXISTS staking_rewards_unclaimed (
  stash TEXT,
  era INTEGER,
  validator TEXT,
  amount REAL,
  PRIMARY KEY (stash, era, validator)
);
CREATE INDEX IF NOT EXISTS idx_sru_stash ON staking_rewards_unclaimed(stash);
CREATE TABLE IF NOT EXISTS price_history (
  timestamp INTEGER PRIMARY KEY,
  price REAL,
  market_cap REAL,
  volume_24h REAL,
  pct_change_24h REAL
);
`;

export function initDb(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(path.join(dataDir, 'explorer.db'));
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    try { migrateFromJson(dataDir); }
    catch (e) { console.warn('JSON -> SQLite migration skipped:', e.message); }
    return db;
}

// Run a function inside a transaction so bulk writes commit in one fsync.
function runTx(fn) {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) { } throw e; }
}

// --- key/value store (singletons + sync watermarks) ---
export function getKv(key) {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch (e) { return null; }
}
export function setKv(key, value) {
    db.prepare('INSERT OR REPLACE INTO kv(key, value, updated_at) VALUES(?,?,?)')
        .run(key, JSON.stringify(value), Date.now());
}
export function getSyncState(name) { return getKv('sync:' + name) || {}; }
export function setSyncState(name, obj) { setKv('sync:' + name, obj); }

// --- validators ---
export function replaceValidators(list, meta) {
    runTx(() => {
        db.prepare('DELETE FROM validators').run();
        const stmt = db.prepare('INSERT OR REPLACE INTO validators(address,name,total_stake,commission,real_apy,avg30day_apy,position) VALUES(?,?,?,?,?,?,?)');
        list.forEach((v, i) => stmt.run(v.address, v.name ?? null, v.totalStake ?? 0, v.commission ?? 0, v.realApy ?? 0, v.avg30DayApy ?? 0, i));
    });
    setSyncState('validators', { totalCount: meta.totalCount, lastSync: meta.lastSync, status: meta.status });
}
export function getValidators() {
    const validators = db.prepare('SELECT address, name, total_stake AS totalStake, commission, real_apy AS realApy, avg30day_apy AS avg30DayApy FROM validators ORDER BY position ASC').all();
    const s = getSyncState('validators');
    return { validators, totalCount: s.totalCount ?? validators.length, lastSync: s.lastSync ?? 0, status: s.status ?? 'Initializing', error: s.error };
}

// --- holders ---
export function replaceHolders(list, meta) {
    runTx(() => {
        db.prepare('DELETE FROM holders').run();
        const stmt = db.prepare('INSERT OR REPLACE INTO holders(address,rank,name,balance,share) VALUES(?,?,?,?,?)');
        list.forEach(h => stmt.run(h.address, h.rank ?? null, h.name ?? null, h.balance ?? 0, h.share ?? 0));
    });
    setSyncState('holders', { totalCount: meta.totalCount, lastSync: meta.lastSync, status: meta.status });
}
export function getHolders() {
    const holders = db.prepare('SELECT address, rank, name, balance, share FROM holders ORDER BY rank ASC').all();
    const s = getSyncState('holders');
    return { holders, totalCount: s.totalCount ?? holders.length, lastSync: s.lastSync ?? 0, status: s.status ?? 'Initializing' };
}
export function getHolderRank(address) {
    const row = db.prepare('SELECT rank FROM holders WHERE address = ?').get(address);
    return row ? row.rank : 0;
}

// --- transactions ---
const TX_COLS = 'hash, from_addr AS "from", to_addr AS "to", block, method, amount, numeric_amount AS numericAmount, value, status, timestamp, event_index AS eventIndex, block_hash AS blockHash, event_derived AS eventDerived';
export function insertTransactions(list) {
    if (!list || !list.length) return 0;
    let added = 0;
    runTx(() => {
        const stmt = db.prepare('INSERT OR IGNORE INTO transactions(hash,from_addr,to_addr,block,method,amount,numeric_amount,value,status,timestamp,event_index,block_hash,event_derived) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const t of list) {
            if (!t || !t.hash) continue;
            const r = stmt.run(t.hash, t.from ?? null, t.to ?? null, t.block ?? null, t.method ?? null,
                t.amount ?? null, t.numericAmount ?? 0, t.value ?? null, t.status ?? null, t.timestamp ?? null,
                t.eventIndex ?? null, t.blockHash ?? null, t.eventDerived ? 1 : 0);
            added += r.changes;
        }
    });
    return added;
}
export function getRecentTransactions(limit) {
    return db.prepare(`SELECT ${TX_COLS} FROM transactions ORDER BY block DESC, timestamp DESC LIMIT ?`).all(limit);
}
export function getTransactionsByAddress(address, limit) {
    return db.prepare(`SELECT ${TX_COLS} FROM transactions WHERE from_addr = ? OR to_addr = ? ORDER BY block DESC LIMIT ?`).all(address, address, limit);
}
export function countTransactions() {
    return db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
}

// --- blocks ---
export function insertBlocks(list) {
    if (!list || !list.length) return;
    runTx(() => {
        const stmt = db.prepare('INSERT OR REPLACE INTO blocks(number,hash,author_address,author_name,extrinsics_count,events_count,timestamp) VALUES(?,?,?,?,?,?,?)');
        for (const b of list) stmt.run(b.number, b.hash ?? null, b.authorAddress ?? null, b.authorName ?? null, b.extrinsicsCount ?? 0, b.eventsCount ?? 0, b.timestamp ?? null);
    });
}
export function getRecentBlocks(limit) {
    return db.prepare('SELECT number, hash, author_address AS authorAddress, author_name AS authorName, extrinsics_count AS extrinsicsCount, events_count AS eventsCount, timestamp FROM blocks ORDER BY number DESC LIMIT ?').all(limit);
}
export function hasBlock(number) {
    return !!db.prepare('SELECT 1 FROM blocks WHERE number = ?').get(number);
}
export function countBlocks() {
    return db.prepare('SELECT COUNT(*) AS c FROM blocks').get().c;
}

// --- events ---
function mapEventRow(r) {
    let data = null;
    try { data = JSON.parse(r.data); } catch (e) { }
    return { ...r, data };
}
const EVENT_COLS = 'hash, tx_hash AS txHash, block_hash AS blockHash, block, event_index AS eventIndex, extrinsic_index AS extrinsicIndex, section, method, data, signer_address AS signerAddress, signer_name AS signerName, timestamp, status';
export function insertEvents(list) {
    if (!list || !list.length) return;
    runTx(() => {
        const stmt = db.prepare('INSERT OR IGNORE INTO events(hash,tx_hash,block_hash,block,event_index,extrinsic_index,section,method,data,signer_address,signer_name,timestamp,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const e of list) {
            if (!e || !e.hash) continue;
            stmt.run(e.hash, e.txHash ?? null, e.blockHash ?? null, e.block ?? null, e.eventIndex ?? null,
                e.extrinsicIndex ?? null, e.section ?? null, e.method ?? null, JSON.stringify(e.data ?? null),
                e.signerAddress ?? null, e.signerName ?? null, e.timestamp ?? null, e.status ?? null);
        }
    });
}
export function getRecentEvents(limit) {
    return db.prepare(`SELECT ${EVENT_COLS} FROM events ORDER BY block DESC, event_index DESC LIMIT ?`).all(limit).map(mapEventRow);
}
export function getEventsByAddress(address, limit) {
    return db.prepare(`SELECT ${EVENT_COLS} FROM events WHERE signer_address = ? ORDER BY block DESC LIMIT ?`).all(address, limit).map(mapEventRow);
}
export function countEvents() {
    return db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
}

// --- validator history & triggers ---
export function upsertValidatorHistory(rows) {
    if (!rows || !rows.length) return;
    runTx(() => {
        const stmt = db.prepare('INSERT OR REPLACE INTO validator_history(era,address,commission,stake,apy) VALUES(?,?,?,?,?)');
        for (const r of rows) stmt.run(r.era, r.address, r.commission ?? 0, r.stake ?? 0, r.apy ?? 0);
    });
}
export function getValidatorHistory(address) {
    return db.prepare('SELECT era, commission, stake, apy FROM validator_history WHERE address = ? ORDER BY era DESC').all(address);
}
export function countValidatorHistoryEras(address) {
    return db.prepare('SELECT COUNT(*) AS c FROM validator_history WHERE address = ?').get(address).c;
}
export function replaceValidatorTriggers(address, triggers) {
    runTx(() => {
        db.prepare('DELETE FROM validator_triggers WHERE address = ?').run(address);
        const stmt = db.prepare('INSERT OR REPLACE INTO validator_triggers(address,era,prev_commission,new_commission,timestamp) VALUES(?,?,?,?,?)');
        for (const t of (triggers || [])) stmt.run(address, t.era, t.prevCommission ?? 0, t.newCommission ?? 0, t.timestamp ?? Date.now());
    });
}
export function getValidatorTriggers(address) {
    return db.prepare('SELECT era, prev_commission AS prevCommission, new_commission AS newCommission, timestamp FROM validator_triggers WHERE address = ? ORDER BY era DESC').all(address);
}

// --- staking rewards (claimed payouts) ---
export function insertStakingRewards(list) {
    if (!list || !list.length) return 0;
    let added = 0;
    runTx(() => {
        const stmt = db.prepare('INSERT OR IGNORE INTO staking_rewards(id,stash,amount,era,validator,block,block_hash,event_index,timestamp) VALUES(?,?,?,?,?,?,?,?,?)');
        for (const r of list) {
            if (!r || !r.id) continue;
            const res = stmt.run(r.id, r.stash, r.amount ?? 0, r.era ?? null, r.validator ?? null, r.block ?? null, r.blockHash ?? null, r.eventIndex ?? null, r.timestamp ?? null);
            added += res.changes;
        }
    });
    return added;
}
export function getStakingRewards(stash) {
    return db.prepare('SELECT id, stash, amount, era, validator, block, block_hash AS blockHash, event_index AS eventIndex, timestamp FROM staking_rewards WHERE stash = ? ORDER BY block DESC, event_index DESC').all(stash);
}
export function countStakingRewards() {
    return db.prepare('SELECT COUNT(*) AS c FROM staking_rewards').get().c;
}
export function countStakingRewardStashes() {
    return db.prepare('SELECT COUNT(DISTINCT stash) AS c FROM staking_rewards').get().c;
}
export function getClaimedRewardKeys(stash) {
    return db.prepare('SELECT DISTINCT era, validator FROM staking_rewards WHERE stash = ?').all(stash);
}

// --- staking rewards (unclaimed / unpaid, computed on demand) ---
export function replaceUnclaimed(stash, rows) {
    runTx(() => {
        db.prepare('DELETE FROM staking_rewards_unclaimed WHERE stash = ?').run(stash);
        const stmt = db.prepare('INSERT OR REPLACE INTO staking_rewards_unclaimed(stash,era,validator,amount) VALUES(?,?,?,?)');
        for (const r of (rows || [])) stmt.run(stash, r.era, r.validator ?? '', r.amount ?? 0);
    });
    setKv('unclaimed_at:' + stash, Date.now());
}
export function getUnclaimed(stash) {
    return db.prepare('SELECT era, validator, amount FROM staking_rewards_unclaimed WHERE stash = ? ORDER BY era DESC').all(stash);
}
export function getUnclaimedComputedAt(stash) {
    const v = getKv('unclaimed_at:' + stash);
    return typeof v === 'number' ? v : 0;
}

// --- price history ---
export function insertPrice(point) {
    db.prepare('INSERT OR REPLACE INTO price_history(timestamp,price,market_cap,volume_24h,pct_change_24h) VALUES(?,?,?,?,?)')
        .run(point.timestamp, point.price ?? null, point.marketCap ?? null, point.volume24h ?? null, point.pctChange24h ?? null);
}
export function getPriceHistory(sinceTs) {
    return db.prepare('SELECT timestamp, price, market_cap AS marketCap, volume_24h AS volume24h, pct_change_24h AS pctChange24h FROM price_history WHERE timestamp >= ? ORDER BY timestamp ASC').all(sinceTs ?? 0);
}
export function getLatestPrice() {
    return db.prepare('SELECT timestamp, price, market_cap AS marketCap, volume_24h AS volume24h, pct_change_24h AS pctChange24h FROM price_history ORDER BY timestamp DESC LIMIT 1').get() || null;
}
export function countPricePoints() {
    return db.prepare('SELECT COUNT(*) AS c FROM price_history').get().c;
}

// --- one-time migration of legacy JSON caches ---
function tableCount(table) {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}
function readJsonFile(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function migrateFromJson(dataDir) {
    const j = name => path.join(dataDir, name);

    if (tableCount('validators') === 0) {
        const d = readJsonFile(j('cache.json'));
        if (d && Array.isArray(d.validators) && d.validators.length) {
            replaceValidators(d.validators, { totalCount: d.totalCount ?? d.validators.length, lastSync: d.lastSync ?? 0, status: d.status ?? 'Synced' });
            console.log('Migrated validators from JSON:', d.validators.length);
        }
    }
    if (tableCount('holders') === 0) {
        const d = readJsonFile(j('holders_cache.json'));
        if (d && Array.isArray(d.holders) && d.holders.length) {
            replaceHolders(d.holders, { totalCount: d.totalCount ?? d.holders.length, lastSync: d.lastSync ?? 0, status: d.status ?? 'Synced' });
            console.log('Migrated holders from JSON:', d.holders.length);
        }
    }
    if (tableCount('transactions') === 0) {
        const d = readJsonFile(j('transactions_cache.json'));
        if (d && Array.isArray(d.transactions) && d.transactions.length) {
            insertTransactions(d.transactions);
            setSyncState('transactions', { lastSync: d.lastSync ?? 0, status: d.status ?? 'Synced', latestScannedBlock: d.latestScannedBlock ?? 0, oldestScannedBlock: d.oldestScannedBlock ?? 0, scannedBlocks: d.scannedBlocks ?? 0, scannerVersion: d.scannerVersion ?? 0 });
            console.log('Migrated transactions from JSON:', d.transactions.length);
        }
    }
    if (tableCount('blocks') === 0) {
        const d = readJsonFile(j('blocks_cache.json'));
        if (d && Array.isArray(d.blocks) && d.blocks.length) { insertBlocks(d.blocks); console.log('Migrated blocks from JSON:', d.blocks.length); }
    }
    if (tableCount('events') === 0) {
        const d = readJsonFile(j('events_cache.json'));
        if (d && Array.isArray(d.events) && d.events.length) { insertEvents(d.events); console.log('Migrated events from JSON:', d.events.length); }
    }
    if (tableCount('validator_history') === 0) {
        const d = readJsonFile(j('validator_history_cache.json'));
        if (d && typeof d === 'object') {
            const rows = [];
            for (const era of Object.keys(d)) {
                const eraData = d[era];
                if (!eraData || typeof eraData !== 'object') continue;
                for (const addr of Object.keys(eraData)) {
                    const v = eraData[addr] || {};
                    rows.push({ era: Number(era), address: addr, commission: v.commission, stake: v.stake, apy: v.apy });
                }
            }
            if (rows.length) { upsertValidatorHistory(rows); console.log('Migrated validator history from JSON:', rows.length); }
        }
    }
    if (tableCount('validator_triggers') === 0) {
        const d = readJsonFile(j('validator_triggers_cache.json'));
        if (d && typeof d === 'object') {
            for (const addr of Object.keys(d)) {
                if (Array.isArray(d[addr]) && d[addr].length) replaceValidatorTriggers(addr, d[addr]);
            }
        }
    }
    if (!getKv('network_info')) {
        const d = readJsonFile(j('network_info_cache.json'));
        if (d && d.networkInfo) setKv('network_info', { networkInfo: d.networkInfo, lastSync: d.lastSync ?? 0, status: d.status ?? 'Synced' });
    }
    if (tableCount('staking_rewards') === 0) {
        const d = readJsonFile(j('staking_rewards_cache.json'));
        if (d && d.rewards && typeof d.rewards === 'object') {
            const rows = [];
            for (const stash of Object.keys(d.rewards)) {
                const list = d.rewards[stash];
                if (!Array.isArray(list)) continue;
                for (const r of list) {
                    rows.push({ id: r.id || `${r.block}-${r.eventIndex}`, stash, amount: r.amount, era: r.era, validator: r.validator, block: r.block, blockHash: r.blockHash, eventIndex: r.eventIndex, timestamp: r.timestamp });
                }
            }
            if (rows.length) { insertStakingRewards(rows); console.log('Migrated staking rewards from JSON:', rows.length); }
            setSyncState('staking_rewards', {
                latestScannedBlock: d.latestScannedBlock ?? 0, oldestScannedBlock: d.oldestScannedBlock ?? 0,
                backfillCursor: d.backfillCursor ?? 0, backfillComplete: !!d.backfillComplete,
                initialized: !!d.initialized, lastSync: d.lastSync ?? 0, status: d.status ?? 'Synced'
            });
        }
    }
}
