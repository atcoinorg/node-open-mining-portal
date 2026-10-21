var algos = require('stratum-pool/lib/algoProperties.js');

module.exports = function(history, current, type, id, address, window) {
    function matches(name) {
        var dot = name.indexOf('.');
        var wallet = dot < 0 ? name : name.slice(0, dot);
        if (type === 'address') return wallet === id;
        return (!address || wallet === address) &&
            (name === id || (dot >= 0 && name.slice(dot + 1) === id));
    }
    var snapshots = history.slice();
    if (current && current.time && !snapshots.some(function(s) { return s.time === current.time; })) snapshots.push(current);
    snapshots.sort(function(a, b) { return a.time - b.time; });
    var names = new Set();
    var receipts = {};
    Object.keys((current && current.pools) || {}).forEach(function(coin) {
        var pool = current.pools[coin];
        var rows = (pool.paymentHistory || []).slice();
        Object.keys(pool.workers || {}).forEach(function(name) {
            var receipt = pool.workers[name].lastPayment;
            if (receipt) rows.push(Object.assign({worker: name}, receipt));
        });
        rows.forEach(function(row) {
            if (!row || typeof row.worker !== 'string' || !matches(row.worker) ||
                !/^[a-f0-9]{64}$/i.test(row.txid) || !Number.isFinite(row.amount) || !Number.isFinite(row.time)) return;
            names.add(row.worker);
            var key = coin + ':' + row.txid;
            var entry = receipts[key] || (receipts[key] = {pool: coin, symbol: pool.symbol,
                txid: row.txid, time: row.time, amount: 0, workers: {}});
            entry.workers[row.worker] = row.amount;
        });
    });
    var payments = Object.values(receipts).map(function(entry) {
        entry.amount = Object.values(entry.workers).reduce(function(sum, amount) { return sum + amount; }, 0);
        delete entry.workers;
        return entry;
    }).sort(function(a, b) { return b.time - a.time || a.txid.localeCompare(b.txid); });
    snapshots.forEach(function(s) {
        Object.keys(s.pools || {}).forEach(function(coin) {
            Object.keys(s.pools[coin].workers || {}).forEach(function(name) { if (matches(name)) names.add(name); });
        });
    });
    if (type === 'worker' && !address && names.size > 1) {
        var error = new Error('This worker name belongs to multiple addresses. Open its link from the Workers page.');
        error.status = 409;
        throw error;
    }
    var points = snapshots.map(function(s) {
        var point = {time: s.time, hashrate: 0, shares: 0, invalidShares: 0, immature: 0, paid: 0};
        Object.keys(s.pools || {}).forEach(function(coin) {
            var pool = s.pools[coin];
            Object.keys(pool.workers || {}).forEach(function(name) {
                if (!matches(name)) return;
                var w = pool.workers[name];
                point.shares += Number(w.shares || 0);
                point.invalidShares += Number(w.invalidshares || 0);
                point.hashrate += Number(w.shares || 0) * Math.pow(2, 32) / algos[pool.algorithm].multiplier / window;
                if (typeof w.immature !== 'number') point.immature = null;
                else if (point.immature !== null) point.immature += w.immature;
                if (typeof w.paid !== 'number') point.paid = null;
                else if (point.paid !== null) point.paid += w.paid;
            });
        });
        return point;
    });
    return {type: type, id: id, address: address || null, workers: Array.from(names), points: points, window: window, payments: payments};
};
