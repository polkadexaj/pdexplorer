import { ApiPromise, WsProvider } from '@polkadot/api';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';

// Polkadex chain SS58 prefix. Addresses encoded with this prefix all start
// with the character "e", which is what we want to show the user — even
// though wallet extensions hand back addresses in their own native format
// (typically prefix 0 "1…" for Polkadot or prefix 42 "5…" for generic
// Substrate). All display sites run through toPolkadexAddress() so the UI
// shows the chain-specific form consistently.
const POLKADEX_SS58 = 88;
function toPolkadexAddress(addr) {
    if (!addr) return '';
    try { return encodeAddress(decodeAddress(addr), POLKADEX_SS58); }
    catch (e) { return addr; }
}

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
            // Only repaint the dashboard widgets when the user is actually
            // viewing the home page — avoids flicker when they deep-linked to
            // another route.
            const onHome = () => {
                const path = (window.location.pathname || '/').replace(/^\/+|\/+$/g, '');
                return path === '' || path === 'home';
            };
            if (txRes) {
                const txData = await txRes.json();
                if (txData.transactions && txData.transactions.length > 0) {
                    transactions = financialTransactionRows(txData.transactions);
                    if (onHome()) renderTransactions();
                }
            }
            if (bRes) {
                const bData = await bRes.json();
                if (bData.blocks && bData.blocks.length > 0) {
                    blocks = bData.blocks;
                    if (onHome()) renderBlocks();
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

    // Initialize routing once after data subscriptions are ready. The router
    // boot wires popstate + the delegated click handler and rewrites any
    // legacy "#X" URL to a clean "/X" URL so canonical/og:url stay accurate.
    bootSeoRouter();
    routeTo(readRouteFromLocation());
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
                    <a href="/block/${block.number}" class="item-title">${block.number}</a>
                    <div class="item-sub">
                        Hash: <a href="/block/${block.hash}" class="item-link">${block.hash.substring(0, 10)}...</a>
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
            ? `<a href="/block/${tx.block}" class="item-title">${shortHash}</a>`
            : `<a href="/tx/${tx.block}/${tx.hash}" class="item-title">${shortHash}</a>`;

        el.innerHTML = `
            <div class="item-main">
                <div class="item-icon"><i class='bx bx-transfer'></i></div>
                <div class="item-details">
                    ${titleHtml}
                    <div class="item-sub">
                        From: ${tx.from === 'System' ? shortFrom : `<a href="/account/${tx.from}" class="item-link">${shortFrom}</a>`}
                    </div>
                    <div class="item-sub">
                        To: ${tx.to === tx.amount ? shortTo : `<a href="/account/${tx.to}" class="item-link">${shortTo}</a>`}
                    </div>
                </div>
            </div>
            <div class="item-meta">
                <span class="item-amount">${tx.amount}</span>
                <span class="item-time">${timeAgo(tx.timestamp)} / Block <a href="/block/${tx.block}" class="item-link">${tx.block}</a></span>
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
                <td class="address-cell"><a href="/validator/${val.address}" class="item-link">${shortAddr}</a></td>
                <td><a href="/validator/${val.address}" class="item-link">${val.name}</a></td>
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
                <td class="address-cell"><a href="/account/${val.address}" class="item-link">${shortAddr}</a></td>
                <td><a href="/account/${val.address}" class="item-link">${val.name}</a></td>
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
            ? `<a href="/block/${tx.block}" class="item-link">${shortHash}</a>`
            : `<a href="/tx/${tx.block}/${tx.hash}" class="item-link">${shortHash}</a>`;

        html += `
            <tr>
                <td class="address-cell">${hashCell}</td>
                <td>${tx.from === 'System' ? shortFrom : `<a href="/account/${tx.from}" class="item-link">${shortFrom}</a>`}</td>
                <td>${tx.to === tx.amount ? shortTo : `<a href="/account/${tx.to}" class="item-link">${shortTo}</a>`}</td>
                <td style="color: var(--text-secondary);">${dateStr}</td>
                <td><a href="/block/${tx.block}" class="item-link">${tx.block}</a></td>
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
                <td><a href="/block/${b.number}" class="item-link">${b.number}</a></td>
                <td style="color: var(--text-secondary);">${timeAgo(b.timestamp)}</td>
                <td>${b.authorName && b.authorName !== "Unknown" && b.authorName !== "System" && !b.authorName.startsWith("Validator") ? `<a href="/account/${b.authorAddress}" class="item-link">${b.authorName}</a>` : `<a href="/account/${b.authorAddress}" class="address-cell item-link">${b.authorAddress.substring(0, 8)}...</a>`}</td>
                <td style="font-weight: 500;">${b.extrinsicsCount}</td>
                <td style="font-weight: 500;">${b.eventsCount}</td>
                <td class="address-cell"><a href="/block/${b.hash}" class="item-link">${shortHash}</a></td>
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
            ? `<a href="/tx/${ev.block}/${ev.txHash}" class="item-link" style="font-size: 13px; color: var(--brand-secondary); opacity: 0.8;">tx: ${shortHash}</a>`
            : `<span style="font-size: 13px; color: var(--text-secondary); opacity: 0.8;">event: ${shortHash}</span>`;
        const statusColor = ev.status === 'failed' ? 'var(--error)' : 'var(--success)';

        html += `
            <div class="event-list-item">
                <div>
                    <a href="/block/${ev.block}" class="item-link" style="display: block; font-size: 15px; margin-bottom: 5px;">${ev.block}</a>
                    ${eventLink}
                </div>
                <div>
                    <div style="font-weight: 500; font-size: 14px; margin-bottom: 5px;">${actionStr}</div>
                    <div style="font-size: 13px; color: var(--text-secondary);">
                        signer:<br>
                        <a href="/account/${ev.signerAddress}" class="item-link" style="font-size: 13px;">${identityStr}</a>
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
                navigateTo('search');
                performSearch(query);
            }
        }
    });
}

// The deep-search button has two modes:
//   - "deep" (default): label "Deep Search Network", triggers an on-chain RPC
//     lookup via deepSearchNetwork().
//   - "back": shown after a successful deep-search result lands. Repurposes
//     the same button as "← Back to search", returning the user to the local
//     search view. The dataset attribute keeps the state on the element so
//     we don't have to swap event listeners on the fly.
function setDeepSearchButtonMode(mode) {
    if (!deepSearchBtn) return;
    if (mode === 'back') {
        deepSearchBtn.dataset.mode = 'back';
        deepSearchBtn.innerHTML = "<i class='bx bx-arrow-back' style=\"vertical-align:middle;\"></i> Back to search";
        deepSearchBtn.style.borderColor = 'var(--border-color)';
        deepSearchBtn.style.background  = 'rgba(255,255,255,0.05)';
        deepSearchBtn.style.display = '';
    } else if (mode === 'hidden') {
        // No query yet — the inline prompt below has its own Search button,
        // so a second deep-search button down here would be redundant noise.
        deepSearchBtn.dataset.mode = 'hidden';
        deepSearchBtn.style.display = 'none';
    } else {
        deepSearchBtn.dataset.mode = 'deep';
        deepSearchBtn.textContent = 'Deep Search Network';
        deepSearchBtn.style.borderColor = 'var(--brand-primary)';
        deepSearchBtn.style.background  = 'rgba(229,0,122,0.1)';
        deepSearchBtn.style.display = '';
    }
}

// Empty-state for /search: shows a prominent search box with paste + clear
// affordances, focused and ready to type into. Triggered when the user lands
// on /search via a page refresh (where currentSearchQuery has been lost), or
// when they explicitly cleared a previous query. `note` is an optional banner
// rendered above the input — used to explain why we got here (e.g. "type a
// query before searching the network").
function renderSearchPrompt(note) {
    if (!searchResultsContainer) return;
    if (searchQueryDisplay) searchQueryDisplay.textContent = '';
    // Hide the header text ("Search Results for: ") since there are no results.
    const header = document.querySelector('.search-page .list-header h2');
    if (header) header.style.display = 'none';
    setDeepSearchButtonMode('hidden');

    searchResultsContainer.innerHTML = `
        <div style="text-align: center; padding: 32px 16px;">
            <h3 style="margin: 0 0 10px; font-size: 1.25rem;">Search the Polkadex Mainnet</h3>
            <p style="color: var(--text-secondary); margin: 0 auto 22px; font-size: 0.88rem; max-width: 540px; line-height: 1.55;">
                Look up a block number, block hash, transaction hash, or account address. The local index is checked first;
                you can also drill into the chain RPC directly with <strong>Deep Search</strong>.
            </p>
            ${note ? `<div style="color: var(--brand-secondary); font-size: 0.85rem; margin-bottom: 14px;">${stakingEscapeHtml(note)}</div>` : ''}
            <div class="inline-search-bar" style="display: flex; gap: 8px; max-width: 640px; margin: 0 auto; flex-wrap: wrap;">
                <input id="inline-search-input" type="text" inputmode="search"
                    placeholder="12345 · 0xhash · es1…address"
                    autocomplete="off" spellcheck="false"
                    style="flex: 1 1 240px; min-width: 0; padding: 12px 14px; background: rgba(255,255,255,0.04); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92rem;">
                <button id="inline-search-paste-btn" type="button" title="Paste from clipboard" aria-label="Paste"
                    style="padding: 10px 14px; background: transparent; border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); cursor: pointer; font-size: 1.05rem;">
                    <i class='bx bx-paste'></i>
                </button>
                <button id="inline-search-clear-btn" type="button" title="Clear" aria-label="Clear"
                    style="padding: 10px 14px; background: transparent; border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); cursor: pointer; font-size: 1.05rem;">
                    <i class='bx bx-x'></i>
                </button>
                <button id="inline-search-submit-btn" type="button"
                    style="padding: 10px 22px; background: var(--brand-primary); border: 0; border-radius: 6px; color: #fff; font-weight: 600; cursor: pointer;">
                    Search
                </button>
            </div>
            <p style="color: var(--text-muted); font-size: 0.78rem; margin-top: 14px;">
                Tip: pressing <kbd style="padding: 1px 5px; border: 1px solid var(--border-color); border-radius: 3px; font-family: inherit;">Enter</kbd> submits.
            </p>
        </div>`;

    const inputEl  = document.getElementById('inline-search-input');
    const submitBtn = document.getElementById('inline-search-submit-btn');
    const pasteBtn  = document.getElementById('inline-search-paste-btn');
    const clearBtn  = document.getElementById('inline-search-clear-btn');

    const submit = () => {
        const q = (inputEl && inputEl.value || '').trim();
        if (!q) { if (inputEl) inputEl.focus(); return; }
        // Sync the topbar input too so users see what they searched for.
        if (searchInput) searchInput.value = q;
        // Restore header visibility before performSearch repaints the container.
        if (header) header.style.display = '';
        performSearch(q);
    };
    if (submitBtn) submitBtn.addEventListener('click', submit);
    if (inputEl) {
        inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        // Focus on next tick so the cursor lands in the field after layout settles.
        setTimeout(() => inputEl.focus(), 30);
    }
    if (pasteBtn) pasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text && inputEl) { inputEl.value = text.trim(); inputEl.focus(); }
        } catch (e) {
            // Clipboard API unavailable (insecure context, or user denied).
            // Fall back to selecting the field so the user can paste manually.
            if (inputEl) inputEl.focus();
        }
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
        if (inputEl) { inputEl.value = ''; inputEl.focus(); }
    });
}

if (deepSearchBtn) {
    // Initialise to deep mode (matches the static HTML defaults).
    setDeepSearchButtonMode('deep');
    deepSearchBtn.addEventListener('click', () => {
        if (deepSearchBtn.dataset.mode === 'back') {
            // Go back to the local search view. performSearch() resets the
            // button to "deep" mode internally so it's ready for re-use.
            performSearch(currentSearchQuery);
        } else {
            deepSearchNetwork(currentSearchQuery);
        }
    });
}

async function performSearch(query) {
    currentSearchQuery = query;
    // Always reset the deep-search button to its default state when a fresh
    // local search starts. If a previous deep-search result had left the
    // button in "Back to search" mode (or the empty-state prompt had hidden
    // it), this puts it back to "Deep Search Network" so the user can drill
    // deeper from any new query.
    setDeepSearchButtonMode('deep');
    // The empty-state prompt hides the page's H2 header; restore it.
    const header = document.querySelector('.search-page .list-header h2');
    if (header) header.style.display = '';
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

// Parse a fetch Response that we *expect* to be JSON, but might not be when
// the backend is timed out / restarting / errored at the nginx (or Cloudflare)
// layer — those return their own HTML error pages on 502/504/521. Returns
// the JSON body on success, or throws a short, friendly message instead of
// the raw "Unexpected token '<'". The caller decides how to prefix it for
// display, so the message itself is just the status + hint + a sanitized
// snippet of any human-readable text.
async function parseJsonResponse(response) {
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) return await response.json();

    // Non-JSON body — strip HTML (doctype, comments incl. IE conditionals, tags)
    // so a Cloudflare or nginx error page collapses to its visible text only.
    const raw = await response.text();
    const stripped = raw
        .replace(/<!doctype[^>]*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const bodyPreview = stripped.slice(0, 140);
    const hint = response.status === 502 ? 'backend is unreachable'
              : response.status === 504 ? 'backend timed out'
              : response.status === 521 ? 'origin server is down (Cloudflare)'
              : response.status === 522 ? 'connection timed out (Cloudflare)'
              : response.status === 524 ? 'a timeout occurred (Cloudflare)'
              : response.status >= 500   ? 'backend error'
              : response.status === 404  ? 'not found'
              : 'unexpected non-JSON response';
    throw new Error(`${response.status} ${response.statusText || hint} (${hint})${bodyPreview ? ' — ' + bodyPreview : ''}`);
}

async function deepSearchNetwork(query) {
    // Guard: an empty query usually means the page was refreshed and
    // `currentSearchQuery` was reset. Calling /api/search/ with no path param
    // produces a 404 (or a Cloudflare 502 when the origin can't be reached),
    // which surfaces as a confusing error. Render the empty-state prompt
    // instead so the user can type a query.
    const q = (query || '').trim();
    if (!q) {
        renderSearchPrompt('Type a query before searching the network.');
        return;
    }

    if (searchResultsContainer) searchResultsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Querying Deep Network RPC...</div>';
    try {
        const response = await fetch(`/api/search/${encodeURIComponent(q)}`);
        if (!response.ok) {
            // Try to read a JSON-shaped error message first; if the upstream
            // returned an nginx/Cloudflare HTML error page, parseJsonResponse
            // converts it to a readable string instead of throwing
            // "Unexpected token '<'".
            try {
                const err = await parseJsonResponse(response);
                searchResultsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Deep Search Failed: ${stakingEscapeHtml(err.error || 'unknown error')}</div>`;
            } catch (e) {
                searchResultsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Deep Search Failed: ${stakingEscapeHtml(e.message)}<br><span style="color:var(--text-secondary);font-size:0.85rem;">If this keeps happening, the chain RPC is likely timing out; try again in a minute.</span></div>`;
            }
            return;
        }

        const data = await parseJsonResponse(response);
        let html = '';

        if (data.type === 'block') {
            html += `<h3 style="margin-top: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">Block Detail (Deep Search)</h3>`;
            html += `<div style="padding: 10px 0;">Block <strong>${data.data.number}</strong> (${data.data.hash})<br>Author: ${data.data.authorAddress}<br>${data.data.extrinsicsCount} extrinsics, ${data.data.eventsCount} events</div>`;
        } else if (data.type === 'account') {
            html += `<h3 style="margin-top: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">Account Detail (Deep Search)</h3>`;
            html += `<div style="padding: 10px 0;">Address: <strong>${data.data.address}</strong><br>Identity: ${data.data.name}<br>Total Balance: ${data.data.balance.toFixed(4)} PDEX<br>Free: ${data.data.free.toFixed(4)} PDEX, Reserved: ${data.data.reserved.toFixed(4)} PDEX</div>`;
        }

        if (html) {
            if (searchResultsContainer) searchResultsContainer.innerHTML = html;
            // A real result is on screen — repurpose the button as "Back to search"
            // so the user has an obvious one-click way back to the local view.
            setDeepSearchButtonMode('back');
        } else {
            // The chain didn't recognise the query as a block or account.
            // Leave the button in "deep" mode so the user can refine and retry.
            if (searchResultsContainer) searchResultsContainer.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-secondary);">No matching block or account found on-chain for that query.</div>';
        }

    } catch (err) {
        searchResultsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Deep search error: ${stakingEscapeHtml(err.message)}</div>`;
    }
}

