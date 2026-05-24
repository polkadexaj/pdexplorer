import { ApiPromise, WsProvider } from '@polkadot/api';
import { decodeAddress } from '@polkadot/util-crypto';

// Utility to generate human readable relative time
function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds} secs ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} mins ago`;
    return `${Math.floor(seconds / 3600)} hrs ago`;
}

// Format PDEX balances (12 decimals)
function formatPDEX(balance) {
    return (Number(balance) / 10 ** 12).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatNetworkNumber(value, maximumFractionDigits = 1) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 'Loading...';
    return number.toLocaleString('en-US', { maximumFractionDigits });
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
}

function setHtml(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = value;
}

// DOM Elements
const blocksListEl = document.getElementById('blocks-list');
const transactionsListEl = document.getElementById('transactions-list');
const sidebar = document.querySelector('.sidebar');
const statusIndicator = document.querySelector('.status-indicator');
const networkStatusText = document.querySelector('.network-status span');

const issuanceEl = document.querySelector('.stat-card:nth-child(2) .stat-value');
const stakeEl = document.querySelector('.stat-card:nth-child(3) .stat-value');
const currentEraEl = document.getElementById('network-current-era');

const validatorsListEl = document.getElementById('validators-list');
const validatorCountEl = document.querySelector('.validator-count');
const holdersListEl = document.getElementById('holders-list');
const holderCountEl = document.querySelector('.holder-count');
const fullTransactionsListEl = document.getElementById('full-transactions-list');
const txCountEl = document.querySelector('.tx-count');
const fullBlocksListEl = document.getElementById('full-blocks-list');
const blockCountEl = document.querySelector('.block-count');
const fullEventsListEl = document.getElementById('full-events-list');
const eventCountEl = document.querySelector('.event-count');
const accountDetailsContainer = document.getElementById('account-details-container');
const blockDetailsContainer = document.getElementById('block-details-container');
const txDetailsContainer = document.getElementById('tx-details-container');

const navItems = document.querySelectorAll('.nav-item');
const pageSections = document.querySelectorAll('.page-section');

// State
let blocks = [];
let fullBlocks = [];
let blocksFetched = false;
let blockDisplayLimit = 50;
let transactions = [];
let txFetched = false;
let txDisplayLimit = 50;
let olderTxBeforeBlock = null;
let transactionCacheMeta = {};
let isLoadingOlderTx = false;
let fullEvents = [];
let eventsFetched = false;
let eventDisplayLimit = 50;
let validatorsFetched = false;
let globalApi = null;
const RECENT_REFRESH_MS = 12000;

async function init() {
    try {
        networkStatusText.innerText = "Connecting...";
        statusIndicator.classList.remove('live');
        statusIndicator.style.background = 'orange';

        const wsProvider = new WsProvider('wss://so.polkadex.ee');
        globalApi = await ApiPromise.create({ provider: wsProvider });

        networkStatusText.innerText = "Polkadex Connected";
        statusIndicator.classList.add('live');
        statusIndicator.style.background = 'var(--success)';

        fetchNetworkStats(globalApi);
        fetchNetworkInformation();

        // Fetch initial dashboard data so it isn't empty on load
        try {
            const [txRes, bRes] = await Promise.all([
                fetch('/api/transactions').catch(() => null),
                fetch('/api/blocks').catch(() => null)
            ]);
            if (txRes) {
                const txData = await txRes.json();
                if (txData.transactions && txData.transactions.length > 0) {
                    transactions = financialTransactionRows(txData.transactions);
                    if (window.location.hash === '') renderTransactions();
                }
            }
            if (bRes) {
                const bData = await bRes.json();
                if (bData.blocks && bData.blocks.length > 0) {
                    blocks = bData.blocks;
                    if (window.location.hash === '') renderBlocks();
                }
            }
        } catch (e) { }

        // Subscribe to new blocks
        subscribeNewBlocks(globalApi);
        setInterval(refreshRecentViews, RECENT_REFRESH_MS);

    } catch (error) {
        console.error("Failed to connect to Polkadex node", error);
        networkStatusText.innerText = "Connection Failed";
        statusIndicator.style.background = 'var(--error)';
        statusIndicator.classList.remove('live');
    }

    // Initialize routing once after data subscriptions are ready.
    routeTo(window.location.hash.substring(1) || 'home');
}

async function fetchNetworkStats(api) {
    try {
        // Total Issuance
        const totalIssuance = await api.query.balances.totalIssuance();
        issuanceEl.innerHTML = `${formatPDEX(totalIssuance)} <span class="unit">PDEX</span>`;

        // Active Era
        const activeEraOption = await api.query.staking.activeEra();
        if (activeEraOption.isSome) {
            const activeEra = activeEraOption.unwrap().index.toNumber();
            currentEraEl.innerText = activeEra;

            // Total Stake
            const totalStake = await api.query.staking.erasTotalStake(activeEra);
            stakeEl.innerHTML = `${formatPDEX(totalStake)} <span class="unit">PDEX</span> <span class="badge small">Live</span>`;
        }
    } catch (err) {
        console.error("Error fetching stats:", err);
    }
}

async function fetchNetworkInformation() {
    try {
        const response = await fetch('/api/network-info');
        const data = await response.json();
        if (!data.networkInfo) return;
        const info = data.networkInfo;

        setText('network-current-era', info.activeEra);
        setText('network-validators', `${info.validators.active} / ${info.validators.total}`);
        setText('network-nominators', `${info.nominators.active} / ${info.nominators.total}`);
        setHtml('network-max-active-stake', `${formatNetworkNumber(info.maxActiveStake, 0)} <span class="unit">PDEX</span>`);
        setText('network-avg-commission', `${formatNetworkNumber(info.avgValidatorCommission, 3)}%`);
        setText('network-min-stake', `${formatNetworkNumber(info.minStake, 0)} PDEX`);
        setText('network-average-stake', `${formatNetworkNumber(info.averageStake, 1)} PDEX`);
        setText('network-avg-stake-account', `${formatNetworkNumber(info.avgStakePerAccount, 1)} PDEX`);
        setText('network-total-bonding', `${formatNetworkNumber(info.totalBonding, 0)} PDEX / ${formatNetworkNumber(info.totalBondingPercent, 0)}%`);
        setText('network-total-unbonding', `-${formatNetworkNumber(info.totalUnbonding, 0)} PDEX`);
        setText('network-last-era-rewards', `${formatNetworkNumber(info.lastEraRewardsTotal, 0)} PDEX`);
    } catch (err) {
        console.error("Error fetching network information:", err);
    }
}

function subscribeNewBlocks(api) {
    api.rpc.chain.subscribeNewHeads(async (header) => {
        const blockNumber = header.number.toNumber();
        const blockHash = header.hash.toHex();

        const newBlock = {
            number: blockNumber,
            hash: blockHash,
            extrinsics: "-",
            timestamp: Date.now()
        };

        // Fetch the full block to get extrinsics count and transactions
        api.rpc.chain.getBlock(blockHash).then(signedBlock => {
            newBlock.extrinsics = signedBlock.block.extrinsics.length;
            renderBlocks(); // re-render when we have the count

            // Extract transactions
            signedBlock.block.extrinsics.forEach((ex) => {
                const summary = getLiveExtrinsicAmountSummary(ex);
                if (summary.amount === '-') return;
                const tx = {
                    hash: ex.hash.toHex(),
                    from: ex.isSigned ? ex.signer.toString() : "System",
                    to: summary.to,
                    block: blockNumber,
                    method: summary.method,
                    amount: summary.amount,
                    numericAmount: summary.numericAmount,
                    value: '-',
                    status: 'success',
                    timestamp: Date.now()
                };
                if (!transactions.find(existing => existing.hash === tx.hash)) transactions.unshift(tx);
                if (currentTxSort.field === null) sortTransactions(); // Keeps it sorted if needed
                if (transactions.length > 500) transactions.pop();
            });
            renderTransactions();
            if (document.querySelector('.transactions-page').style.display === 'flex') {
                renderFullTransactions();
            }

            let author = "System";
            const digest = signedBlock.block.header.digest;
            const preRuntime = digest.logs.find(l => l.isPreRuntime);
            if (preRuntime) {
                author = "Validator " + String(preRuntime.value.toHex()).substring(0, 8);
            }

            const completedBlock = {
                number: blockNumber,
                hash: signedBlock.block.header.hash.toHex(),
                author: author,
                timestamp: Date.now(),
                extrinsics: signedBlock.block.extrinsics.length,
                events: 0 // <--- FIX HERE
            };

            blocks.unshift(completedBlock);
            if (blocks.length > 10) blocks.pop();
            renderBlocks();

            const newFullBlock = {
                number: blockNumber,
                hash: signedBlock.block.header.hash.toHex(),
                authorAddress: author,
                authorName: author,
                extrinsicsCount: signedBlock.block.extrinsics.length,
                eventsCount: 0, // <--- FIX HERE
                timestamp: Date.now()
            };

            fullBlocks.unshift(newFullBlock);
            if (fullBlocks.length > 200) fullBlocks.pop();
            if (document.querySelector('.blocks-page').style.display === 'flex') {
                renderFullBlocks();
            }
        }).catch(console.error);
    });
}

function formatLivePDEX(balance) {
    return Number(balance) / 10 ** 12;
}

function getLiveExtrinsicAmountSummary(ex) {
    const method = `${ex.method.section}.${ex.method.method}`;
    const args = ex.method.args || [];
    let to = method;
    let numericAmount = 0;
    let amount = '-';

    if (ex.method.section === 'balances') {
        if (['transfer', 'transferAllowDeath', 'transferKeepAlive'].includes(ex.method.method) && args.length >= 2) {
            to = args[0].toString();
            numericAmount = formatLivePDEX(args[1]);
            amount = `${numericAmount.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`;
        } else if (ex.method.method === 'forceTransfer' && args.length >= 3) {
            to = args[1].toString();
            numericAmount = formatLivePDEX(args[2]);
            amount = `${numericAmount.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`;
        } else if (ex.method.method === 'transferAll' && args.length >= 1) {
            to = args[0].toString();
            amount = 'All';
        }
    }

    return { method, to, amount, numericAmount };
}

// --- Rendering ---

function renderBlocks() {
    blocksListEl.innerHTML = '';
    blocks.forEach((block, index) => {
        const el = document.createElement('div');
        el.className = `list-item ${index === 0 ? 'animate-in' : ''}`;
        el.innerHTML = `
            <div class="item-main">
                <div class="item-icon"><i class='bx bx-cube-alt'></i></div>
                <div class="item-details">
                    <a href="#block/${block.number}" class="item-title">${block.number}</a>
                    <div class="item-sub">
                        Hash: <a href="#block/${block.hash}" class="item-link">${block.hash.substring(0, 10)}...</a>
                    </div>
                    <div class="item-sub">
                        Extrinsics: ${block.extrinsics}
                    </div>
                </div>
            </div>
            <div class="item-meta">
                <span class="item-time">${timeAgo(block.timestamp)}</span>
            </div>
        `;
        blocksListEl.appendChild(el);
    });
}

function renderTransactions() {
    transactionsListEl.innerHTML = '';
    const financialTransactions = financialTransactionRows(transactions);
    if (financialTransactions.length === 0) {
        transactionsListEl.innerHTML = '<div style="padding: 20px; color: var(--text-muted); font-size: 0.9rem;">Waiting for financial transactions...</div>';
        return;
    }
    financialTransactions.forEach((tx, index) => {
        const el = document.createElement('div');
        el.className = `list-item ${index === 0 ? 'animate-in' : ''}`;

        const shortHash = tx.hash.substring(0, 10) + '...';
        const shortFrom = tx.from.substring(0, 8) + '...';
        let shortTo = tx.to.toString();
        if (shortTo.length > 10) shortTo = shortTo.substring(0, 8) + '...';
        const titleHtml = tx.eventDerived
            ? `<a href="#block/${tx.block}" class="item-title">${shortHash}</a>`
            : `<a href="#tx/${tx.block}/${tx.hash}" class="item-title">${shortHash}</a>`;

        el.innerHTML = `
            <div class="item-main">
                <div class="item-icon"><i class='bx bx-transfer'></i></div>
                <div class="item-details">
                    ${titleHtml}
                    <div class="item-sub">
                        From: ${tx.from === 'System' ? shortFrom : `<a href="#account/${tx.from}" class="item-link">${shortFrom}</a>`}
                    </div>
                    <div class="item-sub">
                        To: ${tx.to === tx.amount ? shortTo : `<a href="#account/${tx.to}" class="item-link">${shortTo}</a>`}
                    </div>
                </div>
            </div>
            <div class="item-meta">
                <span class="item-amount">${tx.amount}</span>
                <span class="item-time">${timeAgo(tx.timestamp)} / Block <a href="#block/${tx.block}" class="item-link">${tx.block}</a></span>
            </div>
        `;
        transactionsListEl.appendChild(el);
    });
}

let currentValidators = [];
let validatorDisplayLimit = 50;

async function fetchValidators() {
    if (validatorsFetched) return;
    try {
        validatorsListEl.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">Fetching from backend indexer...</td></tr>';

        const response = await fetch('/api/validators');
        const data = await response.json();

        if (data.status === 'Initializing' || data.status === 'Syncing' && data.validators.length === 0) {
            validatorsListEl.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px; color: orange;">Indexer is syncing data from Polkadex node, please wait...</td></tr>';
            // Retry in 3 seconds
            setTimeout(() => { validatorsFetched = false; fetchValidators(); }, 3000);
            return;
        }

        validatorCountEl.innerText = `${data.totalCount} Active`;
        currentValidators = data.validators;
        sortValidators();
        validatorsFetched = true;
        renderValidators();

    } catch (err) {
        console.error("Error fetching validators:", err);
        validatorsListEl.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--error);">Error reaching backend indexer. Is node server.js running?</td></tr>';
    }
}

function renderValidators() {
    let html = '';
    const toDisplay = currentValidators.slice(0, validatorDisplayLimit);

    for (const val of toDisplay) {
        const shortAddr = val.address.substring(0, 8) + '...' + val.address.substring(val.address.length - 8);

        // Commission & Risk Logic
        let commissionHtml = `${val.commission.toFixed(2)}%`;
        if (val.commission > 50) {
            commissionHtml += ` <span class="badge" style="background: var(--error);">HIGH RISK</span>`;
        }

        html += `
            <tr>
                <td class="address-cell"><a href="#validator/${val.address}" class="item-link">${shortAddr}</a></td>
                <td><a href="#validator/${val.address}" class="item-link">${val.name}</a></td>
                <td>${Number(val.totalStake).toLocaleString('en-US', { maximumFractionDigits: 2 })} <span class="unit">PDEX</span></td>
                <td>${commissionHtml}</td>
                <td style="color: var(--success); font-weight: 500;">${val.avg30DayApy.toFixed(2)}%</td>
                <td>${val.realApy.toFixed(2)}% <span class="unit">/</span> <span style="color: var(--success);">${val.avg30DayApy.toFixed(2)}%</span></td>
            </tr>
        `;
    }

    validatorsListEl.innerHTML = html;

    const showMoreBtn = document.getElementById('show-more-btn');
    if (showMoreBtn) {
        if (validatorDisplayLimit < currentValidators.length) {
            showMoreBtn.style.display = 'inline-block';
        } else {
            showMoreBtn.style.display = 'none';
        }
    }
}

let currentSort = { field: null, asc: true };

function sortValidators() {
    if (!currentSort.field) return;
    currentValidators.sort((a, b) => {
        let valA = a[currentSort.field];
        let valB = b[currentSort.field];

        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();

        if (valA < valB) return currentSort.asc ? -1 : 1;
        if (valA > valB) return currentSort.asc ? 1 : -1;
        return 0;
    });
}

document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
        const field = th.getAttribute('data-sort');
        if (currentSort.field === field) {
            currentSort.asc = !currentSort.asc;
        } else {
            currentSort.field = field;
            // Default descending for numbers (AP/Comm), ascending for strings (Identity)
            currentSort.asc = field === 'name' ? true : false;
        }

        // update icons
        document.querySelectorAll('.sortable i').forEach(i => i.className = 'bx bx-sort');
        const icon = th.querySelector('i');
        icon.className = currentSort.asc ? 'bx bx-sort-up' : 'bx bx-sort-down';

        sortValidators();
        renderValidators();
    });
});

let holdersFetched = false;
let currentHolders = [];
let holderDisplayLimit = 50;
let currentHolderSort = { field: 'rank', asc: true };

async function fetchHolders() {
    if (holdersFetched) return;
    try {
        if (!holdersListEl) return;
        holdersListEl.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">Fetching from backend indexer...</td></tr>';

        const response = await fetch('/api/holders');
        const data = await response.json();

        if (data.status === 'Initializing' || data.status === 'Syncing' && data.holders.length === 0) {
            holdersListEl.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px; color: orange;">Indexer is syncing data from Polkadex node, please wait...</td></tr>';
            setTimeout(() => { holdersFetched = false; fetchHolders(); }, 3000);
            return;
        }

        if (holderCountEl) holderCountEl.innerText = `${data.holders.length} Top Holders`;
        currentHolders = data.holders;
        holdersFetched = true;
        sortHolders();
        renderHolders();

    } catch (err) {
        console.error("Error fetching holders:", err);
        holdersListEl.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px; color: var(--error);">Error reaching backend indexer. Is node server.js running?</td></tr>';
    }
}

function renderHolders() {
    if (!holdersListEl) return;
    let html = '';
    const toDisplay = currentHolders.slice(0, holderDisplayLimit);

    for (const val of toDisplay) {
        const shortAddr = val.address.substring(0, 8) + '...' + val.address.substring(val.address.length - 8);

        html += `
            <tr>
                <td>#${val.rank}</td>
                <td class="address-cell"><a href="#account/${val.address}" class="item-link">${shortAddr}</a></td>
                <td><a href="#account/${val.address}" class="item-link">${val.name}</a></td>
                <td>${Number(val.balance).toLocaleString('en-US', { maximumFractionDigits: 2 })} <span class="unit">PDEX</span></td>
                <td style="color: var(--brand-primary); font-weight: 500;">${val.share.toFixed(4)}%</td>
            </tr>
        `;
    }

    holdersListEl.innerHTML = html;

    const showMoreBtn = document.getElementById('show-more-holders-btn');
    if (showMoreBtn) {
        if (holderDisplayLimit < currentHolders.length) {
            showMoreBtn.style.display = 'inline-block';
        } else {
            showMoreBtn.style.display = 'none';
        }
    }
}

function sortHolders() {
    if (!currentHolderSort.field) return;
    currentHolders.sort((a, b) => {
        let valA = a[currentHolderSort.field];
        let valB = b[currentHolderSort.field];

        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();

        if (valA < valB) return currentHolderSort.asc ? -1 : 1;
        if (valA > valB) return currentHolderSort.asc ? 1 : -1;
        return 0;
    });
}

document.querySelectorAll('.sortable-holder').forEach(th => {
    th.addEventListener('click', () => {
        const field = th.getAttribute('data-sort');
        if (currentHolderSort.field === field) {
            currentHolderSort.asc = !currentHolderSort.asc;
        } else {
            currentHolderSort.field = field;
            currentHolderSort.asc = field === 'rank' || field === 'name';
        }

        document.querySelectorAll('.sortable-holder i').forEach(i => i.className = 'bx bx-sort');
        const icon = th.querySelector('i');
        icon.className = currentHolderSort.asc ? 'bx bx-sort-up' : 'bx bx-sort-down';

        sortHolders();
        renderHolders();
    });
});

let currentTxSort = { field: null, asc: false };

function sortTransactions() {
    if (!currentTxSort.field) return;
    transactions.sort((a, b) => {
        let valA = a[currentTxSort.field];
        let valB = b[currentTxSort.field];
        if (valA < valB) return currentTxSort.asc ? -1 : 1;
        if (valA > valB) return currentTxSort.asc ? 1 : -1;
        return 0;
    });
}

async function fetchTransactions(force = false) {
    if (txFetched && !force) return;
    try {
        if (!fullTransactionsListEl) return;
        if (!force || transactions.length === 0) {
            fullTransactionsListEl.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px;">Fetching from backend indexer...</td></tr>';
        }

        const response = await fetch('/api/transactions');
        const data = await response.json();

        if (data.status === 'Initializing' || (data.status === 'Syncing' && data.transactions.length === 0)) {
            fullTransactionsListEl.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px; color: orange;">Indexer is crawling historical blocks, please wait...</td></tr>';
            setTimeout(() => { txFetched = false; fetchTransactions(); }, 5000);
            return;
        }

        transactions = financialTransactionRows(data.transactions);
        transactionCacheMeta = {
            latestScannedBlock: data.latestScannedBlock,
            oldestScannedBlock: data.oldestScannedBlock,
            scannedBlocks: data.scannedBlocks
        };
        txFetched = true;
        sortTransactions();
        renderFullTransactions();

    } catch (err) {
        console.error("Error fetching transactions:", err);
        fullTransactionsListEl.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px; color: var(--error);">Error reaching backend indexer. Is node server.js running?</td></tr>';
    }
}

function renderFullTransactions() {
    if (!fullTransactionsListEl) return;
    let html = '';
    const financialTransactions = financialTransactionRows(transactions);
    const toDisplay = financialTransactions.slice(0, txDisplayLimit);

    for (const rawTx of toDisplay) {
        const tx = normalizeTransactionRow(rawTx);
        const shortHash = tx.hash.substring(0, 10) + '...';
        const shortFrom = tx.from.substring(0, 8) + '...';
        let shortTo = tx.to.toString();
        if (shortTo.length > 15) shortTo = shortTo.substring(0, 8) + '...';

        const dateObj = new Date(tx.timestamp);
        const dateStr = `${timeAgo(tx.timestamp)} (${dateObj.toISOString().replace('T', ' ').substring(0, 19)})`;
        const hashCell = tx.eventDerived
            ? `<a href="#block/${tx.block}" class="item-link">${shortHash}</a>`
            : `<a href="#tx/${tx.block}/${tx.hash}" class="item-link">${shortHash}</a>`;

        html += `
            <tr>
                <td class="address-cell">${hashCell}</td>
                <td>${tx.from === 'System' ? shortFrom : `<a href="#account/${tx.from}" class="item-link">${shortFrom}</a>`}</td>
                <td>${tx.to === tx.amount ? shortTo : `<a href="#account/${tx.to}" class="item-link">${shortTo}</a>`}</td>
                <td style="color: var(--text-secondary);">${dateStr}</td>
                <td><a href="#block/${tx.block}" class="item-link">${tx.block}</a></td>
                <td style="font-weight: 500;">${tx.amount}</td>
                <td style="color: var(--text-secondary);">${tx.value}</td>
                <td><span class="badge" style="background: ${tx.status === 'failed' ? 'var(--error)' : 'var(--success)'};">${tx.status}</span></td>
            </tr>
        `;
    }
    if (toDisplay.length === 0) {
        html = '<tr><td colspan="8" style="text-align:center; padding: 20px; color: var(--text-muted);">No recent financial transactions found.</td></tr>';
    }

    fullTransactionsListEl.innerHTML = html;
    if (txCountEl) txCountEl.innerText = `${financialTransactions.length} Records`;
    updateOlderFinancialTxButton(financialTransactions.length === 0);

    const showMoreTxBtn = document.getElementById('show-more-tx-btn');
    if (showMoreTxBtn) {
        if (txDisplayLimit < financialTransactions.length) {
            showMoreTxBtn.style.display = 'inline-block';
        } else {
            showMoreTxBtn.style.display = 'none';
        }
    }
}

function updateOlderFinancialTxButton(show) {
    const loadOlderBtn = document.getElementById('load-older-financial-tx-btn');
    if (!loadOlderBtn) return;
    loadOlderBtn.style.display = show ? 'inline-block' : 'none';
    loadOlderBtn.disabled = isLoadingOlderTx;
    loadOlderBtn.innerText = isLoadingOlderTx ? 'Loading older financial tx...' : 'Load Older 100 Financial Tx';
}

function normalizeTransactionRow(tx) {
    if (tx && typeof tx.amount === 'string' && tx.amount.includes('.') && (!tx.method || tx.value === 'System')) {
        return { ...tx, method: tx.method || tx.amount, to: tx.method || tx.amount, amount: '-', numericAmount: 0, value: '-' };
    }
    return tx;
}

function isFinancialTransactionRow(tx) {
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

function financialTransactionRows(rows) {
    return (rows || []).map(normalizeTransactionRow).filter(isFinancialTransactionRow);
}

async function loadOlderFinancialTransactions() {
    if (isLoadingOlderTx) return;
    isLoadingOlderTx = true;
    updateOlderFinancialTxButton(true);
    try {
        const currentFinancialTx = financialTransactionRows(transactions);
        const oldestLoadedBlock = currentFinancialTx.length > 0 ? Math.min(...currentFinancialTx.map(tx => tx.block)) : null;
        const beforeBlock = olderTxBeforeBlock || oldestLoadedBlock || transactionCacheMeta.oldestScannedBlock;
        const query = new URLSearchParams({ limit: '100' });
        if (beforeBlock) query.set('beforeBlock', beforeBlock);

        const response = await fetch(`/api/transactions/older?${query.toString()}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error);

        olderTxBeforeBlock = data.nextBeforeBlock || olderTxBeforeBlock;
        const existingHashes = new Set(transactions.map(tx => tx.hash));
        const olderRows = financialTransactionRows(data.transactions).filter(tx => !existingHashes.has(tx.hash));
        transactions = financialTransactionRows([...transactions, ...olderRows]);
        sortTransactions();
        renderFullTransactions();

        if (olderRows.length === 0 && fullTransactionsListEl) {
            fullTransactionsListEl.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 20px; color: var(--text-muted);">No financial transactions found in the last ${data.scannedBlocks || 0} older blocks.</td></tr>`;
            updateOlderFinancialTxButton(true);
        }
    } catch (err) {
        console.error("Error loading older financial transactions:", err);
        if (fullTransactionsListEl) {
            fullTransactionsListEl.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 20px; color: var(--error);">Error loading older financial transactions: ${err.message}</td></tr>`;
        }
    } finally {
        isLoadingOlderTx = false;
        updateOlderFinancialTxButton(financialTransactionRows(transactions).length === 0);
    }
}

