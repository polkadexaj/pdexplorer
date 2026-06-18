import { ApiPromise, WsProvider } from '@polkadot/api';
import fs from 'fs/promises';

async function run() {
    const wsProvider = new WsProvider('wss://rpc.polkadex.ee');
    const api = await ApiPromise.create({ provider: wsProvider });
    
    const entries = await api.query.system.account.entries();

    const balances = entries.map(([key, data]) => {
        return {
            address: key.args[0].toString(),
            free: Number(data.data.free) / 10**12,
            reserved: Number(data.data.reserved) / 10**12
        };
    }).sort((a, b) => (b.free + b.reserved) - (a.free + a.reserved));

    const topHolders = balances.slice(0, 20);
    console.log("Checking identities for top 20 holders...");
    
    let foundIdentities = 0;
    for (let i = 0; i < topHolders.length; i++) {
        const addr = topHolders[i].address;
        const identity = await api.query.identity.identityOf(addr);
        const superOf = await api.query.identity.superOf(addr);
        
        let hasId = false;
        if (identity.isSome) {
            console.log(`#${i+1} ${addr} has identityOf!`);
            hasId = true;
        }
        if (superOf.isSome) {
            console.log(`#${i+1} ${addr} has superOf!`);
            hasId = true;
        }
        if (hasId) foundIdentities++;
    }
    
    console.log(`Found ${foundIdentities} identities out of top 20.`);
    process.exit(0);
}

run();
