'use strict';
// The exchange adapters use only GET query strings and URL-encoded POST forms.
const http = require('node:http');
const https = require('node:https');
module.exports = function(options, callback) {
    let request, timer, completed = false;
    function finish(error, response, body) {
        if (completed) return;
        completed = true; clearTimeout(timer);
        if (error && request) request.destroy();
        callback(error, response, body);
    }
    try {
        const url = new URL(options.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw new Error('Invalid exchange URL');
        for (const [key, value] of Object.entries(options.qs || {})) url.searchParams.set(key, String(value));
        const body = options.form ? new URLSearchParams(options.form).toString() : '';
        const headers = {...options.headers};
        if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body); }
        request = (url.protocol === 'https:' ? https : http).request(url, {
            method: options.method || 'GET', headers, rejectUnauthorized: options.strictSSL !== false
        }, response => {
            const chunks = []; let size = 0;
            response.on('error', () => finish(new Error('Exchange response failed')));
            response.on('aborted', () => finish(new Error('Exchange response aborted')));
            response.on('data', chunk => {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) { finish(new Error('Exchange response too large')); response.destroy(); }
                else chunks.push(chunk);
            });
            response.on('end', () => {
                // Never follow redirects carrying exchange API credentials.
                if (response.statusCode < 200 || response.statusCode >= 300) return finish(new Error('Exchange HTTP status ' + response.statusCode));
                let result = Buffer.concat(chunks).toString('utf8');
                if (options.json) {
                    try { result = JSON.parse(result); } catch (_) { return finish(new Error('Invalid exchange JSON')); }
                }
                finish(null, response, result);
            });
        });
        timer = setTimeout(() => finish(new Error('Exchange deadline exceeded')), 10000);
        request.on('error', () => finish(new Error('Exchange request failed')));
        request.end(body);
        return request;
    } catch (_) { queueMicrotask(() => finish(new Error('Invalid exchange request'))); }
};