async function fetchBlocks(force = false) {
    if (blocksFetched && !force) return;
    try {
        if (!fullBlocksListEl) return;
        if (!force || fullBlocks.length === 0) {
            fullBlocksListEl.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 20px;">Fetching from backend indexer...</td></tr>';
        }

        const response = await fetch('/api/blocks');
        const data = await response.json();

        // Safety guard: Ensure data.blocks actually exists before checking length
        if (data.error || !data.blocks) throw new Error(data.error || "Blocks cache empty");

        if (data.status === 'Initializing' || (data.status === 'Syncing' && data.blocks.length === 0)) {
            fullBlocksListEl.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 20px; color: orange;">Indexer is crawling historical blocks, please wait...</td></tr>';
            setTimeout(() => { blocksFetched = false; fetchBlocks(); }, 5000);
            return;
        }

        fullBlocks = data.blocks;
        blocksFetched = true;
        renderFullBlocks();

    } catch (err) {
        console.error("Error fetching blocks:", err);
        fullBlocksListEl.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px; color: var(--error);">Backend Syncing. Please refresh.</td></tr>`;
    }
}

function renderFullBlocks() {
    if (!fullBlocksListEl) return;
    let html = '';
    const toDisplay = fullBlocks.slice(0, blockDisplayLimit);

    for (const b of toDisplay) {
        const shortHash = b.hash.substring(0, 10) + '...';
        const dateObj = new Date(b.timestamp);

        html += `
            <tr>
                <td><a href="#block/${b.number}" class="item-link">${b.number}</a></td>
                <td style="color: var(--text-secondary);">${timeAgo(b.timestamp)}</td>
                <td>${b.authorName && b.authorName !== "Unknown" && b.authorName !== "System" && !b.authorName.startsWith("Validator") ? `<a href="#account/${b.authorAddress}" class="item-link">${b.authorName}</a>` : `<a href="#account/${b.authorAddress}" class="address-cell item-link">${b.authorAddress.substring(0, 8)}...</a>`}</td>
                <td style="font-weight: 500;">${b.extrinsicsCount}</td>
                <td style="font-weight: 500;">${b.eventsCount}</td>
                <td class="address-cell"><a href="#block/${b.hash}" class="item-link">${shortHash}</a></td>
                <td style="color: var(--text-secondary);">${dateObj.toISOString().replace('T', ' ').substring(0, 19)}</td>
            </tr>
        `;
    }

    fullBlocksListEl.innerHTML = html;
    if (blockCountEl) blockCountEl.innerText = `${fullBlocks.length} Records`;

    const showMoreBlocksBtn = document.getElementById('show-more-blocks-btn');
    if (showMoreBlocksBtn) {
        if (blockDisplayLimit < fullBlocks.length) {
            showMoreBlocksBtn.style.display = 'inline-block';
        } else {
            showMoreBlocksBtn.style.display = 'none';
        }
    }
}

async function refreshDashboardLists() {
    try {
        const [txRes, bRes] = await Promise.all([
            fetch('/api/transactions').catch(() => null),
            fetch('/api/blocks').catch(() => null)
        ]);

        if (txRes) {
            const txData = await txRes.json();
            if (Array.isArray(txData.transactions)) {
                transactions = financialTransactionRows(txData.transactions);
                transactionCacheMeta = {
                    latestScannedBlock: txData.latestScannedBlock,
                    oldestScannedBlock: txData.oldestScannedBlock,
                    scannedBlocks: txData.scannedBlocks
                };
                renderTransactions();
            }
        }
        if (bRes) {
            const bData = await bRes.json();
            if (Array.isArray(bData.blocks)) {
                blocks = bData.blocks.slice(0, 10);
                renderBlocks();
            }
        }
    } catch (err) {
        console.error("Error refreshing dashboard lists:", err);
    }
}

function activePageName() {
    const activePage = Array.from(pageSections).find(page => page.style.display !== 'none');
    return activePage ? activePage.getAttribute('data-page') : '';
}

function refreshRecentViews() {
    const activePage = activePageName();
    if (activePage === 'home' || activePage === 'dashboard') refreshDashboardLists();
    if (activePage === 'transactions') fetchTransactions(true);
    if (activePage === 'blocks') fetchBlocks(true);
    if (activePage === 'events') fetchEvents(true);
}

async function fetchEvents(force = false) {
    if (eventsFetched && !force) return;
    try {
        if (!fullEventsListEl) return;
        if (!force || fullEvents.length === 0) {
            fullEventsListEl.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching from backend indexer...</div>';
        }

        const response = await fetch('/api/events');
        const data = await response.json();

        if (data.status === 'Initializing' || (data.status === 'Syncing' && data.events.length === 0)) {
            fullEventsListEl.innerHTML = '<div style="text-align:center; padding: 20px; color: orange;">Indexer is crawling historical events, please wait...</div>';
            setTimeout(() => { eventsFetched = false; fetchEvents(); }, 5000);
            return;
        }

        fullEvents = data.events;
        eventsFetched = true;
        renderFullEvents();

    } catch (err) {
        console.error("Error fetching events:", err);
        fullEventsListEl.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--error);">Error reaching backend indexer. Is node server.js running?</div>';
    }
}

function renderFullEvents() {
    if (!fullEventsListEl) return;
    let html = '';
    const toDisplay = fullEvents.slice(0, eventDisplayLimit);

    for (const ev of toDisplay) {
        const displayHash = ev.txHash || ev.hash;
        const shortHash = displayHash.substring(0, 15) + '...';
        const dateObj = new Date(ev.timestamp);
        const actionStr = `${ev.section} -> ${ev.method}`;
        const identityStr = (ev.signerName && ev.signerName !== "Unknown") ? ev.signerName : ev.signerAddress;
        const eventLink = ev.txHash
            ? `<a href="#tx/${ev.block}/${ev.txHash}" class="item-link" style="font-size: 13px; color: var(--brand-secondary); opacity: 0.8;">tx: ${shortHash}</a>`
            : `<span style="font-size: 13px; color: var(--text-secondary); opacity: 0.8;">event: ${shortHash}</span>`;
        const statusColor = ev.status === 'failed' ? 'var(--error)' : 'var(--success)';

        html += `
            <div class="event-list-item">
                <div>
                    <a href="#block/${ev.block}" class="item-link" style="display: block; font-size: 15px; margin-bottom: 5px;">${ev.block}</a>
                    ${eventLink}
                </div>
                <div>
                    <div style="font-weight: 500; font-size: 14px; margin-bottom: 5px;">${actionStr}</div>
                    <div style="font-size: 13px; color: var(--text-secondary);">
                        signer:<br>
                        <a href="#account/${ev.signerAddress}" class="item-link" style="font-size: 13px;">${identityStr}</a>
                    </div>
                </div>
                <div style="color: var(--text-secondary); font-size: 14px;">
                    ${timeAgo(ev.timestamp)}
                </div>
                <div style="color: var(--text-secondary); font-size: 14px;">
                    ${dateObj.toISOString().replace('T', ' ').substring(0, 19)}(UTC)
                </div>
                <div>
                    <span class="badge" style="background: ${statusColor}; font-size: 11px;">${ev.status}</span>
                </div>
            </div>
        `;
    }

    fullEventsListEl.innerHTML = html;
    if (eventCountEl) eventCountEl.innerText = `${fullEvents.length} Records`;

    const showMoreEventsBtn = document.getElementById('show-more-events-btn');
    if (showMoreEventsBtn) {
        if (eventDisplayLimit < fullEvents.length) {
            showMoreEventsBtn.style.display = 'inline-block';
        } else {
            showMoreEventsBtn.style.display = 'none';
        }
    }
}

document.querySelectorAll('.sortable-tx').forEach(th => {
    th.addEventListener('click', () => {
        const field = th.getAttribute('data-sort');
        if (currentTxSort.field === field) {
            currentTxSort.asc = !currentTxSort.asc;
        } else {
            currentTxSort.field = field;
            currentTxSort.asc = false;
        }

        document.querySelectorAll('.sortable-tx i').forEach(i => i.className = 'bx bx-sort');
        const icon = th.querySelector('i');
        icon.className = currentTxSort.asc ? 'bx bx-sort-up' : 'bx bx-sort-down';

        sortTransactions();
        renderFullTransactions();
    });
});

