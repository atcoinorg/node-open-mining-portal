'use strict';
module.exports = function(now = Date.now) {
    const clients = new Map();
    let sweptAt = -Infinity;
    return function(req, res, next) {
        const time = now();
        if (time - sweptAt >= 60000) {
            for (const [ip, entry] of clients) if (entry.until <= time) clients.delete(ip);
            sweptAt = time;
        }
        const ip = req.socket.remoteAddress;
        let entry = clients.get(ip);
        if (entry && entry.until <= time) { clients.delete(ip); entry = null; }
        if (!entry) {
            if (clients.size >= 10000) return res.status(503).json({error: 'Busy'});
            entry = {count: 0, until: time + 60000}; clients.set(ip, entry);
        }
        if (++entry.count > 120) {
            res.setHeader('Retry-After', '60');
            return res.status(429).json({error: 'Rate limit exceeded'});
        }
        next();
    };
};
