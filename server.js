import express from 'express';
import cors from 'cors';
import { ApiPromise, WsProvider } from '@polkadot/api';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(cors());

// Use dedicated data directory for Docker volumes
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const HOLDERS_CACHE_FILE = path.join(DATA_DIR, 'holders_cache.json');
const TX_CACHE_FILE = path.join(DATA_DIR, 'transactions_cache.json');
const BLOCKS_CACHE_FILE = path.join(DATA_DIR, 'blocks_cache.json');
const EVENTS_CACHE_FILE = path.join(DATA_DIR, 'events_cache.json');
const VALIDATOR_HISTORY_CACHE_FILE = path.join(DATA_DIR, 'validator_history_cache.json');
const ACCOUNT_CACHE_FILE = path.join(DATA_DIR, 'account_history_cache.json');
const VALIDATOR_TRIGGERS_CACHE_FILE = path.join(DATA_DIR, 'validator_triggers_cache.json');
const NETWORK_INFO_CACHE_FILE = path.join(DATA_DIR, 'network_info_cache.json');

const CACHE_DEFAULTS = new Map([
    [CACHE_FILE, { validators: [], lastSync: 0, status: 'Initializing' }],
    [HOLDERS_CACHE_FILE, { holders: [], lastSync: 0, status: 'Initializing' }],
    [TX_CACHE_FILE, { transactions: [], lastSync: 0, status: 'Initializing', latestScannedBlock: 0, oldestScannedBlock: 0, scannedBlocks: 0, scannerVersion: 0 }],
    [BLOCKS_CACHE_FILE, { blocks: [], lastSync: 0, status: 'Initializing' }],
    [EVENTS_CACHE_FILE, { events: [], lastSync: 0, status: 'Initializing' }],
    [VALIDATOR_HISTORY_CACHE_FILE, {}],
    [ACCOUNT_CACHE_FILE, { accounts: {} }],
    [VALIDATOR_TRIGGERS_CACHE_FILE, {}],
    [NETWORK_INFO_CACHE_FILE, { networkInfo: null, lastSync: 0, status: 'Initializing' }]
]);
const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const RECENT_SYNC_INTERVAL = 12 * 1000;
const TX_CACHE_LIMIT = readPositiveInteger(process.env.TX_CACHE_LIMIT, 500);
const TX_INITIAL_SCAN_BLOCKS = readPositiveInteger(process.env.TX_INITIAL_SCAN_BLOCKS, 20000);
const TX_OLDER_SCAN_BLOCKS = readPositiveInteger(process.env.TX_OLDER_SCAN_BLOCKS, TX_INITIAL_SCAN_BLOCKS);
const TX_SCAN_BATCH_SIZE = readPositiveInteger(process.env.TX_SCAN_BATCH_SIZE, 25);
const FINANCIAL_TX_SCANNER_VERSION = 2;
const VALIDATOR_HISTORY_ERAS = readPositiveInteger(process.env.VALIDATOR_HISTORY_ERAS, 30);
const DISPLAY_NAME_OVERRIDES = new Map([
    ['esoEt6uZ9vs23yW8aqTACLf1tViGpSLZKnhPXt5Nq7vQwHGew', 'Polkadex Treasury'],
    ['esm4teFDTrvy4VJ8msKTQmAywumeinGjzsrFzmTEB5FBiiekE', 'Gate.IO']
]);

let isSyncing = false;
let isSyncingHolders = false;
let isSyncingTx = false;
let isSyncingBlocks = false;
let isSyncingEvents = false;
let isCrawlingAccount = {};
let globalApi = null;
const identityCache = new Map();

function readPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Ensure cache exists
async function initCache() {
    try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) { }
    for (const [file, defaultData] of CACHE_DEFAULTS) {
        await readJsonCache(file, defaultData);
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCacheData(data, defaultData) {
    const normalized = isPlainObject(data) ? { ...data } : {};
    for (const [key, fallback] of Object.entries(defaultData)) {
        if (Array.isArray(fallback)) {
            normalized[key] = Array.isArray(normalized[key]) ? normalized[key] : [...fallback];
        } else if (isPlainObject(fallback)) {
            normalized[key] = isPlainObject(normalized[key]) ? normalized[key] : { ...fallback };
        } else if (normalized[key] === undefined) {
            normalized[key] = fallback;
        }
    }
    return normalized;
}

async function readJsonCache(file, defaultData) {
    let data = defaultData;
    let needsWrite = false;
    try {
        data = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
        needsWrite = true;
    }

    const normalized = normalizeCacheData(data, defaultData);
    if (JSON.stringify(normalized) !== JSON.stringify(data)) needsWrite = true;
    if (needsWrite) await fs.writeFile(file, JSON.stringify(normalized));
    return normalized;
}

async function markCacheError(file, defaultData, err) {
    const cacheData = await readJsonCache(file, defaultData);
    cacheData.status = 'Error';
    cacheData.error = err.message;
    await fs.writeFile(file, JSON.stringify(cacheData));
}

function formatPDEX(balance) { return Number(balance) / 10 ** 12; }

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
    const cacheData = await readJsonCache(NETWORK_INFO_CACHE_FILE, CACHE_DEFAULTS.get(NETWORK_INFO_CACHE_FILE));
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
    await fs.writeFile(NETWORK_INFO_CACHE_FILE, JSON.stringify(nextCacheData));
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

    const historyData = {};
    const triggerData = {};
    const validatorAddresses = validators.map(address => address.toString());
    const firstEra = Math.max(activeEra - VALIDATOR_HISTORY_ERAS + 1, 0);

    for (let era = activeEra; era >= firstEra; era--) {
        historyData[era] = {};
        for (const address of validators) {
            const addrStr = address.toString();
            try {
                const [prefs, totalStake] = await Promise.all([
                    globalApi.query.staking.erasValidatorPrefs(era, address),
                    getEraValidatorStake(globalApi, era, address)
                ]);
                const commission = getCommissionPercent(prefs);
                const apy = 23.09 * (1 - (commission / 100));
                historyData[era][addrStr] = {
                    commission,
                    stake: formatPDEX(totalStake),
                    apy
                };
            } catch (err) {
                console.warn(`Validator history skipped ${addrStr} era ${era}:`, err.message);
            }
        }
    }

    for (const address of validatorAddresses) {
        const rows = [];
        for (let era = firstEra; era <= activeEra; era++) {
            if (historyData[era] && historyData[era][address]) {
                rows.push({ era, ...historyData[era][address] });
            }
        }
        for (let i = 1; i < rows.length; i++) {
            const prev = rows[i - 1];
            const current = rows[i];
            if (prev.commission <= 50 && current.commission > 50) {
                if (!triggerData[address]) triggerData[address] = [];
                triggerData[address].push({
                    era: current.era,
                    prevCommission: prev.commission,
                    newCommission: current.commission,
                    timestamp: Date.now()
                });
            }
        }
    }

    await Promise.all([
        fs.writeFile(VALIDATOR_HISTORY_CACHE_FILE, JSON.stringify(historyData)),
        fs.writeFile(VALIDATOR_TRIGGERS_CACHE_FILE, JSON.stringify(triggerData))
    ]);
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
    const [historyData, triggersCache] = await Promise.all([
        readJsonCache(VALIDATOR_HISTORY_CACHE_FILE, CACHE_DEFAULTS.get(VALIDATOR_HISTORY_CACHE_FILE)),
        readJsonCache(VALIDATOR_TRIGGERS_CACHE_FILE, CACHE_DEFAULTS.get(VALIDATOR_TRIGGERS_CACHE_FILE))
    ]);
    for (const row of history) {
        if (!historyData[row.era]) historyData[row.era] = {};
        historyData[row.era][address] = {
            commission: row.commission,
            stake: row.stake,
            apy: row.apy
        };
    }
    triggersCache[address] = triggers;
    await Promise.all([
        fs.writeFile(VALIDATOR_HISTORY_CACHE_FILE, JSON.stringify(historyData)),
        fs.writeFile(VALIDATOR_TRIGGERS_CACHE_FILE, JSON.stringify(triggersCache))
    ]);

    return { history, triggers };
}