// --- Event Listeners ---

const showMoreBtn = document.getElementById('show-more-btn');
if (showMoreBtn) {
    showMoreBtn.addEventListener('click', () => {
        validatorDisplayLimit += 50;
        renderValidators();
    });
}

const showMoreHoldersBtn = document.getElementById('show-more-holders-btn');
if (showMoreHoldersBtn) {
    showMoreHoldersBtn.addEventListener('click', () => {
        holderDisplayLimit += 50;
        renderHolders();
    });
}

const showMoreTxBtn = document.getElementById('show-more-tx-btn');
if (showMoreTxBtn) {
    showMoreTxBtn.addEventListener('click', () => {
        txDisplayLimit += 50;
        renderFullTransactions();
    });
}

const loadOlderFinancialTxBtn = document.getElementById('load-older-financial-tx-btn');
if (loadOlderFinancialTxBtn) {
    loadOlderFinancialTxBtn.addEventListener('click', loadOlderFinancialTransactions);
}

const showMoreBlocksBtn = document.getElementById('show-more-blocks-btn');
if (showMoreBlocksBtn) {
    showMoreBlocksBtn.addEventListener('click', () => {
        blockDisplayLimit += 50;
        renderFullBlocks();
    });
}

const showMoreEventsBtn = document.getElementById('show-more-events-btn');
if (showMoreEventsBtn) {
    showMoreEventsBtn.addEventListener('click', () => {
        eventDisplayLimit += 50;
        renderFullEvents();
    });
}

// Search Logic
const searchInput = document.getElementById('search-input');
const searchResultsContainer = document.getElementById('search-results-container');
const searchQueryDisplay = document.getElementById('search-query-display');
const deepSearchBtn = document.getElementById('deep-search-btn');
let currentSearchQuery = '';

if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (query) {
                window.location.hash = '#search';
                performSearch(query);
            }
        }
    });
}

if (deepSearchBtn) {
    deepSearchBtn.addEventListener('click', () => {
        deepSearchNetwork(currentSearchQuery);
    });
}

async function performSearch(query) {
    currentSearchQuery = query;
    if (searchQueryDisplay) searchQueryDisplay.innerText = query;
    if (searchResultsContainer) searchResultsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Searching local indexer...</div>';

    // Ensure all data is fetched
    await Promise.all([fetchTransactions(), fetchBlocks(), fetchEvents()]);

    let html = '';
    let found = false;

    // Search Blocks (by number or hash)
    const matchingBlocks = fullBlocks.filter(b => b.number.toString() === query || b.hash.toLowerCase() === query.toLowerCase());
    if (matchingBlocks.length > 0) {
        found = true;
        html += `<h3 style="margin-top: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">Matching Blocks</h3>`;
        matchingBlocks.forEach(b => {
            html += `<div style="padding: 10px 0;">Block <strong>${b.number}</strong> (${b.hash}) - ${b.extrinsicsCount} extrinsics, ${b.eventsCount} events</div>`;
        });
    }

    // Search Transactions (by hash or address)
    const matchingTx = transactions.filter(t => t.hash.toLowerCase() === query.toLowerCase() || t.from.toLowerCase() === query.toLowerCase() || t.to.toLowerCase() === query.toLowerCase());
    if (matchingTx.length > 0) {
        found = true;
        html += `<h3 style="margin-top: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">Matching Transactions</h3>`;
        matchingTx.forEach(t => {
            html += `<div style="padding: 10px 0;">Tx Hash: <strong>${t.hash}</strong><br>From: ${t.from}<br>To: ${t.to}<br>Amount: ${t.numericAmount} PDEX</div>`;
        });
    }

    // Search Events (by hash, address, or block)
    const matchingEvents = fullEvents.filter(e => e.hash.toLowerCase() === query.toLowerCase() || (e.txHash && e.txHash.toLowerCase() === query.toLowerCase()) || e.signerAddress.toLowerCase() === query.toLowerCase() || e.block.toString() === query);
    if (matchingEvents.length > 0) {
        found = true;
        html += `<h3 style="margin-top: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">Matching Events</h3>`;
        matchingEvents.forEach(e => {
            html += `<div style="padding: 10px 0;">Event: <strong>${e.section} -> ${e.method}</strong> in Block ${e.block}<br>Signer: ${e.signerName !== 'Unknown' ? e.signerName : e.signerAddress}</div>`;
        });
    }

    if (!found) {
        html = '<div style="text-align:center; padding: 20px; color: orange;">No results found in recent local history. Try deep search.</div>';
    }

    if (searchResultsContainer) searchResultsContainer.innerHTML = html;
}

async function deepSearchNetwork(query) {
    if (searchResultsContainer) searchResultsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Querying Deep Network RPC...</div>';
    try {
        const response = await fetch(`/api/search/${encodeURIComponent(query)}`);
        if (!response.ok) {
            const err = await response.json();
            searchResultsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Deep Search Failed: ${err.error}</div>`;
            return;
        }

        const data = await response.json();
        let html = '';

        if (data.type === 'block') {
            html += `<h3 style="margin-top: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">Block Detail (Deep Search)</h3>`;
            html += `<div style="padding: 10px 0;">Block <strong>${data.data.number}</strong> (${data.data.hash})<br>Author: ${data.data.authorAddress}<br>${data.data.extrinsicsCount} extrinsics, ${data.data.eventsCount} events</div>`;
        } else if (data.type === 'account') {
            html += `<h3 style="margin-top: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">Account Detail (Deep Search)</h3>`;
            html += `<div style="padding: 10px 0;">Address: <strong>${data.data.address}</strong><br>Identity: ${data.data.name}<br>Total Balance: ${data.data.balance.toFixed(4)} PDEX<br>Free: ${data.data.free.toFixed(4)} PDEX, Reserved: ${data.data.reserved.toFixed(4)} PDEX</div>`;
        }

        if (searchResultsContainer) searchResultsContainer.innerHTML = html;

    } catch (err) {
        searchResultsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Deep search error: ${err.message}</div>`;
    }
}

// Routing Logic
function routeTo(target) {
    if (!target) target = 'home';

    let mainTarget = target;
    let detailId = null;
    let detailId2 = null;

    if (target.startsWith('account/')) {
        mainTarget = 'account-details';
        detailId = target.split('/')[1];
    } else if (target.startsWith('validator/')) {
        mainTarget = 'validator-details';
        detailId = target.split('/')[1];
    } else if (target.startsWith('block/')) {
        mainTarget = 'block-details';
        detailId = target.split('/')[1];
    } else if (target.startsWith('tx/')) {
        mainTarget = 'tx-details';
        detailId = target.split('/')[1];
        detailId2 = target.split('/')[2];
    } else if (target.startsWith('staking-rewards/')) {
        mainTarget = 'staking-rewards';
        detailId = target.substring('staking-rewards/'.length);
    } else if (target.startsWith('wallet/')) {
        mainTarget = 'wallet';
        detailId = target.substring('wallet/'.length);
    } else if (target.startsWith('discussions/')) {
        mainTarget = 'discussions';
        detailId = target.substring('discussions/'.length);
    }

    // Update active nav
    navItems.forEach(n => {
        n.classList.remove('active');
        if (n.getAttribute('data-target') === mainTarget || n.getAttribute('data-target') === target) {
            n.classList.add('active');
        }
    });

    // Close sidebar on mobile
    if (typeof sidebar !== 'undefined' && sidebar) sidebar.classList.remove('open');

    // Show target page
    pageSections.forEach(page => {
        if (page.getAttribute('data-page') === mainTarget) {
            page.style.display = mainTarget.includes('details') ? 'block' : 'flex';
            if (mainTarget === 'home') {
                if (blocks && blocks.length > 0) renderBlocks();
                if (transactions && transactions.length > 0) renderTransactions();
            } else if (mainTarget === 'validators') {
                fetchValidators();
            } else if (mainTarget === 'holders') {
                fetchHolders();
            } else if (mainTarget === 'transactions') {
                fetchTransactions();
            } else if (mainTarget === 'blocks') {
                fetchBlocks();
            } else if (mainTarget === 'events') {
                fetchEvents();
            } else if (mainTarget === 'account-details') {
                fetchAccountDetails(detailId);
            } else if (mainTarget === 'validator-details') {
                fetchValidatorDetails(detailId);
            } else if (mainTarget === 'block-details') {
                fetchBlockDetails(detailId);
            } else if (mainTarget === 'tx-details') {
                fetchTxDetails(detailId, detailId2);
            } else if (mainTarget === 'staking-rewards') {
                initStakingRewardsPage(detailId);
            } else if (mainTarget === 'wallet') {
                initWalletPage(detailId);
            } else if (mainTarget === 'donate') {
                initDonatePage();
            } else if (mainTarget === 'discussions') {
                initDiscussionsPage(detailId);
            } else if (mainTarget === 'council') {
                fetchCouncilData();
            } else if (mainTarget === 'democracy') {
                initDemocracyPage();
            } else if (mainTarget === 'treasury') {
                fetchTreasuryData();
            }
        } else {
            page.style.display = 'none';
        }
    });
}

function renderJSONTree(obj, indent = 0) {
    if (obj === null) return '<span class="json-null">null</span>';
    if (typeof obj === 'boolean') return `<span class="json-boolean">${obj}</span>`;
    if (typeof obj === 'number') return `<span class="json-number">${obj}</span>`;
    if (typeof obj === 'string') return `<span class="json-string">"${obj}"</span>`;

    if (Array.isArray(obj)) {
        if (obj.length === 0) return '[]';
        let html = '[\n';
        const innerIndent = indent + 1;
        const spaces = '  '.repeat(innerIndent);
        obj.forEach((val, i) => {
            html += `<div class="json-indent">${spaces}${renderJSONTree(val, innerIndent)}${i < obj.length - 1 ? ',' : ''}</div>`;
        });
        html += '  '.repeat(indent) + ']';
        return html;
    }

    if (typeof obj === 'object') {
        const keys = Object.keys(obj);
        if (keys.length === 0) return '{}';
        let html = '{\n';
        const innerIndent = indent + 1;
        const spaces = '  '.repeat(innerIndent);
        keys.forEach((k, i) => {
            html += `<div class="json-indent">${spaces}<span class="json-key">"${k}"</span>: ${renderJSONTree(obj[k], innerIndent)}${i < keys.length - 1 ? ',' : ''}</div>`;
        });
        html += '  '.repeat(indent) + '}';
        return html;
    }
    return String(obj);
}

window.switchAccountTab = function (tabName) {
    document.querySelectorAll('.account-tab-btn').forEach(btn => btn.classList.remove('active', 'tab-active'));
    document.querySelectorAll('.account-tab-btn').forEach(btn => {
        if (btn.innerText.toLowerCase() === tabName.toLowerCase()) {
            btn.classList.add('active', 'tab-active');
            btn.style.color = 'var(--brand-secondary)';
            btn.style.borderBottom = '2px solid var(--brand-secondary)';
        } else {
            btn.style.color = 'var(--text-secondary)';
            btn.style.borderBottom = 'none';
        }
    });

    document.getElementById('account-tab-transactions').style.display = tabName === 'transactions' ? 'block' : 'none';
    document.getElementById('account-tab-events').style.display = tabName === 'events' ? 'block' : 'none';
};

async function fetchAccountDetails(address) {
    if (accountDetailsContainer) accountDetailsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching account details...</div>';
    try {
        const res = await fetch(`/api/account/${address}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // Transactions Table
        let txHtml = `
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
                <thead>
                    <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-secondary);">
                        <th style="padding: 12px 10px; font-weight: 500;">Txn Hash</th>
                        <th style="padding: 12px 10px; font-weight: 500;">Method/Action</th>
                        <th style="padding: 12px 10px; font-weight: 500;">Age</th>
                        <th style="padding: 12px 10px; font-weight: 500;">Date</th>
                        <th style="padding: 12px 10px; font-weight: 500;">Status</th>
                    </tr>
                </thead>
                <tbody>
        `;

        data.transactions.forEach(t => {
            const dateObj = new Date(t.timestamp);
            const dateStr = dateObj.toISOString().replace('T', ' ').substring(0, 19) + '(UTC)';
            const statusBadge = t.status === 'success' ? `<span class="badge" style="background: rgba(46, 204, 113, 0.2); color: #2ecc71;">Success</span>` : `<span class="badge" style="background: rgba(231, 76, 60, 0.2); color: #e74c3c;">Failed</span>`;

            txHtml += `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.02);">
                    <td style="padding: 15px 10px;"><a href="#tx/${t.block}/${t.hash}" class="item-link" style="color: var(--brand-secondary);">${t.hash.substring(0, 25)}...</a></td>
                    <td style="padding: 15px 10px;">${t.amount || 'system'}<br><span style="color: var(--text-secondary); font-size: 11px;">call</span></td>
                    <td style="padding: 15px 10px;">${timeAgo(t.timestamp)}</td>
                    <td style="padding: 15px 10px;">${dateStr}</td>
                    <td style="padding: 15px 10px;">${statusBadge}</td>
                </tr>
            `;
        });
        if (data.transactions.length === 0) {
            if (data.status === 'Syncing') {
                txHtml += '<tr><td colspan="5" style="padding: 20px; text-align: center; color: var(--brand-secondary);">Crawling deep history (up to 30 days)... Please refresh in a minute.</td></tr>';
            } else {
                txHtml += '<tr><td colspan="5" style="padding: 20px; text-align: center;">No recent transactions.</td></tr>';
            }
        }
        txHtml += `</tbody></table>`;

        // Events Table
        let evHtml = `
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
                <thead>
                    <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-secondary);">
                        <th style="padding: 12px 10px; font-weight: 500;">Event Hash</th>
                        <th style="padding: 12px 10px; font-weight: 500;">Action</th>
                        <th style="padding: 12px 10px; font-weight: 500;">Age</th>
                        <th style="padding: 12px 10px; font-weight: 500;">Date</th>
                        <th style="padding: 12px 10px; font-weight: 500;">Status</th>
                    </tr>
                </thead>
                <tbody>
        `;
        data.events.forEach(e => {
            const dateObj = new Date(e.timestamp);
            const dateStr = dateObj.toISOString().replace('T', ' ').substring(0, 19) + '(UTC)';
            const statusBadge = `<span class="badge" style="background: rgba(46, 204, 113, 0.2); color: #2ecc71;">Success</span>`;

            evHtml += `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.02);">
                    <td style="padding: 15px 10px;"><span class="address-cell" style="color: var(--brand-secondary);">${e.hash.substring(0, 25)}...</span></td>
                    <td style="padding: 15px 10px;">${e.section}<br><span style="color: var(--text-secondary); font-size: 11px;">${e.method}</span></td>
                    <td style="padding: 15px 10px;">${timeAgo(e.timestamp)}</td>
                    <td style="padding: 15px 10px;">${dateStr}</td>
                    <td style="padding: 15px 10px;">${statusBadge}</td>
                </tr>
            `;
        });
        if (data.events.length === 0) {
            if (data.status === 'Syncing') {
                evHtml += '<tr><td colspan="5" style="padding: 20px; text-align: center; color: var(--brand-secondary);">Crawling deep history (up to 30 days)... Please refresh in a minute.</td></tr>';
            } else {
                evHtml += '<tr><td colspan="5" style="padding: 20px; text-align: center;">No recent events.</td></tr>';
            }
        }
        evHtml += `</tbody></table>`;

        let html = `
            <div class="list-header" style="border-bottom: 1px solid var(--border-color); padding: 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h2 style="font-size: 18px;">Account Details</h2>
                <a href="javascript:history.back()" style="color: var(--text-secondary); text-decoration: none; cursor: pointer;"><i class='bx bx-x' style="font-size: 24px;"></i></a>
            </div>
            <div style="background: rgba(255,255,255,0.02); margin-bottom: 20px; border-radius: 4px; border: 1px solid var(--border-color);">
                <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 14px;">
                    <tr style="background: rgba(255,255,255,0.05);">
                        <td style="padding: 12px 20px; font-weight: 600; width: 250px;">account</td>
                        <td style="padding: 12px 20px;" class="address-cell">${data.account} <span onclick="copyToClipboard(this, '${data.account}')" style="cursor: pointer; color: var(--brand-secondary); font-size: 13px; margin-left: 10px;">copy</span></td>
                    </tr>
                    <tr>
                        <td style="padding: 12px 20px; font-weight: 600;">display</td>
                        <td style="padding: 12px 20px; color: var(--brand-secondary);">${data.display}</td>
                    </tr>
                    <tr style="background: rgba(255,255,255,0.02);">
                        <td style="padding: 12px 20px; font-weight: 600;">balance total</td>
                        <td style="padding: 12px 20px;">${data.balanceTotal.toFixed(4)} <span style="font-size: 11px; color: var(--text-secondary);">(PDEX)</span></td>
                    </tr>
                    <tr>
                        <td style="padding: 12px 20px; font-weight: 600;">balance frozen</td>
                        <td style="padding: 12px 20px;">${data.balanceFrozen.toFixed(4)} <span style="font-size: 11px; color: var(--text-secondary);">(PDEX)</span></td>
                    </tr>
                    <tr style="background: rgba(255,255,255,0.02);">
                        <td style="padding: 12px 20px; font-weight: 600;">balance free</td>
                        <td style="padding: 12px 20px;">${data.balanceFree.toFixed(4)} <span style="font-size: 11px; color: var(--text-secondary);">(PDEX)</span></td>
                    </tr>
                    <tr>
                        <td style="padding: 12px 20px; font-weight: 600;">roles</td>
                        <td style="padding: 12px 20px;">${data.roles}</td>
                    </tr>
                    <tr style="background: rgba(255,255,255,0.02);">
                        <td style="padding: 12px 20px; font-weight: 600;">Rating(top)</td>
                        <td style="padding: 12px 20px;">${data.rank === "0" ? "N/A" : data.rank}</td>
                    </tr>
                </table>
            </div>
            
            <div style="margin-bottom: 20px;">
                <div style="display: flex; gap: 20px; padding: 0 20px; border-bottom: 1px solid var(--border-color); margin-bottom: 15px;">
                    <button class="account-tab-btn" onclick="switchAccountTab('transactions')" style="background: none; border: none; cursor: pointer; padding: 10px 5px; font-size: 14px; color: var(--brand-secondary); border-bottom: 2px solid var(--brand-secondary); font-family: 'Inter', sans-serif;">Transactions</button>
                    <button class="account-tab-btn" onclick="switchAccountTab('events')" style="background: none; border: none; cursor: pointer; padding: 10px 5px; font-size: 14px; color: var(--text-secondary); font-family: 'Inter', sans-serif;">Events</button>
                </div>
                
                <div id="account-tab-transactions">
                    ${txHtml}
                </div>
                
                <div id="account-tab-events" style="display: none;">
                    ${evHtml}
                </div>
            </div>
        `;
        accountDetailsContainer.innerHTML = html;
    } catch (e) {
        accountDetailsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Error: ${e.message}</div>`;
    }
}

