import express from 'express';
import cors from 'cors';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { decodeAddress, encodeAddress, signatureVerify, randomAsHex } from '@polkadot/util-crypto';
import { u8aWrapBytes } from '@polkadot/util';
import path from 'path';
import * as db from './db.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

// Use dedicated data directory for Docker volumes
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(process.cwd(), 'data');
const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const THIRTY_SECONDS = 30 * 1000;
const RECENT_SYNC_INTERVAL = 12 * 1000;
const TX_CACHE_LIMIT = readPositiveInteger(process.env.TX_CACHE_LIMIT, 500);
const TX_INITIAL_SCAN_BLOCKS = readPositiveInteger(process.env.TX_INITIAL_SCAN_BLOCKS, 20000);
const TX_OLDER_SCAN_BLOCKS = readPositiveInteger(process.env.TX_OLDER_SCAN_BLOCKS, TX_INITIAL_SCAN_BLOCKS);
const TX_SCAN_BATCH_SIZE = readPositiveInteger(process.env.TX_SCAN_BATCH_SIZE, 25);
const FINANCIAL_TX_SCANNER_VERSION = 2;
const VALIDATOR_HISTORY_ERAS = readPositiveInteger(process.env.VALIDATOR_HISTORY_ERAS, 30);
// Staking rewards indexer tuning. The crawler scans blocks for staking.Rewarded
// events (claimed payouts) and appends them to a local per-address index.
const STAKING_REWARDS_SCAN_BATCH = readPositiveInteger(process.env.STAKING_REWARDS_SCAN_BATCH, 25);
const STAKING_REWARDS_BACKFILL_CHUNK = readPositiveInteger(process.env.STAKING_REWARDS_BACKFILL_CHUNK, 500);
const STAKING_REWARDS_FORWARD_MAX = readPositiveInteger(process.env.STAKING_REWARDS_FORWARD_MAX, 20000);
const STAKING_REWARDS_MIN_BLOCK = readPositiveInteger(process.env.STAKING_REWARDS_MIN_BLOCK, 1);
// Wallet dashboard / price chart / unpaid-reward tuning.
const CMC_API_KEY = process.env.CMC_API_KEY || '';
const CMC_SYMBOL = process.env.CMC_SYMBOL || 'PDEX';
const PRICE_SYNC_INTERVAL = readPositiveInteger(process.env.PRICE_SYNC_INTERVAL_MS, 10 * 60 * 1000);
const UNCLAIMED_TTL = readPositiveInteger(process.env.UNCLAIMED_TTL_MS, 20 * 60 * 1000);
const DISPLAY_NAME_OVERRIDES = new Map([
    ['esoEt6uZ9vs23yW8aqTACLf1tViGpSLZKnhPXt5Nq7vQwHGew', 'Polkadex Treasury'],
    ['esm4teFDTrvy4VJ8msKTQmAywumeinGjzsrFzmTEB5FBiiekE', 'Gate.IO']
]);

let isSyncing = false;
let isSyncingHolders = false;
let isSyncingTx = false;
let isSyncingBlocks = false;
let isSyncingEvents = false;
let isSyncingStakingRewards = false;
let isSyncingPrice = false;
let isSyncingCouncil = false;
let isSyncingDemocracy = false;
let isSyncingTreasury = false;
const computingUnclaimed = new Set();
let isCrawlingAccount = {};
let globalApi = null;
let chainSS58 = 88; // Polkadex SS58 prefix; refreshed from the chain registry on connect.
const identityCache = new Map();

function readPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatPDEX(balance) { return Number(balance) / 10 ** 12; }

// Convert a chain Balance codec to a PDEX number safely for large u128 values.
function balanceToPDEX(balance) {
    try { return Number(BigInt(balance.toString())) / 10 ** 12; }
    catch (e) { return Number(balance) / 10 ** 12; }
}

// True when the string decodes as a valid SS58 address.
function isValidAddress(address) {
    try { decodeAddress(address); return true; }
    catch (e) { return false; }
}

// Canonicalise any SS58/hex address to the Polkadex-prefixed form so that
// indexed keys and lookups always match regardless of the input format.
function normalizeAddress(address) {
    return encodeAddress(decodeAddress(address), chainSS58);
}

function getCommissionPercent(prefs) {
    if (!prefs || !prefs.commission) return 0;
    const commission = prefs.commission.unwrap ? prefs.commission.unwrap() : prefs.commission;
    return (commission.toNumber() / 1000000000) * 100;
}