// --- FALLBACK LIST ENDPOINTS ---
app.get('/api/validators', async (req, res) => { try { res.json(await readJsonCache(CACHE_FILE, CACHE_DEFAULTS.get(CACHE_FILE))); } catch (err) { res.json(CACHE_DEFAULTS.get(CACHE_FILE)); } });
app.get('/api/network-info', async (req, res) => {
    try {
        res.json(await getNetworkInfo());
    } catch (err) {
        const cacheData = await readJsonCache(NETWORK_INFO_CACHE_FILE, CACHE_DEFAULTS.get(NETWORK_INFO_CACHE_FILE));
        res.json({ ...cacheData, status: 'Error', error: err.message });
    }
});
app.get('/api/holders', async (req, res) => {
    try {
        const cacheData = await readJsonCache(HOLDERS_CACHE_FILE, CACHE_DEFAULTS.get(HOLDERS_CACHE_FILE));
        cacheData.holders = await applyDisplayNameOverridesToHolders(cacheData.holders);
        res.json(cacheData);
    } catch (err) { res.json(CACHE_DEFAULTS.get(HOLDERS_CACHE_FILE)); }
});
app.get('/api/transactions', async (req, res) => {
    try {
        const cacheData = await readJsonCache(TX_CACHE_FILE, CACHE_DEFAULTS.get(TX_CACHE_FILE));
        cacheData.transactions = getCachedFinancialTransactions(cacheData);
        res.json(cacheData);
    } catch (err) { res.json(CACHE_DEFAULTS.get(TX_CACHE_FILE)); }
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
app.get('/api/blocks', async (req, res) => { try { res.json(await readJsonCache(BLOCKS_CACHE_FILE, CACHE_DEFAULTS.get(BLOCKS_CACHE_FILE))); } catch (err) { res.json(CACHE_DEFAULTS.get(BLOCKS_CACHE_FILE)); } });
app.get('/api/events', async (req, res) => { try { res.json(await readJsonCache(EVENTS_CACHE_FILE, CACHE_DEFAULTS.get(EVENTS_CACHE_FILE))); } catch (err) { res.json(CACHE_DEFAULTS.get(EVENTS_CACHE_FILE)); } });

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
        let historyData = {};
        try { historyData = await readJsonCache(VALIDATOR_HISTORY_CACHE_FILE, CACHE_DEFAULTS.get(VALIDATOR_HISTORY_CACHE_FILE)); } catch (e) { }

        let identity = await getIdentity(globalApi, address);
        let controller = address;
        if (globalApi) {
            const bondedOpt = await globalApi.query.staking.bonded(address);
            if (bondedOpt && bondedOpt.isSome) controller = bondedOpt.unwrap().toString();
        }

        const eras = Object.keys(historyData).map(Number).sort((a, b) => b - a);
        const history = [];
        for (const era of eras) {
            if (historyData[era] && historyData[era][address]) {
                history.push({ era: era, commission: historyData[era][address].commission, stake: historyData[era][address].stake, apy: historyData[era][address].apy });
            }
        }

        let triggers = [];
        try {
            const triggersCache = await readJsonCache(VALIDATOR_TRIGGERS_CACHE_FILE, CACHE_DEFAULTS.get(VALIDATOR_TRIGGERS_CACHE_FILE));
            if (triggersCache[address]) triggers = triggersCache[address].sort((a, b) => b.era - a.era);
        } catch (e) { }

        if (history.length < VALIDATOR_HISTORY_ERAS) {
            const loadedHistory = await loadValidatorHistory(address);
            history.length = 0;
            history.push(...loadedHistory.history);
            triggers = loadedHistory.triggers.sort((a, b) => b.era - a.era);
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

        let txs = [], evs = [], rank = "0", status = 'Synced';
        try {
            const holdersArray = (await readJsonCache(HOLDERS_CACHE_FILE, CACHE_DEFAULTS.get(HOLDERS_CACHE_FILE))).holders;
            const index = holdersArray.findIndex(h => h.address === address);
            if (index !== -1) rank = (index + 1).toString();
        } catch (e) { }
        try {
            const globalTxCache = await readJsonCache(TX_CACHE_FILE, CACHE_DEFAULTS.get(TX_CACHE_FILE));
            if (globalTxCache && Array.isArray(globalTxCache.transactions)) {
                txs = globalTxCache.transactions.filter(t => t.from === address || t.to === address);
            }
            const globalEventsCache = await readJsonCache(EVENTS_CACHE_FILE, CACHE_DEFAULTS.get(EVENTS_CACHE_FILE));
            if (globalEventsCache && Array.isArray(globalEventsCache.events)) {
                evs = globalEventsCache.events.filter(e => e.signerAddress === address);
            }
        } catch (e) { }

        res.json({ account: address, display: name, balanceTotal: free + reserved, balanceFree: free, balanceFrozen: reserved, roles: "User", rank: rank, transactions: txs, events: evs, status: status });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- BACKGROUND CRAWLERS ---
async function syncData() {
    if (isSyncing || !globalApi) return;
    isSyncing = true;
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
        await fs.writeFile(CACHE_FILE, JSON.stringify({ validators: validatorData, totalCount: validators.length, lastSync: Date.now(), status: 'Synced' }));
    } catch (err) {
        console.error("Validator sync error:", err);
        await markCacheError(CACHE_FILE, CACHE_DEFAULTS.get(CACHE_FILE), err);
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
        await fs.writeFile(HOLDERS_CACHE_FILE, JSON.stringify({ holders: holderData, totalCount: entries.length, lastSync: Date.now(), status: 'Synced' }));
    } catch (err) {
        console.error("Holder sync error:", err);
        await markCacheError(HOLDERS_CACHE_FILE, CACHE_DEFAULTS.get(HOLDERS_CACHE_FILE), err);
    } finally { isSyncingHolders = false; }
}

async function syncBlocks() {
    if (isSyncingBlocks || !globalApi) return;
    isSyncingBlocks = true;
    try {
        let cacheData = { blocks: [], status: 'Syncing' };
        cacheData = await readJsonCache(BLOCKS_CACHE_FILE, CACHE_DEFAULTS.get(BLOCKS_CACHE_FILE));
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newBlocks = cacheData.blocks ? [...cacheData.blocks] : [];

        while (blocksSearched < 50) {
            try {
                const derivedBlock = await globalApi.derive.chain.getBlock(currentHash);
                if (derivedBlock) {
                    const blockNumber = derivedBlock.block.header.number.toNumber();
                    if (!newBlocks.find(b => b.number === blockNumber)) {
                        const timestamp = getBlockTimestamp(derivedBlock);
                        let authorAddr = derivedBlock.author ? derivedBlock.author.toString() : "System";
                        newBlocks.push({ number: blockNumber, hash: derivedBlock.block.header.hash.toHex(), authorAddress: authorAddr, authorName: await getIdentity(globalApi, authorAddr), extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0, timestamp: timestamp });
                    } else break;
                    currentHash = derivedBlock.block.header.parentHash;
                } else break;
            } catch (e) {
                console.warn("Block crawler stopped early:", e.message);
                break;
            }
            blocksSearched++;
        }
        cacheData.blocks = newBlocks.sort((a, b) => b.number - a.number).slice(0, 200);
        cacheData.status = 'Synced';
        cacheData.lastSync = Date.now();
        delete cacheData.error;
        await fs.writeFile(BLOCKS_CACHE_FILE, JSON.stringify(cacheData));
    } catch (err) {
        console.error("Block sync error:", err);
        await markCacheError(BLOCKS_CACHE_FILE, CACHE_DEFAULTS.get(BLOCKS_CACHE_FILE), err);
    } finally { isSyncingBlocks = false; }
}

async function syncTransactions() {
    if (isSyncingTx || !globalApi) return;
    isSyncingTx = true;
    try {
        const cacheData = await readJsonCache(TX_CACHE_FILE, CACHE_DEFAULTS.get(TX_CACHE_FILE));
        const latestHeader = await globalApi.rpc.chain.getHeader();
        const latestBlock = latestHeader.number.toNumber();
        const cachedTransactions = getCachedFinancialTransactions(cacheData);
        const latestScannedBlock = Number(cacheData.latestScannedBlock) || 0;
        const needsInitialCrawl = latestScannedBlock === 0 || cacheData.scannerVersion !== FINANCIAL_TX_SCANNER_VERSION;
        const previousScannedBlocks = Number(cacheData.scannedBlocks) || 0;
        let scan = { transactions: [], scannedBlocks: 0, oldestScannedBlock: Number(cacheData.oldestScannedBlock) || 0 };

        cacheData.status = 'Syncing';
        cacheData.transactions = cachedTransactions;
        await fs.writeFile(TX_CACHE_FILE, JSON.stringify(cacheData));

        if (needsInitialCrawl) {
            scan = await scanFinancialTransactions({
                startBlock: latestBlock,
                limit: TX_CACHE_LIMIT,
                maxBlocks: TX_INITIAL_SCAN_BLOCKS,
                onProgress: async progress => {
                    cacheData.transactions = mergeFinancialTransactions(cachedTransactions, progress.transactions);
                    cacheData.status = 'Syncing';
                    cacheData.oldestScannedBlock = progress.oldestScannedBlock;
                    cacheData.scannedBlocks = previousScannedBlocks + progress.scannedBlocks;
                    await fs.writeFile(TX_CACHE_FILE, JSON.stringify(cacheData));
                }
            });
        } else if (latestBlock > latestScannedBlock) {
            const blocksToScan = latestBlock - latestScannedBlock;
            scan = await scanFinancialTransactions({
                startBlock: latestBlock,
                stopBlock: latestScannedBlock + 1,
                limit: TX_CACHE_LIMIT,
                maxBlocks: blocksToScan
            });
        }

        cacheData.transactions = mergeFinancialTransactions(cachedTransactions, scan.transactions);
        cacheData.status = 'Synced';
        cacheData.lastSync = Date.now();
        cacheData.latestScannedBlock = latestBlock;
        cacheData.oldestScannedBlock = needsInitialCrawl
            ? scan.oldestScannedBlock
            : (Number(cacheData.oldestScannedBlock) || latestScannedBlock);
        cacheData.scannedBlocks = previousScannedBlocks + scan.scannedBlocks;
        cacheData.scannerVersion = FINANCIAL_TX_SCANNER_VERSION;
        delete cacheData.error;
        await fs.writeFile(TX_CACHE_FILE, JSON.stringify(cacheData));
    } catch (err) {
        console.error("Transaction sync error:", err);
        await markCacheError(TX_CACHE_FILE, CACHE_DEFAULTS.get(TX_CACHE_FILE), err);
    } finally { isSyncingTx = false; }
}

async function syncEvents() {
    if (isSyncingEvents || !globalApi) return;
    isSyncingEvents = true;
    try {
        let cacheData = { events: [], status: 'Syncing' };
        cacheData = await readJsonCache(EVENTS_CACHE_FILE, CACHE_DEFAULTS.get(EVENTS_CACHE_FILE));
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newEvents = cacheData.events ? cacheData.events.filter(e => e.blockHash) : [];

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
                    if (newEvents.find(e => e.hash === eventId)) continue;

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
        cacheData.events = newEvents.sort((a, b) => b.timestamp - a.timestamp).slice(0, 500);
        cacheData.status = 'Synced';
        cacheData.lastSync = Date.now();
        delete cacheData.error;
        await fs.writeFile(EVENTS_CACHE_FILE, JSON.stringify(cacheData));
    } catch (err) {
        console.error("Event sync error:", err);
        await markCacheError(EVENTS_CACHE_FILE, CACHE_DEFAULTS.get(EVENTS_CACHE_FILE), err);
    } finally { isSyncingEvents = false; }
}

async function start() {
    await initCache();
    const wsProvider = new WsProvider('wss://so.polkadex.ee');
    globalApi = await ApiPromise.create({ provider: wsProvider });
    console.log("Connected to Polkadex RPC");

    app.listen(PORT, () => {
        console.log(`Backend indexer listening on port ${PORT}`);
    });

    syncBlocks();
    syncTransactions();
    syncEvents();
    syncData();
    syncHolders();

    // Recent-chain caches follow block production. Validator and holder rankings are heavier and run less often.
    setInterval(() => {
        syncBlocks();
        syncTransactions();
        syncEvents();
    }, RECENT_SYNC_INTERVAL);
    setInterval(syncData, FIVE_MINUTES);
    setInterval(syncHolders, THIRTY_MINUTES);
}

start();