async function fetchBlockDetails(id) {
    if (blockDetailsContainer) blockDetailsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching block details...</div>';
    try {
        const res = await fetch(`/api/block/${id}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        let html = `
            <div class="list-header" style="border-bottom: 1px solid var(--border-color); padding: 20px; display: flex; justify-content: space-between; align-items: center;">
                <h2>Block ${data.block.header.number}</h2>
                <a href="javascript:history.back()" style="color: var(--text-secondary); text-decoration: none; cursor: pointer;"><i class='bx bx-x' style="font-size: 24px;"></i></a>
            </div>
            <div style="padding: 20px;">
                <div style="margin-bottom: 10px;"><strong>hash</strong> <span class="address-cell">${data.hash}</span></div>
                <div style="margin-bottom: 20px;"><strong>date UTC</strong> <span style="color: var(--text-secondary);">${new Date(data.date).toISOString().replace('T', ' ').substring(0, 19)}</span></div>
                <div class="json-container">
                    ${renderJSONTree({ block: data.block })}
                </div>
            </div>
        `;
        blockDetailsContainer.innerHTML = html;
    } catch (e) {
        blockDetailsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Error: ${e.message}</div>`;
    }
}

async function fetchTxDetails(block, hash) {
    if (txDetailsContainer) txDetailsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching transaction details...</div>';
    try {
        const res = await fetch(`/api/extrinsic/${block}/${hash}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        let html = `
            <div class="list-header" style="border-bottom: 1px solid var(--border-color); padding: 20px; display: flex; justify-content: space-between; align-items: center;">
                <h2>Tx: ${data.hash}</h2>
                <a href="javascript:history.back()" style="color: var(--text-secondary); text-decoration: none; cursor: pointer;"><i class='bx bx-x' style="font-size: 24px;"></i></a>
            </div>
            <div style="padding: 20px;">
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; text-align: left;">
                    <tr><td style="padding: 10px; font-weight: bold; width: 150px;">Time</td><td style="padding: 10px;">${new Date(data.time).toISOString().replace('T', ' ').substring(0, 19)} (UTC)</td></tr>
                    <tr style="background: rgba(255,255,255,0.02);"><td style="padding: 10px; font-weight: bold;">event</td><td style="padding: 10px;">${data.event}</td></tr>
                    <tr><td style="padding: 10px; font-weight: bold;">from</td><td style="padding: 10px;"><a href="#account/${data.from}" class="item-link address-cell">${data.from}</a></td></tr>
                    <tr style="background: rgba(255,255,255,0.02);"><td style="padding: 10px; font-weight: bold;">to</td><td style="padding: 10px;"><a href="#account/${data.to}" class="item-link address-cell">${data.to}</a></td></tr>
                    <tr><td style="padding: 10px; font-weight: bold;">status</td><td style="padding: 10px;"><span class="badge" style="background: ${data.status === 'success' ? 'var(--success)' : 'var(--error)'}; font-size: 11px;">${data.status}</span></td></tr>
                    <tr style="background: rgba(255,255,255,0.02);"><td style="padding: 10px; font-weight: bold;">block</td><td style="padding: 10px;"><a href="#block/${data.block}" class="item-link">${data.block}</a></td></tr>
                </table>
                <div class="json-container">
                    ${renderJSONTree({ hash: data.hash, signer: data.from, method: data.event, extrinsic: data.extrinsic, events: data.events })}
                </div>
            </div>
        `;
        txDetailsContainer.innerHTML = html;
    } catch (e) {
        txDetailsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Error: ${e.message}</div>`;
    }
}

window.addEventListener('hashchange', () => {
    let hash = window.location.hash.substring(1);
    routeTo(hash || 'home');
});

window.copyToClipboard = function (element, text) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = element.innerText;
        element.innerText = 'copied!';
        element.style.color = 'var(--success)';
        setTimeout(() => {
            element.innerText = originalText;
            element.style.color = 'var(--brand-secondary)';
        }, 1500);
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
};

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        // e.preventDefault();

        const target = item.getAttribute('data-target');
        if (!target) return;
        window.location.hash = target;
    });
});

let validatorChart = null;

async function fetchValidatorDetails(address) {
    const container = document.getElementById('validator-details-container');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching validator history...</div>';

    try {
        const res = await fetch(`/api/validator/${address}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const identityStr = data.identity !== "Unknown" ? data.identity : `<span class="address-cell">${address.substring(0, 8)}...</span>`;

        let commissionWarning = '';
        if (data.history.length > 0) {
            const maxComm = Math.max(...data.history.map(h => h.commission));
            if (maxComm > 50) {
                let triggersHtml = '';
                let triggerActionHtml = '';
                if (data.triggers && data.triggers.length > 0) {
                    triggerActionHtml = `
                        <br><button type="button" id="toggle-trigger-events" style="border: 0; background: transparent; color: #ff6b6b; font-weight: bold; text-decoration: underline; margin-top: 5px; display: inline-block; padding: 0; cursor: pointer;">go to trigger events</button>
                    `;
                    triggersHtml = `
                        <div id="trigger-events-log" style="display: none; margin-top: 15px; border-top: 1px solid rgba(255, 50, 50, 0.2); padding-top: 15px;">
                            <strong style="display: block; margin-bottom: 10px;">Trigger Events Log:</strong>
                            <table style="width: 100%; border-collapse: collapse; font-size: 12px; color: #ffcccc;">
                                <thead>
                                    <tr style="border-bottom: 1px solid rgba(255, 50, 50, 0.2);">
                                        <th style="padding: 5px; text-align: left;">Era</th>
                                        <th style="padding: 5px; text-align: left;">Previous Comm.</th>
                                        <th style="padding: 5px; text-align: left;">New Comm.</th>
                                        <th style="padding: 5px; text-align: left;">Time Detected</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${data.triggers.map(t => `
                                        <tr>
                                            <td style="padding: 5px;">${t.era}</td>
                                            <td style="padding: 5px;">${t.prevCommission.toFixed(2)}%</td>
                                            <td style="padding: 5px; color: #ff6b6b; font-weight: bold;">${t.newCommission.toFixed(2)}%</td>
                                            <td style="padding: 5px;">${new Date(t.timestamp).toISOString().replace('T', ' ').substring(0, 19)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    `;
                }

                commissionWarning = `
                    <div style="background: rgba(255, 50, 50, 0.1); border: 1px solid rgba(255, 50, 50, 0.3); padding: 15px; border-radius: 4px; margin-bottom: 20px;">
                        <div style="color: #ff6b6b; font-size: 13px; line-height: 1.5;">
                            Commission increase above threshold detected in validator network; max commission in 30 eras: ${maxComm.toFixed(2)}%; threshold: 50.00%
                            ${triggerActionHtml}
                        </div>
                        ${triggersHtml}
                    </div>
                `;
            }
        }

        let historyTableRows = '';
        data.history.forEach(h => {
            // Using a mock date for display purposes if not indexed properly, or calculate backwards from today
            // We'll just display Era number.
            historyTableRows += `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 12px 10px;">${h.era}</td>
                    <td style="padding: 12px 10px;">${h.commission.toFixed(2)}%</td>
                    <td style="padding: 12px 10px;">${(h.stake / 1000).toFixed(4)} kPDEX</td>
                    <td style="padding: 12px 10px;">${h.apy.toFixed(2)}%</td>
                </tr>
            `;
        });

        if (data.history.length === 0) {
            historyTableRows = '<tr><td colspan="4" style="padding: 20px; text-align: center; color: var(--text-secondary);">Syncing historical eras. Check back later!</td></tr>';
        }

        container.innerHTML = `
            <div class="list-header" style="border-bottom: 1px solid var(--border-color); padding: 20px; display: flex; justify-content: space-between; align-items: center;">
                <h2 style="font-size: 18px;">Validator history - ${identityStr}</h2>
                <a href="#validators" style="color: var(--text-secondary); text-decoration: none;"><i class='bx bx-x' style="font-size: 24px;"></i></a>
            </div>
            
            <div style="padding: 20px;">
                <div style="margin-bottom: 15px;">
                    <strong>Validator:</strong> ${identityStr}
                </div>
                
                ${commissionWarning}
                
                <div style="margin-bottom: 15px;">
                    <strong style="display: block; margin-bottom: 5px;">Address:</strong>
                    <span class="address-cell">${data.address}</span> <span onclick="copyToClipboard(this, '${data.address}')" style="cursor: pointer; color: var(--brand-secondary); font-size: 13px; margin-left: 10px;">copy</span>
                </div>
                <div style="margin-bottom: 25px;">
                    <strong style="display: block; margin-bottom: 5px;">Controller account:</strong>
                    <span class="address-cell">${data.controller}</span> <span onclick="copyToClipboard(this, '${data.controller}')" style="cursor: pointer; color: var(--brand-secondary); font-size: 13px; margin-left: 10px;">copy</span>
                </div>

                <div style="margin-bottom: 25px;">
                    <h3 style="font-size: 14px; margin-bottom: 10px;">Commission trend (30 eras)</h3>
                    <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); border-radius: 4px; padding: 15px; height: 250px;">
                        <canvas id="validatorChartCanvas"></canvas>
                    </div>
                </div>

                <div>
                    <h3 style="font-size: 14px; margin-bottom: 10px;">Historical data</h3>
                    <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
                        <thead>
                            <tr style="background: rgba(255,255,255,0.02); border-bottom: 1px solid rgba(255,255,255,0.05);">
                                <th style="padding: 12px 10px; font-weight: 600;">Era</th>
                                <th style="padding: 12px 10px; font-weight: 600;">Commission</th>
                                <th style="padding: 12px 10px; font-weight: 600;">Stake PDEX</th>
                                <th style="padding: 12px 10px; font-weight: 600;">APY</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${historyTableRows}
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        const triggerToggle = document.getElementById('toggle-trigger-events');
        const triggerLog = document.getElementById('trigger-events-log');
        if (triggerToggle && triggerLog) {
            triggerToggle.addEventListener('click', () => {
                const shouldShow = triggerLog.style.display === 'none';
                triggerLog.style.display = shouldShow ? 'block' : 'none';
                triggerToggle.innerText = shouldShow ? 'hide trigger events' : 'go to trigger events';
                if (shouldShow) triggerLog.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        }

        // Render Chart.js
        if (data.history.length > 0) {
            const ctx = document.getElementById('validatorChartCanvas');
            if (ctx) {
                // Reverse to chronological order for chart
                const chronHistory = [...data.history].reverse();
                const labels = chronHistory.map(h => `Era ${h.era}`);
                const commissions = chronHistory.map(h => h.commission);
                const apys = chronHistory.map(h => h.apy);

                if (validatorChart) validatorChart.destroy();

                validatorChart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [
                            {
                                label: 'Commission (%)',
                                data: commissions,
                                borderColor: '#ff6b6b',
                                backgroundColor: '#ff6b6b',
                                tension: 0.1,
                                borderWidth: 2,
                                pointRadius: 0
                            },
                            {
                                label: 'APY (%)',
                                data: apys,
                                borderColor: '#4d88ff',
                                backgroundColor: '#4d88ff',
                                tension: 0.1,
                                borderWidth: 2,
                                pointRadius: 0
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: {
                            mode: 'index',
                            intersect: false,
                        },
                        plugins: {
                            legend: {
                                position: 'bottom',
                                labels: { color: '#ccc', font: { family: 'Inter', size: 12 } }
                            }
                        },
                        scales: {
                            x: {
                                ticks: { maxTicksLimit: 5, color: '#888' },
                                grid: { color: 'rgba(255,255,255,0.05)' }
                            },
                            y: {
                                ticks: {
                                    callback: function (value) { return value + '%'; },
                                    color: '#888'
                                },
                                grid: { color: 'rgba(255,255,255,0.05)' }
                            }
                        }
                    }
                });
            }
        }

    } catch (e) {
        container.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Error: ${e.message}</div>`;
    }
}

// --- Shared wallet / staking-rewards helpers ---
let stakingRewardsData = null;
let stakingRewardsChart = null;
let stakingRewardsDisplayLimit = 100;
let stakingRewardFilter = 'all';
let stakingUnclaimedPolls = 0;
let walletPriceChart = null;
const WALLET_STORAGE_KEY = 'pdex_wallet_address';

function stakingEscapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}
function stakingShortAddress(addr) {
    if (!addr || addr.length < 18) return addr || '';
    return addr.substring(0, 8) + '…' + addr.substring(addr.length - 6);
}
function stakingFormatPDEX(value) {
    return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}
