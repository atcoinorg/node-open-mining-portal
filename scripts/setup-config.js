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
if (env.ATCOIN_RPC_ALLOW_IP && !/^[0-9a-fA-F:.]+(?:\/[0-9]{1,3})?$/.test(env.ATCOIN_RPC_ALLOW_IP)) throw new Error('Invalid RPC allow IP');
const portal = config('PORTAL');
const pool = config('POOL');
function port(key) {
    const value = number(key);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid ' + key);
    return value;
}
const rpc = {host: required('ATCOIN_RPC_HOST'), port: port('ATCOIN_RPC_PORT'),
    user: required('ATCOIN_RPC_USER'), password: required('ATCOIN_RPC_PASSWORD')};
portal.redis = {host: env.REDIS_HOST || '127.0.0.1', port: port('REDIS_PORT')};
portal.defaultPoolConfigs.redis = portal.redis;
portal.website.port = port('WEBSITE_PORT');
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
const difficulty = number('STRATUM_DIFFICULTY');
const varDiff = JSON.parse(required('STRATUM_VARDIFF'));
if (difficulty <= 0 || difficulty > Number.MAX_SAFE_INTEGER || !varDiff || typeof varDiff !== 'object' || Array.isArray(varDiff))
    throw new Error('Invalid Stratum difficulty configuration');
if (Object.keys(varDiff).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('Invalid varDiff key');
if (Object.keys(varDiff).length && (!Number.isFinite(varDiff.minDiff) || varDiff.minDiff <= 0 ||
    !Number.isFinite(varDiff.maxDiff) || varDiff.maxDiff < varDiff.minDiff ||
    !Number.isFinite(varDiff.targetTime) || varDiff.targetTime <= 0 ||
    !Number.isFinite(varDiff.retargetTime) || varDiff.retargetTime <= 0 ||
    !Number.isFinite(varDiff.variancePercent) || varDiff.variancePercent < 0 || varDiff.variancePercent > 100))
    throw new Error('Invalid variable difficulty bounds');
if (number('POOL_FEE_PERCENT') > 100) throw new Error('Invalid pool fee percentage');
pool.ports = {[port('STRATUM_PORT')]: {diff: difficulty, varDiff}};
function write(file, data) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, data, {mode: 0o600});
    fs.chmodSync(file, 0o600);
}
if (process.argv.includes('--node')) {
    const options = {server: 1, listen: 1, daemon: 0, rpcbind: '0.0.0.0', rpcallowip: env.ATCOIN_RPC_ALLOW_IP || '172.30.64.0/24',
        rpcport: rpc.port, rpcuser: rpc.user, rpcpassword: rpc.password,
        port: port('ATCOIN_P2P_PORT'), wallet: required('ATCOIN_WALLET'),
        maxconnections: number('ATCOIN_MAX_CONNECTIONS'), dbcache: number('ATCOIN_DB_CACHE'),
        rpcthreads: number('ATCOIN_RPC_THREADS'), rpcworkqueue: number('ATCOIN_RPC_WORKQUEUE'), txindex: number('ATCOIN_TXINDEX')};
    write('.docker/generated/atcoin.conf', Object.entries(options).map(([k,v]) => `${k}=${v}`).join('\n') + '\n');
} else {
    write('config.json', JSON.stringify(portal, null, 4) + '\n');
    write('pool_configs/atcoin.json', JSON.stringify(pool, null, 4) + '\n');
    write('coins/atcoin.json', JSON.stringify(config('COIN'), null, 4) + '\n');
}
console.log('Configuration generated from environment');