// --- SEO router (clean URLs + per-route metadata) ----------------------------
// The app used to hash-route (#blocks, #validator/abc). Crawlers don't index
// fragment URLs as separate pages, so we now use the History API: each route
// gets a real path (/blocks, /validator/abc) that nginx falls back to
// index.html for. Old #X URLs still work — we rewrite them to clean URLs on
// boot for backward compatibility.
const SITE_ORIGIN = 'https://explorer.polkadex.ee';
const SITE_DEFAULT_OG_IMAGE = SITE_ORIGIN + '/og-image.png';
const SITE_NAME = 'Polkadex Explorer';

// Per-route SEO metadata. `title` and `description` are templates; dynamic
// routes (block/:id, validator/:addr, …) are filled in once the detail fetcher
// has real data via `updateSeoMeta()`.
const ROUTE_SEO = {
    'home':               { title: 'Polkadex Mainnet Explorer — Blocks, Validators, Staking & Governance',
                            description: 'The Polkadex Mainnet block explorer. Browse blocks, extrinsics, events, transactions, accounts, validators, staking rewards, and on-chain governance in real time.' },
    'holders':            { title: 'Top PDEX Holders — Polkadex Explorer',
                            description: 'Ranking of the largest PDEX token holders on the Polkadex Mainnet, with balance, share of total supply, and identity.' },
    'transactions':       { title: 'Latest Transactions — Polkadex Explorer',
                            description: 'Real-time feed of Polkadex transactions: transfers, staking calls, governance actions, and more.' },
    'blocks':             { title: 'Latest Blocks — Polkadex Explorer',
                            description: 'Recent blocks finalized on the Polkadex Mainnet, with author, extrinsics count, and timestamps.' },
    'events':             { title: 'On-chain Events — Polkadex Explorer',
                            description: 'Live event log from the Polkadex Mainnet: balances, staking, council, treasury, and runtime events.' },
    'validators':         { title: 'Validators — Polkadex Explorer',
                            description: 'Active and waiting validators on the Polkadex Mainnet, with commission, total stake, nominators, and identity.' },
    'staking-rewards':    { title: 'Staking Rewards — Polkadex Explorer',
                            description: 'Look up staking rewards, claim payouts, stake more, and unstake on the Polkadex Mainnet.' },
    'democracy':          { title: 'Democracy — Polkadex Explorer',
                            description: 'Polkadex governance: open referenda, public proposals, and democracy participation.' },
    'council':            { title: 'Council — Polkadex Explorer',
                            description: 'Polkadex Council members, motions, and recent governance activity.' },
    'treasury':           { title: 'Treasury — Polkadex Explorer',
                            description: 'Polkadex Treasury balance, approved spending, and active proposals.' },
    'discussions':        { title: 'Discussions — Polkadex Explorer',
                            description: 'On-chain governance discussions for Polkadex referenda, treasury proposals, and council motions.' },
    // /wallet (no address) is a public connect-wallet landing page — index it
    // so it captures searches like "connect Polkadex wallet" or "send PDEX".
    // initWalletPage() flips it to noindex when an address is bound (personal).
    'wallet':             { title: 'Connect Wallet — Send PDEX, Stake & Manage Your Account · Polkadex Explorer',
                            description: 'Connect a Polkadot.js, Talisman, or SubWallet extension on desktop, or use Nova Wallet / SubWallet on mobile to send PDEX, stake, and manage your Polkadex account.' },
    'donate':             { title: 'Support the Explorer — Polkadex Explorer',
                            description: 'Donate to support the Polkadex Explorer with PDEX or any major crypto asset.' },
    'search':             { title: 'Search Results — Polkadex Explorer',
                            description: 'Search Polkadex Mainnet for blocks, extrinsics, accounts, and validators.',
                            noindex: true },
    'account-details':    { title: 'Account — Polkadex Explorer',
                            description: 'Polkadex account details: balance, history, and events.' },
    'validator-details':  { title: 'Validator — Polkadex Explorer',
                            description: 'Polkadex validator details: commission, stake, nominators, and era history.' },
    'block-details':      { title: 'Block — Polkadex Explorer',
                            description: 'Polkadex block details: extrinsics, events, author, and timestamp.' },
    'tx-details':         { title: 'Transaction — Polkadex Explorer',
                            description: 'Polkadex transaction details: signer, call, status, and events.' }
};

// Update <title>, meta[description], canonical, and Open Graph / Twitter tags
// for the current route. Detail pages call this again once they've loaded the
// concrete entity (e.g. validator name) so the metadata reflects real content.
function updateSeoMeta(mainTarget, { title, description, canonicalPath, noindex } = {}) {
    const base = ROUTE_SEO[mainTarget] || ROUTE_SEO.home;
    const finalTitle = title || base.title;
    const finalDesc = description || base.description;
    const path = canonicalPath || (window.location.pathname + window.location.search) || '/';
    const canonical = SITE_ORIGIN + (path === '/' ? '/' : path.replace(/\/+$/, '') || '/');
    const shouldNoindex = noindex === true || (noindex !== false && base.noindex === true);

    document.title = finalTitle;
    setMetaContent('name', 'description', finalDesc);
    setLinkHref('canonical', canonical);

    // robots: noindex pages (search results, personal wallet view) should not
    // surface in the SERP even though they're reachable.
    setMetaContent('name', 'robots', shouldNoindex
        ? 'noindex, nofollow'
        : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');

    // Open Graph
    setMetaContent('property', 'og:title', finalTitle);
    setMetaContent('property', 'og:description', finalDesc);
    setMetaContent('property', 'og:url', canonical);
    setMetaContent('property', 'og:type', mainTarget === 'home' ? 'website' : 'article');

    // Twitter
    setMetaContent('name', 'twitter:title', finalTitle);
    setMetaContent('name', 'twitter:description', finalDesc);

    // Clear any route-scoped JSON-LD by default; routes that own one (e.g.
    // /wallet) re-inject after this call returns.
    setRouteJsonLd(null);
}

function setMetaContent(attr, key, value) {
    let el = document.head.querySelector(`meta[${attr}="${key}"]`);
    if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
    }
    el.setAttribute('content', value);
}
function setLinkHref(rel, href) {
    let el = document.head.querySelector(`link[rel="${rel}"]`);
    if (!el) {
        el = document.createElement('link');
        el.setAttribute('rel', rel);
        document.head.appendChild(el);
    }
    el.setAttribute('href', href);
}

// Swap a per-route JSON-LD block in <head>. Pass `null` to remove. The script
// is keyed by a stable id so it never duplicates and we can replace it cleanly
// when the user navigates away from the route that owns it.
function setRouteJsonLd(json) {
    const ID = 'route-jsonld';
    const existing = document.getElementById(ID);
    if (!json) { if (existing) existing.remove(); return; }
    const text = (typeof json === 'string') ? json : JSON.stringify(json);
    if (existing) { existing.textContent = text; return; }
    const el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = ID;
    el.textContent = text;
    document.head.appendChild(el);
}

// Reusable HowTo + FAQ schemas for the connect-wallet page. These help search
// engines surface our connect/send flow for "how to send PDEX" / "connect
// Polkadex wallet" / "Nova Wallet PDEX" style queries.
function buildWalletConnectJsonLd() {
    return {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'HowTo',
                '@id': 'https://explorer.polkadex.ee/wallet#howto-send-pdex',
                'name': 'How to send PDEX on the Polkadex Mainnet',
                'description': 'Connect a Substrate wallet to the Polkadex Explorer and transfer PDEX to any Polkadex address.',
                'image': 'https://explorer.polkadex.ee/og-image.png',
                'totalTime': 'PT2M',
                'tool': [
                    { '@type': 'HowToTool', 'name': 'Polkadot.js, Talisman, or SubWallet browser extension (desktop)' },
                    { '@type': 'HowToTool', 'name': 'Nova Wallet or SubWallet mobile app with in-app browser (mobile)' }
                ],
                'supply': [
                    { '@type': 'HowToSupply', 'name': 'A small PDEX balance to cover the network fee (~0.05 PDEX is plenty)' }
                ],
                'step': [
                    {
                        '@type': 'HowToStep', 'position': 1,
                        'name': 'Connect your wallet',
                        'text': 'Open explorer.polkadex.ee/wallet and click Connect Wallet. On mobile, open the URL inside Nova Wallet or SubWallet\'s in-app dapp browser.',
                        'url': 'https://explorer.polkadex.ee/wallet'
                    },
                    {
                        '@type': 'HowToStep', 'position': 2,
                        'name': 'Authorise the site',
                        'text': 'Approve the connection request in your wallet so it can share account addresses with the explorer.'
                    },
                    {
                        '@type': 'HowToStep', 'position': 3,
                        'name': 'Pick your account',
                        'text': 'Choose the Polkadex account you want to use. Your account dashboard opens with balances, staking, and recent transactions.'
                    },
                    {
                        '@type': 'HowToStep', 'position': 4,
                        'name': 'Open the Send PDEX modal',
                        'text': 'Click the Send PDEX action on the dashboard.'
                    },
                    {
                        '@type': 'HowToStep', 'position': 5,
                        'name': 'Enter recipient and amount',
                        'text': 'Paste the recipient\'s Polkadex address, type the amount in PDEX, and review the live network-fee estimate.'
                    },
                    {
                        '@type': 'HowToStep', 'position': 6,
                        'name': 'Sign in your wallet',
                        'text': 'Click Sign & Send and approve the transaction in your wallet extension. The transfer is included on-chain within seconds.'
                    }
                ]
            },
            {
                '@type': 'FAQPage',
                '@id': 'https://explorer.polkadex.ee/wallet#faq',
                'mainEntity': [
                    {
                        '@type': 'Question',
                        'name': 'Can I send PDEX from a mobile wallet like Nova Wallet?',
                        'acceptedAnswer': {
                            '@type': 'Answer',
                            'text': 'Yes. Open explorer.polkadex.ee inside Nova Wallet or SubWallet\'s built-in dapp browser. Your accounts are injected automatically, just like with a desktop Polkadot.js extension, and you can sign transfers and staking actions directly in the mobile wallet.'
                        }
                    },
                    {
                        '@type': 'Question',
                        'name': 'Which wallets work with the Polkadex Explorer?',
                        'acceptedAnswer': {
                            '@type': 'Answer',
                            'text': 'On desktop: Polkadot.js extension, Talisman, SubWallet, PolkaGate. On mobile: Nova Wallet and SubWallet via their in-app dapp browsers. The explorer never stores private keys — every transaction is signed by your wallet.'
                        }
                    },
                    {
                        '@type': 'Question',
                        'name': 'How much does a PDEX transfer cost?',
                        'acceptedAnswer': {
                            '@type': 'Answer',
                            'text': 'Network fees on Polkadex Mainnet are very small — typically a few thousandths of a PDEX. The Send PDEX modal shows a live fee estimate before you sign so there are no surprises.'
                        }
                    },
                    {
                        '@type': 'Question',
                        'name': 'What is "Keep my account alive" on the Send PDEX modal?',
                        'acceptedAnswer': {
                            '@type': 'Answer',
                            'text': 'Substrate chains require accounts to hold at least the existential deposit. Keep account alive uses balances.transferKeepAlive, which fails the transfer if it would leave your balance below the existential deposit (preventing accidental account reaping). Uncheck it only if you intend to empty an account completely.'
                        }
                    },
                    {
                        '@type': 'Question',
                        'name': 'Can I view my Polkadex account without connecting a wallet?',
                        'acceptedAnswer': {
                            '@type': 'Answer',
                            'text': 'Yes. Paste any Polkadex address into the "look up any address" field on the wallet page for a read-only dashboard with balances, staking, and recent activity. You only need to connect a wallet when you want to send or sign actions.'
                        }
                    }
                ]
            }
        ]
    };
}

