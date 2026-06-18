import { ApiPromise, WsProvider } from '@polkadot/api';

async function run() {
    const wsProvider = new WsProvider('wss://rpc.polkadex.ee');
    const api = await ApiPromise.create({ provider: wsProvider });
    
    console.log("Fetching all accounts...");
    const startTime = Date.now();
    const entries = await api.query.system.account.entries();
    console.log(`Fetched ${entries.length} accounts in ${(Date.now() - startTime)/1000} seconds.`);
    
    // Sort top 5 to see
    const balances = entries.map(([key, data]) => {
        return {
            address: key.args[0].toString(),
            free: Number(data.data.free) / 10**12,
            reserved: Number(data.data.reserved) / 10**12
        };
    }).sort((a, b) => (b.free + b.reserved) - (a.free + a.reserved));
    
    console.log("Top 5:", balances.slice(0, 5));
    process.exit(0);
}

run();
