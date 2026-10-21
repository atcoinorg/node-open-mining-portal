const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const async = require('async');
const txid = 'a'.repeat(64);

async function run(options = {}) {
    const pool = {coin: {name: 'atcoin'}, address: 'pool', redis: {host: 'redis', port: 6379},
        paymentProcessing: {enabled: true, minimumPayment: 70, paymentInterval: 20, feeRate: 1, daemon: {path: '/wallet/test'}}};
    let kickoff, tick, status, updates = [], sends = 0, recovery, journal = null;
    let complete;
    const done = new Promise(resolve => { complete = resolve; });
    function Daemon() {
        this.cmd = (method, args, callback) => {
            const reply = result => setImmediate(() => callback(result));
            if (method === 'validateaddress') return reply({response: {ismine: true}});
            if (method === 'getbalance') return reply({data: options.balanceRaw || '{"result":0.00000000,"error":null,"id":1}'});
            if (method === 'listtransactions') return reply({response: options.recover ? [{category: 'send', txid, comment: JSON.parse(journal).id}] : []});
            if (method === 'gettransaction') return reply({response: {txid, time: 1234, confirmations: 0, details: [{category: 'send', address: 'wallet', amount: -1000}]}});
            assert.equal(method, 'sendmany');
            sends++;
            assert.equal(args[1].wallet, 1000);
            assert.equal(args[8], 1, "sendmany must receive the configured sat/vB fee rate");
            assert.equal(args[4].length, 0, "fees are paid by the pool, without reducing miner rewards");
            if (options.overlap) { tick(); tick(); }
            if (options.recover) return reply({error: {type: 'timeout', message: 'RPC deadline exceeded'}});
            reply(options.sendError ? {error: typeof options.sendError === 'object' ? options.sendError : {code: -4, message: 'Wallet is locked'}} : {response: txid});
        };
        this.batchCmd = (calls, callback) => setImmediate(() => callback(null, [{result: {
            details: [{address: 'pool', category: options.immature ? 'immature' : 'generate', amount: options.reward || 1000}]
        }}]));
    }
    const redis = {createClient() { return {
        hmset(key, fields, callback) { status = fields; callback(null); if (options.recover && fields.status === 'error') setImmediate(tick); else complete(); },
        set(key, value, mode, callback) { assert.equal(mode, 'NX'); const stored = !journal; if (stored) journal = value; setImmediate(() => callback(null, stored ? 'OK' : null)); },
        get(key, callback) { setImmediate(() => callback(null, journal)); },
        del(key, callback) { journal = null; setImmediate(() => callback(null, 1)); },
        multi(commands) { return {exec(callback) {
            setImmediate(() => {
                if (commands[0]?.[1] === 'atcoin:balances') return callback(null, [{}, ['block:coinbase:1']]);
                if (commands[0]?.[0] === 'hgetall') return callback(null, [options.missingShares ? null : {'wallet.a': 1, 'wallet.b': 3}]);
                updates = commands;
                if (!options.redisError && commands.some(c => c[0] === 'del' && c[1] === 'atcoin:paymentInFlight')) journal = null;
                callback(options.redisError ? new Error('Redis disconnected') : null, commands.map(() => 1));
            });
        }}; }
    }; }};
    const sandbox = {module: {exports: {}}, process: {env: {pools: JSON.stringify({atcoin: pool})}},
        setInterval(f) { tick = f; return 1; }, clearInterval() {}, setTimeout(f) { kickoff = f; },
        require(name) {
            if (name === 'redis') return redis;
            if (name === 'async') return async;
            if (name === 'crypto') return require('node:crypto');
            if (name === 'fs') return {writeFile(file, body, callback) { recovery = JSON.parse(body); }};
            if (name === 'stratum-pool') return {daemon: {interface: Daemon}};
            if (name === 'stratum-pool/lib/util.js') return {};
            throw new Error(name);
        }};
    vm.runInNewContext(fs.readFileSync(require.resolve('../libs/paymentProcessor.js'), 'utf8'), sandbox);
    sandbox.module.exports({debug() {}, warning() {}, error() {}});
    await new Promise(setImmediate);
    assert.equal(typeof kickoff, 'function');
    kickoff();
    await done;
    if (options.redisError) { tick(); await new Promise(setImmediate); }
    return {status, updates, sends, recovery, journal};
}

(async () => {
    let result = await run({immature: true});
    assert.equal(result.sends, 0);
    assert.equal(result.status.immature, 1);
    assert.equal(result.status.status, 'waiting');
    result = await run({overlap: true});
    assert.equal(result.sends, 1, 'concurrent timer ticks cannot send the same reward twice');
    assert.equal(result.status.status, 'paid');
    assert.equal(result.status.lastTxid, txid);
    assert.equal(result.status.lastAmount, 1000);
    const receipts = result.updates.filter(c => c[1] === 'atcoin:paymentReceipts').map(c => JSON.parse(c[3]));
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].amount, 250);
    assert.equal(receipts[1].amount, 750);
    const ledger = result.updates.filter(c => c[1] === 'atcoin:paymentHistory').map(c => JSON.parse(c[3]));
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].worker, 'wallet.a');
    assert.equal(ledger[0].txid, txid);
    assert.equal(ledger[0].amount + ledger[1].amount, 1000);
    assert.equal(receipts[0].txid, txid);
    result = await run({sendError: true});
    assert.equal(result.status.status, 'error');
    assert.equal(result.status.message, 'Wallet is locked');
    assert.equal(result.updates.length, 0, 'a rejected payment must not increase Paid');
    result = await run({sendError: {code: -6, message: 'Fee estimation failed. Fallbackfee is disabled.'}});
    assert.equal(result.sends, 1, 'fee errors must not retry with discounted rewards');
    assert.equal(result.updates.length, 0, 'fee errors must preserve pending rounds and reward shares');
    assert.equal(result.status.status, 'error');
    result = await run({balanceRaw: '{"result":0,"error":null,"id":1}'});
    assert.equal(result.status.lastAmount, 1000, 'coin precision must not depend on wallet balance formatting');
    result = await run({recover: true});
    assert.equal(result.sends, 1, 'a timed-out successful send is recovered without a duplicate transfer');
    assert.equal(result.status.status, 'paid');
    assert.equal(result.status.lastTxid, txid);
    assert.equal(result.status.lastPaidAt, 1234);
    assert.equal(result.journal, null, 'journal clears atomically with accounting');
    result = await run({sendError: {type: 'timeout', message: 'RPC deadline exceeded'}});
    assert.ok(result.journal, 'an ambiguous response must retain the durable journal');
    assert.equal(result.updates.length, 0);
    result = await run({reward: 40});
    assert.equal(result.sends, 0);
    assert.ok(result.updates.some(c => c[1] === 'atcoin:balances' && c[3] === 30));
    result = await run({missingShares: true});
    assert.equal(result.sends, 0);
    assert.equal(result.updates.length, 0, 'missing shares must not discard a mature round');
    assert.equal(result.status.status, 'error');
    result = await run({redisError: true});
    assert.equal(result.sends, 1, 'failed accounting must disable further payments');
    assert.equal(result.status.status, 'error');
    assert.ok(result.recovery.length);
    console.log('Payments: maturity, weighted rewards, transaction receipts, overlap guard, rejected payments, minimum balance and Redis recovery OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