// Parse the current address-bar URL into the route token routeTo() expects
// (e.g. "block/12345"). Pathname wins; if a legacy #X fragment is present on
// "/" we fall back to it (and the boot routine rewrites the URL).
function readRouteFromLocation() {
    const path = window.location.pathname || '/';
    const stripped = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (stripped) return stripped;
    const hash = window.location.hash.replace(/^#/, '').trim();
    return hash || 'home';
}

// Push a new history entry and route to it. All call sites that used to do
// `window.location.hash = X` now go through here so the URL bar shows a
// clean path and crawlers can index it.
function navigateTo(target, { replace = false } = {}) {
    if (!target || target === 'home') target = '';
    // Don't push duplicate history entries for the same URL.
    const newPath = '/' + target.replace(/^\/+/, '');
    const currentPath = window.location.pathname + window.location.hash;
    if (newPath !== currentPath || window.location.hash) {
        const fn = replace ? 'replaceState' : 'pushState';
        try { history[fn](null, '', newPath || '/'); }
        catch (e) { /* same-origin / sandboxed iframes can throw; fall back below */ }
    }
    routeTo(target || 'home');
}

// One-time wiring: clean-URL routing, popstate, click delegation, legacy
// hash-URL redirect. Called at the bottom of init.
function bootSeoRouter() {
    // Rewrite any legacy "#X" URLs people might have bookmarked into clean URLs
    // so canonical/og:url match what the user sees.
    const legacyHash = window.location.hash.replace(/^#/, '').trim();
    if (legacyHash && (window.location.pathname === '/' || window.location.pathname === '')) {
        try { history.replaceState(null, '', '/' + legacyHash); }
        catch (e) { /* ignore */ }
    }

    window.addEventListener('popstate', () => {
        routeTo(readRouteFromLocation());
    });

    // Delegated click handler for internal links. Catches both new clean
    // URLs (href="/blocks") and any leftover legacy fragment links
    // (href="/blocks") rendered from inline HTML strings.
    document.addEventListener('click', (e) => {
        // Honor modifier keys and middle-click so "open in new tab" still works.
        if (e.defaultPrevented) return;
        if (e.button !== 0 && e.button !== undefined) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = e.target.closest && e.target.closest('a');
        if (!a) return;
        if (a.target && a.target !== '' && a.target !== '_self') return;
        if (a.hasAttribute('download')) return;
        const href = a.getAttribute('href');
        if (!href) return;
        // External / mailto / tel / protocol-relative.
        if (/^(https?:)?\/\//i.test(href) || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        let target = null;
        if (href.startsWith('#')) {
            const t = href.substring(1).trim();
            if (!t) return;
            target = t;
        } else if (href.startsWith('/')) {
            // Only intercept if the host is the same; absolute paths are SPA routes.
            target = href.replace(/^\/+/, '');
        } else {
            return;
        }
        e.preventDefault();
        navigateTo(target);
    });
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

    // Refresh SEO metadata for the new route. Detail pages (block/validator/
    // wallet/etc.) will call updateSeoMeta() again with concrete data once the
    // fetcher resolves so titles/descriptions reflect real content.
    updateSeoMeta(mainTarget, { canonicalPath: '/' + (target === 'home' ? '' : target) });

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
            } else if (mainTarget === 'search') {
                // /search reached without an active query — usually a page
                // refresh on the search results page, which loses the
                // in-memory `currentSearchQuery`. Render the inline prompt
                // so users have a paste-friendly box to retype into, instead
                // of staring at an empty results panel with a deep-search
                // button that has nothing to query.
                if (!currentSearchQuery) renderSearchPrompt();
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
    const shortAddr = address ? (address.substring(0, 8) + '…' + address.substring(address.length - 6)) : '';
    updateSeoMeta('account-details', {
        title: `Account ${shortAddr} — Polkadex Explorer`,
        description: `Polkadex account ${address}: balance, transactions, and events.`,
        canonicalPath: `/account/${address}`
    });
    try {
        const res = await fetch(`/api/account/${address}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const label = (data.display && data.display !== 'Unknown') ? data.display : shortAddr;
        updateSeoMeta('account-details', {
            title: `Account ${label} — Polkadex Explorer`,
            description: `Polkadex account ${address}${data.display && data.display !== 'Unknown' ? ' (' + data.display + ')' : ''}: balance ${data.balanceTotal != null ? data.balanceTotal.toFixed ? data.balanceTotal.toFixed(2) + ' PDEX' : data.balanceTotal + ' PDEX' : ''}, transactions, and events.`,
            canonicalPath: `/account/${address}`
        });

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
                    <td style="padding: 15px 10px;"><a href="/tx/${t.block}/${t.hash}" class="item-link" style="color: var(--brand-secondary);">${t.hash.substring(0, 25)}...</a></td>
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
    // Provisional SEO update — overwritten with concrete data once the fetch lands.
    updateSeoMeta('block-details', {
        title: `Block #${id} — Polkadex Explorer`,
        description: `Polkadex Mainnet block #${id}: extrinsics, events, author, and timestamp.`,
        canonicalPath: `/block/${id}`
    });
    try {
        const res = await fetch(`/api/block/${id}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const blockNum = data.block && data.block.header && data.block.header.number;
        updateSeoMeta('block-details', {
            title: `Block #${blockNum || id} — Polkadex Explorer`,
            description: `Polkadex Mainnet block #${blockNum || id} (${new Date(data.date).toISOString().substring(0, 19).replace('T', ' ')} UTC): extrinsics, events, and author.`,
            canonicalPath: `/block/${id}`
        });

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
    const shortHash = (hash || '').substring(0, 12);
    updateSeoMeta('tx-details', {
        title: `Transaction ${shortHash}… — Polkadex Explorer`,
        description: `Polkadex Mainnet transaction ${hash} in block #${block}.`,
        canonicalPath: `/tx/${block}/${hash}`
    });
    try {
        const res = await fetch(`/api/extrinsic/${block}/${hash}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        updateSeoMeta('tx-details', {
            title: `Transaction ${shortHash}… (${data.event || 'extrinsic'}) — Polkadex Explorer`,
            description: `Polkadex Mainnet transaction ${data.hash || hash} in block #${block}: ${data.event || 'extrinsic'} from ${data.from || 'unknown'} to ${data.to || 'unknown'}, status: ${data.status || 'unknown'}.`,
            canonicalPath: `/tx/${block}/${hash}`
        });

        let html = `
            <div class="list-header" style="border-bottom: 1px solid var(--border-color); padding: 20px; display: flex; justify-content: space-between; align-items: center;">
                <h2>Tx: ${data.hash}</h2>
                <a href="javascript:history.back()" style="color: var(--text-secondary); text-decoration: none; cursor: pointer;"><i class='bx bx-x' style="font-size: 24px;"></i></a>
            </div>
            <div style="padding: 20px;">
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; text-align: left;">
                    <tr><td style="padding: 10px; font-weight: bold; width: 150px;">Time</td><td style="padding: 10px;">${new Date(data.time).toISOString().replace('T', ' ').substring(0, 19)} (UTC)</td></tr>
                    <tr style="background: rgba(255,255,255,0.02);"><td style="padding: 10px; font-weight: bold;">event</td><td style="padding: 10px;">${data.event}</td></tr>
                    <tr><td style="padding: 10px; font-weight: bold;">from</td><td style="padding: 10px;"><a href="/account/${data.from}" class="item-link address-cell">${data.from}</a></td></tr>
                    <tr style="background: rgba(255,255,255,0.02);"><td style="padding: 10px; font-weight: bold;">to</td><td style="padding: 10px;"><a href="/account/${data.to}" class="item-link address-cell">${data.to}</a></td></tr>
                    <tr><td style="padding: 10px; font-weight: bold;">status</td><td style="padding: 10px;"><span class="badge" style="background: ${data.status === 'success' ? 'var(--success)' : 'var(--error)'}; font-size: 11px;">${data.status}</span></td></tr>
                    <tr style="background: rgba(255,255,255,0.02);"><td style="padding: 10px; font-weight: bold;">block</td><td style="padding: 10px;"><a href="/block/${data.block}" class="item-link">${data.block}</a></td></tr>
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

// Kept for backward compatibility — if a third-party link still drops a "#X"
// fragment on the user, fall through to clean-URL routing.
window.addEventListener('hashchange', () => {
    const hash = window.location.hash.substring(1).trim();
    if (hash) navigateTo(hash, { replace: true });
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
        const target = item.getAttribute('data-target');
        if (!target) return;
        // The delegated click handler in bootSeoRouter() also catches these
        // anchors (since their href is "/<target>"). We keep this listener so
        // data-target-only nav items (no href) still work as expected.
        if (!item.getAttribute('href')) {
            e.preventDefault();
            navigateTo(target);
        }
    });
});

let validatorChart = null;

async function fetchValidatorDetails(address) {
    const container = document.getElementById('validator-details-container');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching validator history...</div>';

    const shortAddr = address ? (address.substring(0, 8) + '…' + address.substring(address.length - 6)) : '';
    updateSeoMeta('validator-details', {
        title: `Validator ${shortAddr} — Polkadex Explorer`,
        description: `Polkadex validator ${address}: era history, commission, stake, and nominators.`,
        canonicalPath: `/validator/${address}`
    });

    try {
        const res = await fetch(`/api/validator/${address}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const validatorLabel = (data.identity && data.identity !== 'Unknown') ? data.identity : shortAddr;
        updateSeoMeta('validator-details', {
            title: `Validator ${validatorLabel} — Polkadex Explorer`,
            description: `Polkadex validator ${validatorLabel} (${address}): era history, commission, total stake, and nominators on the Polkadex Mainnet.`,
            canonicalPath: `/validator/${address}`
        });

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
                <a href="/validators" style="color: var(--text-secondary); text-decoration: none;"><i class='bx bx-x' style="font-size: 24px;"></i></a>
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
// Compare two SS58 addresses by their underlying public key bytes. Wallet
// extensions often hand back addresses in the generic Substrate format
// (prefix 42) while the backend normalizes them to Polkadex's prefix 88,
// so a raw string comparison incorrectly says they differ.
function isSameAddress(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try {
        const ax = decodeAddress(a);
        const bx = decodeAddress(b);
        if (ax.length !== bx.length) return false;
        for (let i = 0; i < ax.length; i++) if (ax[i] !== bx[i]) return false;
        return true;
    } catch (e) { return false; }
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
        if (!data.backfillComplete) {
            el.innerHTML = `<div class="gov-index-note" style="margin-top: 10px;"><i class='bx bx-loader-alt bx-spin'></i> Indexing past staking rewards from chain history — scanned back to block ${stakingFormatNumber(data.oldestScannedBlock)}. Older staking rewards will keep appearing as the crawl progresses.</div>`;
        } else {
            el.innerHTML = `<span class="staking-index-status" style="margin-top: 10px; display: inline-block;">Indexer: blocks ${stakingFormatNumber(data.oldestScannedBlock)}–${stakingFormatNumber(data.latestScannedBlock)} · ${stakingFormatNumber(data.totalRewardsIndexed)} payouts · backfill complete</span>`;
        }
    } catch (e) {
        el.innerHTML = `<span class="staking-index-status" style="margin-top: 10px; display: inline-block;">Indexer: status unavailable</span>`;
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
    navigateTo('staking-rewards/' + addr);
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
                ? `No staking rewards were found for <span style="color: var(--brand-secondary);">${stakingEscapeHtml(stakingShortAddress(data.address))}</span>.`
                : 'The indexer is still backfilling older history — check back shortly.');
                
        const title = data.unclaimedComputing 
            ? 'Computing Rewards' 
            : (index.backfillComplete ? 'No Staking Rewards' : 'Coming Soon');

        const iconHtml = (data.unclaimedComputing || !index.backfillComplete) 
            ? `<i class='bx bx-time-five' style="font-size: 48px; margin-bottom: 16px; opacity: 0.5;"></i>` 
            : '';

        resultsEl.innerHTML = `
            <div style="padding: 40px; text-align: center; color: var(--text-secondary);">
                ${iconHtml}
                <h3>${title}</h3>
                <p>${note}</p>
            </div>`;
        return;
    }

    const rewards = getFilteredRewards(data, stakingRewardFilter);
    const shown = rewards.slice(0, stakingRewardsDisplayLimit);
    let rowsHtml = '';
    shown.forEach(r => {
        const date = r.timestamp ? new Date(r.timestamp).toISOString().replace('T', ' ').substring(0, 19) : '—';
        const validatorCell = r.validator
            ? `<a href="/validator/${encodeURIComponent(r.validator)}" class="item-link" style="color: var(--brand-secondary);">${stakingShortAddress(r.validator)}</a>`
            : '<span style="color: var(--text-muted);">—</span>';
        const blockCell = r.block != null
            ? `<a href="/block/${r.block}" class="item-link" style="color: var(--brand-secondary);">${stakingFormatNumber(r.block)}</a>`
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
            <a href="/account/${encodeURIComponent(data.address)}" class="item-link" style="color: var(--text-secondary); font-size: 0.78rem;">${stakingEscapeHtml(data.address)}</a>
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

// --- Wallet Connect + Dashboard ---
function getStoredWallet() {
    try {
        const v = localStorage.getItem(WALLET_STORAGE_KEY) || '';
        if (!v) return '';
        // Legacy installs may have a generic Polkadot/Substrate address in
        // storage from before we normalised on write — coerce on read and
        // rewrite so the rest of the UI sees the Polkadex form.
        const pdex = toPolkadexAddress(v);
        if (pdex && pdex !== v) {
            try { localStorage.setItem(WALLET_STORAGE_KEY, pdex); } catch (e) { /* ignore quota */ }
            return pdex;
        }
        return v;
    } catch (e) { return ''; }
}
function setStoredWallet(addr) {
    try {
        if (addr) localStorage.setItem(WALLET_STORAGE_KEY, toPolkadexAddress(addr));
        else localStorage.removeItem(WALLET_STORAGE_KEY);
    } catch (e) { }
}
function refreshConnectWalletButton() {
    const btn = document.getElementById('connect-wallet-btn');
    const label = document.getElementById('connect-wallet-label');
    const sub = document.getElementById('connect-wallet-sub');
    const disconnectBtn = document.getElementById('disconnect-wallet-btn');
    const stored = getStoredWallet();
    if (stored) {
        // Connected: lead with "My Account" so the affordance is obvious, and
        // tuck the abbreviated address underneath as a secondary line.
        if (label) label.textContent = 'My Account';
        if (sub) { sub.textContent = stakingShortAddress(stored); sub.style.display = 'block'; }
        if (btn) {
            btn.classList.add('is-connected');
            btn.setAttribute('title', 'View your account: ' + stored);
            btn.setAttribute('aria-label', 'View my account (' + stakingShortAddress(stored) + ')');
        }
    } else {
        if (label) label.textContent = 'Connect Wallet';
        if (sub) { sub.textContent = ''; sub.style.display = 'none'; }
        if (btn) {
            btn.classList.remove('is-connected');
            btn.setAttribute('title', 'Connect your Substrate wallet to view balances and sign staking actions');
            btn.setAttribute('aria-label', 'Connect wallet');
        }
    }
    if (disconnectBtn) disconnectBtn.style.display = stored ? 'inline-flex' : 'none';
    // Reflect connected state on the sidebar item too — clearer than a generic "My Account" link.
    const navMine = document.getElementById('nav-my-account');
    if (navMine) {
        const navLabel = navMine.querySelector('span') || navMine;
        navMine.title = stored ? ('Your account: ' + stored) : 'Connect a wallet to view your account';
    }
}

// --- Mobile / in-app wallet detection --------------------------------------
// A handful of mobile wallets (Nova, SubWallet, Talisman, Math, etc.) ship an
// in-app browser that injects `window.injectedWeb3` exactly like the desktop
// Polkadot.js extension does. The existing enumeration below already picks
// those up — these helpers just let the connect panel show appropriate
// messaging and deep-link buttons.
function isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
}

// Cheap synchronous check: is *any* Substrate wallet currently injecting
// accounts into this tab? Used to gate the wallet-dashboard action bar so
// users who arrived in view-only mode (typed-in address) or whose wallet
// session has ended don't see signing buttons that lead to a dead-end error.
function hasInjectedWalletNow() {
    return !!(typeof window !== 'undefined'
        && window.injectedWeb3
        && Object.keys(window.injectedWeb3).length > 0);
}

// Identify the in-app wallet browser hosting us (if any) so the panel can
// greet the user by name. `window.injectedWeb3` key names are stable identifiers
// each wallet self-declares.
function detectInjectedWalletEnv() {
    const w = (typeof window !== 'undefined' && window.injectedWeb3) || {};
    const keys = Object.keys(w);
    const has = (k) => keys.includes(k);
    if (has('subwallet-js')) return { id: 'subwallet', name: 'SubWallet' };
    if (has('talisman')) return { id: 'talisman', name: 'Talisman' };
    if (has('polkagate')) return { id: 'polkagate', name: 'PolkaGate' };
    if (has('polkadot-js')) {
        // polkadot-js is the namespace Nova Wallet and the desktop extension
        // both use. UA sniffing tells them apart for greeting purposes.
        const ua = (navigator.userAgent || '').toLowerCase();
        if (ua.includes('novawallet') || ua.includes('nova-wallet') || ua.includes('nova/')) return { id: 'nova', name: 'Nova Wallet' };
        return { id: 'polkadot-js', name: 'Polkadot.js' };
    }
    if (keys.length) return { id: keys[0], name: keys[0] };
    return null;
}

// Known mobile wallets that ship a dapp browser. Each entry tells the connect
// panel how to deep-link / app-store-link / explain itself. Deep links use the
// wallets' published universal-link domains where verified; users who don't
// have the wallet installed get the app-store fallback automatically.
const MOBILE_WALLETS = [
    {
        id: 'nova',
        name: 'Nova Wallet',
        // Nova publishes nova.app.link for opening URLs in its built-in browser.
        deeplink: (url) => 'https://app.novawallet.io/open/dapp?url=' + encodeURIComponent(url),
        appStore: 'https://apps.apple.com/app/nova-polkadot-kusama-wallet/id1597119355',
        playStore: 'https://play.google.com/store/apps/details?id=io.novafoundation.nova.market',
        site: 'https://novawallet.io',
        tagline: 'Polkadot & Kusama native — Apple/Android'
    },
    {
        id: 'subwallet',
        name: 'SubWallet',
        // SubWallet exposes subwallet:// as a URL scheme to open arbitrary dapp URLs.
        deeplink: (url) => 'subwallet://browser?url=' + encodeURIComponent(url),
        appStore: 'https://apps.apple.com/app/subwallet-polkadot-wallet/id1633050285',
        playStore: 'https://play.google.com/store/apps/details?id=app.subwallet.mobile',
        site: 'https://subwallet.app',
        tagline: 'Multi-chain dapp browser — Apple/Android'
    },
    {
        id: 'talisman',
        name: 'Talisman',
        // Talisman is browser-extension first; the deep-link is a docs hand-off.
        deeplink: null,
        appStore: null,
        playStore: null,
        site: 'https://talisman.xyz/download',
        tagline: 'Browser extension — desktop today'
    }
];

// Enumerate accounts from installed Substrate wallet extensions / mobile
// in-app browsers. The retry loop helps mobile wallets that inject
// `window.injectedWeb3` slightly after `DOMContentLoaded`.
// Each account is returned with two address fields:
//   `address`    — the Polkadex-prefixed form (starts with "e…") for display
//                  and for everything the user/UI persists.
//   `rawAddress` — the extension's native SS58 form (often "1…" or "5…")
//                  needed by the wallet's `signAndSend` so the injected
//                  signer recognises the account.
async function getInjectedAccounts({ retries = 6, retryDelayMs = 250 } = {}) {
    // Wait briefly for late injection on mobile wallet in-app browsers.
    for (let i = 0; i < retries; i++) {
        if (window.injectedWeb3 && Object.keys(window.injectedWeb3).length) break;
        await new Promise(r => setTimeout(r, retryDelayMs));
    }
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
                for (const a of accs) {
                    const pdex = toPolkadexAddress(a.address);
                    accounts.push({ address: pdex, rawAddress: a.address, name: a.name || key, source: key });
                }
            }
        } catch (e) { /* user rejected this extension */ }
    }
    return accounts;
}

function connectWallet() {
    const stored = getStoredWallet();
    navigateTo(stored ? ('wallet/' + stored) : 'wallet');
}
function selectWallet(address) {
    if (!isValidPolkadexAddress(address)) return;
    // Always store + route with the Polkadex-prefixed form so the URL bar,
    // localStorage, and dashboard all show the chain-specific "e…" address.
    const pdex = toPolkadexAddress(address);
    setStoredWallet(pdex);
    refreshConnectWalletButton();
    navigateTo('wallet/' + pdex);
}
function disconnectWallet() {
    setStoredWallet('');
    refreshConnectWalletButton();
    // If the user is currently on a wallet page, return them to the connect panel.
    const current = readRouteFromLocation();
    if (current.startsWith('wallet')) {
        if (current === 'wallet') {
            const root = document.getElementById('wallet-dashboard');
            if (root) renderWalletConnectPanel(root);
        } else {
            navigateTo('wallet');
        }
    }
}

function initWalletPage(address) {
    const root = document.getElementById('wallet-dashboard');
    if (!root) return;
    if (address) {
        // If the URL still contains a generic Polkadot/Substrate address from
        // an older link or a wallet extension's native format, rewrite it to
        // the Polkadex-prefixed form so the address bar (and any subsequent
        // share / bookmark) matches what the dashboard shows.
        if (isValidPolkadexAddress(address)) {
            const pdex = toPolkadexAddress(address);
            if (pdex && pdex !== address) {
                try { history.replaceState(null, '', '/wallet/' + pdex); } catch (e) { /* ignore */ }
                address = pdex;
            }
        }
        // Personal dashboard: noindex and no route JSON-LD (PII / dynamic).
        updateSeoMeta('wallet', {
            title: 'My Account — Polkadex Explorer',
            description: 'Your Polkadex account dashboard: balances, staking, nominations, rewards, and recent transactions.',
            canonicalPath: '/wallet/' + address,
            noindex: true
        });
        if (isValidPolkadexAddress(address)) fetchWalletDashboard(address);
        else root.innerHTML = '<div class="list-container glass" style="padding:32px;color:var(--error);">Invalid Polkadex address.</div>';
        return;
    }
    // Public connect-wallet landing: indexable + rich HowTo/FAQ structured
    // data so search engines surface us for "connect Polkadex wallet" and
    // "how to send PDEX" queries.
    updateSeoMeta('wallet', { canonicalPath: '/wallet', noindex: false });
    setRouteJsonLd(buildWalletConnectJsonLd());
    renderWalletConnectPanel(root);
}

// Build the "Open in mobile wallet" deep-link card list. Rendered as an extra
// section in the connect panel so phone users have a one-tap path into a
// wallet's in-app browser (where injectedWeb3 just works).
function renderMobileWalletCards(currentUrl) {
    const isMobile = isMobileDevice();
    const cards = MOBILE_WALLETS.map(w => {
        const link = w.deeplink ? w.deeplink(currentUrl) : null;
        // On mobile, the primary CTA is the deep-link; on desktop we point to
        // app stores so the user can install + paste the URL.
        const primary = isMobile && link
            ? `<a class="mobile-wallet-cta" href="${stakingEscapeHtml(link)}">Open in ${stakingEscapeHtml(w.name)}</a>`
            : (w.appStore || w.playStore)
                ? `<div class="mobile-wallet-storelinks">
                    ${w.appStore ? `<a href="${stakingEscapeHtml(w.appStore)}" target="_blank" rel="noopener"><i class='bx bxl-apple'></i> iOS</a>` : ''}
                    ${w.playStore ? `<a href="${stakingEscapeHtml(w.playStore)}" target="_blank" rel="noopener"><i class='bx bxl-play-store'></i> Android</a>` : ''}
                   </div>`
                : `<a class="mobile-wallet-cta secondary" href="${stakingEscapeHtml(w.site)}" target="_blank" rel="noopener">Visit ${stakingEscapeHtml(w.name)}</a>`;
        return `<div class="mobile-wallet-card">
            <div class="mobile-wallet-head">
                <strong>${stakingEscapeHtml(w.name)}</strong>
                <span>${stakingEscapeHtml(w.tagline)}</span>
            </div>
            ${primary}
        </div>`;
    }).join('');
    return `<div class="mobile-wallet-grid">${cards}</div>`;
}

async function renderWalletConnectPanel(root) {
    const env = detectInjectedWalletEnv();
    const onMobile = isMobileDevice();
    const currentUrl = (typeof location !== 'undefined') ? location.href : 'https://explorer.polkadex.ee/wallet';

    const envBanner = env
        ? `<div class="wallet-env-banner"><i class='bx bx-check-circle'></i> Detected <strong>${stakingEscapeHtml(env.name)}</strong> — pick an account below to connect.</div>`
        : '';

    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header"><h2>Connect Wallet</h2></div>
            <div style="padding: 24px;">
                ${envBanner}
                <p style="color: var(--text-secondary); font-size: 0.88rem; margin-bottom: 16px; line-height: 1.6;">
                    Connect a Substrate wallet to open your dashboard. You'll be able to view your balance and
                    sign actions — send PDEX, bond more, nominate validators, pay out rewards or unbond.
                    Every transaction needs your explicit approval in the wallet; the explorer can never move
                    funds without it.
                </p>
                <div id="wallet-accounts" style="display:flex; flex-direction:column; gap:10px;">
                    <div style="color: var(--text-muted); font-size: 0.85rem;">Looking for wallets…</div>
                </div>

                <div id="wallet-mobile-section" style="display:none; margin-top: 24px;">
                    <h3 style="font-size: 0.95rem; margin-bottom: 6px;">On mobile? Use a wallet's in-app browser</h3>
                    <p style="color: var(--text-secondary); font-size: 0.82rem; margin-bottom: 12px; line-height: 1.5;">
                        Browser extensions don't run on phones. Open the explorer inside a mobile wallet's built-in
                        dapp browser — your accounts inject automatically, just like with a desktop extension.
                    </p>
                    ${renderMobileWalletCards(currentUrl)}
                    <div class="mobile-wallet-copyrow">
                        <input id="wallet-copy-url" type="text" readonly value="${stakingEscapeHtml(currentUrl)}">
                        <button id="wallet-copy-btn" type="button"><i class='bx bx-copy'></i> Copy URL</button>
                    </div>
                </div>

                <div style="margin-top: 22px; border-top: 1px solid var(--border-color); padding-top: 18px;">
                    <p style="color: var(--text-secondary); font-size: 0.82rem; margin-bottom: 10px;">…or look up any address without connecting (view-only):</p>
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

    // Copy-URL helper for mobile users; falls back to selecting the input
    // when navigator.clipboard isn't available (older WebViews).
    const copyBtn = document.getElementById('wallet-copy-btn');
    const copyInput = document.getElementById('wallet-copy-url');
    if (copyBtn && copyInput) copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(copyInput.value);
            copyBtn.innerHTML = "<i class='bx bx-check'></i> Copied!";
            setTimeout(() => { copyBtn.innerHTML = "<i class='bx bx-copy'></i> Copy URL"; }, 1500);
        } catch (e) {
            copyInput.select();
            try { document.execCommand('copy'); } catch (e2) { /* nothing more to try */ }
        }
    });

    // Show the mobile-wallet section by default on mobile; on desktop, only
    // surface it if no wallet was detected (it's still useful info for users
    // who keep their stash on a phone-only wallet like Nova).
    const mobileSection = document.getElementById('wallet-mobile-section');
    const accountsEl = document.getElementById('wallet-accounts');

    const accounts = await getInjectedAccounts();
    if (accounts === null) {
        accountsEl.innerHTML = onMobile
            ? `<div class="wallet-empty-msg">
                No wallet is exposing accounts to this browser tab. If you're on a phone, open this URL inside a
                mobile wallet's in-app browser using one of the options below. On desktop, install
                <a href="https://polkadot.js.org/extension/" target="_blank" rel="noopener">Polkadot.js</a>,
                Talisman or SubWallet.
               </div>`
            : `<div class="wallet-empty-msg">
                No Substrate wallet extension detected. Install
                <a href="https://polkadot.js.org/extension/" target="_blank" rel="noopener">Polkadot.js</a>,
                Talisman or SubWallet — or, if your stash lives on your phone, use a mobile wallet's in-app
                browser (see below).
               </div>`;
        if (mobileSection) mobileSection.style.display = 'block';
        return;
    }
    if (accounts.length === 0) {
        accountsEl.innerHTML = `<div class="wallet-empty-msg">
            ${env ? stakingEscapeHtml(env.name) + ' is connected, but no accounts were shared.' : 'No accounts were shared.'}
            Authorise this site in your wallet and try again.
           </div>`;
        if (mobileSection) mobileSection.style.display = onMobile ? 'block' : 'none';
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
    if (mobileSection) mobileSection.style.display = onMobile ? 'block' : 'none';
}

