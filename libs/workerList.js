module.exports = function(stats, query) {
    var search = String(query.search || '').trim().toLowerCase();
    var sort = ['worker', 'address', 'shares', 'immature', 'paid'].includes(query.sort) ? query.sort : 'shares';
    var direction = query.direction === 'asc' ? 'asc' : 'desc';
    var limit = [25, 50, 100].includes(Number(query.limit)) ? Number(query.limit) : 25;
    var page = Math.max(1, Math.floor(Number(query.page)) || 1);
    var rows = [];
    Object.keys(stats.pools || {}).forEach(function(coin) {
        var pool = stats.pools[coin];
        Object.keys(pool.workers || {}).forEach(function(name) {
            if (search && !name.toLowerCase().includes(search)) return;
            var dot = name.indexOf('.');
            var w = pool.workers[name];
            rows.push({name: name, worker: dot < 0 ? '' : name.slice(dot + 1),
                address: dot < 0 ? name : name.slice(0, dot), pool: coin, symbol: pool.symbol,
                shares: Number(w.shares || 0), invalidShares: Number(w.invalidshares || 0),
                hashrate: w.hashrateString, immature: typeof w.immature === 'number' ? w.immature : null,
                paid: Number(w.paid || 0)});
        });
    });
    rows.sort(function(a, b) {
        if (a[sort] === null && b[sort] !== null) return 1;
        if (b[sort] === null && a[sort] !== null) return -1;
        var cmp = typeof a[sort] === 'string' ? a[sort].localeCompare(b[sort], undefined, {numeric: true, sensitivity: 'base'}) : a[sort] - b[sort];
        return (direction === 'asc' ? cmp : -cmp) || a.name.localeCompare(b.name) || a.pool.localeCompare(b.pool);
    });
    var total = rows.length;
    var pages = Math.max(1, Math.ceil(total / limit));
    page = Math.min(page, pages);
    return {rows: rows.slice((page - 1) * limit, page * limit), total: total, page: page,
        pages: pages, limit: limit, sort: sort, direction: direction, search: String(query.search || '').trim()};
};
