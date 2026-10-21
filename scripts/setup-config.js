const fs = require('node:fs');
const path = require('node:path');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
function required(key) {
    if (!env[key] || /[\r\n]/.test(env[key])) throw new Error('Invalid or missing ' + key);
    return env[key];
}
function number(key) {
    const value = Number(required(key));
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid ' + key);
    return value;
}
function config(prefix) {
    const result = {};
    for (const [key, value] of Object.entries(env)) {
        if (!key.startsWith(prefix + '__')) continue;
        const keys = key.slice(prefix.length + 2).split('__');
        if (keys.some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error('Invalid key');
        let target = result;
        for (const k of keys.slice(0, -1)) target = target[k] ||= {};
        target[keys.at(-1)] = JSON.parse(value);
    }
    return result;
}
const portal = config('PORTAL');
const pool = config('POOL');
const rpc = {host: required('ATCOIN_RPC_HOST'), port: number('ATCOIN_RPC_PORT'),
    user: required('ATCOIN_RPC_USER'), password: required('ATCOIN_RPC_PASSWORD')};
portal.redis = {host: env.REDIS_HOST || '127.0.0.1', port: number('REDIS_PORT')};
portal.defaultPoolConfigs.redis = portal.redis;
portal.website.port = number('WEBSITE_PORT');
pool.address = required('ATCOIN_POOL_ADDRESS');
pool.rewardRecipients = {[pool.address]: number('POOL_FEE_PERCENT')};
pool.daemons = [rpc];
pool.paymentProcessing.rpcTimeout ??= 120000;
if (!Number.isFinite(pool.paymentProcessing.rpcTimeout) || pool.paymentProcessing.rpcTimeout <= 0)
    throw new Error('Invalid payment RPC timeout');
pool.paymentProcessing.daemon = {...rpc, timeout: pool.paymentProcessing.rpcTimeout,
    path: '/wallet/' + encodeURIComponent(required('ATCOIN_WALLET'))};
// ATCOIN sendmany accepts fee_rate in atomic units per virtual byte.
pool.paymentProcessing.feeRate ??= 1;
if (!Number.isFinite(pool.paymentProcessing.feeRate) || pool.paymentProcessing.feeRate <= 0)
    throw new Error('Invalid payment feeRate');
pool.ports = {[number('STRATUM_PORT')]: {diff: number('STRATUM_DIFFICULTY'), varDiff: JSON.parse(required('STRATUM_VARDIFF'))}};
function write(file, data) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, data, {mode: 0o600});
}
if (process.argv.includes('--node')) {
    const options = {server: 1, listen: 1, daemon: 0, rpcbind: '0.0.0.0', rpcallowip: '0.0.0.0/0',
        rpcport: rpc.port, rpcuser: rpc.user, rpcpassword: rpc.password,
        port: number('ATCOIN_P2P_PORT'), wallet: required('ATCOIN_WALLET'),
        maxconnections: number('ATCOIN_MAX_CONNECTIONS'), dbcache: number('ATCOIN_DB_CACHE'),
        rpcthreads: number('ATCOIN_RPC_THREADS'), rpcworkqueue: number('ATCOIN_RPC_WORKQUEUE'), txindex: number('ATCOIN_TXINDEX')};
    write('.docker/generated/atcoin.conf', Object.entries(options).map(([k,v]) => `${k}=${v}`).join('\n') + '\n');
} else {
    write('config.json', JSON.stringify(portal, null, 4) + '\n');
    write('pool_configs/atcoin.json', JSON.stringify(pool, null, 4) + '\n');
    write('coins/atcoin.json', JSON.stringify(config('COIN'), null, 4) + '\n');
}
console.log('Configuration generated from environment');