// Animated, stepped loading state shown while the wallet dashboard is fetched.
// Returns a cleanup function that stops the message-cycling timer.
function renderWalletLoading(root, address) {
    const steps = [
        { icon: 'bx-link-alt', label: 'Verify address', msg: 'Verifying your address on the Polkadex chain…' },
        { icon: 'bx-coin-stack', label: 'Balances & staking', msg: 'Fetching your balances and staking positions…' },
        { icon: 'bx-gift', label: 'Reward history', msg: 'Reading your on-chain reward history…' },
        { icon: 'bx-bar-chart-alt-2', label: 'Build dashboard', msg: 'Almost there — assembling your dashboard…' }
    ];
    const stepPill = (s, i, state) => {
        const icon = state === 'done' ? 'bx-check'
            : state === 'active' ? 'bx-loader-alt spin'
            : s.icon;
        return `<div class="wallet-step ${state}" data-step="${i}"><i class='bx ${icon}'></i>${s.label}</div>`;
    };
    root.innerHTML = `
        <div class="wallet-loading">
            <div class="list-container glass">
                <div class="wallet-loading-banner">
                    <div class="wallet-spinner"><i class='bx bx-wallet'></i></div>
                    <div class="wallet-loading-text">
                        <div class="wallet-loading-title">Loading your wallet dashboard</div>
                        <div class="wallet-loading-msg" id="wallet-loading-msg">${steps[0].msg}</div>
                        <div class="wallet-loading-steps" id="wallet-loading-steps">
                            ${steps.map((s, i) => stepPill(s, i, i === 0 ? 'active' : 'pending')).join('')}
                        </div>
                    </div>
                </div>
            </div>
            <div class="list-container glass">
                <div class="list-header"><h2><i class='bx bx-wallet'></i> ${stakingEscapeHtml(stakingShortAddress(address))}</h2></div>
                <div class="wallet-skel-summary">
                    ${[0, 1, 2, 3].map(() => '<div class="wallet-skel-card"><div class="skel line-sm"></div><div class="skel line-lg"></div></div>').join('')}
                </div>
            </div>
            <div class="wallet-grid">
                ${[0, 1].map(() => `<div class="list-container glass"><div class="wallet-skel-rows">${[0, 1, 2, 3, 4].map(() => '<div class="skel wallet-skel-row"></div>').join('')}</div></div>`).join('')}
            </div>
        </div>`;
    let idx = 0;
    const msgEl = document.getElementById('wallet-loading-msg');
    const stepsEl = document.getElementById('wallet-loading-steps');
    const timer = setInterval(() => {
        if (idx >= steps.length - 1) return; // hold on the final step until data arrives
        const prev = stepsEl && stepsEl.querySelector(`[data-step="${idx}"]`);
        if (prev) { prev.className = 'wallet-step done'; prev.innerHTML = `<i class='bx bx-check'></i>${steps[idx].label}`; }
        idx++;
        const cur = stepsEl && stepsEl.querySelector(`[data-step="${idx}"]`);
        if (cur) { cur.className = 'wallet-step active'; cur.innerHTML = `<i class='bx bx-loader-alt spin'></i>${steps[idx].label}`; }
        if (msgEl) {
            msgEl.textContent = steps[idx].msg;
            msgEl.classList.remove('swap');
            void msgEl.offsetWidth; // restart the fade animation
            msgEl.classList.add('swap');
        }
    }, 1500);
    return () => clearInterval(timer);
}

async function fetchWalletDashboard(address) {
    const root = document.getElementById('wallet-dashboard');
    if (!root) return;
    const stopLoading = renderWalletLoading(root, address);
    try {
        const [walletRes, priceRes] = await Promise.all([
            fetch('/api/wallet/' + encodeURIComponent(address)),
            fetch('/api/price-history?days=30').catch(() => null)
        ]);
        const data = await walletRes.json();
        if (!walletRes.ok || data.error) throw new Error(data.error || ('Request failed (' + walletRes.status + ')'));
        let price = { history: [], configured: false };
        if (priceRes) { try { price = await priceRes.json(); } catch (e) { } }
        stopLoading();
        renderWalletDashboard(data, price);
    } catch (e) {
        stopLoading();
        root.innerHTML = `<div class="list-container glass" style="padding:40px;text-align:center;color:var(--error);">Error: ${stakingEscapeHtml(e.message)}</div>`;
    }
}