function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function chunkArray(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

async function getEraValidatorStake(api, era, address) {
    let totalStake = 0;
    if (api.query.staking.erasStakersOverview) {
        const overviewOpt = await api.query.staking.erasStakersOverview(era, address);
        if (overviewOpt.isSome) totalStake = overviewOpt.unwrap().total;
    } else if (api.query.staking.erasStakers) {
        const exposure = await api.query.staking.erasStakers(era, address);
        totalStake = exposure.total;
    }
    return totalStake && totalStake.unwrap ? totalStake.unwrap() : totalStake;
}

async function getNetworkInfo() {
    if (!globalApi) throw new Error('API not ready');
    const cacheData = db.getKv('network_info') || { networkInfo: null, lastSync: 0, status: 'Initializing' };
    if (cacheData.networkInfo && Date.now() - cacheData.lastSync < FIVE_MINUTES) return cacheData;

    const activeEraOption = await globalApi.query.staking.activeEra();
    const activeEra = activeEraOption.isSome ? activeEraOption.unwrap().index.toNumber() : 0;
    const previousEra = Math.max(activeEra - 1, 0);
    const [
        totalIssuanceRaw,
        totalStakeRaw,
        previousTotalStakeRaw,
        validators,
        counterForValidators,
        counterForNominators,
        lastEraRewardsRaw
    ] = await Promise.all([
        globalApi.query.balances.totalIssuance(),
        globalApi.query.staking.erasTotalStake(activeEra),
        globalApi.query.staking.erasTotalStake(previousEra),
        globalApi.query.session.validators(),
        globalApi.query.staking.counterForValidators(),
        globalApi.query.staking.counterForNominators(),
        globalApi.query.staking.erasValidatorReward(previousEra)
    ]);

    const stakes = [];
    const commissions = [];
    const activeNominators = new Set();

    for (const chunk of chunkArray(validators, 25)) {
        const results = await Promise.all(chunk.map(async address => {
            const [prefs, exposure] = await Promise.all([
                globalApi.query.staking.validators(address),
                globalApi.query.staking.erasStakers(activeEra, address)
            ]);
            return { prefs, exposure };
        }));
        for (const { prefs, exposure } of results) {
            stakes.push(formatPDEX(exposure.total));
            commissions.push(getCommissionPercent(prefs));
            for (const nomination of exposure.others) activeNominators.add(nomination.who.toString());
        }
    }

    let totalUnlocking = 0;
    const ledgerEntries = await globalApi.query.staking.ledger.entries();
    for (const [, ledgerOpt] of ledgerEntries) {
        const ledger = ledgerOpt.isSome ? ledgerOpt.unwrap() : ledgerOpt;
        for (const unlocking of ledger.unlocking || []) {
            totalUnlocking += formatPDEX(unlocking.value);
        }
    }

    const totalIssuance = formatPDEX(totalIssuanceRaw);
    const totalStake = formatPDEX(totalStakeRaw);
    const previousTotalStake = formatPDEX(previousTotalStakeRaw);
    const networkInfo = {
        activeEra,
        avgValidatorCommission: average(commissions),
        validators: {
            active: validators.length,
            total: Number(counterForValidators)
        },
        nominators: {
            active: activeNominators.size,
            total: Number(counterForNominators)
        },
        maxActiveStake: Math.max(...stakes),
        minStake: Math.min(...stakes),
        averageStake: average(stakes),
        avgStakePerAccount: activeNominators.size ? totalStake / activeNominators.size : 0,
        totalBonding: totalStake,
        totalBondingPercent: totalIssuance ? (totalStake / totalIssuance) * 100 : 0,
        totalUnbonding: totalUnlocking,
        totalStakeChange: totalStake - previousTotalStake,
        lastEraRewardsTotal: formatPDEX(lastEraRewardsRaw)
    };

    const nextCacheData = {
        networkInfo,
        lastSync: Date.now(),
        status: 'Synced'
    };
    db.setKv('network_info', nextCacheData);
    return nextCacheData;
}

function formatIdentityName(rawStr) {
    if (!rawStr) return "Unknown";
    if (rawStr.startsWith('0x')) {
        try { return Buffer.from(rawStr.slice(2), 'hex').toString('utf8'); } catch (e) { return rawStr; }
    }
    return rawStr;
}

async function getIdentity(api, address) {
    const cacheKey = address.toString();
    const hasOverride = DISPLAY_NAME_OVERRIDES.has(cacheKey);
    if (!hasOverride && identityCache.has(cacheKey)) return identityCache.get(cacheKey);

    const onChainName = await getOnChainIdentity(api, address);
    if (onChainName !== "Unknown") {
        identityCache.set(cacheKey, onChainName);
        return onChainName;
    }

    const fallbackName = DISPLAY_NAME_OVERRIDES.get(cacheKey) || "Unknown";
    if (!hasOverride) identityCache.set(cacheKey, fallbackName);
    return fallbackName;
}

async function getOnChainIdentity(api, address) {
    const cacheKey = address.toString();
    let name = "Unknown";
    try {
        const superOf = await api.query.identity.superOf(address);
        if (superOf.isSome) {
            const [parentAddress, data] = superOf.unwrap();
            const parentIdentity = await api.query.identity.identityOf(parentAddress);
            let parentName = "Unknown";
            const pHuman = parentIdentity.toHuman();
            if (pHuman && pHuman.info && pHuman.info.display && pHuman.info.display.Raw) parentName = formatIdentityName(pHuman.info.display.Raw);
            else if (pHuman && Array.isArray(pHuman) && pHuman[0] && pHuman[0].info) parentName = formatIdentityName(pHuman[0].info.display.Raw);

            const subDataHuman = data.toHuman();
            const subName = subDataHuman ? formatIdentityName(subDataHuman.Raw) : "Unknown";
            name = `${parentName} / ${subName}`;
        } else {
            const identity = await api.query.identity.identityOf(address);
            const human = identity.toHuman();
            if (human && human.info && human.info.display && human.info.display.Raw) name = formatIdentityName(human.info.display.Raw);
            else if (human && Array.isArray(human) && human[0] && human[0].info) name = formatIdentityName(human[0].info.display.Raw);
        }
    } catch (e) {
        console.warn(`Identity lookup failed for ${cacheKey}:`, e.message);
    }
    return name;
}

function getBlockTimestamp(signedBlock) {
    let timestamp = Date.now();
    signedBlock.block.extrinsics.forEach((ex) => {
        if (ex.method.section === 'timestamp' && ex.method.method === 'set') timestamp = ex.method.args[0].toNumber();
    });
    return timestamp;
}

function getExtrinsicStatus(events, index) {
    const txEvents = events.filter(record => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === index);
    return txEvents.some(record => record.event.section === 'system' && record.event.method === 'ExtrinsicFailed') ? 'failed' : 'success';
}

function getExtrinsicMethod(ex) {
    return `${ex.method.section}.${ex.method.method}`;
}

function getExtrinsicAmountSummary(ex) {
    const method = getExtrinsicMethod(ex);
    const args = ex.method.args;
    let to = method;
    let numericAmount = 0;
    let amount = '-';

    if (ex.method.section === 'balances') {
        if (['transfer', 'transferAllowDeath', 'transferKeepAlive'].includes(ex.method.method) && args.length >= 2) {
            to = args[0].toString();
            numericAmount = formatPDEX(args[1]);
            amount = `${numericAmount.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`;
        } else if (ex.method.method === 'forceTransfer' && args.length >= 3) {
            to = args[1].toString();
            numericAmount = formatPDEX(args[2]);
            amount = `${numericAmount.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`;
        } else if (ex.method.method === 'transferAll' && args.length >= 1) {
            to = args[0].toString();
            amount = 'All';
        }
    }

    return { method, to, amount, numericAmount };
}

function buildFinancialTransaction(ex, index, blockNumber, timestamp, events) {
    const summary = getExtrinsicAmountSummary(ex);
    if (summary.amount === '-') return null;
    return {
        hash: ex.hash.toHex(),
        from: ex.isSigned ? ex.signer.toString() : "System",
        to: summary.to,
        block: blockNumber,
        method: summary.method,
        amount: summary.amount,
        numericAmount: summary.numericAmount,
        value: '-',
        status: getExtrinsicStatus(events, index),
        timestamp
    };
}

async function getBlockTimestampAt(blockHash) {
    try {
        return Number(await globalApi.query.timestamp.now.at(blockHash));
    } catch (err) {
        return Date.now();
    }
}

function buildFinancialTransactionFromEvent(record, eventIndex, blockNumber, blockHash, timestamp) {
    const event = record.event;
    if (event.section !== 'balances' || event.method !== 'Transfer' || event.data.length < 3) return null;

    const from = event.data[0].toString();
    const to = event.data[1].toString();
    const numericAmount = formatPDEX(event.data[2]);
    return {
        hash: `event-${blockNumber}-${eventIndex}`,
        from,
        to,
        block: blockNumber,
        method: 'balances.Transfer',
        amount: `${numericAmount.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`,
        numericAmount,
        value: '-',
        status: 'success',
        timestamp,
        eventIndex,
        blockHash: blockHash.toString(),
        eventDerived: true
    };
}

function normalizeTransactionRecord(tx) {
    if (!tx || typeof tx !== 'object') return tx;
    if (typeof tx.amount === 'string' && tx.amount.includes('.') && (!tx.method || tx.value === 'System')) {
        return {
            ...tx,
            method: tx.method || tx.amount,
            to: tx.method || tx.amount,
            amount: '-',
            numericAmount: 0,
            value: '-'
        };
    }
    return tx;
}

function isFinancialTransactionRecord(tx) {
    if (!tx || tx.amount === '-' || tx.amount === undefined || tx.amount === null) return false;
    if (tx.method) {
        return [
            'balances.transfer',
            'balances.transferAllowDeath',
            'balances.transferKeepAlive',
            'balances.forceTransfer',
            'balances.transferAll',
            'balances.Transfer'
        ].includes(tx.method);
    }
    return tx.amount === 'All' || (typeof tx.amount === 'string' && tx.amount.includes('PDEX'));
}

function getCachedFinancialTransactions(cacheData) {
    return Array.isArray(cacheData.transactions)
        ? cacheData.transactions.map(normalizeTransactionRecord).filter(isFinancialTransactionRecord)
        : [];
}

function mergeFinancialTransactions(existingTransactions, incomingTransactions) {
    const transactionsByHash = new Map();
    for (const tx of existingTransactions) {
        if (tx && tx.hash) transactionsByHash.set(tx.hash, tx);
    }
    for (const tx of incomingTransactions) {
        if (!tx || !tx.hash) continue;
        transactionsByHash.set(tx.hash, {
            ...(transactionsByHash.get(tx.hash) || {}),
            ...tx
        });
    }

    return Array.from(transactionsByHash.values())
        .filter(isFinancialTransactionRecord)
        .sort((a, b) => {
            const blockDiff = (Number(b.block) || 0) - (Number(a.block) || 0);
            if (blockDiff !== 0) return blockDiff;
            return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
        })
        .slice(0, TX_CACHE_LIMIT);
}

async function scanFinancialTransactions({
    startBlock,
    stopBlock = 0,
    limit = TX_CACHE_LIMIT,
    maxBlocks = TX_INITIAL_SCAN_BLOCKS,
    onProgress = null,
    progressInterval = 100
}) {
    const transactions = [];
    let scannedBlocks = 0;
    let lastScannedBlock = startBlock;

    for (let nextBlock = startBlock; nextBlock >= stopBlock && transactions.length < limit && scannedBlocks < maxBlocks;) {
        const blockNumbers = [];
        while (nextBlock >= stopBlock && blockNumbers.length < TX_SCAN_BATCH_SIZE && scannedBlocks + blockNumbers.length < maxBlocks) {
            blockNumbers.push(nextBlock);
            nextBlock--;
        }
        if (blockNumbers.length === 0) break;

        const batchResults = await Promise.all(blockNumbers.map(async blockNumber => {
            try {
                const blockHash = await globalApi.rpc.chain.getBlockHash(blockNumber);
                const [events, timestamp] = await Promise.all([
                    globalApi.query.system.events.at(blockHash),
                    getBlockTimestampAt(blockHash)
                ]);
                const blockTransactions = [];
                events.forEach((record, eventIndex) => {
                    const tx = buildFinancialTransactionFromEvent(record, eventIndex, blockNumber, blockHash, timestamp);
                    if (tx) blockTransactions.push(tx);
                });
                return { blockNumber, transactions: blockTransactions };
            } catch (err) {
                console.warn(`Financial transaction scan skipped block ${blockNumber}:`, err.message);
                return { blockNumber, transactions: [] };
            }
        }));

        scannedBlocks += blockNumbers.length;
        lastScannedBlock = blockNumbers[blockNumbers.length - 1];
        for (const result of batchResults.sort((a, b) => b.blockNumber - a.blockNumber)) {
            for (const tx of result.transactions) {
                if (transactions.length >= limit) break;
                transactions.push(tx);
            }
            if (transactions.length >= limit) break;
        }

        if (onProgress && (scannedBlocks % progressInterval === 0 || transactions.length >= limit)) {
            await onProgress({
                transactions,
                scannedBlocks,
                oldestScannedBlock: lastScannedBlock,
                nextBeforeBlock: Math.max(lastScannedBlock, 0)
            });
        }
    }

    return {
        transactions,
        scannedBlocks,
        nextBeforeBlock: scannedBlocks > 0 ? Math.max(lastScannedBlock, 0) : Math.max(startBlock, 0),
        oldestScannedBlock: scannedBlocks > 0 ? lastScannedBlock : 0
    };
}

async function applyDisplayNameOverridesToHolders(holders) {
    return Promise.all(holders.map(async holder => {
        if (!DISPLAY_NAME_OVERRIDES.has(holder.address)) return holder;
        if (!globalApi) {
            return {
                ...holder,
                name: holder.name && holder.name !== "Unknown" ? holder.name : DISPLAY_NAME_OVERRIDES.get(holder.address)
            };
        }
        return { ...holder, name: await getIdentity(globalApi, holder.address) };
    }));
}

async function syncValidatorHistory(activeEra, validators) {
    if (!globalApi || !globalApi.query.staking.erasValidatorPrefs) return;

    const validatorAddresses = validators.map(address => address.toString());
    const firstEra = Math.max(activeEra - VALIDATOR_HISTORY_ERAS + 1, 0);
    const historyRows = [];
    const perAddress = {};

    for (let era = activeEra; era >= firstEra; era--) {
        for (const address of validators) {
            const addrStr = address.toString();
            try {
                const [prefs, totalStake] = await Promise.all([
                    globalApi.query.staking.erasValidatorPrefs(era, address),
                    getEraValidatorStake(globalApi, era, address)
                ]);
                const commission = getCommissionPercent(prefs);
                const row = { era, address: addrStr, commission, stake: formatPDEX(totalStake), apy: 23.09 * (1 - (commission / 100)) };
                historyRows.push(row);
                (perAddress[addrStr] = perAddress[addrStr] || []).push(row);
            } catch (err) {
                console.warn(`Validator history skipped ${addrStr} era ${era}:`, err.message);
            }
        }
    }

    // UPSERT keeps eras already stored, so history grows past the rolling window.
    db.upsertValidatorHistory(historyRows);
    for (const address of validatorAddresses) {
        const rows = (perAddress[address] || []).slice().sort((a, b) => a.era - b.era);
        db.replaceValidatorTriggers(address, getCommissionTriggers(rows));
    }
}

function getCommissionTriggers(history) {
    const triggers = [];
    const chronologicalHistory = [...history].sort((a, b) => a.era - b.era);
    for (let i = 1; i < chronologicalHistory.length; i++) {
        const prev = chronologicalHistory[i - 1];
        const current = chronologicalHistory[i];
        if (prev.commission <= 50 && current.commission > 50) {
            triggers.push({
                era: current.era,
                prevCommission: prev.commission,
                newCommission: current.commission,
                timestamp: Date.now()
            });
        }
    }
    return triggers;
}

async function loadValidatorHistory(address) {
    if (!globalApi || !globalApi.query.staking.erasValidatorPrefs) return { history: [], triggers: [] };

    const activeEraOption = await globalApi.query.staking.activeEra();
    const activeEra = activeEraOption.isSome ? activeEraOption.unwrap().index.toNumber() : 0;
    const firstEra = Math.max(activeEra - VALIDATOR_HISTORY_ERAS + 1, 0);
    const history = [];

    for (let era = activeEra; era >= firstEra; era--) {
        try {
            const [prefs, totalStake] = await Promise.all([
                globalApi.query.staking.erasValidatorPrefs(era, address),
                getEraValidatorStake(globalApi, era, address)
            ]);
            const commission = getCommissionPercent(prefs);
            history.push({
                era,
                commission,
                stake: formatPDEX(totalStake),
                apy: 23.09 * (1 - (commission / 100))
            });
        } catch (err) {
            console.warn(`Validator history skipped ${address} era ${era}:`, err.message);
        }
    }

    const triggers = getCommissionTriggers(history);
    db.upsertValidatorHistory(history.map(h => ({ era: h.era, address, commission: h.commission, stake: h.stake, apy: h.apy })));
    db.replaceValidatorTriggers(address, triggers);

    return { history, triggers };
}

// --- LIST ENDPOINTS (served from SQLite) ---
app.get('/api/validators', (req, res) => {
    try { res.json(db.getValidators()); }
    catch (err) { res.status(500).json({ validators: [], status: 'Error', error: err.message }); }
});
app.get('/api/network-info', async (req, res) => {
    try {
        res.json(await getNetworkInfo());
    } catch (err) {
        const cacheData = db.getKv('network_info') || { networkInfo: null, lastSync: 0, status: 'Initializing' };
        res.json({ ...cacheData, status: 'Error', error: err.message });
    }
});
app.get('/api/holders', async (req, res) => {
    try {
        const cacheData = db.getHolders();
        cacheData.holders = await applyDisplayNameOverridesToHolders(cacheData.holders);
        res.json(cacheData);
    } catch (err) { res.status(500).json({ holders: [], status: 'Error', error: err.message }); }
});
app.get('/api/transactions', (req, res) => {
    try {
        const state = db.getSyncState('transactions');
        res.json({
            transactions: db.getRecentTransactions(1000),
            totalCount: db.countTransactions(),
            lastSync: state.lastSync || 0,
            status: state.status || 'Initializing',
            latestScannedBlock: state.latestScannedBlock || 0,
            oldestScannedBlock: state.oldestScannedBlock || 0
        });
    } catch (err) { res.status(500).json({ transactions: [], status: 'Error', error: err.message }); }
});
app.get('/api/transactions/older', async (req, res) => {
    if (!globalApi) return res.status(500).json({ error: 'API not ready' });
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 100);
    const maxBlocks = Math.min(readPositiveInteger(req.query.maxBlocks, TX_OLDER_SCAN_BLOCKS), 100000);
    try {
        const latestHeader = await globalApi.rpc.chain.getHeader();
        const latestBlock = latestHeader.number.toNumber();
        const beforeBlock = Math.min(parseInt(req.query.beforeBlock || latestBlock + 1, 10) || latestBlock + 1, latestBlock + 1);
        const scan = await scanFinancialTransactions({
            startBlock: Math.max(beforeBlock - 1, 0),
            limit,
            maxBlocks
        });

        res.json({
            transactions: scan.transactions,
            nextBeforeBlock: scan.nextBeforeBlock,
            scannedBlocks: scan.scannedBlocks,
            status: 'Synced'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/blocks', (req, res) => {
    try {
        const state = db.getSyncState('blocks');
        res.json({ blocks: db.getRecentBlocks(200), lastSync: state.lastSync || 0, status: state.status || 'Initializing' });
    } catch (err) { res.status(500).json({ blocks: [], status: 'Error', error: err.message }); }
});
app.get('/api/events', (req, res) => {
    try {
        const state = db.getSyncState('events');
        res.json({ events: db.getRecentEvents(500), lastSync: state.lastSync || 0, status: state.status || 'Initializing' });
    } catch (err) { res.status(500).json({ events: [], status: 'Error', error: err.message }); }
});

// --- DETAIL ENDPOINTS (Restored) ---
app.get('/api/block/:id', async (req, res) => {
    try {
        const id = req.params.id.trim();
        let hash = id;
        if (/^\d+$/.test(id)) hash = await globalApi.rpc.chain.getBlockHash(parseInt(id));
        const signedBlock = await globalApi.rpc.chain.getBlock(hash);
        if (!signedBlock) return res.status(404).json({ error: "Block not found" });

        const timestamp = getBlockTimestamp(signedBlock);

        res.json({
            hash: signedBlock.block.header.hash.toHex(),
            date: timestamp,
            block: signedBlock.toHuman().block
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/extrinsic/:block/:txHash', async (req, res) => {
    try {
        const blockId = req.params.block.trim();
        const txHash = req.params.txHash.trim();
        let hash = blockId;
        if (/^\d+$/.test(blockId)) hash = await globalApi.rpc.chain.getBlockHash(parseInt(blockId));

        const signedBlock = await globalApi.rpc.chain.getBlock(hash);
        if (!signedBlock) return res.status(404).json({ error: "Block not found" });

        const extrinsics = signedBlock.block.extrinsics;
        let extIndex = -1;
        let targetExt = null;
        for (let i = 0; i < extrinsics.length; i++) {
            if (extrinsics[i].hash.toHex() === txHash) { extIndex = i; targetExt = extrinsics[i]; break; }
        }
        if (!targetExt) return res.status(404).json({ error: "Extrinsic not found in block" });

        const allEvents = await globalApi.query.system.events.at(hash);
        const txEvents = allEvents.filter(record => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === extIndex);

        const timestamp = getBlockTimestamp(signedBlock);
        const status = getExtrinsicStatus(allEvents, extIndex);
        const summary = getExtrinsicAmountSummary(targetExt);

        res.json({
            hash: txHash,
            block: signedBlock.block.header.number.toNumber(),
            time: timestamp,
            event: `${targetExt.method.section} -> ${targetExt.method.method}`,
            from: targetExt.isSigned ? targetExt.signer.toString() : "System",
            to: summary.to,
            amount: summary.amount,
            status: status,
            extrinsic: targetExt.toHuman(),
            events: txEvents.map(e => e.toHuman().event)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/validator/:address', async (req, res) => {
    try {
        const address = req.params.address.trim();

        let identity = await getIdentity(globalApi, address);
        let controller = address;
        if (globalApi) {
            const bondedOpt = await globalApi.query.staking.bonded(address);
            if (bondedOpt && bondedOpt.isSome) controller = bondedOpt.unwrap().toString();
        }

        let history = db.getValidatorHistory(address);
        let triggers = db.getValidatorTriggers(address);

        if (history.length < VALIDATOR_HISTORY_ERAS) {
            const loadedHistory = await loadValidatorHistory(address);
            history = loadedHistory.history;
            triggers = loadedHistory.triggers.slice().sort((a, b) => b.era - a.era);
        }

        res.json({ address: address, identity: identity, controller: controller, history: history, triggers: triggers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search/:query', async (req, res) => {
    const q = req.params.query.trim();
    if (!globalApi) return res.status(500).json({ error: 'API not ready' });
    try {
        if (/^\d+$/.test(q)) {
            const hash = await globalApi.rpc.chain.getBlockHash(parseInt(q));
            if (hash && !hash.isEmpty) {
                const derivedBlock = await globalApi.derive.chain.getBlock(hash);
                if (derivedBlock) return res.json({ type: 'block', data: { number: parseInt(q), hash: hash.toHex(), authorAddress: derivedBlock.author ? derivedBlock.author.toString() : "System", extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0 } });
            }
        }
        if (q.startsWith('0x') && q.length === 66) {
            try {
                const derivedBlock = await globalApi.derive.chain.getBlock(q);
                if (derivedBlock) return res.json({ type: 'block', data: { number: derivedBlock.block.header.number.toNumber(), hash: q, authorAddress: derivedBlock.author ? derivedBlock.author.toString() : "System", extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0 } });
            } catch (e) { }
        }
        try {
            const accountInfo = await globalApi.query.system.account(q);
            const name = await getIdentity(globalApi, q);
            const free = Number(accountInfo.data.free) / 10 ** 12;
            const reserved = Number(accountInfo.data.reserved) / 10 ** 12;
            if (free > 0 || reserved > 0 || name !== "Unknown") return res.json({ type: 'account', data: { address: q, name: name, balance: free + reserved, free: free, reserved: reserved } });
        } catch (e) { }
        res.status(404).json({ error: 'No exact deep network match found.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/account/:address', async (req, res) => {
    const address = req.params.address.trim();
    if (!globalApi) return res.status(500).json({ error: 'API not ready' });
    try {
        const accountInfo = await globalApi.query.system.account(address);
        const name = await getIdentity(globalApi, address);
        const free = Number(accountInfo.data.free) / 10 ** 12;
        const reserved = Number(accountInfo.data.reserved) / 10 ** 12;

        let txs = [], evs = [], rank = "0";
        try {
            const holderRank = db.getHolderRank(address);
            if (holderRank) rank = holderRank.toString();
            txs = db.getTransactionsByAddress(address, 200);
            evs = db.getEventsByAddress(address, 200);
        } catch (e) { }

        res.json({ account: address, display: name, balanceTotal: free + reserved, balanceFree: free, balanceFrozen: reserved, roles: "User", rank: rank, transactions: txs, events: evs, status: 'Synced' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- STAKING REWARDS ENDPOINTS ---
app.get('/api/staking-rewards-status', (req, res) => {
    try {
        const s = db.getSyncState('staking_rewards');
        res.json({
            latestScannedBlock: s.latestScannedBlock || 0,
            oldestScannedBlock: s.oldestScannedBlock || 0,
            backfillComplete: !!s.backfillComplete,
            addressesIndexed: db.countStakingRewardStashes(),
            totalRewardsIndexed: db.countStakingRewards(),
            lastSync: s.lastSync || 0,
            status: s.status || 'Initializing'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/staking-rewards/:address', async (req, res) => {
    const raw = (req.params.address || '').trim();
    if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex wallet address.' });
    let address;
    try { address = normalizeAddress(raw); }
    catch (e) { return res.status(400).json({ error: 'Invalid Polkadex wallet address.' }); }

    try {
        const claimed = db.getStakingRewards(address).map(r => ({
            era: r.era, amount: r.amount, validator: r.validator, block: r.block,
            blockHash: r.blockHash, eventIndex: r.eventIndex, timestamp: r.timestamp, status: 'claimed'
        }));
        const unclaimed = db.getUnclaimed(address).map(r => ({
            era: r.era, amount: r.amount, validator: r.validator || null, block: null,
            blockHash: null, eventIndex: null, timestamp: null, status: 'unclaimed'
        }));

        // Unpaid rewards are computed on demand; refresh in the background when stale.
        const unclaimedAt = db.getUnclaimedComputedAt(address);
        const unclaimedFresh = unclaimedAt > Date.now() - UNCLAIMED_TTL;
        if (!unclaimedFresh && !computingUnclaimed.has(address)) recomputeUnclaimed(address);

        let identity = 'Unknown';
        try { identity = await getIdentity(globalApi, address); } catch (e) { }

        const claimedTotal = claimed.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
        const unclaimedTotal = unclaimed.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
        const eraSet = new Set([...claimed, ...unclaimed].filter(r => r.era != null).map(r => r.era));
        const newest = claimed.length ? claimed[0] : null;
        const oldest = claimed.length ? claimed[claimed.length - 1] : null;
        const syncState = db.getSyncState('staking_rewards');

        res.json({
            address,
            identity,
            claimed,
            unclaimed,
            summary: {
                claimedTotal,
                claimedCount: claimed.length,
                unclaimedTotal,
                unclaimedCount: unclaimed.length,
                totalAmount: claimedTotal + unclaimedTotal,
                eraCount: eraSet.size,
                firstBlock: oldest ? oldest.block : null,
                lastBlock: newest ? newest.block : null,
                firstTimestamp: oldest ? oldest.timestamp : null,
                lastTimestamp: newest ? newest.timestamp : null
            },
            unclaimedFresh,
            unclaimedComputing: !unclaimedFresh,
            index: {
                latestScannedBlock: syncState.latestScannedBlock || 0,
                oldestScannedBlock: syncState.oldestScannedBlock || 0,
                backfillComplete: !!syncState.backfillComplete,
                lastSync: syncState.lastSync || 0,
                status: syncState.status || 'Initializing'
            },
            status: syncState.status || 'Initializing'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- PRICE ENDPOINTS ---
app.get('/api/price-latest', (req, res) => {
    try {
        const state = db.getSyncState('price');
        res.json({ price: db.getLatestPrice(), lastSync: state.lastSync || 0, status: state.status || 'Initializing', configured: !!CMC_API_KEY });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/price-history', (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
        const since = Date.now() - days * 24 * 60 * 60 * 1000;
        res.json({ history: db.getPriceHistory(since), latest: db.getLatestPrice(), configured: !!CMC_API_KEY });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- WALLET DASHBOARD ENDPOINT ---
app.get('/api/council', (req, res) => {
    try {
        const data = db.getKv('council') || { members: [], runnersUp: [], candidates: [], motions: [], blocksRemaining: 0, termDuration: 0, desiredMembers: 0, desiredRunnersUp: 0, collectivePallet: null };
        res.json(data);
    } catch (err) {
        console.error('API Error /api/council:', err);
        res.status(500).json({ error: 'Failed to fetch council data' });
    }
});

app.get('/api/treasury', (req, res) => {
    try {
        const data = db.getKv('treasury') || { 
            proposals: [], 
            approvals: [], 
            spendPeriod: 0, 
            burn: 0, 
            blocksRemaining: 0, 
            spendableFunds: 0,
            proposalCount: 0
        };
        res.json(data);
    } catch (err) {
        console.error('API Error /api/treasury:', err);
        res.status(500).json({ error: 'Failed to fetch treasury data' });
    }
});

app.get('/api/democracy', (req, res) => {
    try {
        const meta = db.getKv('democracy_meta') || {};
        const state = db.getSyncState('democracy');
        res.json({
            referendumCount: meta.referendumCount || 0,
            publicPropCount: meta.publicPropCount || 0,
            activeReferenda: meta.activeReferenda || 0,
            activeProposals: meta.activeProposals || 0,
            launchPeriod: meta.launchPeriod || 0,
            currentBlock: meta.currentBlock || 0,
            lowestUnbaked: meta.lowestUnbaked || 0,
            totalIssuance: meta.totalIssuance || 0,
            publicProposals: meta.publicProposals || [],
            externalProposal: meta.externalProposal || null,
            referenda: db.getDemocracyReferenda(),
            lastSync: meta.lastSync || state.lastSync || 0,
            status: state.status || 'Initializing'
        });
    } catch (err) {
        console.error('API Error /api/democracy:', err);
        res.status(500).json({ error: 'Failed to fetch democracy data' });
    }
});

// --- DISCUSSION BOARD: wallet-signature auth ---
const AUTH_SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const AUTH_CHALLENGE_TTL = 10 * 60 * 1000;
const POST_COOLDOWN_MS = 8 * 1000;
const lastPostAt = new Map();

function challengeMessage(address, nonce) {
    return `Sign in to the Polkadex Explorer discussion board.\n\nAddress: ${address}\nNonce: ${nonce}`;
}

function getAuthAddress(req) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    const session = db.getSession(token);
    return session ? session.address : null;
}

app.post('/api/auth/challenge', (req, res) => {
    const raw = (req.body && req.body.address || '').trim();
    if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid wallet address.' });
    let address;
    try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid wallet address.' }); }
    const nonce = randomAsHex(16);
    db.setChallenge(address, nonce);
    res.json({ address, message: challengeMessage(address, nonce) });
});

app.post('/api/auth/verify', (req, res) => {
    const raw = (req.body && req.body.address || '').trim();
    const signature = (req.body && req.body.signature || '').trim();
    if (!isValidAddress(raw) || !signature) return res.status(400).json({ error: 'Invalid request.' });
    let address;
    try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid wallet address.' }); }
    const challenge = db.getChallenge(address);
    if (!challenge || Date.now() - challenge.createdAt > AUTH_CHALLENGE_TTL) {
        return res.status(400).json({ error: 'Login challenge expired — please try again.' });
    }
    const message = challengeMessage(address, challenge.nonce);
    let valid = false;
    try {
        // Browser extensions wrap raw-bytes payloads in <Bytes>…</Bytes>, so accept either form.
        valid = signatureVerify(message, signature, address).isValid
            || signatureVerify(u8aWrapBytes(message), signature, address).isValid;
    } catch (e) { valid = false; }
    if (!valid) return res.status(401).json({ error: 'Signature verification failed.' });
    db.deleteChallenge(address);
    const token = randomAsHex(24);
    db.createSession(token, address, AUTH_SESSION_TTL);
    res.json({ token, address, expiresIn: AUTH_SESSION_TTL });
});

app.post('/api/auth/logout', (req, res) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) db.deleteSession(token);
    res.json({ ok: true });
});

// --- DISCUSSION BOARD: threads + posts ---
app.get('/api/discussions', (req, res) => {
    try {
        const kind = (req.query.kind === 'proposal' || req.query.kind === 'motion') ? req.query.kind : null;
        res.json({ threads: db.getThreads(kind) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/discussions/:id', (req, res) => {
    try {
        const thread = db.getThread(req.params.id);
        if (!thread) return res.status(404).json({ error: 'Discussion thread not found.' });
        res.json({ thread, posts: db.getPosts(thread.id) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/discussions/:id/posts', async (req, res) => {
    try {
        const address = getAuthAddress(req);
        if (!address) return res.status(401).json({ error: 'Sign in with your wallet to post.' });
        const thread = db.getThread(req.params.id);
        if (!thread) return res.status(404).json({ error: 'Discussion thread not found.' });
        if (thread.status === 'closed') return res.status(403).json({ error: 'This discussion is closed.' });

        const content = (req.body && req.body.content || '').trim();
        if (!content) return res.status(400).json({ error: 'Post content is required.' });
        if (content.length > 4000) return res.status(400).json({ error: 'Post is too long (4000 character limit).' });

        const now = Date.now();
        if (now - (lastPostAt.get(address) || 0) < POST_COOLDOWN_MS) {
            return res.status(429).json({ error: 'You are posting too quickly — please wait a moment.' });
        }
        lastPostAt.set(address, now);

        let authorName = 'Unknown';
        try { authorName = await getIdentity(globalApi, address); } catch (e) { }
        db.createPost({ threadId: thread.id, author: address, authorName, content });
        res.json({ thread: db.getThread(thread.id), posts: db.getPosts(thread.id) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auto-create one discussion thread per active item and close threads whose
// underlying proposal/motion has moved on (to voting, or concluded).
function reconcileProposalThreads(publicProposals) {
    const activeIds = new Set();
    for (const p of (publicProposals || [])) {
        const id = `proposal-${p.index}`;
        activeIds.add(id);
        db.createThreadIfMissing({ id, kind: 'proposal', refKey: String(p.index), title: `Public Proposal #${p.index}` });
    }
    for (const openId of db.getOpenThreadIds('proposal')) {
        if (!activeIds.has(openId)) db.closeThread(openId, 'Proposal tabled and moved to a referendum (voting).');
    }
}

function reconcileMotionThreads(motions) {
    const activeIds = new Set();
    for (const m of (motions || [])) {
        const id = `motion-${m.hash}`;
        activeIds.add(id);
        db.createThreadIfMissing({ id, kind: 'motion', refKey: m.hash, title: m.title || 'Council Motion' });
    }
    for (const openId of db.getOpenThreadIds('motion')) {
        if (!activeIds.has(openId)) db.closeThread(openId, 'Council motion concluded.');
    }
}

app.get('/api/wallet/:address', async (req, res) => {
    const raw = (req.params.address || '').trim();
    if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex wallet address.' });
    if (!globalApi) return res.status(503).json({ error: 'API not ready' });
    let address;
    try { address = normalizeAddress(raw); }
    catch (e) { return res.status(400).json({ error: 'Invalid Polkadex wallet address.' }); }

    try {
        const [accountInfo, identity, bondedOpt, nominatorsOpt, activeEraOpt, sessionValidators] = await Promise.all([
            globalApi.query.system.account(address),
            getIdentity(globalApi, address),
            globalApi.query.staking.bonded(address),
            globalApi.query.staking.nominators(address),
            globalApi.query.staking.activeEra(),
            globalApi.query.session.validators()
        ]);
        const free = balanceToPDEX(accountInfo.data.free);
        const reserved = balanceToPDEX(accountInfo.data.reserved);

        // Bonded ledger (total staked).
        let totalStaked = 0, activeStaked = 0, unlocking = 0;
        const controller = (bondedOpt && bondedOpt.isSome) ? bondedOpt.unwrap().toString() : address;
        try {
            const ledgerOpt = await globalApi.query.staking.ledger(controller);
            if (ledgerOpt && ledgerOpt.isSome) {
                const ledger = ledgerOpt.unwrap();
                totalStaked = balanceToPDEX(ledger.total);
                activeStaked = balanceToPDEX(ledger.active);
                for (const u of (ledger.unlocking || [])) unlocking += balanceToPDEX(u.value);
            }
        } catch (e) { }

        // My validators (nomination targets).
        let nominating = [];
        if (nominatorsOpt && nominatorsOpt.isSome) {
            const targets = nominatorsOpt.unwrap().targets.map(t => t.toString());
            nominating = await Promise.all(targets.map(async t => ({ address: t, name: await getIdentity(globalApi, t) })));
        }
        const sessionValAddrs = sessionValidators.map(v => v.toString());

        // Rewards from the local index; trigger an unpaid-reward refresh if stale.
        const claimed = db.getStakingRewards(address);
        const claimedTotal = claimed.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const unclaimed = db.getUnclaimed(address);
        const unpaidTotal = unclaimed.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const unclaimedAt = db.getUnclaimedComputedAt(address);
        const unclaimedFresh = unclaimedAt > Date.now() - UNCLAIMED_TTL;
        if (!unclaimedFresh && !computingUnclaimed.has(address)) recomputeUnclaimed(address);

        // Network staking parameters.
        const networkData = await getNetworkInfo().catch(() => null);
        const ni = networkData ? networkData.networkInfo : null;
        let minStake = 0;
        try { minStake = balanceToPDEX(await globalApi.query.staking.minNominatorBond()); } catch (e) { }
        const constNumber = c => { try { return c != null ? Number(c.toString()) : 0; } catch (e) { return 0; } };
        const staking = globalApi.consts.staking || {};
        const babe = globalApi.consts.babe || {};
        const sessionsPerEra = constNumber(staking.sessionsPerEra);
        const bondingDuration = constNumber(staking.bondingDuration);
        const epochDuration = constNumber(babe.epochDuration);
        const blockTime = constNumber(babe.expectedBlockTime);
        const eraDurationMs = (sessionsPerEra && epochDuration && blockTime) ? sessionsPerEra * epochDuration * blockTime : 0;

        res.json({
            address,
            identity,
            balance: { free, reserved, total: free + reserved },
            staking: {
                isStaker: totalStaked > 0,
                isValidator: sessionValAddrs.includes(address),
                isNominator: nominating.length > 0,
                totalStaked,
                activeStaked,
                unlocking,
                nominating
            },
            rewards: {
                claimedTotal,
                claimedCount: claimed.length,
                unpaidTotal,
                unpaidCount: unclaimed.length,
                unclaimedFresh,
                recentClaimed: claimed.slice(0, 10)
            },
            recentTransactions: db.getTransactionsByAddress(address, 10),
            network: {
                currentEra: activeEraOpt && activeEraOpt.isSome ? activeEraOpt.unwrap().index.toNumber() : 0,
                activeValidators: ni ? ni.validators.active : sessionValAddrs.length,
                totalValidators: ni ? ni.validators.total : sessionValAddrs.length,
                activeNominators: ni ? ni.nominators.active : 0,
                totalNominators: ni ? ni.nominators.total : 0,
                totalStakedNetwork: ni ? ni.totalBonding : 0,
                minStake,
                eraDurationMs,
                bondingDurationEras: bondingDuration,
                unbondingMs: eraDurationMs * bondingDuration
            },
            price: db.getLatestPrice()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- BACKGROUND CRAWLERS ---
async function syncTreasury() {
    if (!globalApi || isSyncingTreasury) return;
    isSyncingTreasury = true;
    try {
        if (!globalApi.query.treasury) {
            console.warn('Treasury sync: no treasury pallet found on this runtime.');
            db.setSyncState('treasury', { lastSync: Date.now(), status: 'Unavailable' });
            return;
        }

        const [proposalsEntries, approvalsData, currentBlockOpt, proposalCountOpt] = await Promise.all([
            globalApi.query.treasury.proposals.entries(),
            globalApi.query.treasury.approvals(),
            globalApi.query.system.number(),
            globalApi.query.treasury.proposalCount ? globalApi.query.treasury.proposalCount() : Promise.resolve({ toNumber: () => 0 })
        ]);

        const currentBlock = currentBlockOpt.toNumber();
        const spendPeriod = globalApi.consts.treasury.spendPeriod ? globalApi.consts.treasury.spendPeriod.toNumber() : 0;
        const burn = globalApi.consts.treasury.burn ? globalApi.consts.treasury.burn.toNumber() : 0;

        const progress = spendPeriod > 0 ? currentBlock % spendPeriod : 0;
        const blocksRemaining = spendPeriod > 0 ? spendPeriod - progress : 0;

        const approvedProposalIds = approvalsData.map(id => id.toNumber());

        const proposals = await Promise.all(proposalsEntries.map(async ([key, proposalOpt]) => {
            const id = key.args[0].toNumber();
            const proposal = proposalOpt.unwrap();
            const proposer = proposal.proposer.toString();
            const beneficiary = proposal.beneficiary.toString();
            
            const proposerName = await getIdentity(globalApi, proposer);
            const beneficiaryName = await getIdentity(globalApi, beneficiary);

            return {
                id,
                proposer,
                proposerName,
                beneficiary,
                beneficiaryName,
                value: balanceToPDEX(proposal.value),
                bond: balanceToPDEX(proposal.bond)
            };
        }));
        
        // Sort proposals descending by ID
        proposals.sort((a, b) => b.id - a.id);

        let spendableFunds = 0;
        if (globalApi.consts.treasury.palletId) {
            const { stringToU8a, u8aConcat } = require('@polkadot/util');
            const { encodeAddress } = require('@polkadot/util-crypto');
            const palletId = globalApi.consts.treasury.palletId.toU8a();
            const treasuryAccountU8a = u8aConcat(
                stringToU8a('modl'),
                palletId,
                new Uint8Array(32)
            ).slice(0, 32);
            const treasuryAddress = encodeAddress(treasuryAccountU8a, chainSS58);
            const accountData = await globalApi.query.system.account(treasuryAddress);
            spendableFunds = balanceToPDEX(accountData.data.free);
        }

        db.setKv('treasury', {
            proposals,
            approvals: approvedProposalIds,
            spendPeriod,
            burn,
            blocksRemaining,
            spendableFunds,
            proposalCount: proposalCountOpt.toNumber()
        });
        db.setSyncState('treasury', { lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        console.error('Error syncing treasury:', err.message);
        db.setSyncState('treasury', { lastSync: Date.now(), status: 'Error' });
    } finally {
        isSyncingTreasury = false;
    }
}

async function syncCouncil() {
    if (!globalApi || isSyncingCouncil) return;
    isSyncingCouncil = true;
    try {
        // The elections-phragmen pallet is registered under different names
        // across runtimes (elections / phragmenElection / electionsPhragmen).
        const electionsModule = ['elections', 'phragmenElection', 'electionsPhragmen']
            .find(name => globalApi.query[name] && globalApi.consts[name]);
        if (!electionsModule) {
            console.warn('Council sync: no elections pallet found on this runtime.');
            db.setSyncState('council', { lastSync: Date.now(), status: 'Unavailable' });
            return;
        }
        const electionsQuery = globalApi.query[electionsModule];
        const electionsConsts = globalApi.consts[electionsModule];

        const [membersData, runnersUpData, candidatesData, currentBlockObj] = await Promise.all([
            electionsQuery.members(),
            electionsQuery.runnersUp(),
            electionsQuery.candidates(),
            globalApi.query.system.number()
        ]);

        const currentBlock = currentBlockObj.toNumber();
        const termDuration = electionsConsts.termDuration ? electionsConsts.termDuration.toNumber() : 0;
        const desiredMembers = electionsConsts.desiredMembers ? electionsConsts.desiredMembers.toNumber() : 0;
        const desiredRunnersUp = electionsConsts.desiredRunnersUp ? electionsConsts.desiredRunnersUp.toNumber() : 0;
        const progress = termDuration > 0 ? currentBlock % termDuration : 0;
        const blocksRemaining = termDuration > 0 ? termDuration - progress : 0;
        
        const processAccountList = async (list) => {
            const arr = [];
            const items = list.toJSON() || [];
            for (const item of items) {
                let address = item;
                let stake = 0;
                if (Array.isArray(item)) {
                    address = item[0];
                    stake = balanceToPDEX(item[1]);
                } else if (item && item.who) {
                    address = item.who;
                    stake = balanceToPDEX(item.stake);
                }
                const name = await getIdentity(globalApi, address);
                arr.push({ address, name, stake });
            }
            return arr;
        };
        
        const members = await processAccountList(membersData);
        const runnersUp = await processAccountList(runnersUpData);
        const candidates = await processAccountList(candidatesData);

        // Council motions (the collective pallet). The collective is registered
        // under different names across runtimes (council / councilCollective / generalCouncil).
        const motions = [];
        let collectivePallet = null;
        for (const name of ['council', 'councilCollective', 'generalCouncil']) {
            const mod = globalApi.query[name];
            if (mod && mod.proposals && mod.proposalOf) { collectivePallet = name; break; }
        }
        if (collectivePallet) {
            const collectiveModule = globalApi.query[collectivePallet];
            try {
                const motionHashes = await collectiveModule.proposals();
                const probeAddress = members[0] ? members[0].address : null;
                for (const h of motionHashes) {
                    const hash = h.toString();
                    let section = '', method = '', args = [];
                    let lengthBound = 0;
                    // Generous defaults used as the close() weight bound when an
                    // exact estimate cannot be computed (bound only needs to be >= actual).
                    let weightRefTime = '10000000000', weightProofSize = '500000';
                    try {
                        const callOpt = await collectiveModule.proposalOf(h);
                        if (callOpt && callOpt.isSome) {
                            const call = callOpt.unwrap();
                            section = String(call.section);
                            method = String(call.method);
                            lengthBound = call.encodedLength;
                            const argMeta = (call.meta && call.meta.args) || [];
                            args = call.args.map((a, i) => {
                                let value;
                                try { value = a.toString(); } catch (e) { value = '[unprintable]'; }
                                // Cap large args (e.g. a runtime wasm blob) so the
                                // council payload stays small.
                                if (value.length > 512) value = value.slice(0, 512) + '…(truncated)';
                                return { name: argMeta[i] ? String(argMeta[i].name) : ('arg' + i), value };
                            });
                            if (probeAddress) {
                                try {
                                    const info = await globalApi.tx(call).paymentInfo(probeAddress);
                                    const w = info.weight;
                                    if (w && w.refTime !== undefined) {
                                        weightRefTime = (BigInt(w.refTime.toString()) * 2n).toString();
                                        weightProofSize = (BigInt(w.proofSize.toString()) * 2n + 32768n).toString();
                                    } else if (w) {
                                        weightRefTime = (BigInt(w.toString()) * 2n).toString();
                                    }
                                } catch (e) { /* keep generous defaults */ }
                            }
                        }
                    } catch (e) { }
                    let index = null, threshold = 0, ayes = [], nays = [], end = 0;
                    try {
                        const votingOpt = await collectiveModule.voting(h);
                        if (votingOpt && votingOpt.isSome) {
                            const v = votingOpt.unwrap();
                            index = v.index.toNumber();
                            threshold = v.threshold.toNumber();
                            ayes = v.ayes.map(a => a.toString());
                            nays = v.nays.map(a => a.toString());
                            end = v.end.toNumber();
                        }
                    } catch (e) { }
                    motions.push({
                        hash,
                        title: (section && method) ? `${section}.${method}` : 'Council Motion',
                        section, method, args,
                        index, threshold, ayes, nays, end,
                        lengthBound, weightRefTime, weightProofSize
                    });
                }
                motions.sort((a, b) => (b.index || 0) - (a.index || 0));
            } catch (e) { console.warn('Council motions skipped:', e.message); }
        }

        const councilData = {
            members,
            runnersUp,
            candidates,
            motions,
            currentBlock,
            termDuration,
            blocksRemaining,
            desiredMembers,
            desiredRunnersUp,
            pallet: electionsModule,
            collectivePallet,
            lastSync: Date.now()
        };
        
        db.setKv('council', councilData);
        db.setSyncState('council', { lastSync: Date.now(), status: 'Synced' });
        reconcileMotionThreads(motions);
    } catch (err) {
        console.error('Council sync error:', err);
    } finally {
        isSyncingCouncil = false;
    }
}

// Indexes the democracy pallet: referenda (status + vote tally), active public
// proposals, the queued external proposal, and launch-period progress.
async function syncDemocracy() {
    if (isSyncingDemocracy || !globalApi) return;
    isSyncingDemocracy = true;
    try {
        const dem = globalApi.query.democracy;
        if (!dem || !dem.referendumCount) {
            db.setSyncState('democracy', { lastSync: Date.now(), status: 'Unavailable' });
            return;
        }

        const [refCountRaw, propCountRaw, publicPropsRaw, nextExternalRaw, lowestUnbakedRaw, currentBlockRaw, totalIssuanceRaw] = await Promise.all([
            dem.referendumCount(),
            dem.publicPropCount ? dem.publicPropCount() : Promise.resolve(null),
            dem.publicProps(),
            dem.nextExternal ? dem.nextExternal() : Promise.resolve(null),
            dem.lowestUnbaked ? dem.lowestUnbaked() : Promise.resolve(null),
            globalApi.query.system.number(),
            globalApi.query.balances.totalIssuance()
        ]);

        const referendumCount = refCountRaw.toNumber();
        const publicPropCount = propCountRaw ? propCountRaw.toNumber() : 0;
        const currentBlock = currentBlockRaw.toNumber();
        const totalIssuance = balanceToPDEX(totalIssuanceRaw);
        const launchPeriod = (globalApi.consts.democracy && globalApi.consts.democracy.launchPeriod)
            ? Number(globalApi.consts.democracy.launchPeriod.toString()) : 0;

        // Active public proposals.
        const publicProposals = [];
        const propsJson = publicPropsRaw.toJSON() || [];
        for (const entry of propsJson) {
            const propIndex = Array.isArray(entry) ? entry[0] : entry;
            const proposer = Array.isArray(entry) ? entry[entry.length - 1] : null;
            let deposit = 0, seconds = 0;
            try {
                const depOpt = await dem.depositOf(propIndex);
                if (depOpt && depOpt.isSome) {
                    const depJson = depOpt.unwrap().toJSON();
                    if (Array.isArray(depJson[0])) { seconds = depJson[0].length; deposit = balanceToPDEX(depJson[1]); }
                    else { deposit = balanceToPDEX(depJson[0]); seconds = Array.isArray(depJson[1]) ? depJson[1].length : 0; }
                }
            } catch (e) { }
            let proposerName = 'Unknown';
            if (proposer) { try { proposerName = await getIdentity(globalApi, proposer); } catch (e) { } }
            publicProposals.push({ index: propIndex, proposer, proposerName, deposit, seconds });
        }

        // Current external proposal.
        let externalProposal = null;
        if (nextExternalRaw && nextExternalRaw.isSome) {
            const ext = nextExternalRaw.unwrap();
            externalProposal = {
                proposal: ext[0] ? ext[0].toString().slice(0, 66) : null,
                threshold: ext[1] ? ext[1].toString() : null
            };
        }

        // Referenda — index new/ongoing ones; finalised ones with a known tally are skipped.
        const existing = {};
        for (const r of db.getDemocracyReferenda()) existing[r.refIndex] = r;
        let activeReferenda = 0;
        for (let i = 0; i < referendumCount; i++) {
            const prev = existing[i];
            if (prev && prev.status !== 'Ongoing' && prev.tallyKnown) continue;
            let info;
            try { info = await dem.referendumInfoOf(i); } catch (e) { continue; }
            if (!info || info.isNone) continue;
            const r = info.unwrap();
            if (r.isOngoing) {
                activeReferenda++;
                const s = r.asOngoing;
                db.upsertDemocracyReferendum({
                    refIndex: i, status: 'Ongoing', endBlock: s.end.toNumber(),
                    ayes: balanceToPDEX(s.tally.ayes), nays: balanceToPDEX(s.tally.nays), turnout: balanceToPDEX(s.tally.turnout),
                    tallyKnown: 1,
                    proposal: s.proposal ? s.proposal.toString().slice(0, 66) : null,
                    threshold: s.threshold ? s.threshold.toString() : null
                });
            } else if (r.isFinished) {
                const f = r.asFinished;
                const status = f.approved.isTrue ? 'Passed' : 'NotPassed';
                const endBlock = f.end.toNumber();
                let ayes = prev ? prev.ayes : null;
                let nays = prev ? prev.nays : null;
                let turnout = prev ? prev.turnout : null;
                let tallyKnown = (prev && prev.tallyKnown) ? 1 : 0;
                // Recover the final tally from historical state (archive nodes only).
                if (!tallyKnown) {
                    try {
                        const histHash = await globalApi.rpc.chain.getBlockHash(Math.max(endBlock - 1, 0));
                        const histInfo = await dem.referendumInfoOf.at(histHash, i);
                        if (histInfo && histInfo.isSome && histInfo.unwrap().isOngoing) {
                            const hs = histInfo.unwrap().asOngoing;
                            ayes = balanceToPDEX(hs.tally.ayes);
                            nays = balanceToPDEX(hs.tally.nays);
                            turnout = balanceToPDEX(hs.tally.turnout);
                            tallyKnown = 1;
                        }
                    } catch (e) { /* node is not an archive — tally remains unknown */ }
                }
                db.upsertDemocracyReferendum({
                    refIndex: i, status, endBlock, ayes, nays, turnout, tallyKnown,
                    proposal: prev ? prev.proposal : null, threshold: prev ? prev.threshold : null
                });
            }
        }

        reconcileProposalThreads(publicProposals);

        db.setKv('democracy_meta', {
            referendumCount, publicPropCount, launchPeriod, currentBlock, totalIssuance,
            lowestUnbaked: lowestUnbakedRaw ? lowestUnbakedRaw.toNumber() : 0,
            activeReferenda, activeProposals: publicProposals.length,
            publicProposals, externalProposal, lastSync: Date.now()
        });
        db.setSyncState('democracy', { lastSync: Date.now(), status: 'Synced' });
        console.log(`Democracy indexer: ${referendumCount} referenda, ${publicProposals.length} active proposals.`);
    } catch (err) {
        console.error('Democracy sync error:', err);
        db.setSyncState('democracy', { ...db.getSyncState('democracy'), status: 'Error', error: err.message });
    } finally {
        isSyncingDemocracy = false;
    }
}

async function syncData() {
    if (isSyncing || !globalApi) return;
    isSyncing || (isSyncing = true);
    try {
        console.log("Starting validator indexer sync...");
        const activeEraOption = await globalApi.query.staking.activeEra();
        const activeEra = activeEraOption.isSome ? activeEraOption.unwrap().index.toNumber() : 0;
        const validators = await globalApi.query.session.validators();
        const validatorData = [];

        for (const address of validators) {
            const addrStr = address.toString();
            const name = await getIdentity(globalApi, address);
            const [totalStake, prefs] = await Promise.all([
                getEraValidatorStake(globalApi, activeEra, address),
                globalApi.query.staking.validators(address)
            ]);
            const commissionPct = getCommissionPercent(prefs);
            const currentApy = 23.09 * (1 - (commissionPct / 100));

            validatorData.push({ address: addrStr, name: name, totalStake: formatPDEX(totalStake), commission: commissionPct, realApy: currentApy, avg30DayApy: currentApy });
        }
        await syncValidatorHistory(activeEra, validators);
        db.replaceValidators(validatorData, { totalCount: validators.length, lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        console.error("Validator sync error:", err);
        db.setSyncState('validators', { ...db.getSyncState('validators'), status: 'Error', error: err.message });
    } finally { isSyncing = false; }
}

async function syncHolders() {
    if (isSyncingHolders || !globalApi) return;
    isSyncingHolders = true;
    try {
        console.log("Starting holder indexer sync...");
        const entries = await globalApi.query.system.account.entries();
        const totalIssuance = formatPDEX(await globalApi.query.balances.totalIssuance());
        const balances = entries.map(([key, data]) => ({ address: key.args[0].toString(), free: Number(data.data.free) / 10 ** 12, reserved: Number(data.data.reserved) / 10 ** 12 }))
            .sort((a, b) => (b.free + b.reserved) - (a.free + a.reserved));

        const topHolders = balances.slice(0, 500);
        const holderData = [];
        for (let i = 0; i < topHolders.length; i++) {
            const h = topHolders[i];
            const name = await getIdentity(globalApi, h.address);
            const total = h.free + h.reserved;
            holderData.push({ rank: i + 1, address: h.address, name: name, balance: total, share: (total / totalIssuance) * 100 });
        }
        db.replaceHolders(holderData, { totalCount: entries.length, lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        console.error("Holder sync error:", err);
        db.setSyncState('holders', { ...db.getSyncState('holders'), status: 'Error', error: err.message });
    } finally { isSyncingHolders = false; }
}

async function syncBlocks() {
    if (isSyncingBlocks || !globalApi) return;
    isSyncingBlocks = true;
    try {
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newBlocks = [];

        while (blocksSearched < 50) {
            try {
                const derivedBlock = await globalApi.derive.chain.getBlock(currentHash);
                if (!derivedBlock) break;
                const blockNumber = derivedBlock.block.header.number.toNumber();
                if (db.hasBlock(blockNumber)) break;
                const timestamp = getBlockTimestamp(derivedBlock);
                const authorAddr = derivedBlock.author ? derivedBlock.author.toString() : "System";
                newBlocks.push({ number: blockNumber, hash: derivedBlock.block.header.hash.toHex(), authorAddress: authorAddr, authorName: await getIdentity(globalApi, authorAddr), extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0, timestamp: timestamp });
                currentHash = derivedBlock.block.header.parentHash;
            } catch (e) {
                console.warn("Block crawler stopped early:", e.message);
                break;
            }
            blocksSearched++;
        }
        db.insertBlocks(newBlocks);
        db.setSyncState('blocks', { lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        console.error("Block sync error:", err);
        db.setSyncState('blocks', { ...db.getSyncState('blocks'), status: 'Error', error: err.message });
    } finally { isSyncingBlocks = false; }
}

async function syncTransactions() {
    if (isSyncingTx || !globalApi) return;
    isSyncingTx = true;
    try {
        const state = db.getSyncState('transactions');
        const latestHeader = await globalApi.rpc.chain.getHeader();
        const latestBlock = latestHeader.number.toNumber();
        const latestScannedBlock = Number(state.latestScannedBlock) || 0;
        const needsInitialCrawl = latestScannedBlock === 0 || state.scannerVersion !== FINANCIAL_TX_SCANNER_VERSION;
        const previousScannedBlocks = Number(state.scannedBlocks) || 0;
        let scan = { transactions: [], scannedBlocks: 0, oldestScannedBlock: Number(state.oldestScannedBlock) || 0 };

        db.setSyncState('transactions', { ...state, status: 'Syncing' });

        if (needsInitialCrawl) {
            scan = await scanFinancialTransactions({
                startBlock: latestBlock,
                limit: Number.MAX_SAFE_INTEGER,
                maxBlocks: TX_INITIAL_SCAN_BLOCKS,
                onProgress: progress => { db.insertTransactions(progress.transactions); }
            });
        } else if (latestBlock > latestScannedBlock) {
            scan = await scanFinancialTransactions({
                startBlock: latestBlock,
                stopBlock: latestScannedBlock + 1,
                limit: Number.MAX_SAFE_INTEGER,
                maxBlocks: latestBlock - latestScannedBlock
            });
        }

        db.insertTransactions(scan.transactions);
        db.setSyncState('transactions', {
            lastSync: Date.now(),
            status: 'Synced',
            latestScannedBlock: latestBlock,
            oldestScannedBlock: needsInitialCrawl ? scan.oldestScannedBlock : (Number(state.oldestScannedBlock) || latestScannedBlock),
            scannedBlocks: previousScannedBlocks + scan.scannedBlocks,
            scannerVersion: FINANCIAL_TX_SCANNER_VERSION
        });
    } catch (err) {
        console.error("Transaction sync error:", err);
        db.setSyncState('transactions', { ...db.getSyncState('transactions'), status: 'Error', error: err.message });
    } finally { isSyncingTx = false; }
}

async function syncEvents() {
    if (isSyncingEvents || !globalApi) return;
    isSyncingEvents = true;
    try {
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newEvents = [];

        while (blocksSearched < 50) {
            try {
                const signedBlock = await globalApi.rpc.chain.getBlock(currentHash);
                const allEvents = await globalApi.query.system.events.at(currentHash);
                const blockNumber = signedBlock.block.header.number.toNumber();
                const timestamp = getBlockTimestamp(signedBlock);
                const blockHash = signedBlock.block.header.hash.toHex();

                for (let eventIndex = 0; eventIndex < allEvents.length; eventIndex++) {
                    const record = allEvents[eventIndex];
                    const eventId = `${blockHash}-${eventIndex}`;

                    const extrinsicIndex = record.phase.isApplyExtrinsic ? record.phase.asApplyExtrinsic.toNumber() : null;
                    const extrinsic = extrinsicIndex !== null ? signedBlock.block.extrinsics[extrinsicIndex] : null;
                    const signerAddress = extrinsic && extrinsic.isSigned ? extrinsic.signer.toString() : "System";
                    const txHash = extrinsic ? extrinsic.hash.toHex() : "";
                    const status = record.event.section === 'system' && record.event.method === 'ExtrinsicFailed' ? 'failed' : 'success';
                    const signerName = signerAddress !== "System" ? await getIdentity(globalApi, signerAddress) : "System";

                    newEvents.push({
                        hash: eventId,
                        txHash,
                        blockHash,
                        block: blockNumber,
                        eventIndex,
                        extrinsicIndex,
                        section: record.event.section,
                        method: record.event.method,
                        data: record.event.data.toHuman(),
                        signerAddress,
                        signerName,
                        timestamp,
                        status
                    });
                    }
                currentHash = signedBlock.block.header.parentHash;
            } catch (e) {
                console.warn("Event crawler stopped early:", e.message);
                break;
            }
            blocksSearched++;
        }
        db.insertEvents(newEvents);
        db.setSyncState('events', { lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        console.error("Event sync error:", err);
        db.setSyncState('events', { ...db.getSyncState('events'), status: 'Error', error: err.message });
    } finally { isSyncingEvents = false; }
}

// --- STAKING REWARDS INDEXER ---
// Indexes claimed staking payouts by scanning blocks for staking.Rewarded
// (and legacy staking.Reward) events. Each crawl appends newly discovered
// rewards to a per-address local index, building a full history over time.

// Parse a staking reward event into { stash, amount } or null.
function parseRewardedEvent(record) {
    const event = record.event;
    if (event.section !== 'staking') return null;
    if (event.method !== 'Rewarded' && event.method !== 'Reward') return null;

    const data = event.data;
    const names = data.names || null;
    let stash = null;
    let amount = null;

    if (names && names.length === data.length) {
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            if (stash === null && (name === 'stash' || name === 'account' || name === 'who' || name === 'validatorStash')) {
                stash = data[i].toString();
            }
            if (name === 'amount' || name === 'value') amount = data[i];
        }
    }
    // Positional fallback for runtimes that emit unnamed event fields.
    if (stash === null && data.length >= 1) stash = data[0].toString();
    if (amount === null && data.length >= 2) amount = data[data.length - 1];
    if (stash === null || amount === null) return null;

    return { stash, amount: balanceToPDEX(amount) };
}

// Best-effort extraction of { era, validator } from a call, following
// utility.batch* and proxy.proxy wrappers around staking.payoutStakers.
function findPayoutInfo(call, depth = 0) {
    if (!call || depth > 4) return { era: null, validator: null };
    const section = call.section;
    const method = call.method;

    if (section === 'staking' && (method === 'payoutStakers' || method === 'payoutStakersByPage')) {
        const args = call.args || [];
        const validator = args[0] != null ? args[0].toString() : null;
        let era = null;
        if (args[1] != null) {
            const parsed = Number(args[1].toString());
            if (Number.isFinite(parsed)) era = parsed;
        }
        return { era, validator };
    }
    if (section === 'utility' && ['batch', 'batchAll', 'forceBatch'].includes(method)) {
        const inner = call.args && call.args[0];
        if (inner && inner.length) {
            for (const sub of inner) {
                const result = findPayoutInfo(sub, depth + 1);
                // A batch can pay several validators in one era; only trust the
                // validator field when the batch holds a single call.
                if (result.era != null) {
                    return { era: result.era, validator: inner.length === 1 ? result.validator : null };
                }
            }
        }
        return { era: null, validator: null };
    }
    if (section === 'proxy' && method === 'proxy' && call.args && call.args.length >= 3) {
        return findPayoutInfo(call.args[2], depth + 1);
    }
    return { era: null, validator: null };
}

function extractPayoutInfo(extrinsic) {
    if (!extrinsic || !extrinsic.method) return { era: null, validator: null };
    try { return findPayoutInfo(extrinsic.method); }
    catch (e) { return { era: null, validator: null }; }
}

// Scan a single block; returns an array of reward records (usually empty).
async function scanBlockForRewards(blockNumber) {
    try {
        const blockHash = await globalApi.rpc.chain.getBlockHash(blockNumber);
        const events = await globalApi.query.system.events.at(blockHash);

        const hits = [];
        events.forEach((record, eventIndex) => {
            const parsed = parseRewardedEvent(record);
            if (parsed) hits.push({ record, parsed, eventIndex });
        });
        if (hits.length === 0) return [];

        // Only fetch the full block (for era/validator context) when the block
        // actually contains payouts — most blocks do not.
        const [signedBlock, timestamp] = await Promise.all([
            globalApi.rpc.chain.getBlock(blockHash),
            getBlockTimestampAt(blockHash)
        ]);
        const blockHashHex = blockHash.toHex();

        return hits.map(({ record, parsed, eventIndex }) => {
            let era = null;
            let validator = null;
            if (record.phase.isApplyExtrinsic) {
                const exIndex = record.phase.asApplyExtrinsic.toNumber();
                const info = extractPayoutInfo(signedBlock.block.extrinsics[exIndex]);
                era = info.era;
                validator = info.validator;
            }
            return {
                stash: parsed.stash,
                amount: parsed.amount,
                era,
                validator,
                block: blockNumber,
                blockHash: blockHashHex,
                eventIndex,
                timestamp
            };
        });
    } catch (err) {
        console.warn(`Staking rewards scan skipped block ${blockNumber}:`, err.message);
        return [];
    }
}

// Scan a descending block range in concurrent batches.
async function scanStakingRewards({ startBlock, stopBlock, maxBlocks }) {
    const rewards = [];
    let scannedBlocks = 0;
    let oldestScannedBlock = startBlock;

    for (let nextBlock = startBlock; nextBlock >= stopBlock && scannedBlocks < maxBlocks;) {
        const blockNumbers = [];
        while (nextBlock >= stopBlock && blockNumbers.length < STAKING_REWARDS_SCAN_BATCH && scannedBlocks + blockNumbers.length < maxBlocks) {
            blockNumbers.push(nextBlock);
            nextBlock--;
        }
        if (blockNumbers.length === 0) break;

        const batchResults = await Promise.all(blockNumbers.map(scanBlockForRewards));
        scannedBlocks += blockNumbers.length;
        oldestScannedBlock = blockNumbers[blockNumbers.length - 1];
        for (const blockRewards of batchResults) {
            for (const reward of blockRewards) rewards.push(reward);
        }
    }
    return { rewards, scannedBlocks, oldestScannedBlock };
}

// Map a scanned reward into a SQLite row with normalized addresses.
function toRewardRow(reward) {
    let stash = reward.stash;
    let validator = reward.validator;
    try { stash = normalizeAddress(reward.stash); } catch (e) { }
    if (validator) { try { validator = normalizeAddress(validator); } catch (e) { } }
    return {
        id: `${reward.block}-${reward.eventIndex}`,
        stash,
        amount: reward.amount,
        era: reward.era,
        validator: validator || null,
        block: reward.block,
        blockHash: reward.blockHash,
        eventIndex: reward.eventIndex,
        timestamp: reward.timestamp
    };
}

// Compute a stash's unpaid (unclaimed) rewards on demand via the staking
// derive and cache them in SQLite. Runs in the background, guarded per stash.
async function recomputeUnclaimed(stash) {
    if (computingUnclaimed.has(stash) || !globalApi) return;
    computingUnclaimed.add(stash);
    try {
        if (!globalApi.derive || !globalApi.derive.staking || !globalApi.derive.staking.stakerRewards) {
            db.replaceUnclaimed(stash, []);
            return;
        }
        const pending = await globalApi.derive.staking.stakerRewards(stash, false);
        const claimedKeys = new Set(db.getClaimedRewardKeys(stash).map(k => `${k.era}|${k.validator || ''}`));
        const rows = [];
        for (const entry of pending) {
            const era = entry.era && entry.era.toNumber ? entry.era.toNumber() : Number(entry.era);
            const validators = entry.validators || {};
            for (const validatorId of Object.keys(validators)) {
                const info = validators[validatorId];
                const amount = balanceToPDEX(info.value);
                if (!(amount > 0)) continue;
                let validator = validatorId;
                try { validator = normalizeAddress(validatorId); } catch (e) { }
                // Skip anything already recorded as a claimed payout (defensive).
                if (claimedKeys.has(`${era}|${validator}`)) continue;
                rows.push({ era, validator, amount });
            }
        }
        db.replaceUnclaimed(stash, rows);
        console.log(`Unclaimed rewards computed for ${stash}: ${rows.length} pending entries.`);
    } catch (err) {
        console.warn(`Unclaimed rewards computation failed for ${stash}:`, err.message);
    } finally {
        computingUnclaimed.delete(stash);
    }
}

// Poll CoinMarketCap for the live PDEX price and append it to the local price
// history. CMC's free tier only exposes the current quote, so the chart builds
// up from the moment polling begins.
async function syncPrice() {
    if (isSyncingPrice || !CMC_API_KEY) return;
    isSyncingPrice = true;
    try {
        const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(CMC_SYMBOL)}&convert=USD`;
        const resp = await fetch(url, { headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, 'Accept': 'application/json' } });
        if (!resp.ok) throw new Error(`CoinMarketCap HTTP ${resp.status}`);
        const json = await resp.json();
        const entry = json && json.data && json.data[CMC_SYMBOL];
        const quote = entry ? (Array.isArray(entry) ? entry[0] : entry) : null;
        const usd = quote && quote.quote && quote.quote.USD;
        if (!usd || typeof usd.price !== 'number') throw new Error('CoinMarketCap response missing price');
        db.insertPrice({
            timestamp: Date.now(),
            price: usd.price,
            marketCap: usd.market_cap ?? null,
            volume24h: usd.volume_24h ?? null,
            pctChange24h: usd.percent_change_24h ?? null
        });
        db.setSyncState('price', { lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        console.warn('Price sync error:', err.message);
        db.setSyncState('price', { ...db.getSyncState('price'), lastSync: Date.now(), status: 'Error', error: err.message });
    } finally {
        isSyncingPrice = false;
    }
}

// One crawl pass: index new blocks (forward) and walk a resumable chunk of
// older history (backfill). Runs once per interval and appends every time.
async function syncStakingRewards() {
    if (isSyncingStakingRewards || !globalApi) return;
    isSyncingStakingRewards = true;
    try {
        const state = db.getSyncState('staking_rewards');
        const latestHeader = await globalApi.rpc.chain.getHeader();
        const head = latestHeader.number.toNumber();

        let initialized = !!state.initialized;
        let latestScannedBlock = Number(state.latestScannedBlock) || 0;
        let oldestScannedBlock = Number(state.oldestScannedBlock) || 0;
        let backfillCursor = Number(state.backfillCursor) || 0;
        let backfillComplete = !!state.backfillComplete;

        // First run: anchor watermarks to the current head; the resumable
        // backfill pass then walks everything below it.
        if (!initialized) {
            initialized = true;
            latestScannedBlock = head;
            oldestScannedBlock = head;
            backfillCursor = head - 1;
            backfillComplete = (head - 1) < STAKING_REWARDS_MIN_BLOCK;
        }

        // FORWARD PASS — index blocks produced since the previous crawl.
        if (head > latestScannedBlock) {
            if (head - latestScannedBlock > STAKING_REWARDS_FORWARD_MAX) {
                console.warn(`Staking rewards: forward gap ${head - latestScannedBlock} exceeds cap; scanning most recent ${STAKING_REWARDS_FORWARD_MAX} blocks.`);
            }
            const forward = await scanStakingRewards({
                startBlock: head,
                stopBlock: latestScannedBlock + 1,
                maxBlocks: STAKING_REWARDS_FORWARD_MAX
            });
            db.insertStakingRewards(forward.rewards.map(toRewardRow));
            latestScannedBlock = head;
            db.setSyncState('staking_rewards', { initialized, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete, lastSync: Date.now(), status: 'Syncing' });
        }

        // BACKFILL PASS — walk one resumable chunk further down the chain.
        if (!backfillComplete) {
            if (backfillCursor >= STAKING_REWARDS_MIN_BLOCK) {
                const stopBlock = Math.max(backfillCursor - STAKING_REWARDS_BACKFILL_CHUNK + 1, STAKING_REWARDS_MIN_BLOCK);
                const backfill = await scanStakingRewards({
                    startBlock: backfillCursor,
                    stopBlock,
                    maxBlocks: STAKING_REWARDS_BACKFILL_CHUNK
                });
                db.insertStakingRewards(backfill.rewards.map(toRewardRow));
                oldestScannedBlock = Math.min(oldestScannedBlock || backfillCursor, backfill.oldestScannedBlock);
                backfillCursor = backfill.oldestScannedBlock - 1;
                if (backfillCursor < STAKING_REWARDS_MIN_BLOCK) backfillComplete = true;
            } else {
                backfillComplete = true;
            }
        }

        db.setSyncState('staking_rewards', { initialized, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete, lastSync: Date.now(), status: 'Synced' });
        console.log(`Staking rewards indexer: blocks ${oldestScannedBlock}-${latestScannedBlock}, ${db.countStakingRewards()} payouts indexed, backfill ${backfillComplete ? 'complete' : 'in progress'}.`);
    } catch (err) {
        console.error("Staking rewards sync error:", err);
        db.setSyncState('staking_rewards', { ...db.getSyncState('staking_rewards'), status: 'Error', error: err.message });
    } finally {
        isSyncingStakingRewards = false;
    }
}

async function start() {
    db.initDb(DATA_DIR);
    const wsProvider = new WsProvider('wss://so.polkadex.ee');
    globalApi = await ApiPromise.create({ provider: wsProvider });
    console.log("Connected to Polkadex RPC");
    if (globalApi.registry && globalApi.registry.chainSS58 != null) {
        chainSS58 = globalApi.registry.chainSS58;
    }

    app.listen(PORT, () => {
        console.log(`Backend indexer listening on port ${PORT}`);
    });

    syncBlocks();
    syncTransactions();
    syncEvents();
    syncData();
    syncHolders();
    syncStakingRewards();
    syncPrice();
    syncCouncil();
    syncDemocracy();

    // Recent-chain caches follow block production. Validator and holder rankings are heavier and run less often.
    setInterval(() => {
        syncBlocks();
        syncTransactions();
        syncEvents();
    }, RECENT_SYNC_INTERVAL);
    setInterval(syncHolders, THIRTY_MINUTES);
    setInterval(syncCouncil, FIVE_MINUTES);
    setInterval(syncTreasury, FIVE_MINUTES);
    setInterval(syncDemocracy, FIVE_MINUTES);
    setInterval(syncTransactions, THIRTY_SECONDS);
    // Staking rewards indexer: continuously appends new payouts each era and
    // resumably backfills older history.
    setInterval(syncStakingRewards, THIRTY_SECONDS);
    setInterval(syncPrice, PRICE_SYNC_INTERVAL);
}

start();