function stakingFormatNumber(value) {
    return Number(value || 0).toLocaleString('en-US');
}
function isValidPolkadexAddress(addr) {
    try { decodeAddress(addr); return true; }
    catch (e) { return false; }
}
function formatDuration(ms) {
    if (!ms || ms <= 0) return '—';
    const hours = ms / 3600000;
    if (hours < 48) return (Math.round(hours * 10) / 10) + ' hours';
    return (Math.round(hours / 24 * 10) / 10) + ' days';
}
function stakingCsvCell(value) {
    const s = String(value == null ? '' : value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadStakingBlob(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Staking Rewards Page ---
async function loadStakingIndexStatus() {
    const el = document.getElementById('staking-index-status');
    if (!el) return;
    try {
        const res = await fetch('/api/staking-rewards-status');
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const backfill = data.backfillComplete ? 'backfill complete' : 'backfill in progress';
        el.textContent = `Indexer: blocks ${stakingFormatNumber(data.oldestScannedBlock)}–${stakingFormatNumber(data.latestScannedBlock)} · ${stakingFormatNumber(data.totalRewardsIndexed)} payouts · ${backfill}`;
    } catch (e) {
        el.textContent = 'Indexer: status unavailable';
    }
}

function initStakingRewardsPage(address) {
    loadStakingIndexStatus();
    const input = document.getElementById('staking-address-input');
    const errEl = document.getElementById('staking-rewards-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (address) {
        if (input) input.value = address;
        fetchStakingRewards(address);
    }
}

function submitStakingSearch() {
    const input = document.getElementById('staking-address-input');
    const errEl = document.getElementById('staking-rewards-error');
    if (!input) return;
    const addr = input.value.trim();
    if (!addr) {
        if (errEl) { errEl.textContent = 'Please enter a Polkadex wallet address.'; errEl.style.display = 'block'; }
        return;
    }
    if (!isValidPolkadexAddress(addr)) {
        if (errEl) { errEl.textContent = 'That does not look like a valid Polkadex wallet address.'; errEl.style.display = 'block'; }
        return;
    }
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    window.location.hash = 'staking-rewards/' + addr;
}

async function fetchStakingRewards(address, isPoll) {
    const resultsEl = document.getElementById('staking-rewards-results');
    const errEl = document.getElementById('staking-rewards-error');
    if (!resultsEl) return;
    if (errEl && !isPoll) { errEl.style.display = 'none'; errEl.textContent = ''; }

    if (!isValidPolkadexAddress(address)) {
        if (errEl) { errEl.textContent = 'That does not look like a valid Polkadex wallet address.'; errEl.style.display = 'block'; }
        resultsEl.style.display = 'none';
        return;
    }

    if (!isPoll) {
        stakingRewardsDisplayLimit = 100;
        stakingRewardFilter = 'all';
        stakingUnclaimedPolls = 0;
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-secondary);">Loading staking rewards…</div>';
    }

    try {
        const res = await fetch('/api/staking-rewards/' + encodeURIComponent(address));
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        stakingRewardsData = data;
        renderStakingRewards(data);
        // Unpaid rewards are computed in the background; poll until they are ready.
        if (data.unclaimedComputing && stakingUnclaimedPolls < 12) {
            stakingUnclaimedPolls++;
            setTimeout(() => {
                if (stakingRewardsData && stakingRewardsData.address === data.address) fetchStakingRewards(address, true);
            }, 6000);
        }
    } catch (e) {
        if (!isPoll) {
            stakingRewardsData = null;
            resultsEl.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--error);">Error: ${stakingEscapeHtml(e.message)}</div>`;
        }
    }
}

// Merge claimed + unclaimed reward records according to the active filter.
function getFilteredRewards(data, filter) {
    const claimed = (data.claimed || []).map(r => ({ ...r, status: 'claimed' }));
    const unclaimed = (data.unclaimed || []).map(r => ({ ...r, status: 'unclaimed' }));
    let list;
    if (filter === 'claimed') list = claimed.slice();
    else if (filter === 'unclaimed') list = unclaimed.slice();
    else list = claimed.concat(unclaimed);
    list.sort((a, b) => {
        const ea = a.era == null ? -Infinity : a.era;
        const eb = b.era == null ? -Infinity : b.era;
        if (eb !== ea) return eb - ea;
        return (b.block || 0) - (a.block || 0);
    });
    return list;
}

function renderStakingRewards(data) {
    const resultsEl = document.getElementById('staking-rewards-results');
    if (!resultsEl) return;
    const summary = data.summary || {};
    const index = data.index || {};
    const identity = data.identity && data.identity !== 'Unknown' ? data.identity : null;
    const claimedCount = (data.claimed || []).length;
    const unclaimedCount = (data.unclaimed || []).length;

    if (claimedCount === 0 && unclaimedCount === 0) {
        const note = data.unclaimedComputing
            ? 'Unpaid rewards are still being computed — this can take a moment.'
            : (index.backfillComplete
                ? 'The indexer has scanned the full available chain history.'
                : 'The indexer is still backfilling older history — check back shortly.');
        resultsEl.innerHTML = `
            <div class="list-header"><h2>No staking rewards found</h2></div>
            <div style="padding: 32px 24px; color: var(--text-secondary); font-size: 0.9rem; line-height: 1.7;">
                No staking rewards were found for
                <span style="color: var(--brand-secondary);">${stakingEscapeHtml(stakingShortAddress(data.address))}</span>.
                <br>${note}
            </div>`;
        return;
    }

    const rewards = getFilteredRewards(data, stakingRewardFilter);
    const shown = rewards.slice(0, stakingRewardsDisplayLimit);
    let rowsHtml = '';
    shown.forEach(r => {
        const date = r.timestamp ? new Date(r.timestamp).toISOString().replace('T', ' ').substring(0, 19) : '—';
        const validatorCell = r.validator
            ? `<a href="#validator/${encodeURIComponent(r.validator)}" class="item-link" style="color: var(--brand-secondary);">${stakingShortAddress(r.validator)}</a>`
            : '<span style="color: var(--text-muted);">—</span>';
        const blockCell = r.block != null
            ? `<a href="#block/${r.block}" class="item-link" style="color: var(--brand-secondary);">${stakingFormatNumber(r.block)}</a>`
            : '<span style="color: var(--text-muted);">—</span>';
        const statusBadge = r.status === 'claimed'
            ? '<span class="reward-badge claimed">Claimed</span>'
            : '<span class="reward-badge unclaimed">Unpaid</span>';
        rowsHtml += `
            <tr>
                <td>${r.era != null ? r.era : '<span style="color:var(--text-muted);">—</span>'}</td>
                <td style="white-space: nowrap;">${date}</td>
                <td class="staking-amount">${stakingFormatPDEX(r.amount)} PDEX</td>
                <td>${statusBadge}</td>
                <td>${validatorCell}</td>
                <td>${blockCell}</td>
            </tr>`;
    });

    const remaining = rewards.length - shown.length;
    const showMoreHtml = remaining > 0
        ? `<div style="text-align:center; padding: 18px;"><button id="staking-show-more" class="staking-download-btn">Show more (${stakingFormatNumber(remaining)} remaining)</button></div>`
        : '';
    const fbtn = (key, label) => `<button class="reward-filter-btn${stakingRewardFilter === key ? ' active' : ''}" data-filter="${key}">${label}</button>`;
    const computingNote = data.unclaimedComputing
        ? '<div style="padding: 0 24px 14px; color: var(--text-muted); font-size: 0.78rem;">Unpaid rewards are being computed in the background and will appear shortly.</div>'
        : '';

    resultsEl.innerHTML = `
        <div class="list-header">
            <h2>Reward history${identity ? ' — ' + stakingEscapeHtml(identity) : ''}</h2>
            <a href="#account/${encodeURIComponent(data.address)}" class="item-link" style="color: var(--text-secondary); font-size: 0.78rem;">${stakingEscapeHtml(data.address)}</a>
        </div>
        <div class="staking-summary-grid">
            <div class="staking-summary-card"><div class="label">Claimed Rewards</div><div class="value accent">${stakingFormatPDEX(summary.claimedTotal)} PDEX</div></div>
            <div class="staking-summary-card"><div class="label">Unpaid Rewards</div><div class="value" style="color: var(--brand-primary);">${stakingFormatPDEX(summary.unclaimedTotal)} PDEX</div></div>
            <div class="staking-summary-card"><div class="label">Total Rewards</div><div class="value">${stakingFormatPDEX(summary.totalAmount)} PDEX</div></div>
            <div class="staking-summary-card"><div class="label">Claimed Payouts</div><div class="value">${stakingFormatNumber(summary.claimedCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Eras</div><div class="value">${stakingFormatNumber(summary.eraCount)}</div></div>
        </div>
        <div class="staking-chart-wrap"><canvas id="staking-rewards-chart"></canvas></div>
        ${computingNote}
        <div class="staking-toolbar">
            <div class="reward-filter">${fbtn('all', 'All')}${fbtn('claimed', 'Claimed')}${fbtn('unclaimed', 'Unpaid')}</div>
            <div class="staking-toolbar-actions">
                <button class="staking-download-btn" id="staking-dl-csv"><i class='bx bx-download'></i> CSV</button>
                <button class="staking-download-btn" id="staking-dl-json"><i class='bx bx-download'></i> JSON</button>
            </div>
        </div>
        <div class="table-responsive">
            <table class="staking-rewards-table">
                <thead>
                    <tr><th>Era</th><th>Date (UTC)</th><th>Amount</th><th>Status</th><th>Validator</th><th>Block</th></tr>
                </thead>
                <tbody>${rowsHtml || '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-secondary);">No rewards match this filter.</td></tr>'}</tbody>
            </table>
        </div>
        ${showMoreHtml}`;

    resultsEl.querySelectorAll('.reward-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            stakingRewardFilter = btn.getAttribute('data-filter');
            stakingRewardsDisplayLimit = 100;
            renderStakingRewards(stakingRewardsData);
        });
    });
    const csvBtn = document.getElementById('staking-dl-csv');
    if (csvBtn) csvBtn.addEventListener('click', downloadStakingRewardsCSV);
    const jsonBtn = document.getElementById('staking-dl-json');
    if (jsonBtn) jsonBtn.addEventListener('click', downloadStakingRewardsJSON);
    const moreBtn = document.getElementById('staking-show-more');
    if (moreBtn) moreBtn.addEventListener('click', () => {
        stakingRewardsDisplayLimit += 100;
        renderStakingRewards(stakingRewardsData);
    });

    renderStakingRewardsChart(data);
}

function renderStakingRewardsChart(data) {
    const canvas = document.getElementById('staking-rewards-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (stakingRewardsChart) { stakingRewardsChart.destroy(); stakingRewardsChart = null; }

    const claimedByEra = new Map();
    const unclaimedByEra = new Map();
    const eraSet = new Set();
    const addTo = (map, era, amt) => {
        const key = era == null ? 'Unknown' : era;
        map.set(key, (map.get(key) || 0) + amt);
        eraSet.add(key);
    };
    (data.claimed || []).forEach(r => addTo(claimedByEra, r.era, Number(r.amount) || 0));
    (data.unclaimed || []).forEach(r => addTo(unclaimedByEra, r.era, Number(r.amount) || 0));

    const eras = [...eraSet].filter(e => e !== 'Unknown').sort((a, b) => a - b);
    if (eraSet.has('Unknown')) eras.push('Unknown');
    if (eras.length === 0) return;
    const labels = eras.map(e => e === 'Unknown' ? 'Unknown' : 'Era ' + e);

    stakingRewardsChart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                { label: 'Claimed', data: eras.map(e => claimedByEra.get(e) || 0), backgroundColor: 'rgba(0, 230, 118, 0.6)', borderColor: '#00E676', borderWidth: 1, borderRadius: 3 },
                { label: 'Unpaid', data: eras.map(e => unclaimedByEra.get(e) || 0), backgroundColor: 'rgba(230, 0, 122, 0.55)', borderColor: '#E6007A', borderWidth: 1, borderRadius: 3 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 11 } } },
                tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + Number(ctx.parsed.y).toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' PDEX' } }
            },
            scales: {
                x: { stacked: true, ticks: { maxTicksLimit: 12, color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { stacked: true, ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
            }
        }
    });
}