function renderWalletDashboard(data, price) {
    const root = document.getElementById('wallet-dashboard');
    if (!root) return;
    currentWalletData = data;
    const isOwnWallet = isSameAddress(getStoredWallet(), data.address);
    const identity = data.identity && data.identity !== 'Unknown' ? data.identity : null;
    const staking = data.staking || {};
    const rewards = data.rewards || {};
    const network = data.network || {};
    const balance = data.balance || {};

    const validatorsHtml = (staking.nominating && staking.nominating.length)
        ? staking.nominating.map(v => `
            <a href="/validator/${encodeURIComponent(v.address)}" class="wallet-validator-row item-link">
                <span>${v.name && v.name !== 'Unknown' ? stakingEscapeHtml(v.name) : stakingShortAddress(v.address)}</span>
                <i class='bx bx-chevron-right'></i>
            </a>`).join('')
        : '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 8px 0;">This wallet is not nominating any validators.</div>';

    const txHtml = (data.recentTransactions && data.recentTransactions.length)
        ? data.recentTransactions.map(t => {
            const dir = t.from === data.address ? 'out' : 'in';
            const date = t.timestamp ? new Date(t.timestamp).toLocaleDateString('en-US') : '—';
            return `<tr>
                <td><a href="/tx/${t.block}/${t.hash}" class="item-link" style="color:var(--brand-secondary);">${stakingShortAddress(t.hash)}</a></td>
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
                    <a href="/staking-rewards/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">Full reward history</a>
                    <button id="wallet-switch-btn" class="staking-download-btn">Switch wallet</button>
                </div>
            </div>
            <div style="padding: 12px 24px 0;">
                <a href="/account/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--text-secondary);font-size:0.78rem;">${stakingEscapeHtml(data.address)}</a>
            </div>
            <div class="staking-summary-grid">
                <div class="staking-summary-card"><div class="label">Total Balance</div><div class="value accent">${stakingFormatPDEX(balance.total)} PDEX</div></div>
                <div class="staking-summary-card"><div class="label">Total Staked</div><div class="value">${stakingFormatPDEX(staking.totalStaked)} PDEX</div></div>
                <div class="staking-summary-card"><div class="label">Claimed Rewards</div><div class="value">${stakingFormatPDEX(rewards.claimedTotal)} PDEX</div></div>
                <div class="staking-summary-card"><div class="label">Unpaid Rewards</div><div class="value" style="color:var(--brand-primary);">${stakingFormatPDEX(rewards.unpaidTotal)} PDEX${rewards.unclaimedFresh ? '' : ' <span style="font-size:0.6rem;color:var(--text-muted);">computing…</span>'}</div></div>
            </div>
        </div>

        ${isOwnWallet ? `
        <div id="wallet-actions-slot">
            ${hasInjectedWalletNow() ? `
            <div class="wallet-action-bar" id="wallet-action-bar">
                <button class="wallet-action-btn primary" id="wallet-act-send"${(getStakeableBalance(data) > 0) ? '' : ' disabled title="No transferable balance available."'}>
                    <i class='bx bx-paper-plane'></i>
                    <div><strong>Send PDEX</strong><span>Transfer to any Polkadex address</span></div>
                </button>
                <button class="wallet-action-btn" id="wallet-act-stake">
                    <i class='bx bx-plus-circle'></i>
                    <div><strong>Stake more</strong><span>Add bond &amp; choose validators</span></div>
                </button>
                <button class="wallet-action-btn" id="wallet-act-payout"${(rewards.unpaidCount || 0) ? '' : ' disabled title="No unclaimed rewards to pay out."'}>
                    <i class='bx bx-gift'></i>
                    <div><strong>Pay out rewards</strong><span>${stakingFormatNumber(rewards.unpaidCount || 0)} unclaimed entr${(rewards.unpaidCount || 0) === 1 ? 'y' : 'ies'}</span></div>
                </button>
                <button class="wallet-action-btn" id="wallet-act-unstake"${((staking.activeStaked || 0) > 0) ? '' : ' disabled title="No active bond to unstake."'}>
                    <i class='bx bx-minus-circle'></i>
                    <div><strong>Unstake</strong><span>Begin the unbonding period</span></div>
                </button>
            </div>` : buildViewOnlyCallout()}
        </div>` : ''}

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
                <div class="list-header"><h2>Recent Staking Rewards</h2><a href="/staking-rewards/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">View all</a></div>
                <div class="table-responsive">
                    <table class="staking-rewards-table">
                        <thead><tr><th>Era</th><th>Amount</th><th>Date</th></tr></thead>
                        <tbody>${recentRewardsHtml}</tbody>
                    </table>
                </div>
            </div>
        </div>

        <div class="list-container glass">
            <div class="list-header"><h2>Recent Transactions</h2><a href="/account/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">View account</a></div>
            <div class="table-responsive">
                <table class="staking-rewards-table">
                    <thead><tr><th>Hash</th><th>Direction</th><th>Amount</th><th>Date</th></tr></thead>
                    <tbody>${txHtml}</tbody>
                </table>
            </div>
        </div>`;

    const switchBtn = document.getElementById('wallet-switch-btn');
    if (switchBtn) switchBtn.addEventListener('click', disconnectWallet);
    if (isOwnWallet) {
        bindWalletActionHandlers();
        bindViewOnlyCalloutHandlers();
        // Mobile wallet WebViews sometimes inject `window.injectedWeb3` a
        // beat after the page settles. If we rendered the view-only callout
        // because nothing was injected at first paint, schedule a couple of
        // re-checks that swap the action bar in once injection lands. We
        // also do the reverse — if the user's wallet session has gone away
        // while the page is open, swap the action bar out for the callout.
        scheduleWalletSigningRechecks(data);
    }
    if (priceHistory.length) renderWalletPriceChart(priceHistory);
}

// Wire up the four wallet action buttons. Idempotent — re-binding after a
// re-render of the action bar is safe because each new node has fresh listeners.
function bindWalletActionHandlers() {
    const sendBtn = document.getElementById('wallet-act-send');
    const stakeBtn = document.getElementById('wallet-act-stake');
    const payoutBtn = document.getElementById('wallet-act-payout');
    const unstakeBtn = document.getElementById('wallet-act-unstake');
    if (sendBtn && !sendBtn.disabled) sendBtn.addEventListener('click', openSendModal);
    if (stakeBtn) stakeBtn.addEventListener('click', openStakeModal);
    if (payoutBtn && !payoutBtn.disabled) payoutBtn.addEventListener('click', openPayoutModal);
    if (unstakeBtn && !unstakeBtn.disabled) unstakeBtn.addEventListener('click', openUnstakeModal);
}

// Wire up the "copy URL" affordance inside the read-only callout. The mobile
// wallet deep-link cards are plain anchors so they don't need handlers.
function bindViewOnlyCalloutHandlers() {
    const copyBtn = document.getElementById('wallet-readonly-copy-btn');
    const copyInput = document.getElementById('wallet-readonly-copy-url');
    if (copyBtn && copyInput) copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(copyInput.value);
            copyBtn.innerHTML = "<i class='bx bx-check'></i> Copied!";
            setTimeout(() => { copyBtn.innerHTML = "<i class='bx bx-copy'></i> Copy URL"; }, 1500);
        } catch (e) {
            copyInput.select();
            try { document.execCommand('copy'); } catch (e2) { /* nothing more to try */ }
        }
    });
}

// Build the "read-only mode" callout shown in place of the action bar when
// the dashboard belongs to the user but no wallet extension / mobile wallet
// is currently injecting accounts. Surfaces the same mobile-wallet deep
// links the connect panel uses so the user can hop into a wallet's in-app
// browser in one tap and come back signing-capable.
function buildViewOnlyCallout() {
    const onMobile = isMobileDevice();
    const currentUrl = (typeof location !== 'undefined') ? location.href : 'https://explorer.polkadex.ee/wallet';
    const intro = onMobile
        ? `You're viewing this account in <strong>read-only</strong> mode. To send PDEX, stake, claim rewards, or unbond, open this page inside a mobile wallet's in-app browser so it can sign transactions.`
        : `You're viewing this account in <strong>read-only</strong> mode. To send PDEX, stake, claim rewards, or unbond, connect a Substrate browser extension (Polkadot.js, Talisman, SubWallet) — or open this page in a mobile wallet's in-app browser.`;
    return `<div class="wallet-readonly-callout">
        <div class="wallet-readonly-head">
            <i class='bx bx-show'></i>
            <div>
                <strong>Read-only mode</strong>
                <p>${intro}</p>
            </div>
        </div>
        ${renderMobileWalletCards(currentUrl)}
        <div class="mobile-wallet-copyrow" style="margin-top:8px;">
            <input id="wallet-readonly-copy-url" type="text" readonly value="${stakingEscapeHtml(currentUrl)}">
            <button id="wallet-readonly-copy-btn" type="button"><i class='bx bx-copy'></i> Copy URL</button>
        </div>
    </div>`;
}

// Re-check whether a wallet is currently injected and, if the on-screen state
// is stale, swap the action bar in/out without re-rendering the rest of the
// dashboard. Runs a small bounded sequence of checks so we cover the typical
// 100–1500 ms window in which mobile WebViews inject late.
let _walletSigningRecheckTimer = null;
function scheduleWalletSigningRechecks(data) {
    if (_walletSigningRecheckTimer) { clearTimeout(_walletSigningRecheckTimer); _walletSigningRecheckTimer = null; }
    const delays = [400, 1000, 2000];
    let i = 0;
    const tick = () => {
        const slot = document.getElementById('wallet-actions-slot');
        // If the dashboard was navigated away from, stop polling.
        if (!slot || !isSameAddress(getStoredWallet(), data.address)) return;
        const hasInjection = hasInjectedWalletNow();
        const hasBar = !!document.getElementById('wallet-action-bar');
        const needsBar = hasInjection && !hasBar;
        const needsCallout = !hasInjection && hasBar;
        if (needsBar) {
            slot.innerHTML = buildWalletActionBarMarkup(data);
            bindWalletActionHandlers();
        } else if (needsCallout) {
            slot.innerHTML = buildViewOnlyCallout();
            bindViewOnlyCalloutHandlers();
        }
        if (i < delays.length) {
            _walletSigningRecheckTimer = setTimeout(tick, delays[i++]);
        }
    };
    _walletSigningRecheckTimer = setTimeout(tick, delays[i++]);
}

