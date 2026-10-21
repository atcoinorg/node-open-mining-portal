const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const statsRequire = createRequire(require.resolve('../libs/stats.js'));

function collect(shares) {
    const old = {time: 1, global: {workers: 2}, algos: {scrypt: {workers: 2}}, pools: {
        atcoin: {algorithm: 'scrypt', workerCount: 2, hashrate: 0, blocks: {pending: 33},
            workers: {rewardOnly: {shares: 0, invalidshares: 0, immature: 12}, paidOnly: {shares: 0, paid: 5}}}
    }};
    let connections = 0;
    const fakeRedis = {createClient() {
        const history = connections++ === 0;
        return {on() {}, zrangebyscore(args, callback) { callback(null, [JSON.stringify(old)]); },
            multi() { return {exec(callback) { callback(null, history ? [] : [0, shares, {}, 33, 0, 0, {paidOnly: '5'}, {balanceOnly: '20'}, {paidOnly: JSON.stringify({txid: 'a'.repeat(64), time: 1000, amount: 5})}, {status: 'paid', lastTxid: 'a'.repeat(64)}]); }}; }};
    }};
    const sandbox = {module: {exports: {}}, require(name) {
        if (name === 'redis') return fakeRedis;
        if (name === './immature.js') return (client, coin, config, callback) => callback(null, {rewardOnly: 12});
        return statsRequire(name);
    }};
    vm.runInNewContext(fs.readFileSync(require.resolve('../libs/stats.js'), 'utf8'), sandbox);
    const stats = new sandbox.module.exports({error() { throw new Error('Unexpected stats error'); }},
        {redis: {host: 'redis', port: 6379}, website: {stats: {historicalRetention: 43200, hashrateWindow: 300}}},
        {atcoin: {redis: {host: 'redis', port: 6379}, coin: {symbol: 'ATL', algorithm: 'scrypt'}}});
    assert.equal(stats.statPoolHistory[0].pools.atcoin.workerCount, 0, 'historical reward-only workers must be inactive');
    assert.equal(stats.statHistory[0].global.workers, 0);
    assert.equal(stats.statHistory[0].algos.scrypt.workers, 0);
    return new Promise(resolve => stats.getGlobalStats(() => resolve(stats.stats)));
}

(async () => {
    const minerStats = require('../libs/minerStats.js');
    const txid = 'b'.repeat(64);
    const record = (worker, amount) => ({worker, amount, txid, time: 1234});
    const current = {time: 1235, pools: {atcoin: {algorithm: 'scrypt', symbol: 'ATL',
        workers: {'wallet.one': {lastPayment: record('wallet.one', 10)}, 'wallet.two': {}},
        paymentHistory: [record('wallet.one', 10), record('wallet.two', 20), record('other.one', 50)]}}};
    const addressPayments = minerStats([], current, 'address', 'wallet', null, 300).payments;
    assert.equal(addressPayments.length, 1, 'group one transaction across address workers');
    assert.equal(addressPayments[0].amount, 30, 'deduplicate latest receipt and exclude other addresses');
    const workerPayments = minerStats([], current, 'worker', 'one', 'wallet', 300).payments;
    assert.equal(workerPayments.length, 1);
    assert.equal(workerPayments[0].amount, 10, 'worker sees only its own part of the transfer');
    assert.throws(() => minerStats([], current, 'worker', 'one', null, 300), /multiple addresses/);
    const idle = await collect([]);
    assert.equal(idle.pools.atcoin.workerCount, 0);
    assert.equal(idle.global.workers, 0);
    assert.equal(idle.algos.scrypt.workers, 0);
    assert.equal(idle.pools.atcoin.hashrate, 0);
    assert.equal(idle.pools.atcoin.blocks.pending, 33, 'pending balance survives downtime');
    assert.equal(idle.pools.atcoin.workers.rewardOnly.immature, 12, 'keep reward history visible');
    assert.equal(idle.pools.atcoin.workers.paidOnly.paid, 5);
    assert.equal(idle.pools.atcoin.workers.balanceOnly.balance, 20);
    assert.equal(idle.pools.atcoin.workers.paidOnly.lastPayment.txid, 'a'.repeat(64));
    const list = require('../libs/workerList.js')(idle, {});
    assert.equal(list.payments[0].status.status, 'paid');
    assert.equal(list.rows.find(w => w.name === 'paidOnly').lastPayment.amount, 5);
    assert.equal(list.rows.find(w => w.name === 'balanceOnly').balance, 20);
    const active = await collect(['8:miner:1', '-2:invalidMiner:2']);
    assert.equal(active.pools.atcoin.workerCount, 2);
    assert.equal(active.algos.scrypt.workers, 2);
    assert.ok(active.pools.atcoin.hashrate > 0);

    const sandbox = {document: {getElementById() { return {dataset: {interval: '60', retention: '43200'}}; }},
        nv: {utils: {windowResize() {}}}, $: {getJSON() {}}, statsSource: {addEventListener() {}}};
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(require.resolve('../website/static/stats.js'), 'utf8'), sandbox);
    const snapshot = (time, workers, hashrate, pending) => ({time, pools: {atcoin: {workerCount: workers, hashrate, blocks: {pending}}}});
    sandbox.mergeStats([snapshot(1000, 2, 100, 33), snapshot(1060, 0, 0, 33), snapshot(4120, 0, 0, 33)]);
    assert.equal(sandbox.poolWorkerData[0].values[1][1], 0);
    assert.equal(sandbox.poolBlockData[0].values[1][1], 33);
    for (const key of ['poolWorkerData', 'poolHashrateData', 'poolBlockData']) {
        assert.equal(sandbox[key][0].values[2][1], null, 'unknown downtime must break each chart');
        assert.equal(sandbox[key][0].values[2][0], 1120000);
    }
    sandbox.mergeStats([snapshot(4120, 0, 0, 33)]);
    assert.equal(sandbox.statData.length, 3, 'deduplicate history and live events');
    sandbox.mergeStats([snapshot(50000, 1, 100, 40)]);
    assert.equal(sandbox.statData.length, 1, 'expire by retention rather than point count');
    assert.equal(sandbox.getReadableHashRateString(1000), '1.00 KH');
    console.log('Stats: active counts, historical correction, pending balances, chart gaps, deduplication and retention OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
