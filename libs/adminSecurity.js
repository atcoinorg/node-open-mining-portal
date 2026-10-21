'use strict';
const crypto = require('node:crypto');
module.exports = function(config, now = Date.now) {
    const sessions = new Map(), attempts = new Map();
    let sweptAt = -Infinity;
    const lifetime = 30 * 60 * 1000;
    const digest = value => crypto.createHash('sha256').update(value).digest();
    return function(req, res, next) {
        res.setHeader('Cache-Control', 'no-store');
        if (!config || !config.enabled) return res.status(404).json({error: 'Unavailable'});
        if (typeof config.password !== 'string' || config.password.length < 16)
            return res.status(503).json({error: 'Configure an administrator password of at least 16 characters'});
        // Require a same-origin custom header on every POST, including login (no permissive CORS).
        if (req.get('X-Admin-Request') !== '1' ||
            (req.get('Origin') && req.get('Origin') !== (config.origin || req.protocol + '://' + req.get('Host'))))
            return res.status(403).json({error: 'Invalid request origin'});
        const time = now();
        if (time - sweptAt >= 60000) {
            for (const [key, value] of sessions) if (value <= time) sessions.delete(key);
            for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
            sweptAt = time;
        }
        if (req.params.method === 'login') {
            const ip = req.socket.remoteAddress;
            const attempt = attempts.get(ip) || {count: 0, until: time + 60000};
            if (attempt.count >= 5 || attempts.size >= 10000)
                return res.status(429).json({error: 'Try again later'});
            attempt.count++; attempts.set(ip, attempt);
            const password = req.body && req.body.password;
            if (typeof password !== 'string' || password.length > 1024 ||
                !crypto.timingSafeEqual(digest(password), digest(config.password)))
                return res.status(401).json({error: 'Authentication required'});
            if (sessions.size >= 1000) return res.status(503).json({error: 'Session limit'});
            const token = crypto.randomBytes(32).toString('hex');
            sessions.set(digest(token).toString('hex'), time + lifetime);
            res.setHeader('Set-Cookie', 'adminSession=' + token + '; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=1800' +
                (req.secure || config.secureCookies !== false ? '; Secure' : ''));
            return res.json({result: true});
        }
        const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)adminSession=([a-f0-9]{64})(?:;|$)/);
        if (!cookie || !(sessions.get(digest(cookie[1]).toString('hex')) > time))
            return res.status(401).json({error: 'Authentication required'});
        next();
    };
};