function downloadStakingRewardsCSV() {
    if (!stakingRewardsData) return;
    const rows = getFilteredRewards(stakingRewardsData, stakingRewardFilter);
    const lines = [['Era', 'Date (UTC)', 'Amount (PDEX)', 'Status', 'Validator', 'Block', 'Block Hash'].join(',')];
    rows.forEach(r => {
        const date = r.timestamp ? new Date(r.timestamp).toISOString().replace('T', ' ').substring(0, 19) : '';
        lines.push([
            r.era != null ? r.era : '',
            date,
            Number(r.amount || 0).toFixed(6),
            r.status || '',
            r.validator || '',
            r.block != null ? r.block : '',
            r.blockHash || ''
        ].map(stakingCsvCell).join(','));
    });
    downloadStakingBlob(`staking-rewards-${stakingRewardFilter}-${stakingRewardsData.address || 'address'}.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function downloadStakingRewardsJSON() {
    if (!stakingRewardsData) return;
    const payload = {
        address: stakingRewardsData.address,
        identity: stakingRewardsData.identity,
        generatedAt: new Date().toISOString(),
        summary: stakingRewardsData.summary,
        index: stakingRewardsData.index,
        claimed: stakingRewardsData.claimed,
        unclaimed: stakingRewardsData.unclaimed
    };
    downloadStakingBlob(`staking-rewards-${stakingRewardsData.address || 'address'}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

// --- Read-only Wallet Connect + Dashboard ---
function getStoredWallet() {
    try { return localStorage.getItem(WALLET_STORAGE_KEY) || ''; }
    catch (e) { return ''; }
}
function setStoredWallet(addr) {
    try { if (addr) localStorage.setItem(WALLET_STORAGE_KEY, addr); else localStorage.removeItem(WALLET_STORAGE_KEY); }
    catch (e) { }
}
function refreshConnectWalletButton() {
    const label = document.getElementById('connect-wallet-label');
    const disconnectBtn = document.getElementById('disconnect-wallet-btn');
    const stored = getStoredWallet();
    if (label) label.textContent = stored ? stakingShortAddress(stored) : 'Connect Wallet';
    if (disconnectBtn) disconnectBtn.style.display = stored ? 'inline-flex' : 'none';
}

// Enumerate accounts from installed Substrate wallet extensions (read-only).
async function getInjectedAccounts() {
    const injected = window.injectedWeb3;
    if (!injected || Object.keys(injected).length === 0) return null;
    const accounts = [];
    for (const key of Object.keys(injected)) {
        try {
            const provider = injected[key];
            if (!provider || typeof provider.enable !== 'function') continue;
            const ext = await provider.enable('Polkadex Explorer');
            if (ext && ext.accounts && typeof ext.accounts.get === 'function') {
                const accs = await ext.accounts.get();
                for (const a of accs) accounts.push({ address: a.address, name: a.name || key, source: key });
            }
        } catch (e) { /* user rejected this extension */ }
    }
    return accounts;
}

function connectWallet() {
    const stored = getStoredWallet();
    window.location.hash = stored ? ('wallet/' + stored) : 'wallet';
}
function selectWallet(address) {
    if (!isValidPolkadexAddress(address)) return;
    setStoredWallet(address);
    refreshConnectWalletButton();
    window.location.hash = 'wallet/' + address;
}
function disconnectWallet() {
    setStoredWallet('');
    refreshConnectWalletButton();
    // If the user is currently on a wallet page, return them to the connect panel.
    const hash = window.location.hash.replace(/^#/, '');
    if (hash.startsWith('wallet')) {
        if (hash === 'wallet') {
            const root = document.getElementById('wallet-dashboard');
            if (root) renderWalletConnectPanel(root);
        } else {
            window.location.hash = 'wallet';
        }
    }
}

function initWalletPage(address) {
    const root = document.getElementById('wallet-dashboard');
    if (!root) return;
    if (address) {
        if (isValidPolkadexAddress(address)) fetchWalletDashboard(address);
        else root.innerHTML = '<div class="list-container glass" style="padding:32px;color:var(--error);">Invalid Polkadex address.</div>';
        return;
    }
    renderWalletConnectPanel(root);
}

async function renderWalletConnectPanel(root) {
    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header"><h2>Connect Wallet</h2><span style="color:var(--text-secondary);font-size:0.78rem;">Read-only mode</span></div>
            <div style="padding: 24px;">
                <p style="color: var(--text-secondary); font-size: 0.88rem; margin-bottom: 16px; line-height: 1.6;">
                    Connect a Substrate wallet extension to open your dashboard. The explorer only reads your
                    address — it can never request a signature or move funds.
                </p>
                <div id="wallet-accounts" style="display:flex; flex-direction:column; gap:10px;">
                    <div style="color: var(--text-muted); font-size: 0.85rem;">Looking for wallet extensions…</div>
                </div>
                <div style="margin-top: 22px; border-top: 1px solid var(--border-color); padding-top: 18px;">
                    <p style="color: var(--text-secondary); font-size: 0.82rem; margin-bottom: 10px;">…or view any address in read-only mode:</p>
                    <div class="staking-search-bar">
                        <input type="text" id="wallet-manual-input" placeholder="Polkadex address" autocomplete="off" spellcheck="false">
                        <button id="wallet-manual-btn"><i class='bx bx-search'></i> View</button>
                    </div>
                    <div id="wallet-manual-error" class="staking-error" style="display:none;"></div>
                </div>
            </div>
        </div>`;

    const manualBtn = document.getElementById('wallet-manual-btn');
    const manualInput = document.getElementById('wallet-manual-input');
    const manualErr = document.getElementById('wallet-manual-error');
    const submitManual = () => {
        const addr = (manualInput.value || '').trim();
        if (!isValidPolkadexAddress(addr)) {
            manualErr.textContent = 'That does not look like a valid Polkadex address.';
            manualErr.style.display = 'block';
            return;
        }
        selectWallet(addr);
    };
    if (manualBtn) manualBtn.addEventListener('click', submitManual);
    if (manualInput) manualInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitManual(); });

    const accountsEl = document.getElementById('wallet-accounts');
    const accounts = await getInjectedAccounts();
    if (accounts === null) {
        accountsEl.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem; line-height: 1.6;">
            No Substrate wallet extension detected. Install
            <a href="https://polkadot.js.org/extension/" target="_blank" rel="noopener" style="color:var(--brand-secondary);">Polkadot.js</a>,
            Talisman or SubWallet, or use the read-only address option below.</div>`;
        return;
    }
    if (accounts.length === 0) {
        accountsEl.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No accounts were shared. Authorise this site in your wallet extension and try again.</div>';
        return;
    }
    accountsEl.innerHTML = accounts.map(a => `
        <button class="wallet-account-btn" data-address="${stakingEscapeHtml(a.address)}">
            <span class="wallet-account-name">${stakingEscapeHtml(a.name)}</span>
            <span class="wallet-account-addr">${stakingShortAddress(a.address)}</span>
        </button>`).join('');
    accountsEl.querySelectorAll('.wallet-account-btn').forEach(btn => {
        btn.addEventListener('click', () => selectWallet(btn.getAttribute('data-address')));
    });
}

async function fetchWalletDashboard(address) {
    const root = document.getElementById('wallet-dashboard');
    if (!root) return;
    root.innerHTML = '<div class="list-container glass" style="padding:40px;text-align:center;color:var(--text-secondary);">Loading wallet dashboard…</div>';
    try {
        const [walletRes, priceRes] = await Promise.all([
            fetch('/api/wallet/' + encodeURIComponent(address)),
            fetch('/api/price-history?days=30').catch(() => null)
        ]);
        const data = await walletRes.json();
        if (!walletRes.ok || data.error) throw new Error(data.error || ('Request failed (' + walletRes.status + ')'));
        let price = { history: [], configured: false };
        if (priceRes) { try { price = await priceRes.json(); } catch (e) { } }
        renderWalletDashboard(data, price);
    } catch (e) {
        root.innerHTML = `<div class="list-container glass" style="padding:40px;text-align:center;color:var(--error);">Error: ${stakingEscapeHtml(e.message)}</div>`;
    }
}

function renderWalletDashboard(data, price) {
    const root = document.getElementById('wallet-dashboard');
    if (!root) return;
    const identity = data.identity && data.identity !== 'Unknown' ? data.identity : null;
    const staking = data.staking || {};
    const rewards = data.rewards || {};
    const network = data.network || {};
    const balance = data.balance || {};

    const validatorsHtml = (staking.nominating && staking.nominating.length)
        ? staking.nominating.map(v => `
            <a href="#validator/${encodeURIComponent(v.address)}" class="wallet-validator-row item-link">
                <span>${v.name && v.name !== 'Unknown' ? stakingEscapeHtml(v.name) : stakingShortAddress(v.address)}</span>
                <i class='bx bx-chevron-right'></i>
            </a>`).join('')
        : '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 8px 0;">This wallet is not nominating any validators.</div>';

    const txHtml = (data.recentTransactions && data.recentTransactions.length)
        ? data.recentTransactions.map(t => {
            const dir = t.from === data.address ? 'out' : 'in';
            const date = t.timestamp ? new Date(t.timestamp).toLocaleDateString('en-US') : '—';
            return `<tr>
                <td><a href="#tx/${t.block}/${t.hash}" class="item-link" style="color:var(--brand-secondary);">${stakingShortAddress(t.hash)}</a></td>
                <td><span class="reward-badge ${dir === 'out' ? 'unclaimed' : 'claimed'}">${dir === 'out' ? 'Sent' : 'Received'}</span></td>
                <td>${stakingEscapeHtml(t.amount || '—')}</td>
                <td style="white-space:nowrap;">${date}</td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-muted);">No recent transactions.</td></tr>';

    const recentRewardsHtml = (rewards.recentClaimed && rewards.recentClaimed.length)
        ? rewards.recentClaimed.map(r => `<tr>
            <td>${r.era != null ? r.era : '—'}</td>
            <td class="staking-amount">${stakingFormatPDEX(r.amount)} PDEX</td>
            <td style="white-space:nowrap;">${r.timestamp ? new Date(r.timestamp).toLocaleDateString('en-US') : '—'}</td>
          </tr>`).join('')
        : '<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--text-muted);">No claimed rewards indexed yet.</td></tr>';

    const priceConfigured = price && price.configured;
    const priceHistory = (price && price.history) || [];
    const latestPrice = data.price || (price && price.latest) || null;

    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header">
                <h2><i class='bx bx-wallet'></i> ${identity ? stakingEscapeHtml(identity) : 'Wallet Dashboard'}</h2>
                <div style="display:flex; gap:14px; align-items:center;">
                    <a href="#staking-rewards/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">Full reward history</a>
                    <button id="wallet-switch-btn" class="staking-download-btn">Switch wallet</button>
                </div>
            </div>
            <div style="padding: 12px 24px 0;">
                <a href="#account/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--text-secondary);font-size:0.78rem;">${stakingEscapeHtml(data.address)}</a>
            </div>
            <div class="staking-summary-grid">
                <div class="staking-summary-card"><div class="label">Total Balance</div><div class="value accent">${stakingFormatPDEX(balance.total)} PDEX</div></div>
                <div class="staking-summary-card"><div class="label">Total Staked</div><div class="value">${stakingFormatPDEX(staking.totalStaked)} PDEX</div></div>
                <div class="staking-summary-card"><div class="label">Claimed Rewards</div><div class="value">${stakingFormatPDEX(rewards.claimedTotal)} PDEX</div></div>
                <div class="staking-summary-card"><div class="label">Unpaid Rewards</div><div class="value" style="color:var(--brand-primary);">${stakingFormatPDEX(rewards.unpaidTotal)} PDEX${rewards.unclaimedFresh ? '' : ' <span style="font-size:0.6rem;color:var(--text-muted);">computing…</span>'}</div></div>
            </div>
        </div>

        <div class="wallet-grid">
            <div class="list-container glass">
                <div class="list-header"><h2>PDEX Price (30d)</h2>${latestPrice ? `<span style="color:var(--brand-secondary);font-size:0.85rem;">$${Number(latestPrice.price).toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>` : ''}</div>
                <div class="staking-chart-wrap" style="height:220px;">
                    ${priceHistory.length ? '<canvas id="wallet-price-chart"></canvas>' : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.85rem;text-align:center;padding:0 20px;">${priceConfigured ? 'Collecting price history — the chart fills in as data is polled.' : 'Price feed not configured (set CMC_API_KEY on the backend).'}</div>`}
                </div>
            </div>
            <div class="list-container glass">
                <div class="list-header"><h2>Staking Overview</h2></div>
                <div class="wallet-stat-list">
                    <div class="wallet-stat"><span>Total Staked</span><strong>${stakingFormatPDEX(staking.totalStaked)} PDEX</strong></div>
                    <div class="wallet-stat"><span>Minimum Stake</span><strong>${stakingFormatPDEX(network.minStake)} PDEX</strong></div>
                    <div class="wallet-stat"><span>Active Nominators</span><strong>${stakingFormatNumber(network.activeNominators)} / ${stakingFormatNumber(network.totalNominators)}</strong></div>
                    <div class="wallet-stat"><span>Active Validators</span><strong>${stakingFormatNumber(network.activeValidators)} / ${stakingFormatNumber(network.totalValidators)}</strong></div>
                    <div class="wallet-stat"><span>Staking Period (era)</span><strong>${formatDuration(network.eraDurationMs)}</strong></div>
                    <div class="wallet-stat"><span>Unstaking Period</span><strong>${formatDuration(network.unbondingMs)}</strong></div>
                    <div class="wallet-stat"><span>Current Era</span><strong>${stakingFormatNumber(network.currentEra)}</strong></div>
                </div>
            </div>
        </div>

        <div class="wallet-grid">
            <div class="list-container glass">
                <div class="list-header"><h2>My Validators</h2><span style="color:var(--text-secondary);font-size:0.78rem;">${(staking.nominating || []).length} nominated</span></div>
                <div style="padding: 8px 24px 20px;">${validatorsHtml}</div>
            </div>
            <div class="list-container glass">
                <div class="list-header"><h2>Recent Staking Rewards</h2><a href="#staking-rewards/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">View all</a></div>
                <div class="table-responsive">
                    <table class="staking-rewards-table">
                        <thead><tr><th>Era</th><th>Amount</th><th>Date</th></tr></thead>
                        <tbody>${recentRewardsHtml}</tbody>
                    </table>
                </div>
            </div>
        </div>

        <div class="list-container glass">
            <div class="list-header"><h2>Recent Transactions</h2><a href="#account/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">View account</a></div>
            <div class="table-responsive">
                <table class="staking-rewards-table">
                    <thead><tr><th>Hash</th><th>Direction</th><th>Amount</th><th>Date</th></tr></thead>
                    <tbody>${txHtml}</tbody>
                </table>
            </div>
        </div>`;

    const switchBtn = document.getElementById('wallet-switch-btn');
    if (switchBtn) switchBtn.addEventListener('click', disconnectWallet);
    if (priceHistory.length) renderWalletPriceChart(priceHistory);
}

function renderWalletPriceChart(history) {
    const canvas = document.getElementById('wallet-price-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (walletPriceChart) { walletPriceChart.destroy(); walletPriceChart = null; }
    walletPriceChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: history.map(p => new Date(p.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
            datasets: [{
                label: 'PDEX / USD',
                data: history.map(p => p.price),
                borderColor: '#00E676',
                backgroundColor: 'rgba(0, 230, 118, 0.12)',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: 0.25
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ' $' + Number(ctx.parsed.y).toLocaleString('en-US', { maximumFractionDigits: 6 }) } }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 8, color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { ticks: { color: '#888', callback: v => '$' + v }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

// --- Donate Page ---
const DONATION_ADDRESSES = [
    { category: 'Coins', asset: 'BTC', network: 'Bitcoin', address: 'bc1qlugkf7vv94yrr4vm54xrjx2zwj9q0cs76pz200', uri: 'bitcoin:' },
    { category: 'Coins', asset: 'ETH', network: 'Ethereum', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a', uri: 'ethereum:' },
    { category: 'Coins', asset: 'SOL', network: 'Solana', address: 'H4LTvHcqhP9bqXpEkM1JFBvnh9f8HAfMe66r6pBWD7E7', uri: 'solana:' },
    { category: 'Coins', asset: 'BNB', network: 'BNB Smart Chain', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Coins', asset: 'TRX', network: 'Tron', address: 'TEnrQfBoVpT8q5cscRAYTzA2bqA9b5qWwA', uri: 'tron:' },
    { category: 'Coins', asset: 'DOT', network: 'Polkadot', address: '13wPMFBWzDyNY3DJutMN7b6PJai5PRmW9aTSuS4oDMqnzumL' },
    { category: 'Coins', asset: 'POL', network: 'Polygon', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Coins', asset: 'ETH', network: 'Arbitrum', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Coins', asset: 'ADA', network: 'Cardano', address: 'addr1q9szq9mef3wlvdgu95lqgqcvjjeuv998u4nfpeuf4cmlsx9vl55478r077m3v6677thhy6zjdc6hrmaum9nx4l49wtrsn5wq7q' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Tron', address: 'TEnrQfBoVpT8q5cscRAYTzA2bqA9b5qWwA' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Ethereum', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Solana', address: 'H4LTvHcqhP9bqXpEkM1JFBvnh9f8HAfMe66r6pBWD7E7' },
    { category: 'Stablecoins', asset: 'USDT', network: 'BNB Smart Chain', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Base', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Arbitrum', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Polygon', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDC', network: 'Ethereum', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDC', network: 'Solana', address: 'H4LTvHcqhP9bqXpEkM1JFBvnh9f8HAfMe66r6pBWD7E7' },
    { category: 'Stablecoins', asset: 'USDC', network: 'Base', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDC', network: 'BNB Smart Chain', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDC', network: 'Polygon', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Crypto.org', address: 'cro1sz7rjpwmfyqdsyvhpnpe5ttlczgwn62kzxeuum' }
];
let donatePageRendered = false;

function initDonatePage() {
    const root = document.getElementById('donate-content');
    if (!root || donatePageRendered) return;

    const donateCard = d => {
        const addr = stakingEscapeHtml(d.address);
        const openLink = d.uri
            ? `<a class="donate-open" href="${d.uri}${addr}"><i class='bx bx-wallet'></i> Open in wallet</a>`
            : '';
        return `
        <div class="donate-card">
            <div class="donate-card-head">
                <span class="donate-asset">${stakingEscapeHtml(d.asset)}</span>
                <span class="donate-network">${stakingEscapeHtml(d.network)}</span>
            </div>
            <div class="donate-qr" data-address="${addr}"></div>
            <div class="donate-address" title="${addr}">${addr}</div>
            <div class="donate-actions">
                <button class="donate-copy" data-address="${addr}"><i class='bx bx-copy'></i> Copy address</button>
                ${openLink}
            </div>
        </div>`;
    };

    const coins = DONATION_ADDRESSES.filter(d => d.category === 'Coins');
    const stables = DONATION_ADDRESSES.filter(d => d.category === 'Stablecoins');

    root.innerHTML = `
        <div class="list-container glass donate-hero">
            <h1>Support the Polkadex Explorer</h1>
            <p>This explorer is a free, community-run window into the Polkadex network — no ads, no trackers, no paywalls. Behind the scenes, though, archive RPC nodes, servers, price feeds and continuous development all cost real money and time to keep running.</p>
            <p>If it has ever helped you check a transaction, track a validator or understand your staking rewards, please consider chipping in. A contribution of any size — in any coin, on any network — keeps the data flowing, the project independent, and the explorer free and open for the whole community. Thank you for your support; it means a great deal.</p>
            <p class="donate-note">To donate, scan a QR code with your wallet app or copy the address for the coin and network you use. Pick whichever of the 20+ supported networks below is easiest for you.</p>
        </div>
        <div class="donate-section-title">Coins</div>
        <div class="donate-grid">${coins.map(donateCard).join('')}</div>
        <div class="donate-section-title">Stablecoins &mdash; USDT &amp; USDC</div>
        <div class="donate-grid">${stables.map(donateCard).join('')}</div>
        <div class="donate-disclaimer"><i class='bx bx-info-circle'></i> Always double-check the asset, address and network before sending. Funds sent to the wrong network may be unrecoverable.</div>`;

    // Render a QR code for every address.
    root.querySelectorAll('.donate-qr').forEach(el => {
        const addr = el.getAttribute('data-address');
        if (typeof QRCode !== 'undefined') {
            try {
                new QRCode(el, {
                    text: addr,
                    width: 116,
                    height: 116,
                    colorDark: '#0d0d12',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.M
                });
            } catch (e) {
                el.innerHTML = '<span class="donate-qr-fallback">QR unavailable</span>';
            }
        } else {
            el.innerHTML = '<span class="donate-qr-fallback">QR unavailable</span>';
        }
    });

    // Copy-to-clipboard buttons.
    root.querySelectorAll('.donate-copy').forEach(btn => {
        btn.addEventListener('click', () => {
            const addr = btn.getAttribute('data-address');
            const done = () => {
                const original = btn.innerHTML;
                btn.innerHTML = "<i class='bx bx-check'></i> Copied!";
                btn.classList.add('copied');
                setTimeout(() => { btn.innerHTML = original; btn.classList.remove('copied'); }, 1600);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(addr).then(done).catch(() => { });
            }
        });
    });

    donatePageRendered = true;
}

// --- Discussion Board ---
const DISCUSS_TOKEN_KEY = 'pdex_discuss_session';

function getDiscussSession() {
    try {
        const raw = localStorage.getItem(DISCUSS_TOKEN_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || !s.token || !s.address) return null;
        const connected = getStoredWallet();
        if (connected && connected !== s.address) return null;
        return s;
    } catch (e) { return null; }
}

function initDiscussionsPage(threadId) {
    if (threadId) fetchDiscussionThread(threadId);
    else fetchDiscussionThreads();
}

async function fetchDiscussionThreads() {
    const root = document.getElementById('discussions-content');
    if (!root) return;
    root.innerHTML = '<div class="list-container glass" style="padding:40px;text-align:center;color:var(--text-secondary);">Loading discussions…</div>';
    try {
        const res = await fetch('/api/discussions');
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
        renderThreadList(data.threads || []);
    } catch (e) {
        root.innerHTML = `<div class="list-container glass" style="padding:40px;text-align:center;color:var(--error);">Error: ${stakingEscapeHtml(e.message)}</div>`;
    }
}

function renderThreadList(threads) {
    const root = document.getElementById('discussions-content');
    if (!root) return;
    const proposals = threads.filter(t => t.kind === 'proposal');
    const motions = threads.filter(t => t.kind === 'motion');
    const card = t => {
        const badge = t.status === 'open'
            ? '<span class="reward-badge claimed">Open</span>'
            : '<span class="reward-badge unclaimed">Closed</span>';
        const meta = `${t.postCount} post${t.postCount === 1 ? '' : 's'}` +
            (t.status === 'closed' && t.closedReason ? ' · ' + stakingEscapeHtml(t.closedReason) : '');
        return `<a class="discussion-thread-row" href="#discussions/${encodeURIComponent(t.id)}">
            <div class="discussion-thread-main">
                <span class="discussion-thread-title">${stakingEscapeHtml(t.title || t.id)}</span>
                <span class="discussion-thread-meta">${meta}</span>
            </div>
            ${badge}
        </a>`;
    };
    const section = (title, items) => `
        <div class="list-container glass" style="margin-bottom:20px;">
            <div class="list-header"><h2>${title}</h2><span style="color:var(--text-secondary);font-size:0.8rem;">${items.length}</span></div>
            <div style="padding:8px 0;">
                ${items.length ? items.map(card).join('') : '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.86rem;">No threads yet — one is created automatically when a proposal or motion appears on-chain.</div>'}
            </div>
        </div>`;
    root.innerHTML = `
        <div class="list-container glass" style="margin-bottom:20px;">
            <div class="list-header"><h2>Discussions</h2></div>
            <div style="padding:18px 24px;color:var(--text-secondary);font-size:0.88rem;line-height:1.6;">
                A discussion thread opens automatically for every public proposal and council motion. Each thread locks for new posts once its proposal moves to a referendum (voting) or its motion concludes. Sign in with your Substrate wallet to take part.
            </div>
        </div>
        ${section('Public Proposals', proposals)}
        ${section('Council Motions', motions)}`;
}

async function fetchDiscussionThread(id) {
    const root = document.getElementById('discussions-content');
    if (!root) return;
    root.innerHTML = '<div class="list-container glass" style="padding:40px;text-align:center;color:var(--text-secondary);">Loading discussion…</div>';
    try {
        const res = await fetch('/api/discussions/' + encodeURIComponent(id));
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
        renderThread(data.thread, data.posts || []);
    } catch (e) {
        root.innerHTML = `<div class="list-container glass" style="padding:40px;text-align:center;color:var(--error);">Error: ${stakingEscapeHtml(e.message)}</div>`;
    }
}

function renderThread(thread, posts) {
    const root = document.getElementById('discussions-content');
    if (!root) return;
    const session = getDiscussSession();
    const postsHtml = posts.length
        ? posts.map(p => `
            <div class="discussion-post">
                <div class="discussion-post-head">
                    <a href="#account/${encodeURIComponent(p.author)}" class="item-link" style="color:var(--brand-secondary);font-weight:600;">${stakingEscapeHtml(p.authorName && p.authorName !== 'Unknown' ? p.authorName : stakingShortAddress(p.author))}</a>
                    <span style="color:var(--text-muted);font-size:0.75rem;">${new Date(p.createdAt).toLocaleString('en-US')}</span>
                </div>
                <div class="discussion-post-body">${stakingEscapeHtml(p.content).replace(/\n/g, '<br>')}</div>
            </div>`).join('')
        : '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.86rem;">No posts yet — be the first to comment.</div>';

    let composer;
    if (thread.status === 'closed') {
        composer = `<div class="discussion-closed-note"><i class='bx bx-lock-alt'></i> ${stakingEscapeHtml(thread.closedReason || 'This discussion is closed.')}</div>`;
    } else if (!session) {
        composer = `<div class="discussion-composer">
            <p style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:10px;">Sign in with your Substrate wallet to join this discussion. You will sign a short message — no transaction, no fees.</p>
            <button id="discuss-signin-btn" class="staking-download-btn"><i class='bx bx-log-in'></i> Sign in with wallet</button>
            <div id="discuss-post-error" class="staking-error" style="display:none;"></div>
        </div>`;
    } else {
        composer = `<div class="discussion-composer">
            <div style="color:var(--text-secondary);font-size:0.78rem;margin-bottom:8px;">Posting as <span style="color:var(--brand-secondary);">${stakingShortAddress(session.address)}</span></div>
            <textarea id="discuss-post-input" class="discussion-textarea" placeholder="Share your thoughts…" maxlength="4000"></textarea>
            <div style="display:flex;justify-content:flex-end;margin-top:8px;">
                <button id="discuss-post-btn" class="staking-download-btn" style="background:var(--brand-primary);color:#fff;border-color:var(--brand-primary);"><i class='bx bx-send'></i> Post</button>
            </div>
            <div id="discuss-post-error" class="staking-error" style="display:none;"></div>
        </div>`;
    }

    const badge = thread.status === 'open'
        ? '<span class="reward-badge claimed">Open</span>'
        : '<span class="reward-badge unclaimed">Closed</span>';
    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header">
                <h2 style="display:flex;align-items:center;gap:10px;">${stakingEscapeHtml(thread.title || thread.id)} ${badge}</h2>
                <a href="#discussions" class="item-link" style="color:var(--text-secondary);font-size:0.8rem;">All discussions</a>
            </div>
            <div class="discussion-posts">${postsHtml}</div>
            ${composer}
        </div>`;

    const signinBtn = document.getElementById('discuss-signin-btn');
    if (signinBtn) signinBtn.addEventListener('click', async () => {
        signinBtn.disabled = true;
        signinBtn.innerHTML = "<i class='bx bx-loader-alt'></i> Check your wallet…";
        const ok = await discussSignIn();
        if (ok) fetchDiscussionThread(thread.id);
        else { signinBtn.disabled = false; signinBtn.innerHTML = "<i class='bx bx-log-in'></i> Sign in with wallet"; }
    });
    const postBtn = document.getElementById('discuss-post-btn');
    if (postBtn) postBtn.addEventListener('click', () => submitDiscussionPost(thread.id));
}

// Locate an extension signer that can sign for the given address.
async function getWalletSigner(address) {
    const injected = window.injectedWeb3;
    if (!injected) return null;
    for (const key of Object.keys(injected)) {
        try {
            const provider = injected[key];
            if (!provider || typeof provider.enable !== 'function') continue;
            const ext = await provider.enable('Polkadex Explorer');
            if (ext && ext.accounts && ext.accounts.get && ext.signer && ext.signer.signRaw) {
                const accs = await ext.accounts.get();
                if (accs.some(a => a.address === address)) return ext.signer;
            }
        } catch (e) { /* user rejected this extension */ }
    }
    return null;
}

async function discussSignIn() {
    const address = getStoredWallet();
    if (!address) { alert('Connect your wallet first using the button in the top-right.'); return false; }
    try {
        const challRes = await fetch('/api/auth/challenge', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address })
        });
        const chall = await challRes.json();
        if (!challRes.ok || chall.error) throw new Error(chall.error || 'Could not start sign-in.');
        const signer = await getWalletSigner(address);
        if (!signer) throw new Error('Could not reach a wallet extension that holds this address.');
        const signed = await signer.signRaw({ address, data: chall.message, type: 'bytes' });
        const verRes = await fetch('/api/auth/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, signature: signed.signature })
        });
        const ver = await verRes.json();
        if (!verRes.ok || ver.error) throw new Error(ver.error || 'Verification failed.');
        localStorage.setItem(DISCUSS_TOKEN_KEY, JSON.stringify({ token: ver.token, address }));
        return true;
    } catch (e) {
        alert('Sign-in failed: ' + e.message);
        return false;
    }
}