// Build only the action-bar HTML (used by scheduleWalletSigningRechecks when
// it needs to swap the slot's contents). Mirrors the inline markup in
// renderWalletDashboard so layout/copy stays consistent.
function buildWalletActionBarMarkup(data) {
    const staking = data.staking || {};
    const rewards = data.rewards || {};
    const stakeable = getStakeableBalance(data);
    const unpaid = rewards.unpaidCount || 0;
    const active = staking.activeStaked || 0;
    return `<div class="wallet-action-bar" id="wallet-action-bar">
        <button class="wallet-action-btn primary" id="wallet-act-send"${stakeable > 0 ? '' : ' disabled title="No transferable balance available."'}>
            <i class='bx bx-paper-plane'></i>
            <div><strong>Send PDEX</strong><span>Transfer to any Polkadex address</span></div>
        </button>
        <button class="wallet-action-btn" id="wallet-act-stake">
            <i class='bx bx-plus-circle'></i>
            <div><strong>Stake more</strong><span>Add bond &amp; choose validators</span></div>
        </button>
        <button class="wallet-action-btn" id="wallet-act-payout"${unpaid ? '' : ' disabled title="No unclaimed rewards to pay out."'}>
            <i class='bx bx-gift'></i>
            <div><strong>Pay out rewards</strong><span>${stakingFormatNumber(unpaid)} unclaimed entr${unpaid === 1 ? 'y' : 'ies'}</span></div>
        </button>
        <button class="wallet-action-btn" id="wallet-act-unstake"${active > 0 ? '' : ' disabled title="No active bond to unstake."'}>
            <i class='bx bx-minus-circle'></i>
            <div><strong>Unstake</strong><span>Begin the unbonding period</span></div>
        </button>
    </div>`;
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

// --- Wallet staking actions: stake more, pay out rewards, unstake ---
// `currentWalletData` is the most recently rendered wallet payload; it's the
// data backing each modal so users see live numbers without an extra fetch.
let currentWalletData = null;
let validatorsCache = null;
let validatorsCacheAt = 0;
const VALIDATORS_CACHE_TTL = 60 * 1000;
let stakeSelected = new Map(); // address -> { address, name }
let stakeValidators = [];

async function loadValidatorsForPicker() {
    if (validatorsCache && Date.now() - validatorsCacheAt < VALIDATORS_CACHE_TTL) return validatorsCache;
    const res = await fetch('/api/validators');
    const data = await res.json();
    validatorsCache = Array.isArray(data.validators) ? data.validators.slice() : [];
    // Sort by total stake desc so the top validators surface first.
    validatorsCache.sort((a, b) => (Number(b.totalStake) || 0) - (Number(a.totalStake) || 0));
    validatorsCacheAt = Date.now();
    return validatorsCache;
}

// PDEX has 12 decimals. Parse a decimal string into Planck units as a string
// so we never lose precision through Number.
function pdexToPlanck(value) {
    const s = String(value || '0').trim();
    if (!s) return '0';
    const neg = s.startsWith('-');
    const abs = neg ? s.slice(1) : s;
    const [intPart, decPart = ''] = abs.split('.');
    const decPadded = (decPart + '000000000000').slice(0, 12);
    const result = BigInt(intPart || '0') * 1000000000000n + BigInt(decPadded || '0');
    return (neg ? -result : result).toString();
}

function isPositiveNumberInput(str) {
    if (str == null || String(str).trim() === '') return false;
    const n = parseFloat(str);
    return Number.isFinite(n) && n > 0;
}

// Some Substrate runtimes use batch / batchAll / forceBatch under utility.
function batchTx(api, calls) {
    if (calls.length === 1) return calls[0];
    if (api.tx.utility && api.tx.utility.batchAll) return api.tx.utility.batchAll(calls);
    if (api.tx.utility && api.tx.utility.batch) return api.tx.utility.batch(calls);
    throw new Error('utility.batch / batchAll is not available on this runtime.');
}

// staking.bond signature varies: legacy is (controller, value, payee), modern
// is (value, payee). Detect from extrinsic metadata.
function buildBondOrExtra(api, planckStr, stash, hasBond) {
    if (hasBond) return api.tx.staking.bondExtra(planckStr);
    const argCount = (api.tx.staking.bond && api.tx.staking.bond.meta && api.tx.staking.bond.meta.args) ? api.tx.staking.bond.meta.args.length : 2;
    if (argCount >= 3) return api.tx.staking.bond(stash, planckStr, 'Staked');
    return api.tx.staking.bond(planckStr, 'Staked');
}

// Newer staking pallets only expose payoutStakersByPage; older only payoutStakers.
function buildPayoutCall(api, validator, era) {
    if (api.tx.staking.payoutStakers) return api.tx.staking.payoutStakers(validator, era);
    if (api.tx.staking.payoutStakersByPage) return api.tx.staking.payoutStakersByPage(validator, era, 0);
    throw new Error('staking.payoutStakers is not available on this runtime.');
}

// Available balance for staking: `free` from the API includes already-bonded
// tokens (they're locked, not reserved), so we subtract `totalStaked` to get
// the amount the user can actually bond on top of their existing stake.
// Prefers the server-computed `transferable` when present, falls back to
// computing it client-side for resilience.
function getStakeableBalance(data) {
    if (!data || !data.balance) return 0;
    if (typeof data.balance.transferable === 'number') return Math.max(0, data.balance.transferable);
    const free = Number(data.balance.free || 0);
    const staked = Number((data.staking && data.staking.totalStaked) || 0);
    return Math.max(0, free - staked);
}

// --- Stake / Nominate modal ---
function showStakeError(msg) {
    const el = document.getElementById('stake-modal-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function clearStakeError() {
    const el = document.getElementById('stake-modal-error');
    if (el) { el.textContent = ''; el.style.display = 'none'; }
}

async function openStakeModal() {
    const data = currentWalletData;
    if (!data) return alert('Wallet data is not loaded yet.');
    const modal = document.getElementById('stake-modal');
    if (!modal) return;
    clearStakeError();
    const amtInput = document.getElementById('stake-amount-input');
    if (amtInput) amtInput.value = '';

    // Use `transferable` (free - totalStaked) so the hint reflects what's
    // actually available to bond, not the raw free balance which still
    // counts tokens already locked in staking.
    const stakeableBalance = getStakeableBalance(data);
    document.getElementById('stake-available').textContent = stakingFormatPDEX(stakeableBalance);
    document.getElementById('stake-current').textContent = stakingFormatPDEX(data.staking && data.staking.totalStaked) + ' PDEX';
    document.getElementById('stake-minimum').textContent = stakingFormatPDEX(data.network && data.network.minStake) + ' PDEX';

    // Pre-fill selected with the current nominations so the user can curate.
    stakeSelected = new Map();
    for (const v of (data.staking && data.staking.nominating) || []) {
        stakeSelected.set(v.address, { address: v.address, name: v.name });
    }
    renderStakeSelected();
    modal.style.display = 'flex';

    const listEl = document.getElementById('stake-validator-list');
    if (listEl) listEl.innerHTML = '<div class="stake-empty">Loading validators…</div>';
    try {
        stakeValidators = await loadValidatorsForPicker();
    } catch (e) {
        if (listEl) listEl.innerHTML = '<div class="stake-empty">Could not load validators.</div>';
        return;
    }
    renderStakeValidatorList('');
    const searchEl = document.getElementById('stake-validator-search');
    if (searchEl) {
        searchEl.value = '';
        searchEl.oninput = () => renderStakeValidatorList(searchEl.value);
    }
}

function renderStakeValidatorList(filterStr) {
    const listEl = document.getElementById('stake-validator-list');
    if (!listEl) return;
    const f = (filterStr || '').trim().toLowerCase();
    const filtered = stakeValidators.filter(v => {
        if (!f) return true;
        return (v.name || '').toLowerCase().includes(f) || (v.address || '').toLowerCase().includes(f);
    });
    if (!filtered.length) {
        listEl.innerHTML = '<div class="stake-empty">No matching validators.</div>';
        return;
    }
    listEl.innerHTML = filtered.map(v => {
        const isSelected = stakeSelected.has(v.address);
        const name = v.name && v.name !== 'Unknown' ? v.name : stakingShortAddress(v.address);
        const commission = (Number(v.commission) || 0).toFixed(1);
        return `<div class="stake-validator-item${isSelected ? ' selected' : ''}" data-addr="${stakingEscapeHtml(v.address)}">
            <div class="stake-val-info">
                <div class="stake-val-name">${stakingEscapeHtml(name)}</div>
                <div class="stake-val-meta">${stakingFormatPDEX(v.totalStake)} PDEX &middot; ${commission}% comm</div>
            </div>
            <button type="button" class="stake-val-add" ${isSelected ? 'disabled aria-label="Already selected"' : 'aria-label="Add to selection"'}>${isSelected ? '✓' : '+'}</button>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.stake-validator-item').forEach(item => {
        const addr = item.getAttribute('data-addr');
        const addBtn = item.querySelector('.stake-val-add');
        if (addBtn) addBtn.addEventListener('click', (e) => { e.stopPropagation(); addStakeValidator(addr); });
        item.addEventListener('click', () => addStakeValidator(addr));
    });
}

function addStakeValidator(address) {
    if (stakeSelected.has(address)) return;
    if (stakeSelected.size >= 16) { showStakeError('You can nominate at most 16 validators per transaction.'); return; }
    const v = stakeValidators.find(x => x.address === address) || { address, name: null };
    stakeSelected.set(address, { address, name: v.name });
    renderStakeSelected();
    const searchEl = document.getElementById('stake-validator-search');
    renderStakeValidatorList(searchEl ? searchEl.value : '');
    clearStakeError();
}
function removeStakeValidator(address) {
    stakeSelected.delete(address);
    renderStakeSelected();
    const searchEl = document.getElementById('stake-validator-search');
    renderStakeValidatorList(searchEl ? searchEl.value : '');
}

function renderStakeSelected() {
    const el = document.getElementById('stake-selected-list');
    const countEl = document.getElementById('stake-selected-count');
    const headerCountEl = document.getElementById('stake-chosen-count');
    const n = stakeSelected.size;
    if (countEl) countEl.textContent = `${n} / 16`;
    if (headerCountEl) headerCountEl.textContent = `${n} / 16`;
    if (!el) return;
    if (!n) { el.innerHTML = '<div class="stake-empty">Pick validators from the list on the left.</div>'; return; }
    el.innerHTML = Array.from(stakeSelected.values()).map(v => {
        const name = v.name && v.name !== 'Unknown' ? v.name : stakingShortAddress(v.address);
        return `<div class="stake-validator-item selected" data-addr="${stakingEscapeHtml(v.address)}">
            <div class="stake-val-info">
                <div class="stake-val-name">${stakingEscapeHtml(name)}</div>
                <div class="stake-val-meta">${stakingShortAddress(v.address)}</div>
            </div>
            <button type="button" class="stake-val-remove" aria-label="Remove">×</button>
        </div>`;
    }).join('');
    el.querySelectorAll('.stake-val-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const addr = btn.closest('.stake-validator-item').getAttribute('data-addr');
            removeStakeValidator(addr);
        });
    });
}

async function submitStakeTx() {
    clearStakeError();
    const data = currentWalletData;
    if (!data) return showStakeError('Wallet data is not loaded.');
    if (!isSameAddress(getStoredWallet(), data.address)) return showStakeError('Connect this wallet to perform staking actions.');

    const amtStr = (document.getElementById('stake-amount-input').value || '').trim();
    const targets = Array.from(stakeSelected.keys());
    const hasAmount = amtStr !== '' && parseFloat(amtStr) > 0;

    if (!targets.length) return showStakeError('Select at least one validator before submitting.');
    if (targets.length > 16) return showStakeError('At most 16 validators can be nominated.');

    const available = getStakeableBalance(data);
    const hasBond = ((data.staking && data.staking.totalStaked) || 0) > 0;

    if (hasAmount) {
        const amt = parseFloat(amtStr);
        if (!Number.isFinite(amt) || amt <= 0) return showStakeError('Enter a valid amount.');
        if (amt > available) return showStakeError(`Amount exceeds your available balance (${stakingFormatPDEX(available)} PDEX).`);
        if (amt > available - 0.01) return showStakeError(`Keep at least 0.01 PDEX free for the transaction fee. Try ${stakingFormatPDEX(Math.max(0, available - 0.01))} PDEX or less.`);
        if (!hasBond) {
            const minStake = Number((data.network && data.network.minStake) || 0);
            if (minStake > 0 && amt < minStake) {
                return showStakeError(`A first-time bond must be at least the minimum stake (${stakingFormatPDEX(minStake)} PDEX).`);
            }
        }
    } else if (!hasBond) {
        return showStakeError('You have no existing bond — enter an amount to bond as well.');
    }

    await submitSignedTx({
        buildTx: (api) => {
            const calls = [];
            if (hasAmount) calls.push(buildBondOrExtra(api, pdexToPlanck(amtStr), data.address, hasBond));
            calls.push(api.tx.staking.nominate(targets));
            return batchTx(api, calls);
        },
        label: 'Stake & nominate',
        button: document.getElementById('submit-stake-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Submit',
        onError: showStakeError,
        onSuccess: () => {
            const modal = document.getElementById('stake-modal');
            if (modal) modal.style.display = 'none';
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

// --- Pay out rewards modal ---
function openPayoutModal() {
    const data = currentWalletData;
    if (!data) return alert('Wallet data is not loaded yet.');
    const entries = (data.rewards && data.rewards.unpaidEntries) || [];
    const total = (data.rewards && data.rewards.unpaidTotal) || 0;
    document.getElementById('payout-count').textContent = stakingFormatNumber(entries.length);
    document.getElementById('payout-total').textContent = stakingFormatPDEX(total) + ' PDEX';
    const errEl = document.getElementById('payout-modal-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    const listEl = document.getElementById('payout-entries');
    const submitBtn = document.getElementById('submit-payout-tx-btn');
    if (!entries.length) {
        listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.85rem;">No unclaimed rewards available to pay out. The indexer recomputes unpaid rewards in the background; try again in a minute.</div>';
        if (submitBtn) submitBtn.disabled = true;
    } else {
        listEl.innerHTML = entries.map(e => `<div class="payout-entry">
            <div><span class="payout-era">Era ${stakingFormatNumber(e.era)}</span> <a href="/validator/${encodeURIComponent(e.validator)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">${stakingShortAddress(e.validator)}</a></div>
            <div class="payout-amt">${stakingFormatPDEX(e.amount)} PDEX</div>
        </div>`).join('');
        if (submitBtn) submitBtn.disabled = false;
    }
    document.getElementById('payout-modal').style.display = 'flex';
}

async function submitPayoutTx() {
    const errEl = document.getElementById('payout-modal-error');
    const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } };
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    const data = currentWalletData;
    if (!data) return fail('Wallet data is not loaded.');
    const entries = (data.rewards && data.rewards.unpaidEntries) || [];
    if (!entries.length) return fail('Nothing to claim right now.');
    // Cap at 30 per tx to stay well under per-block weight limits; user can re-trigger.
    const batch = entries.slice(0, 30);
    const truncated = entries.length > batch.length;
    await submitSignedTx({
        buildTx: (api) => batchTx(api, batch.map(e => buildPayoutCall(api, e.validator, e.era))),
        label: 'Payout rewards' + (truncated ? ` (${batch.length} of ${entries.length})` : ''),
        button: document.getElementById('submit-payout-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Pay Out',
        onError: fail,
        onSuccess: () => {
            const modal = document.getElementById('payout-modal');
            if (modal) modal.style.display = 'none';
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

// --- Unstake modal ---
function openUnstakeModal() {
    const data = currentWalletData;
    if (!data) return alert('Wallet data is not loaded yet.');
    const errEl = document.getElementById('unstake-modal-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    const amtInput = document.getElementById('unstake-amount-input');
    if (amtInput) amtInput.value = '';
    const s = data.staking || {};
    document.getElementById('unstake-active').textContent = stakingFormatPDEX(s.activeStaked) + ' PDEX';
    document.getElementById('unstake-unlocking').textContent = stakingFormatPDEX(s.unlocking) + ' PDEX';
    document.getElementById('unstake-period').textContent = formatDuration(data.network && data.network.unbondingMs);
    document.getElementById('unstake-modal').style.display = 'flex';
}

async function submitUnstakeTx() {
    const errEl = document.getElementById('unstake-modal-error');
    const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } };
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    const data = currentWalletData;
    if (!data) return fail('Wallet data is not loaded.');
    if (!isSameAddress(getStoredWallet(), data.address)) return fail('Connect this wallet to perform staking actions.');
    const amtStr = (document.getElementById('unstake-amount-input').value || '').trim();
    if (!isPositiveNumberInput(amtStr)) return fail('Enter an amount greater than zero.');
    const amt = parseFloat(amtStr);
    const active = Number((data.staking && data.staking.activeStaked) || 0);
    if (active <= 0) return fail('You have no active bonded stake to unbond.');
    if (amt > active) return fail(`Amount exceeds your active bonded stake (${stakingFormatPDEX(active)} PDEX).`);
    await submitSignedTx({
        buildTx: (api) => api.tx.staking.unbond(pdexToPlanck(amtStr)),
        label: 'Unstake',
        button: document.getElementById('submit-unstake-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Unstake',
        onError: fail,
        onSuccess: () => {
            const modal = document.getElementById('unstake-modal');
            if (modal) modal.style.display = 'none';
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

// --- Send / Transfer modal -------------------------------------------------
// Token transfer for the connected wallet. Uses balances.transferKeepAlive by
// default (so the user can't accidentally reap their own account by undershooting
// the existential deposit) and balances.transferAllowDeath if they explicitly
// uncheck "Keep account alive". Falls back to balances.transfer on older
// runtimes that don't expose the split variants. The fee is estimated via
// `tx.paymentInfo(sender)` and refreshed as the recipient/amount changes.
const SEND_FEE_BUFFER = 0.05; // PDEX held back from "Max" to cover fee + slippage.
let sendFeeDebounce = null;
let sendLastFeePDEX = null;     // last estimated fee in PDEX
let sendValidRecipient = false; // cached so we don't re-validate on every keystroke

function showSendError(msg) {
    const el = document.getElementById('send-modal-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function clearSendError() {
    const el = document.getElementById('send-modal-error');
    if (el) { el.textContent = ''; el.style.display = 'none'; }
}

// Build the transfer extrinsic, picking the best variant available on the
// connected runtime. Newer Substrate splits the call into KeepAlive vs
// AllowDeath; older versions only have balances.transfer.
function buildTransferTx(api, dest, planckStr, keepAlive) {
    const t = api.tx.balances;
    if (!t) throw new Error('balances pallet is not available on this runtime.');
    if (keepAlive && t.transferKeepAlive) return t.transferKeepAlive(dest, planckStr);
    if (!keepAlive && t.transferAllowDeath) return t.transferAllowDeath(dest, planckStr);
    if (t.transferAllowDeath) return t.transferAllowDeath(dest, planckStr);
    if (t.transferKeepAlive) return t.transferKeepAlive(dest, planckStr);
    if (t.transfer) return t.transfer(dest, planckStr);
    throw new Error('No supported balances.transfer* call on this runtime.');
}

// Existential deposit (in PDEX) read from chain constants.
function getExistentialDepositPDEX() {
    try {
        const ed = globalApi && globalApi.consts && globalApi.consts.balances && globalApi.consts.balances.existentialDeposit;
        if (!ed) return 0;
        return Number(BigInt(ed.toString())) / 1e12;
    } catch (e) { return 0; }
}

// Re-estimate the network fee for the current recipient + amount and paint it
// into the modal's summary row. Debounced so we don't spam the chain on every
// keystroke. Falls back to a sensible buffer if estimation isn't available.
function refreshSendFeeEstimate() {
    if (sendFeeDebounce) clearTimeout(sendFeeDebounce);
    sendFeeDebounce = setTimeout(async () => {
        const data = currentWalletData;
        const feeEl = document.getElementById('send-fee');
        const amountPreviewEl = document.getElementById('send-amount-preview');
        const recvPreviewEl = document.getElementById('send-recv-preview');
        const toEl = document.getElementById('send-to-input');
        const amtEl = document.getElementById('send-amount-input');
        const keepAliveEl = document.getElementById('send-keep-alive');
        if (!data || !globalApi || !feeEl) return;
        const to = (toEl && toEl.value || '').trim();
        const amtStr = (amtEl && amtEl.value || '').trim();
        const amt = parseFloat(amtStr);
        const validAmt = Number.isFinite(amt) && amt > 0;
        if (amountPreviewEl) amountPreviewEl.textContent = validAmt ? (stakingFormatPDEX(amt) + ' PDEX') : '—';

        if (!sendValidRecipient || !validAmt) {
            feeEl.textContent = '—';
            if (recvPreviewEl) recvPreviewEl.textContent = '—';
            sendLastFeePDEX = null;
            return;
        }
        try {
            const tx = buildTransferTx(globalApi, to, pdexToPlanck(amtStr), !!(keepAliveEl && keepAliveEl.checked));
            const info = await tx.paymentInfo(data.address);
            const feePlanck = info && info.partialFee ? BigInt(info.partialFee.toString()) : 0n;
            const feePDEX = Number(feePlanck) / 1e12;
            sendLastFeePDEX = feePDEX;
            feeEl.textContent = feePDEX > 0 ? (stakingFormatPDEX(feePDEX) + ' PDEX') : '~0';
            if (recvPreviewEl) recvPreviewEl.textContent = stakingFormatPDEX(amt) + ' PDEX';
        } catch (e) {
            // paymentInfo can fail before a node connection is ready; show a
            // conservative placeholder rather than blocking the flow.
            feeEl.textContent = '≈ ' + stakingFormatPDEX(SEND_FEE_BUFFER) + ' PDEX (est.)';
            sendLastFeePDEX = null;
            if (recvPreviewEl) recvPreviewEl.textContent = stakingFormatPDEX(amt) + ' PDEX';
        }
    }, 250);
}

function validateSendRecipient() {
    const toEl = document.getElementById('send-to-input');
    const hintEl = document.getElementById('send-to-hint');
    if (!toEl) return;
    const v = (toEl.value || '').trim();
    if (!v) {
        sendValidRecipient = false;
        if (hintEl) { hintEl.textContent = 'Paste a valid Polkadex (SS58 prefix 88) address.'; hintEl.style.color = ''; }
        return;
    }
    if (!isValidPolkadexAddress(v)) {
        sendValidRecipient = false;
        if (hintEl) { hintEl.textContent = 'That address is not valid on Polkadex.'; hintEl.style.color = 'var(--error)'; }
        return;
    }
    const data = currentWalletData;
    if (data && isSameAddress(v, data.address)) {
        sendValidRecipient = false;
        if (hintEl) { hintEl.textContent = 'Cannot send to yourself.'; hintEl.style.color = 'var(--error)'; }
        return;
    }
    sendValidRecipient = true;
    if (hintEl) { hintEl.textContent = 'Address looks good.'; hintEl.style.color = 'var(--success, #2ecc71)'; }
}

function openSendModal() {
    const data = currentWalletData;
    if (!data) return alert('Wallet data is not loaded yet.');
    if (!isSameAddress(getStoredWallet(), data.address)) return alert('Connect this wallet to send PDEX.');
    const modal = document.getElementById('send-modal');
    if (!modal) return;
    clearSendError();
    sendValidRecipient = false;
    sendLastFeePDEX = null;

    const toEl = document.getElementById('send-to-input');
    const amtEl = document.getElementById('send-amount-input');
    if (toEl) toEl.value = '';
    if (amtEl) amtEl.value = '';
    const hintEl = document.getElementById('send-to-hint');
    if (hintEl) { hintEl.textContent = 'Paste a valid Polkadex (SS58 prefix 88) address.'; hintEl.style.color = ''; }

    const available = getStakeableBalance(data);
    const availEl = document.getElementById('send-available');
    if (availEl) availEl.textContent = stakingFormatPDEX(available);
    const feeEl = document.getElementById('send-fee');
    if (feeEl) feeEl.textContent = '—';
    const previewEl = document.getElementById('send-amount-preview');
    if (previewEl) previewEl.textContent = '—';
    const recvEl = document.getElementById('send-recv-preview');
    if (recvEl) recvEl.textContent = '—';

    modal.style.display = 'flex';
    // Focus the recipient field for fast keyboard entry.
    setTimeout(() => { if (toEl) toEl.focus(); }, 50);
}

async function submitSendTx() {
    clearSendError();
    const data = currentWalletData;
    if (!data) return showSendError('Wallet data is not loaded.');
    if (!isSameAddress(getStoredWallet(), data.address)) return showSendError('Connect this wallet to send PDEX.');

    const to = (document.getElementById('send-to-input').value || '').trim();
    const amtStr = (document.getElementById('send-amount-input').value || '').trim();
    const keepAlive = !!document.getElementById('send-keep-alive').checked;

    if (!to) return showSendError('Enter a recipient address.');
    if (!isValidPolkadexAddress(to)) return showSendError('That recipient address is not valid on Polkadex.');
    if (isSameAddress(to, data.address)) return showSendError('You cannot send to your own address.');
    if (!isPositiveNumberInput(amtStr)) return showSendError('Enter an amount greater than zero.');
    const amt = parseFloat(amtStr);
    if (!Number.isFinite(amt) || amt <= 0) return showSendError('Enter a valid amount.');

    const available = getStakeableBalance(data);
    const feeBuffer = (sendLastFeePDEX != null) ? Math.max(sendLastFeePDEX * 1.2, SEND_FEE_BUFFER / 5) : SEND_FEE_BUFFER;
    if (amt > available) return showSendError(`Amount exceeds your transferable balance (${stakingFormatPDEX(available)} PDEX).`);
    if (amt > available - feeBuffer) return showSendError(`Keep at least ~${stakingFormatPDEX(feeBuffer)} PDEX free for the network fee. Try ${stakingFormatPDEX(Math.max(0, available - feeBuffer))} PDEX or less.`);

    // Warn the user if sending below the existential deposit to a recipient
    // that probably doesn't exist yet — the runtime will reject the transfer.
    const ed = getExistentialDepositPDEX();
    if (ed > 0 && amt < ed) {
        return showSendError(`Amount must be at least the existential deposit (${stakingFormatPDEX(ed)} PDEX) when funding a new account.`);
    }

    await submitSignedTx({
        buildTx: (api) => buildTransferTx(api, to, pdexToPlanck(amtStr), keepAlive),
        label: 'Transfer',
        button: document.getElementById('submit-send-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Send',
        onError: showSendError,
        onSuccess: () => {
            const modal = document.getElementById('send-modal');
            if (modal) modal.style.display = 'none';
            // Refresh dashboard a beat later so the chain has finalized the
            // new balances by the time we re-query.
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

// One-time wiring of the static modal controls (close buttons, max buttons, submit).
(function wireWalletStakingModals() {
    const closeOn = (modalId, btnId) => {
        const modal = document.getElementById(modalId);
        const btn = document.getElementById(btnId);
        if (btn && modal) btn.addEventListener('click', () => { modal.style.display = 'none'; });
        if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    };
    closeOn('stake-modal', 'close-stake-modal');
    closeOn('payout-modal', 'close-payout-modal');
    closeOn('unstake-modal', 'close-unstake-modal');
    closeOn('send-modal', 'close-send-modal');

    const stakeMax = document.getElementById('stake-max-btn');
    if (stakeMax) stakeMax.addEventListener('click', () => {
        const data = currentWalletData;
        if (!data) return;
        // Max button should propose the transferable balance (free minus
        // already-bonded tokens), keeping a small fee buffer.
        const available = getStakeableBalance(data);
        const usable = Math.max(0, available - 0.01);
        const amtInput = document.getElementById('stake-amount-input');
        if (amtInput) amtInput.value = usable.toFixed(4);
    });
    const stakeClear = document.getElementById('stake-clear-btn');
    if (stakeClear) stakeClear.addEventListener('click', () => {
        stakeSelected.clear();
        renderStakeSelected();
        const searchEl = document.getElementById('stake-validator-search');
        renderStakeValidatorList(searchEl ? searchEl.value : '');
    });
    const stakeSubmit = document.getElementById('submit-stake-tx-btn');
    if (stakeSubmit) stakeSubmit.addEventListener('click', submitStakeTx);

    const unstakeMax = document.getElementById('unstake-max-btn');
    if (unstakeMax) unstakeMax.addEventListener('click', () => {
        const data = currentWalletData;
        if (!data) return;
        const active = Number((data.staking && data.staking.activeStaked) || 0);
        const amtInput = document.getElementById('unstake-amount-input');
        if (amtInput) amtInput.value = active.toFixed(4);
    });
    const unstakeSubmit = document.getElementById('submit-unstake-tx-btn');
    if (unstakeSubmit) unstakeSubmit.addEventListener('click', submitUnstakeTx);

    const payoutSubmit = document.getElementById('submit-payout-tx-btn');
    if (payoutSubmit) payoutSubmit.addEventListener('click', submitPayoutTx);

    // Send modal: Max, submit, live validation, live fee estimate.
    const sendMax = document.getElementById('send-max-btn');
    if (sendMax) sendMax.addEventListener('click', () => {
        const data = currentWalletData;
        if (!data) return;
        // Reserve a small fee buffer — refined to the actual estimated fee
        // (×1.2 for safety) when paymentInfo has returned at least once.
        const available = getStakeableBalance(data);
        const buffer = (sendLastFeePDEX != null) ? Math.max(sendLastFeePDEX * 1.2, SEND_FEE_BUFFER / 5) : SEND_FEE_BUFFER;
        const usable = Math.max(0, available - buffer);
        const amtInput = document.getElementById('send-amount-input');
        if (amtInput) {
            amtInput.value = usable.toFixed(4);
            refreshSendFeeEstimate();
        }
    });
    const sendSubmit = document.getElementById('submit-send-tx-btn');
    if (sendSubmit) sendSubmit.addEventListener('click', submitSendTx);
    const sendTo = document.getElementById('send-to-input');
    if (sendTo) sendTo.addEventListener('input', () => { validateSendRecipient(); refreshSendFeeEstimate(); });
    const sendAmt = document.getElementById('send-amount-input');
    if (sendAmt) sendAmt.addEventListener('input', refreshSendFeeEstimate);
    const sendKeep = document.getElementById('send-keep-alive');
    if (sendKeep) sendKeep.addEventListener('change', refreshSendFeeEstimate);
})();

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
        return `<a class="discussion-thread-row" href="/discussions/${encodeURIComponent(t.id)}">
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
                    <a href="/account/${encodeURIComponent(p.author)}" class="item-link" style="color:var(--brand-secondary);font-weight:600;">${stakingEscapeHtml(p.authorName && p.authorName !== 'Unknown' ? p.authorName : stakingShortAddress(p.author))}</a>
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
                <a href="/discussions" class="item-link" style="color:var(--text-secondary);font-size:0.8rem;">All discussions</a>
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
                if (accs.some(a => isSameAddress(a.address, address))) return ext.signer;
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
            <td><a href="/account/${encodeURIComponent(p.proposer)}" class="item-link" style="color:var(--brand-secondary);">${stakingEscapeHtml(who)}</a></td>
            <td style="text-align:right;">${stakingFormatPDEX(p.deposit)} PDEX</td>
            <td style="text-align:right;">${stakingFormatNumber(p.seconds)}</td>
            <td style="text-align:right;"><a href="/discussions/proposal-${p.index}" class="item-link" style="color:var(--brand-secondary);">Discuss</a></td>
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
let councilData = null;

async function fetchCouncilData() {
    try {
        const response = await fetch('/api/council');
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        if (data.pallet) councilPalletName = data.pallet;
        councilData = data;

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
        renderCouncilMotions(data);
    } catch (err) {
        console.error('Failed to fetch council data', err);
        const failMsg = '<tr><td colspan="2" style="text-align:center; padding:20px; color: var(--error);">Failed to load council data.</td></tr>';
        ['council-members-list', 'council-runnersup-list', 'council-candidates-list'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = failMsg;
        });
        const motionsEl = document.getElementById('council-motions-content');
        if (motionsEl) motionsEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--error);">Failed to load council motions.</div>';
    }
}

// --- Council Motions: rendering + on-chain actions ---
function councilMotionStatus(m, currentBlock) {
    const ayes = (m.ayes || []).length;
    const nays = (m.nays || []).length;
    const threshold = Number(m.threshold) || 0;
    if (threshold && ayes >= threshold) return { key: 'approved', label: 'Threshold met', badge: 'claimed', closeable: true };
    if (threshold && nays >= threshold) return { key: 'rejected', label: 'Rejected', badge: 'unclaimed', closeable: true };
    if (m.end && currentBlock && currentBlock >= m.end) return { key: 'expired', label: 'Voting ended', badge: 'neutral', closeable: true };
    return { key: 'voting', label: 'Voting open', badge: 'neutral', closeable: false };
}

function renderCouncilMotions(data) {
    const root = document.getElementById('council-motions-content');
    if (!root) return;
    const motions = Array.isArray(data.motions) ? data.motions : [];
    const members = Array.isArray(data.members) ? data.members : [];
    const currentBlock = Number(data.currentBlock) || 0;
    const stored = getStoredWallet();
    const isCouncilMember = !!stored && members.some(m => m.address === stored);

    if (!data.collectivePallet) {
        root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">Council motions are not available on this runtime.</div>';
        return;
    }

    const summary = `
        <div class="staking-summary-grid" style="margin-bottom:20px;">
            <div class="staking-summary-card"><div class="label">Active Motions</div><div class="value accent">${stakingFormatNumber(motions.length)}</div></div>
            <div class="staking-summary-card"><div class="label">Council Seats</div><div class="value">${stakingFormatNumber(members.length)}</div></div>
            <div class="staking-summary-card"><div class="label">Your Role</div><div class="value" style="font-size:1rem;">${isCouncilMember ? 'Council member' : (stored ? 'Observer' : 'Not connected')}</div></div>
        </div>`;

    if (!motions.length) {
        root.innerHTML = summary
            + governanceIndexNote(data.history, 'motions')
            + '<div style="padding:28px;text-align:center;color:var(--text-muted);">No motions are currently open before the council.</div>'
            + renderResolvedMotions(data);
        return;
    }

    const roleNote = isCouncilMember
        ? '<div style="margin-bottom:16px;color:var(--text-secondary);font-size:0.82rem;">You are a council member — you can vote on and close the motions below.</div>'
        : `<div style="margin-bottom:16px;color:var(--text-muted);font-size:0.82rem;">${stored ? 'Voting and closing motions is restricted to council members.' : 'Connect a council member wallet to vote on or close motions.'}</div>`;

    const cards = motions.map(m => {
        const st = councilMotionStatus(m, currentBlock);
        const ayes = (m.ayes || []).length;
        const nays = (m.nays || []).length;
        const threshold = Number(m.threshold) || 0;
        const ayePct = threshold ? Math.min(100, Math.round(ayes / threshold * 100)) : 0;
        const nayPct = threshold ? Math.min(100, Math.round(nays / threshold * 100)) : 0;
        const votedAye = !!stored && (m.ayes || []).includes(stored);
        const votedNay = !!stored && (m.nays || []).includes(stored);
        const idxLabel = (m.index === null || m.index === undefined) ? '—' : ('#' + m.index);

        const argsHtml = (m.args && m.args.length)
            ? `<details class="motion-details"><summary>Call arguments (${m.args.length})</summary>
                 <div class="motion-args">${m.args.map(a => `<div><span>${stakingEscapeHtml(a.name)}</span><code>${stakingEscapeHtml(String(a.value).slice(0, 220))}${String(a.value).length > 220 ? '…' : ''}</code></div>`).join('')}</div>
               </details>`
            : '';

        const voterList = (label, addrs) => {
            if (!addrs || !addrs.length) return '';
            return `<details class="motion-details"><summary>${label} (${addrs.length})</summary>
                <div class="motion-voters">${addrs.map(a => `<a href="/account/${encodeURIComponent(a)}" class="item-link" style="color:var(--brand-secondary);">${stakingShortAddress(a)}</a>`).join('')}</div>
            </details>`;
        };

        let actions = '';
        if (isCouncilMember) {
            actions = `<div class="motion-actions">
                <button class="motion-btn aye motion-aye-btn" data-hash="${m.hash}" data-index="${m.index}" ${votedAye ? 'disabled' : ''}>${votedAye ? 'Voted Aye' : 'Vote Aye'}</button>
                <button class="motion-btn nay motion-nay-btn" data-hash="${m.hash}" data-index="${m.index}" ${votedNay ? 'disabled' : ''}>${votedNay ? 'Voted Nay' : 'Vote Nay'}</button>
                <button class="motion-btn close motion-close-btn" data-hash="${m.hash}" data-index="${m.index}" ${st.closeable ? '' : 'disabled'} title="${st.closeable ? 'Finalize this motion' : 'Available once the vote is decided or has ended'}">Close motion</button>
            </div>`;
        }

        return `<div class="motion-card">
            <div class="motion-card-head">
                <div>
                    <span class="motion-index">${idxLabel}</span>
                    <span class="motion-title">${stakingEscapeHtml(m.title || 'Council Motion')}</span>
                </div>
                <span class="reward-badge ${st.badge}">${st.label}</span>
            </div>
            <div class="motion-hash">${stakingEscapeHtml(m.hash)}</div>
            <div class="motion-tally">
                <div class="motion-tally-row"><span>Ayes</span><span>${ayes} / ${threshold} threshold</span></div>
                <div class="motion-bar"><div class="motion-bar-fill aye" style="width:${ayePct}%;"></div></div>
                <div class="motion-tally-row"><span>Nays</span><span>${nays} / ${threshold} threshold</span></div>
                <div class="motion-bar"><div class="motion-bar-fill nay" style="width:${nayPct}%;"></div></div>
            </div>
            <div class="motion-meta">Voting ends at block ${stakingFormatNumber(m.end)}${currentBlock ? ` &middot; current block ${stakingFormatNumber(currentBlock)}` : ''}</div>
            ${argsHtml}
            ${voterList('Aye voters', m.ayes)}
            ${voterList('Nay voters', m.nays)}
            ${actions}
        </div>`;
    }).join('');

    root.innerHTML = summary + governanceIndexNote(data.history, 'motions') + roleNote
        + '<div class="motion-list">' + cards + '</div>'
        + renderResolvedMotions(data);

    root.querySelectorAll('.motion-aye-btn').forEach(b => b.addEventListener('click', () => councilMotionVote(b.getAttribute('data-hash'), b.getAttribute('data-index'), true)));
    root.querySelectorAll('.motion-nay-btn').forEach(b => b.addEventListener('click', () => councilMotionVote(b.getAttribute('data-hash'), b.getAttribute('data-index'), false)));
    root.querySelectorAll('.motion-close-btn').forEach(b => b.addEventListener('click', () => councilMotionClose(b.getAttribute('data-hash'), b.getAttribute('data-index'))));
}

// Resolved (historical) council motions, crawled from chain events.
function resolvedMotionBadge(status) {
    if (status === 'executed') return '<span class="reward-badge claimed">Executed</span>';
    if (status === 'approved') return '<span class="reward-badge claimed">Approved</span>';
    if (status === 'disapproved') return '<span class="reward-badge unclaimed">Disapproved</span>';
    return '<span class="reward-badge neutral">Closed</span>';
}

function renderResolvedMotions(data) {
    const history = Array.isArray(data.motionHistory) ? data.motionHistory : [];
    const resolved = history.filter(m => m.status && m.status !== 'proposed');
    if (!resolved.length) return '';
    const rows = resolved.map(m => {
        const idx = (m.motionIndex === null || m.motionIndex === undefined) ? '—' : ('#' + m.motionIndex);
        const call = (m.section && m.method) ? `${m.section}.${m.method}` : 'Council Motion';
        const proposer = m.proposer
            ? `<a href="/account/${encodeURIComponent(m.proposer)}" class="item-link" style="color:var(--brand-secondary);">${stakingEscapeHtml(treasuryPartyName(m.proposerName, m.proposer))}</a>`
            : '<span style="color:var(--text-muted);">—</span>';
        const tally = (m.ayes == null && m.nays == null) ? '—' : `${m.ayes || 0} / ${m.nays || 0}`;
        return `<tr>
            <td>${idx}</td>
            <td><span class="motion-title" style="font-size:0.82rem;">${stakingEscapeHtml(call)}</span></td>
            <td>${proposer}</td>
            <td style="text-align:right;">${m.threshold == null ? '—' : m.threshold}</td>
            <td style="text-align:right;">${tally}</td>
            <td style="text-align:right;">${stakingFormatNumber(m.resolvedBlock)}</td>
            <td style="text-align:right;">${resolvedMotionBadge(m.status)}</td>
        </tr>`;
    }).join('');
    return `<div style="margin-top:26px;">
        <h3 style="font-size:0.95rem;color:var(--text-primary);margin-bottom:12px;">Resolved Motions <span style="color:var(--text-muted);font-weight:400;font-size:0.8rem;">(${resolved.length})</span></h3>
        <div class="table-responsive"><table class="data-table">
            <thead><tr><th>Motion</th><th>Call</th><th>Proposer</th><th style="text-align:right;">Threshold</th><th style="text-align:right;">Ayes / Nays</th><th style="text-align:right;">Resolved Block</th><th style="text-align:right;">Outcome</th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div>
    </div>`;
}

function councilMotionVote(hash, index, approve) {
    if (!councilData || !councilData.collectivePallet) return alert('Council data is not ready yet.');
    const idx = Number(index);
    if (!confirm(`Cast a ${approve ? 'AYE' : 'NAY'} vote on council motion #${idx}?`)) return;
    const pallet = councilData.collectivePallet;
    submitSignedTx({
        buildTx: (api) => api.tx[pallet].vote(hash, idx, approve),
        label: `Motion #${idx} ${approve ? 'aye' : 'nay'} vote`,
        onSuccess: () => setTimeout(fetchCouncilData, 2500)
    });
}

function councilMotionClose(hash, index) {
    if (!councilData || !councilData.collectivePallet) return alert('Council data is not ready yet.');
    const idx = Number(index);
    const motion = (councilData.motions || []).find(m => m.hash === hash);
    if (!motion) return alert('Motion details are no longer available — refresh the page.');
    if (!confirm(`Close council motion #${idx}?\n\nThis finalizes the vote and, if it passed, dispatches the proposed call.`)) return;
    const pallet = councilData.collectivePallet;
    const weightBound = { refTime: motion.weightRefTime || '10000000000', proofSize: motion.weightProofSize || '500000' };
    submitSignedTx({
        buildTx: (api) => api.tx[pallet].close(hash, idx, weightBound, motion.lengthBound || 0),
        label: `Motion #${idx} close`,
        onSuccess: () => setTimeout(fetchCouncilData, 2500)
    });
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
        
        const account = injected.find(a => isSameAddress(a.address, address));
        if (!account) return alert('Connected account not found in wallet extension. Please reconnect.');

        const provider = window.injectedWeb3[account.source];
        const ext = await provider.enable('Polkadex Explorer');

        document.getElementById('submit-candidacy-tx-btn').innerText = 'Signing...';

        const response = await fetch('/api/council');
        const data = await response.json();
        const candidateCount = (data.candidates || []).length;

        const unsub = await globalApi.tx[councilPalletName].submitCandidacy(candidateCount)
            .signAndSend(account.address, { signer: ext.signer }, ({ status }) => {
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
        
        const account = injected.find(a => isSameAddress(a.address, address));
        if (!account) return alert('Connected account not found in wallet extension.');

        const provider = window.injectedWeb3[account.source];
        const ext = await provider.enable('Polkadex Explorer');

        document.getElementById('submit-vote-tx-btn').innerText = 'Signing...';

        const unsub = await globalApi.tx[councilPalletName].vote(candidates, stakePlanck.toString())
            .signAndSend(account.address, { signer: ext.signer }, ({ status }) => {
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

// --- Shared signed-transaction helper ---
// Resolves the connected wallet, requests a signer from the extension, signs and
// sends a transaction, and reports success/failure. Used by Treasury and Council.
async function submitSignedTx({ buildTx, label, button, busyText, idleText, onError, onSuccess }) {
    const fail = (m) => { if (onError) onError(m); else alert(m); };
    const address = getStoredWallet();
    if (!address) return fail('Please connect your wallet first.');
    if (!globalApi) return fail('Blockchain connection is not ready yet. Please wait a moment and try again.');

    let injected;
    try { injected = await getInjectedAccounts(); }
    catch (e) { return fail('Could not access your wallet extension.'); }
    if (!injected || !injected.length) {
        return fail(isMobileDevice()
            ? "You're in read-only mode — no wallet is connected to this browser tab. Open this page inside Nova Wallet or SubWallet's in-app browser to sign transactions, then come back to this action."
            : 'No Substrate wallet extension found. Install Polkadot.js, Talisman or SubWallet (desktop) — or open this page in a mobile wallet\'s in-app browser.');
    }

    // Match by underlying public key so an SS58-prefix mismatch between the
    // extension (often prefix 42) and the stored address (Polkadex prefix 88)
    // doesn't make the account look missing.
    const account = injected.find(a => isSameAddress(a.address, address));
    if (!account) return fail("This account isn't available in your connected wallet. Switch to the right account in your wallet extension (or reconnect) and try again.");

    let signer;
    try {
        const provider = window.injectedWeb3[account.source];
        const ext = await provider.enable('Polkadex Explorer');
        signer = ext.signer;
    } catch (e) { return fail('Wallet extension authorization was rejected.'); }

    const setBusy = () => { if (button) { button.disabled = true; if (busyText) button.textContent = busyText; } };
    const restore = () => { if (button) { button.disabled = false; if (idleText) button.textContent = idleText; } };

    setBusy();
    try {
        const tx = buildTx(globalApi);
        // Sign with the extension's address (its native SS58 format) so the
        // injected signer recognizes the account.
        const unsub = await tx.signAndSend(account.address, { signer }, (result) => {
            const { status, dispatchError } = result;
            if (dispatchError) {
                let msg = dispatchError.toString();
                if (dispatchError.isModule) {
                    try {
                        const meta = globalApi.registry.findMetaError(dispatchError.asModule);
                        msg = `${meta.section}.${meta.name}`;
                    } catch (e) { }
                }
                fail((label || 'Transaction') + ' failed: ' + msg);
                restore();
                if (typeof unsub === 'function') unsub();
                return;
            }
            if (status.isInBlock || status.isFinalized) {
                restore();
                if (typeof unsub === 'function') unsub();
                alert((label || 'Transaction') + ' was included on-chain.');
                if (onSuccess) onSuccess();
            }
        });
    } catch (e) {
        fail((label || 'Transaction') + ' failed: ' + (e && e.message ? e.message : String(e)));
        restore();
    }
}

// --- Treasury Module Logic ---
let treasuryData = null;
let treasuryTab = 'overview';

async function fetchTreasuryData() {
    treasuryTab = 'overview';
    const root = document.getElementById('treasury-content');
    if (!root) return;
    root.innerHTML = '<div class="list-container glass" style="padding:40px;text-align:center;color:var(--text-secondary);">Loading treasury data…</div>';
    try {
        const res = await fetch('/api/treasury');
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
        treasuryData = data;
        renderTreasury();
    } catch (e) {
        root.innerHTML = `<div class="list-container glass" style="padding:40px;text-align:center;color:var(--error);">Error: ${stakingEscapeHtml(e.message)}</div>`;
    }
}

function renderTreasury() {
    const root = document.getElementById('treasury-content');
    if (!root || !treasuryData) return;
    const d = treasuryData;
    const all = Array.isArray(d.allProposals) ? d.allProposals : [];
    const openProposals = all.filter(p => p.status === 'proposed');
    const approvedProposals = all.filter(p => p.status === 'approved');
    const historyProposals = all.filter(p => p.status === 'awarded' || p.status === 'rejected');

    const tabBtn = (key, label) => `<button class="account-tab${treasuryTab === key ? ' active' : ''}" data-treastab="${key}">${label}</button>`;
    let body;
    if (treasuryTab === 'proposals') body = renderTreasuryProposals(openProposals);
    else if (treasuryTab === 'approved') body = renderTreasuryApproved(approvedProposals);
    else if (treasuryTab === 'history') body = renderTreasuryHistory(historyProposals);
    else body = renderTreasuryOverview(d, openProposals.length, approvedProposals.length, historyProposals);

    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header">
                <h2>Treasury</h2>
                <div style="display:flex;gap:14px;align-items:center;">
                    <span style="color:var(--text-secondary);font-size:0.78rem;">${stakingFormatNumber(d.proposalCount)} lifetime proposals</span>
                    <button id="treasury-submit-btn" class="staking-download-btn"><i class='bx bx-plus-circle'></i> Submit proposal</button>
                </div>
            </div>
            <div class="account-tabs" style="margin:0 24px;">
                ${tabBtn('overview', 'Overview')}${tabBtn('proposals', `Open (${openProposals.length})`)}${tabBtn('approved', `Approved (${approvedProposals.length})`)}${tabBtn('history', `History (${historyProposals.length})`)}
            </div>
            <div style="padding:24px;">${governanceIndexNote(d.history, 'proposals')}${body}</div>
        </div>`;

    root.querySelectorAll('[data-treastab]').forEach(btn => {
        btn.addEventListener('click', () => { treasuryTab = btn.getAttribute('data-treastab'); renderTreasury(); });
    });
    const submitBtn = document.getElementById('treasury-submit-btn');
    if (submitBtn) submitBtn.addEventListener('click', openTreasurySubmitModal);
}

// Banner shown while the governance history crawler is still backfilling.
function governanceIndexNote(history, noun) {
    if (!history || history.backfillComplete || !history.status || history.status === 'Initializing') return '';
    return `<div class="gov-index-note"><i class='bx bx-loader-alt bx-spin'></i> Indexing past ${noun} from chain history — scanned back to block ${stakingFormatNumber(history.oldestScannedBlock)}. Older ${noun} will keep appearing as the crawl progresses.</div>`;
}

function renderTreasuryOverview(d, openCount, approvedCount, historyList) {
    const spendable = Number(d.spendableFunds) || 0;
    const spendPeriod = Number(d.spendPeriod) || 0;
    const blocksRemaining = Number(d.blocksRemaining) || 0;
    const pct = spendPeriod > 0
        ? Math.min(100, Math.max(0, Math.floor(((spendPeriod - blocksRemaining) / spendPeriod) * 100)))
        : 0;
    const remSecs = blocksRemaining * 12;
    const remDays = Math.floor(remSecs / 86400);
    const remHrs = Math.floor((remSecs % 86400) / 3600);
    const burnFraction = (Number(d.burn) || 0) / 1e6; // burn is a Permill
    const burnAmount = spendable * burnFraction;
    const awardedCount = historyList.filter(p => p.status === 'awarded').length;
    const rejectedCount = historyList.filter(p => p.status === 'rejected').length;
    const indexed = (Array.isArray(d.allProposals) ? d.allProposals.length : 0);
    return `
        <div class="staking-summary-grid">
            <div class="staking-summary-card"><div class="label">Treasury Balance</div><div class="value accent">${stakingFormatPDEX(spendable)} PDEX</div></div>
            <div class="staking-summary-card"><div class="label">Open Proposals</div><div class="value">${stakingFormatNumber(openCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Approved (awaiting payout)</div><div class="value">${stakingFormatNumber(approvedCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Paid Out</div><div class="value">${stakingFormatNumber(awardedCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Rejected</div><div class="value">${stakingFormatNumber(rejectedCount)}</div></div>
        </div>
        <div class="wallet-stat-list" style="padding:14px 0 0;">
            <div class="wallet-stat"><span>Lifetime proposals (on-chain counter)</span><strong>${stakingFormatNumber(d.proposalCount)}</strong></div>
            <div class="wallet-stat"><span>Proposals indexed locally</span><strong>${stakingFormatNumber(indexed)}</strong></div>
            <div class="wallet-stat"><span>Next burn</span><strong>${stakingFormatPDEX(burnAmount)} PDEX (${(burnFraction * 100).toFixed(2)}%)</strong></div>
            <div class="wallet-stat"><span>Spend period length</span><strong>${stakingFormatNumber(spendPeriod)} blocks</strong></div>
            <div class="wallet-stat"><span>Next spend payout in</span><strong>~${remDays}d ${remHrs}h &middot; ${stakingFormatNumber(blocksRemaining)} blocks (${pct}%)</strong></div>
        </div>`;
}

function treasuryPartyName(name, address) {
    if (name && name !== 'Unknown' && name !== address) return name;
    if (address) return stakingShortAddress(address);
    return '—';
}

function treasuryStatusBadge(status) {
    if (status === 'awarded') return '<span class="reward-badge claimed">Paid out</span>';
    if (status === 'rejected') return '<span class="reward-badge unclaimed">Rejected</span>';
    if (status === 'approved') return '<span class="reward-badge claimed">Approved</span>';
    return '<span class="reward-badge neutral">Open</span>';
}

function treasuryPartyCell(name, address) {
    if (!address) return '<span style="color:var(--text-muted);">—</span>';
    return `<a href="/account/${encodeURIComponent(address)}" class="item-link" style="color:var(--brand-secondary);">${stakingEscapeHtml(treasuryPartyName(name, address))}</a>`;
}

function renderTreasuryProposalRows(list, showStatus) {
    return list.map(p => `<tr>
        <td>#${p.id}</td>
        <td>${treasuryPartyCell(p.beneficiaryName, p.beneficiary)}</td>
        <td>${treasuryPartyCell(p.proposerName, p.proposer)}</td>
        <td style="text-align:right;">${p.bond == null ? '—' : stakingFormatPDEX(p.bond) + ' PDEX'}</td>
        <td style="text-align:right;font-weight:600;">${p.value == null ? '—' : stakingFormatPDEX(p.value) + ' PDEX'}</td>
        ${showStatus ? `<td style="text-align:right;">${treasuryStatusBadge(p.status)}</td>` : ''}
    </tr>`).join('');
}

function renderTreasuryProposals(list) {
    if (!list.length) return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No open proposals are currently awaiting council approval.</div>';
    return `<div class="table-responsive"><table class="data-table">
        <thead><tr><th>Proposal</th><th>Beneficiary</th><th>Proposer</th><th style="text-align:right;">Bond</th><th style="text-align:right;">Requested</th></tr></thead>
        <tbody>${renderTreasuryProposalRows(list, false)}</tbody></table></div>`;
}

function renderTreasuryApproved(list) {
    if (!list.length) return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No approved proposals are awaiting payout.</div>';
    return `<div class="table-responsive"><table class="data-table">
        <thead><tr><th>Proposal</th><th>Beneficiary</th><th>Proposer</th><th style="text-align:right;">Bond</th><th style="text-align:right;">Requested</th><th style="text-align:right;">Status</th></tr></thead>
        <tbody>${renderTreasuryProposalRows(list, true)}</tbody></table></div>`;
}

function renderTreasuryHistory(list) {
    if (!list.length) return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No resolved proposals indexed yet. Past proposals are crawled from chain history in the background.</div>';
    return `<div class="table-responsive"><table class="data-table">
        <thead><tr><th>Proposal</th><th>Beneficiary</th><th>Proposer</th><th style="text-align:right;">Bond</th><th style="text-align:right;">Requested</th><th style="text-align:right;">Outcome</th></tr></thead>
        <tbody>${renderTreasuryProposalRows(list, true)}</tbody></table></div>`;
}

function openTreasurySubmitModal() {
    const modal = document.getElementById('treasury-submit-modal');
    if (!modal) return;
    const stored = getStoredWallet();
    const warn = document.getElementById('treasury-modal-wallet-warning');
    const activeEl = document.getElementById('treasury-active-wallet');
    const errEl = document.getElementById('treasury-modal-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (warn) warn.style.display = stored ? 'none' : 'block';
    if (activeEl) activeEl.textContent = stored || '--';
    modal.style.display = 'flex';
}

async function submitTreasuryProposal() {
    const errEl = document.getElementById('treasury-modal-error');
    const showErr = (m) => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } };
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    const amtInput = document.getElementById('treasury-amount-input');
    const benInput = document.getElementById('treasury-beneficiary-input');
    const amt = parseFloat(amtInput ? amtInput.value : '');
    const beneficiary = (benInput ? benInput.value : '').trim();

    if (isNaN(amt) || amt <= 0) return showErr('Enter a valid PDEX amount greater than zero.');
    if (!beneficiary) return showErr('Enter a beneficiary address.');
    if (!isValidPolkadexAddress(beneficiary)) return showErr('That beneficiary address is not a valid Polkadex address.');

    const valuePlanck = BigInt(Math.floor(amt * 1e12)).toString();
    await submitSignedTx({
        buildTx: (api) => api.tx.treasury.proposeSpend(valuePlanck, beneficiary),
        label: 'Treasury proposal',
        button: document.getElementById('submit-treasury-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Submit Proposal',
        onError: showErr,
        onSuccess: () => {
            const modal = document.getElementById('treasury-submit-modal');
            if (modal) modal.style.display = 'none';
            if (amtInput) amtInput.value = '';
            if (benInput) benInput.value = '';
            setTimeout(fetchTreasuryData, 2000);
        }
    });
}

(function wireTreasuryModal() {
    const modal = document.getElementById('treasury-submit-modal');
    const closeBtn = document.getElementById('close-treasury-modal');
    const submitTxBtn = document.getElementById('submit-treasury-tx-btn');
    if (closeBtn && modal) closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    if (submitTxBtn) submitTxBtn.addEventListener('click', submitTreasuryProposal);
})();

init();
