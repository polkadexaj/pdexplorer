import { ApiPromise, WsProvider } from '@polkadot/api';

async function run() {
    const wsProvider = new WsProvider('wss://rpc.polkadex.ee');
    const api = await ApiPromise.create({ provider: wsProvider });
    
    const validators = await api.query.session.validators();
    console.log(`Found ${validators.length} validators. Checking first 10...`);
    
    for (let i = 0; i < 10; i++) {
        const addr = validators[i].toString();
        const superOf = await api.query.identity.superOf(addr);
        if (superOf.isSome) {
            const [parentAddress, data] = superOf.unwrap();
            const parentIdentity = await api.query.identity.identityOf(parentAddress);
            console.log("SUPEROF", addr, "Parent:", parentAddress.toString());
            console.log("PARENT IDENTITY:", JSON.stringify(parentIdentity.toHuman(), null, 2));
            console.log("SUB DATA:", JSON.stringify(data.toHuman(), null, 2));
        } else {
            const identity = await api.query.identity.identityOf(addr);
            console.log("IDENTITYOF", addr);
            console.log(JSON.stringify(identity.toHuman(), null, 2));
        }
    }
    process.exit(0);
}

run();