async function submitDiscussionPost(threadId) {
    const input = document.getElementById('discuss-post-input');
    const errEl = document.getElementById('discuss-post-error');
    const btn = document.getElementById('discuss-post-btn');
    if (!input) return;
    const content = input.value.trim();
    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
    if (!content) { showErr('Write something before posting.'); return; }
    const session = getDiscussSession();
    if (!session) { showErr('Your session has expired — please sign in again.'); fetchDiscussionThread(threadId); return; }
    if (btn) btn.disabled = true;
    if (errEl) errEl.style.display = 'none';
    try {
        const res = await fetch('/api/discussions/' + encodeURIComponent(threadId) + '/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token },
            body: JSON.stringify({ content })
        });
        const data = await res.json();
        if (res.status === 401) { localStorage.removeItem(DISCUSS_TOKEN_KEY); throw new Error('Session expired — please sign in again.'); }
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to post.');
        renderThread(data.thread, data.posts || []);
    } catch (e) {
        showErr(e.message);
        if (btn) btn.disabled = false;
    }
}

// --- Democracy Page ---
let democracyData = null;
let democracyTab = 'overview';
let democracyVoteChart = null;
let democracyTurnoutChart = null;
let democracyTurnoutPctChart = null;

function initDemocracyPage() {
    democracyTab = 'overview';
    fetchDemocracyData();
}

async function fetchDemocracyData() {
    const root = document.getElementById('democracy-content');
    if (!root) return;
    root.innerHTML = '<div class="list-container glass" style="padding:40px;text-align:center;color:var(--text-secondary);">Loading democracy data…</div>';
    try {
        const res = await fetch('/api/democracy');
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
        democracyData = data;
        renderDemocracy();
    } catch (e) {
        root.innerHTML = `<div class="list-container glass" style="padding:40px;text-align:center;color:var(--error);">Error: ${stakingEscapeHtml(e.message)}</div>`;
    }
}

