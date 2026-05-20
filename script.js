import { ApiPromise, WsProvider } from '@polkadot/api';

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
const mobileToggle = document.querySelector('.mobile-toggle');
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
mobileToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
});

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
                        <td style="padding: 12px 20px;" class="address-cell">${data.account}</td>
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

setInterval(() => {
    renderBlocks();
    if (transactions.length > 0) renderTransactions();
}, 10000);

init();