function renderDemocracy() {
    const root = document.getElementById('democracy-content');
    if (!root || !democracyData) return;
    const d = democracyData;
    const tabBtn = (key, label) => `<button class="account-tab${democracyTab === key ? ' active' : ''}" data-demtab="${key}">${label}</button>`;
    let body;
    if (democracyTab === 'referenda') body = renderDemocracyReferenda(d);
    else if (democracyTab === 'proposals') body = renderDemocracyProposals(d);
    else if (democracyTab === 'statistics') body = renderDemocracyStatisticsBody(d);
    else body = renderDemocracyOverview(d);

    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header">
                <h2>Democracy</h2>
                <span style="color:var(--text-secondary);font-size:0.78rem;">${d.status === 'Synced' ? 'Synced' : stakingEscapeHtml(d.status || 'Initializing')}</span>
            </div>
            <div class="account-tabs" style="margin:0 24px;">
                ${tabBtn('overview', 'Overview')}${tabBtn('referenda', 'Referenda')}${tabBtn('proposals', 'Public Proposals')}${tabBtn('statistics', 'Statistics')}
            </div>
            <div style="padding:24px;">${body}</div>
        </div>`;

    root.querySelectorAll('[data-demtab]').forEach(btn => {
        btn.addEventListener('click', () => { democracyTab = btn.getAttribute('data-demtab'); renderDemocracy(); });
    });
    if (democracyTab === 'statistics') renderDemocracyCharts(d);
}

function renderDemocracyOverview(d) {
    const lp = Number(d.launchPeriod) || 0;
    const into = lp > 0 ? (d.currentBlock % lp) : 0;
    const remaining = lp > 0 ? (lp - into) : 0;
    const pct = lp > 0 ? Math.floor(into / lp * 100) : 0;
    const remSecs = remaining * 12;
    const remDays = Math.floor(remSecs / 86400);
    const remHrs = Math.floor((remSecs % 86400) / 3600);
    const ext = d.externalProposal;
    return `
        <div class="staking-summary-grid">
            <div class="staking-summary-card"><div class="label">Referenda (total)</div><div class="value accent">${stakingFormatNumber(d.referendumCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Public Proposals (total)</div><div class="value">${stakingFormatNumber(d.publicPropCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Active Referenda</div><div class="value">${stakingFormatNumber(d.activeReferenda)}</div></div>
            <div class="staking-summary-card"><div class="label">Active Proposals</div><div class="value">${stakingFormatNumber(d.activeProposals)}</div></div>
            <div class="staking-summary-card"><div class="label">Launch Period</div><div class="value">${pct}%</div></div>
        </div>
        <div class="wallet-stat-list" style="padding:14px 0 0;">
            <div class="wallet-stat"><span>Launch period length</span><strong>${stakingFormatNumber(lp)} blocks</strong></div>
            <div class="wallet-stat"><span>Next referendum launch in</span><strong>~${remDays}d ${remHrs}h &middot; ${stakingFormatNumber(remaining)} blocks</strong></div>
            <div class="wallet-stat"><span>Current block</span><strong>${stakingFormatNumber(d.currentBlock)}</strong></div>
            <div class="wallet-stat"><span>External proposal</span><strong>${ext ? 'Queued' + (ext.threshold ? ' (' + stakingEscapeHtml(ext.threshold) + ')' : '') : 'None'}</strong></div>
        </div>`;
}

function democracyStatusBadge(s) {
    if (s === 'Ongoing') return '<span class="reward-badge claimed">Ongoing</span>';
    if (s === 'Passed') return '<span class="reward-badge claimed">Passed</span>';
    return '<span class="reward-badge unclaimed">Not Passed</span>';
}

function renderDemocracyReferenda(d) {
    const refs = d.referenda || [];
    if (!refs.length) return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No referenda indexed yet.</div>';
    let rows = '';
    refs.forEach(r => {
        const dash = '<span style="color:var(--text-muted);">&mdash;</span>';
        const tally = r.tallyKnown ? `${stakingFormatPDEX(r.ayes)} / ${stakingFormatPDEX(r.nays)}` : dash;
        rows += `<tr>
            <td>#${r.refIndex}</td>
            <td>${democracyStatusBadge(r.status)}</td>
            <td style="text-align:right;">${tally}</td>
            <td style="text-align:right;">${r.tallyKnown ? stakingFormatPDEX(r.turnout) : dash}</td>
            <td style="text-align:right;">${stakingFormatNumber(r.endBlock)}</td>
        </tr>`;
    });
    return `<div class="table-responsive"><table class="data-table">
        <thead><tr><th>Referendum</th><th>Status</th><th style="text-align:right;">Ayes / Nays (PDEX)</th><th style="text-align:right;">Turnout</th><th style="text-align:right;">End Block</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}

function renderDemocracyProposals(d) {
    const props = d.publicProposals || [];
    if (!props.length) return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No active public proposals. Proposals appear here while they await tabling to a referendum.</div>';
    let rows = '';
    props.forEach(p => {
        const who = p.proposerName && p.proposerName !== 'Unknown' ? p.proposerName : stakingShortAddress(p.proposer);
        rows += `<tr>
            <td>#${p.index}</td>
            <td><a href="#account/${encodeURIComponent(p.proposer)}" class="item-link" style="color:var(--brand-secondary);">${stakingEscapeHtml(who)}</a></td>
            <td style="text-align:right;">${stakingFormatPDEX(p.deposit)} PDEX</td>
            <td style="text-align:right;">${stakingFormatNumber(p.seconds)}</td>
            <td style="text-align:right;"><a href="#discussions/proposal-${p.index}" class="item-link" style="color:var(--brand-secondary);">Discuss</a></td>
        </tr>`;
    });
    return `<div class="table-responsive"><table class="data-table">
        <thead><tr><th>Proposal</th><th>Proposer</th><th style="text-align:right;">Deposit</th><th style="text-align:right;">Seconds</th><th style="text-align:right;">Discussion</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}

function renderDemocracyStatisticsBody(d) {
    const known = (d.referenda || []).filter(r => r.tallyKnown).length;
    const note = known === 0
        ? '<div style="padding:0 0 16px;color:var(--text-muted);font-size:0.83rem;line-height:1.6;">Vote tallies are still being collected. Tallies for ongoing referenda are captured live; historical tallies are recovered when the node serves archive state.</div>'
        : '';
    return note + `
        <div class="staking-chart-wrap" style="height:300px;padding:10px 0 0;"><canvas id="dem-vote-chart"></canvas></div>
        <div class="wallet-grid" style="margin-top:18px;">
            <div>
                <div style="color:var(--text-secondary);font-size:0.8rem;font-weight:600;margin-bottom:4px;">Turnout per Referendum (PDEX)</div>
                <div class="staking-chart-wrap" style="height:230px;padding:6px 0 0;"><canvas id="dem-turnout-chart"></canvas></div>
            </div>
            <div>
                <div style="color:var(--text-secondary);font-size:0.8rem;font-weight:600;margin-bottom:4px;">Turnout % of Total Issuance</div>
                <div class="staking-chart-wrap" style="height:230px;padding:6px 0 0;"><canvas id="dem-turnoutpct-chart"></canvas></div>
            </div>
        </div>`;
}

function renderDemocracyCharts(d) {
    if (typeof Chart === 'undefined') return;
    [democracyVoteChart, democracyTurnoutChart, democracyTurnoutPctChart].forEach(c => { if (c) c.destroy(); });
    democracyVoteChart = democracyTurnoutChart = democracyTurnoutPctChart = null;

    const refs = (d.referenda || []).filter(r => r.tallyKnown).slice().sort((a, b) => a.refIndex - b.refIndex);
    if (!refs.length) return;
    const labels = refs.map(r => '#' + r.refIndex);
    const axis = (extra) => Object.assign({
        ticks: { color: '#888', maxTicksLimit: 14 }, grid: { color: 'rgba(255,255,255,0.05)' }
    }, extra || {});

    const voteCanvas = document.getElementById('dem-vote-chart');
    if (voteCanvas) {
        democracyVoteChart = new Chart(voteCanvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { label: 'Ayes', data: refs.map(r => r.ayes || 0), backgroundColor: 'rgba(0,230,118,0.6)', borderColor: '#00E676', borderWidth: 1 },
                    { label: 'Nays', data: refs.map(r => r.nays || 0), backgroundColor: 'rgba(230,0,122,0.55)', borderColor: '#E6007A', borderWidth: 1 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 11 } } },
                    title: { display: true, text: 'Vote Trend — Ayes vs Nays (PDEX)', color: '#ccc' }
                },
                scales: { x: axis({ stacked: true }), y: axis({ stacked: true, beginAtZero: true, maxTicksLimit: 8 }) }
            }
        });
    }
    const turnoutCanvas = document.getElementById('dem-turnout-chart');
    if (turnoutCanvas) {
        democracyTurnoutChart = new Chart(turnoutCanvas.getContext('2d'), {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Turnout', data: refs.map(r => r.turnout || 0), backgroundColor: 'rgba(124,108,255,0.6)', borderColor: '#7c6cff', borderWidth: 1 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: axis({ maxTicksLimit: 12 }), y: axis({ beginAtZero: true, maxTicksLimit: 6 }) }
            }
        });
    }
    const pctCanvas = document.getElementById('dem-turnoutpct-chart');
    if (pctCanvas) {
        const issuance = Number(d.totalIssuance) || 0;
        democracyTurnoutPctChart = new Chart(pctCanvas.getContext('2d'), {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Turnout %', data: refs.map(r => issuance > 0 ? (r.turnout / issuance * 100) : 0), backgroundColor: 'rgba(124,108,255,0.6)', borderColor: '#7c6cff', borderWidth: 1 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + ctx.parsed.y.toFixed(3) + '%' } } },
                scales: { x: axis({ maxTicksLimit: 12 }), y: axis({ beginAtZero: true, maxTicksLimit: 6, ticks: { color: '#888', callback: v => v + '%' } }) }
            }
        });
    }
}

// --- Event wiring: staking rewards + wallet connect ---
const stakingSearchBtn = document.getElementById('staking-search-btn');
if (stakingSearchBtn) stakingSearchBtn.addEventListener('click', submitStakingSearch);
const stakingAddressInput = document.getElementById('staking-address-input');
const stakingClearBtn = document.getElementById('staking-clear-btn');
const stakingPasteBtn = document.getElementById('staking-paste-btn');

if (stakingAddressInput) {
    stakingAddressInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitStakingSearch();
    });
    stakingAddressInput.addEventListener('input', () => {
        if (stakingClearBtn) {
            stakingClearBtn.style.display = stakingAddressInput.value.length > 0 ? 'inline-block' : 'none';
        }
    });
}

if (stakingClearBtn) {
    stakingClearBtn.addEventListener('click', () => {
        if (stakingAddressInput) {
            stakingAddressInput.value = '';
            stakingClearBtn.style.display = 'none';
            stakingAddressInput.focus();
        }
    });
}

if (stakingPasteBtn) {
    stakingPasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (stakingAddressInput) {
                stakingAddressInput.value = text.trim();
                if (stakingClearBtn) stakingClearBtn.style.display = 'inline-block';
                stakingAddressInput.focus();
            }
        } catch (err) {
            console.error('Failed to read clipboard contents: ', err);
            alert('Failed to access clipboard. Please paste manually.');
        }
    });
}
const connectWalletBtn = document.getElementById('connect-wallet-btn');
if (connectWalletBtn) connectWalletBtn.addEventListener('click', connectWallet);
const disconnectWalletBtn = document.getElementById('disconnect-wallet-btn');
if (disconnectWalletBtn) disconnectWalletBtn.addEventListener('click', disconnectWallet);
refreshConnectWalletButton();

setInterval(() => {
    renderBlocks();
    if (transactions.length > 0) renderTransactions();
}, 10000);

// --- Council Module Logic ---
let councilPalletName = 'elections'; // overridden by the /api/council response

async function fetchCouncilData() {
    try {
        const response = await fetch('/api/council');
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        if (data.pallet) councilPalletName = data.pallet;

        const members = Array.isArray(data.members) ? data.members : [];
        const runnersUp = Array.isArray(data.runnersUp) ? data.runnersUp : [];
        const candidates = Array.isArray(data.candidates) ? data.candidates : [];
        const termDuration = Number(data.termDuration) || 0;
        const blocksRemaining = Number(data.blocksRemaining) || 0;

        document.getElementById('council-seats-count').innerText = `${members.length}/${data.desiredMembers || 0}`;
        document.getElementById('council-runnersup-count').innerText = runnersUp.length;
        document.getElementById('council-candidates-count').innerText = candidates.length;

        // Term progress (guarded against a zero/missing term duration).
        const pct = termDuration > 0
            ? Math.min(100, Math.max(0, Math.floor(((termDuration - blocksRemaining) / termDuration) * 100)))
            : 0;
        document.getElementById('council-progress-pct').innerText = `${pct}%`;
        document.getElementById('council-progress-arc').style.strokeDasharray = `${pct}, 100`;

        // Polkadex block time is ~12s
        const remainingSeconds = blocksRemaining * 12;
        const days = Math.floor(remainingSeconds / (24 * 3600));
        const hours = Math.floor((remainingSeconds % (24 * 3600)) / 3600);
        document.getElementById('council-term-remaining').innerText = `${days} days ${hours} hrs`;

        const renderList = (list, elementId) => {
            const el = document.getElementById(elementId);
            if (!el) return;
            if (!list || list.length === 0) {
                el.innerHTML = '<tr><td colspan="2" style="text-align:center; padding:20px;">No accounts found</td></tr>';
                return;
            }
            el.innerHTML = list.map(item => {
                const addr = stakingEscapeHtml(item.address);
                return `
                <tr style="background: rgba(255,255,255,0.02);">
                    <td>
                        <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">${stakingEscapeHtml(item.name || 'Unknown')}</div>
                        <div class="address-cell" style="font-size: 13px;">${addr} <span onclick="copyToClipboard(this, '${addr}')" style="cursor: pointer; color: var(--brand-secondary); margin-left: 8px;">copy</span></div>
                    </td>
                    <td style="text-align: right; font-weight: 600;">
                        ${Number(item.stake || 0).toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX
                    </td>
                </tr>`;
            }).join('');
        };

        renderList(members, 'council-members-list');
        renderList(runnersUp, 'council-runnersup-list');
        renderList(candidates, 'council-candidates-list');
    } catch (err) {
        console.error('Failed to fetch council data', err);
        const failMsg = '<tr><td colspan="2" style="text-align:center; padding:20px; color: var(--error);">Failed to load council data.</td></tr>';
        ['council-members-list', 'council-runnersup-list', 'council-candidates-list'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = failMsg;
        });
    }
}

// Tab switching
const councilTabs = document.querySelectorAll('.council-page .account-tab');
councilTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        councilTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const targetId = tab.getAttribute('data-tab');
        document.querySelectorAll('.council-page .account-tab-content').forEach(c => {
            c.classList.remove('active');
            c.style.display = 'none';
        });
        const activeContent = document.getElementById(targetId);
        if (activeContent) {
            activeContent.classList.add('active');
            activeContent.style.display = 'block';
        }
    });
});

// Modals
const candidacyModal = document.getElementById('council-candidacy-modal');
const voteModal = document.getElementById('council-vote-modal');

if (document.getElementById('council-submit-candidacy-btn')) {
    document.getElementById('council-submit-candidacy-btn').addEventListener('click', () => {
        candidacyModal.style.display = 'flex';
        checkWalletForCouncil('candidacy');
    });
}
if (document.getElementById('close-candidacy-modal')) {
    document.getElementById('close-candidacy-modal').addEventListener('click', () => {
        candidacyModal.style.display = 'none';
    });
}

if (document.getElementById('council-vote-btn')) {
    document.getElementById('council-vote-btn').addEventListener('click', () => {
        voteModal.style.display = 'flex';
        checkWalletForCouncil('vote');
    });
}
if (document.getElementById('close-vote-modal')) {
    document.getElementById('close-vote-modal').addEventListener('click', () => {
        voteModal.style.display = 'none';
    });
}

function checkWalletForCouncil(modalType) {
    const address = getStoredWallet();
    const activeDivId = modalType === 'candidacy' ? 'candidacy-active-wallet' : '';
    const warningId = modalType === 'candidacy' ? 'candidacy-modal-wallet-warning' : 'vote-modal-wallet-warning';
    
    if (!address) {
        document.getElementById(warningId).style.display = 'block';
        if (activeDivId) document.getElementById(activeDivId).innerText = '--';
        return;
    }
    
    document.getElementById(warningId).style.display = 'none';
    if (activeDivId) document.getElementById(activeDivId).innerText = address;
}

async function submitCouncilCandidacy() {
    const address = getStoredWallet();
    if (!address) return alert('Please connect your wallet first');
    
    try {
        const injected = await getInjectedAccounts();
        if (!injected || injected.length === 0) return alert('No wallet extension found. Please install Polkadot.js or Talisman.');
        
        const account = injected.find(a => a.address === address);
        if (!account) return alert('Connected account not found in wallet extension. Please reconnect.');
        
        const provider = window.injectedWeb3[account.source];
        const ext = await provider.enable('Polkadex Explorer');
        
        document.getElementById('submit-candidacy-tx-btn').innerText = 'Signing...';
        
        const response = await fetch('/api/council');
        const data = await response.json();
        const candidateCount = (data.candidates || []).length;

        const unsub = await globalApi.tx[councilPalletName].submitCandidacy(candidateCount)
            .signAndSend(address, { signer: ext.signer }, ({ status }) => {
                if (status.isInBlock) {
                    alert(`Transaction included at blockHash ${status.asInBlock}`);
                    candidacyModal.style.display = 'none';
                    unsub();
                    document.getElementById('submit-candidacy-tx-btn').innerText = 'Sign & Submit Candidacy';
                }
            });
            
    } catch (err) {
        console.error(err);
        alert('Transaction failed: ' + err.message);
        document.getElementById('submit-candidacy-tx-btn').innerText = 'Sign & Submit Candidacy';
    }
}

if (document.getElementById('submit-candidacy-tx-btn')) {
    document.getElementById('submit-candidacy-tx-btn').addEventListener('click', submitCouncilCandidacy);
}

async function submitCouncilVote() {
    const address = getStoredWallet();
    if (!address) return alert('Please connect your wallet first');
    
    const candidatesInput = document.getElementById('vote-candidates-input').value;
    const stakeInput = document.getElementById('vote-stake-input').value;
    
    if (!candidatesInput || !stakeInput) return alert('Please fill in all fields');
    
    const candidates = candidatesInput.split(',').map(a => a.trim()).filter(a => a);
    if (candidates.length > 16) return alert('You can vote for a maximum of 16 candidates');
    if (candidates.length === 0) return alert('Please provide at least one candidate address');
    
    const stakeAmount = parseFloat(stakeInput);
    if (isNaN(stakeAmount) || stakeAmount <= 0) return alert('Invalid stake amount');
    const stakePlanck = BigInt(Math.floor(stakeAmount * (10 ** 12)));
    
    try {
        const injected = await getInjectedAccounts();
        if (!injected || injected.length === 0) return alert('No wallet extension found.');
        
        const account = injected.find(a => a.address === address);
        if (!account) return alert('Connected account not found in wallet extension.');
        
        const provider = window.injectedWeb3[account.source];
        const ext = await provider.enable('Polkadex Explorer');
        
        document.getElementById('submit-vote-tx-btn').innerText = 'Signing...';
        
        const unsub = await globalApi.tx[councilPalletName].vote(candidates, stakePlanck.toString())
            .signAndSend(address, { signer: ext.signer }, ({ status }) => {
                if (status.isInBlock) {
                    alert(`Transaction included at blockHash ${status.asInBlock}`);
                    voteModal.style.display = 'none';
                    unsub();
                    document.getElementById('submit-vote-tx-btn').innerText = 'Sign & Submit Vote';
                }
            });
            
    } catch (err) {
        console.error(err);
        alert('Transaction failed: ' + err.message);
        document.getElementById('submit-vote-tx-btn').innerText = 'Sign & Submit Vote';
    }
}

if (document.getElementById('submit-vote-tx-btn')) {
    document.getElementById('submit-vote-tx-btn').addEventListener('click', submitCouncilVote);
}

// --- Treasury Module Logic ---
async function fetchTreasuryData() {
    try {
        const response = await fetch('/api/treasury');
        const data = await response.json();
        if (data.error) throw new Error(data.error);

        const proposals = Array.isArray(data.proposals) ? data.proposals : [];
        const approvals = Array.isArray(data.approvals) ? data.approvals : [];
        
        document.getElementById('treasury-open-count').innerText = proposals.length;
        document.getElementById('treasury-approved-count').innerText = approvals.length;
        document.getElementById('treasury-total-count').innerText = data.proposalCount || 0;
        
        // Next burn
        const spendableFunds = Number(data.spendableFunds) || 0;
        let burnAmount = 0;
        if (data.burn && data.burn > 0 && spendableFunds > 0) {
             burnAmount = spendableFunds * (data.burn / 1000000000); // Usually a Permill (1000000)
        }
        document.getElementById('treasury-next-burn').innerText = formatPDEX(burnAmount);
        
        // Spendable / Available
        const spendableFormatted = formatPDEX(spendableFunds);
        document.getElementById('treasury-spendable').innerText = spendableFormatted;
        document.getElementById('treasury-available').innerText = spendableFormatted;

        // Spend period
        const termDuration = Number(data.spendPeriod) || 0;
        const blocksRemaining = Number(data.blocksRemaining) || 0;
        const pct = termDuration > 0
            ? Math.min(100, Math.max(0, Math.floor(((termDuration - blocksRemaining) / termDuration) * 100)))
            : 0;
        
        const pctEl = document.getElementById('treasury-spend-pct');
        const arcEl = document.getElementById('treasury-spend-arc');
        if (pctEl) pctEl.innerText = `${pct}%`;
        if (arcEl) arcEl.style.strokeDasharray = `${pct}, 100`;

        const remainingSeconds = blocksRemaining * 12;
        const days = Math.floor(remainingSeconds / (24 * 3600));
        const hours = Math.floor((remainingSeconds % (24 * 3600)) / 3600);
        document.getElementById('treasury-spend-days').innerText = days;
        document.getElementById('treasury-spend-hours').innerText = hours;

        // Render Open Proposals
        const renderProposalsList = () => {
            const el = document.getElementById('treasury-proposals-list');
            if (!el) return;
            el.innerHTML = '';
            if (proposals.length === 0) {
                el.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px;">No open proposals</td></tr>';
                return;
            }
            proposals.forEach(p => {
                const tr = document.createElement('tr');
                
                // Column 1: ID
                const tdId = document.createElement('td');
                tdId.innerText = p.id;
                
                // Column 2: Beneficiary and Value
                const tdBeneficiary = document.createElement('td');
                tdBeneficiary.innerHTML = `
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            ${p.beneficiaryName && p.beneficiaryName !== p.beneficiary ? `<i class='bx bxs-check-circle' style="color: var(--success-color);"></i>` : ''}
                            <span style="font-size: 11px; text-transform: uppercase;">${p.beneficiaryName || shortenAddress(p.beneficiary)}</span>
                        </div>
                        <div style="font-weight: 600;">${formatPDEX(p.value)} <span style="font-size: 11px; color: var(--text-secondary); font-weight: normal;">PDEX</span></div>
                    </div>
                `;

                // Column 3: Proposer and Action
                const tdProposer = document.createElement('td');
                tdProposer.innerHTML = `
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 20px;">
                        <div></div>
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <div style="text-align: right;">
                                <div style="display: flex; align-items: center; justify-content: flex-end; gap: 6px;">
                                    ${p.proposerName && p.proposerName !== p.proposer ? `<i class='bx bxs-check-circle' style="color: var(--success-color);"></i>` : ''}
                                    <span style="font-size: 11px; text-transform: uppercase;">${p.proposerName || shortenAddress(p.proposer)}</span>
                                </div>
                                <div style="font-size: 11px; color: var(--text-secondary);">${formatPDEX(p.bond)} PDEX</div>
                            </div>
                            <div class="glass" style="padding: 4px 10px; border-radius: 4px; font-size: 11px; display: flex; align-items: center; gap: 6px; cursor: pointer;">
                                <i class='bx bx-fast-forward' ></i> To council <i class='bx bx-chevron-down' ></i>
                            </div>
                        </div>
                    </div>
                `;

                tr.appendChild(tdId);
                tr.appendChild(tdBeneficiary);
                tr.appendChild(tdProposer);
                el.appendChild(tr);
            });
        };
        renderProposalsList();

        // Render Approved Proposals
        const renderApprovedList = () => {
            const el = document.getElementById('treasury-approved-list');
            if (!el) return;
            if (approvals.length === 0) {
                el.innerHTML = '<tr><td style="text-align:center; padding: 20px; color: var(--text-secondary);">No approved proposals</td></tr>';
            } else {
                el.innerHTML = `<tr><td style="padding: 20px; color: var(--text-secondary);">IDs: ${approvals.join(', ')}</td></tr>`;
            }
        };
        renderApprovedList();

    } catch (err) {
        console.error('Error fetching treasury data:', err);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const submitBtn = document.getElementById('treasury-submit-btn');
    if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
            if (!activeSigner) {
                alert('Please connect your wallet first by clicking "Connect Wallet" at the top right.');
                return;
            }
            const amtStr = prompt("Enter the amount of PDEX you want to request from the Treasury:");
            if (!amtStr) return;
            const amt = parseFloat(amtStr);
            if (isNaN(amt) || amt <= 0) {
                alert("Invalid amount.");
                return;
            }
            
            const beneficiary = prompt("Enter the beneficiary address:");
            if (!beneficiary || beneficiary.trim() === '') return;

            const confirmMsg = `Submit Treasury Spend Proposal?\n\nAmount: ${amt} PDEX\nBeneficiary: ${beneficiary}\nProposer: ${activeSigner.address}\n\nA bond (usually 5% of the amount) will be reserved from your account.`;
            
            if (confirm(confirmMsg)) {
                try {
                    const api = await getApi();
                    // value is requested in Planck (10^12)
                    const valuePlanck = BigInt(Math.floor(amt * 1e12)).toString();
                    
                    const tx = api.tx.treasury.proposeSpend(valuePlanck, beneficiary);
                    
                    const injector = await window.injectedWeb3['polkadot-js'].enable('Polkadex Explorer');
                    await tx.signAndSend(activeSigner.address, { signer: injector.signer }, ({ status, dispatchError }) => {
                        if (status.isInBlock) {
                            console.log(`Completed at block hash #${status.asInBlock.toString()}`);
                        } else {
                            console.log(`Current status: ${status.type}`);
                        }
                    });
                    alert("Treasury proposal transaction submitted! Please check your extension.");
                } catch (e) {
                    console.error(e);
                    alert("Failed to submit proposal: " + e.message);
                }
            }
        });
    }
});

init();
