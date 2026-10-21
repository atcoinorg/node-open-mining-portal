'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const express = require('express');
const admin = require('../libs/adminSecurity');
const limits = require('../libs/httpLimits');
function request(method, body, cookie, headers = {}) {
    return {params: {method}, body, socket: {remoteAddress: 'local'}, headers: {cookie}, protocol: 'https', secure: true,
        get(name) { return ({'X-Admin-Request': '1', Host: 'pool.test', Origin: 'https://pool.test', ...headers})[name]; }};
}
function response() {
    return {code: 200, headers: {}, status(code) {this.code = code; return this;}, json(value) {this.body = value; return this;},
        setHeader(key, value) {this.headers[key] = value;}};
}
test('admin: missing/wrong credentials, CSRF, valid login, tampering and expiry', () => {
    let time = 1000;
    const middleware = admin({enabled: true, password: 'a-long-test-password'}, () => time);
    for (const password of [undefined, null, {}, 'wrong']) {
        const res = response(); middleware(request('login', {password}), res, () => assert.fail());
        assert.equal(res.code, 401);
    }
    let res = response(); middleware(request('login', {password: 'a-long-test-password'}, '', {Origin: 'https://evil.test'}), res, () => assert.fail());
    assert.equal(res.code, 403);
    res = response(); middleware(request('login', {password: 'a-long-test-password'}), res, () => assert.fail());
    const cookie = res.headers['Set-Cookie'];
    assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /; Secure$/);
    assert.ok(!cookie.includes('a-long-test-password'));
    let accepted = 0; middleware(request('pools', {}, cookie.split(';')[0]), response(), () => accepted++);
    assert.equal(accepted, 1);
    for (const token of ['', 'adminSession=' + '0'.repeat(64)]) {
        res = response(); middleware(request('pools', {password: 'a-long-test-password'}, token), res, () => assert.fail());
        assert.equal(res.code, 401);
    }
    time += 1800001;
    res = response(); middleware(request('pools', {}, cookie.split(';')[0]), res, () => assert.fail()); assert.equal(res.code, 401);
});
test('admin brute force and weak configuration fail closed', () => {
    const middleware = admin({enabled: true, password: 'a-long-test-password'});
    for (let i = 0; i < 6; i++) {
        const res = response(); middleware(request('login', {password: 'bad'}), res, () => assert.fail());
        assert.equal(res.code, i < 5 ? 401 : 429);
    }
    const res = response(); admin({enabled: true})(request('pools', {}), res, () => assert.fail()); assert.equal(res.code, 503);
});
test('API flood limiter recovers after window', () => {
    let time = 0, count = 0; const middleware = limits(() => time);
    for (let i = 0; i < 121; i++) {
        const res = response(); middleware(request('stats'), res, () => count++);
        if (i === 120) assert.equal(res.code, 429);
    }
    assert.equal(count, 120); time = 60001;
    middleware(request('stats'), response(), () => count++); assert.equal(count, 121);
});
test('CLI malformed, oversized, fragmented, unknown, multiple and normal commands', async t => {
    const Listener = require('../libs/cliListener');
    const listener = new Listener(0); let commands = 0;
    listener.on('command', (command, params, options, reply) => {commands++; reply('OK');});
    const server = listener.start(); t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once('listening', resolve));
    async function send(parts) {
        return new Promise((resolve, reject) => {
            const socket = net.connect(server.address().port, '127.0.0.1'); let data = '';
            socket.on('error', error => error.code === 'ECONNRESET' ? resolve(data) : reject(error));
            socket.on('data', chunk => data += chunk); socket.on('close', () => resolve(data));
            socket.on('connect', () => { for (const part of parts) socket.write(part); });
        });
    }
    assert.match(await send(['{bad}\n']), /Invalid/);
    await send(['x'.repeat(8193)]);
    assert.match(await send(['{"command":"evil","params":[]}\n']), /Invalid/);
    assert.match(await send(['{}\n{}\n']), /Invalid/);
    assert.match(await send(['{"command":"blocknotify","params":[]}\n']), /Invalid/);
    assert.match(await send(['{"command":"blocknotify","params":["coin","hash"]}\n']), /Invalid/);
    assert.equal(await send(['{"command":"block', 'notify","params":["coin","' + 'a'.repeat(64) + '"]}\n']), 'OK');
    assert.equal(commands, 1);
});
test('MPOS difficulty update is bound and rejects invalid values', () => {
    const fs = require('node:fs'), vm = require('node:vm'); let query;
    const connection = {on() {}, query(...args) {query = args;}};
    const sandbox = {module: {exports: {}}, require(name) {if (name === 'mysql') return {createPool() {return connection;}}; return require(name);}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../libs/mposCompatibility'), 'utf8'), sandbox);
    const instance = new sandbox.module.exports({error() {}, debug() {}}, {coin: {name: 'test'}, mposMode: {}});
    for (const diff of [-1, NaN, Infinity, '1; DROP TABLE shares']) instance.handleDifficultyUpdate('worker', diff);
    assert.equal(query, undefined);
    instance.handleDifficultyUpdate("worker' OR 1=1", 2);
    assert.match(query[0], /difficulty` = \?/); assert.equal(query[1][0], 2); assert.equal(query[1][1], "worker' OR 1=1");
});
test('exchange adapter preserves query/form/json and refuses redirects, invalid JSON and oversized responses', async t => {
    const http = require('node:http'), exchange = require('../libs/exchangeRequest');
    let seen;
    const server = http.createServer((req, res) => {
        let data = ''; req.on('data', chunk => data += chunk);
        req.on('end', () => {
            seen = {url: req.url, body: data, header: req.headers['x-test']};
            if (req.url === '/redirect') {res.writeHead(302, {Location: 'http://127.0.0.1:1/'}); return res.end();}
            if (req.url === '/bad') return res.end('{broken');
            if (req.url === '/large') return res.end('x'.repeat(2 * 1024 * 1024 + 1));
            res.end('{"ok":true}');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const call = options => new Promise(resolve => exchange({url: 'http://127.0.0.1:' + server.address().port + '/', json: true, ...options}, (error, response, body) => resolve({error, body})));
    assert.deepEqual((await call({qs: {symbol: 'A+B'}})).body, {ok: true});
    assert.equal(seen.url, '/?symbol=A%2BB');
    assert.equal((await call({method: 'POST', form: {key: 'a&b'}, headers: {'X-Test': 'value'}})).error, null);
    assert.equal(seen.body, 'key=a%26b'); assert.equal(seen.header, 'value');
    for (const path of ['/redirect', '/bad', '/large']) assert.ok((await call({url: 'http://127.0.0.1:' + server.address().port + path})).error);
});
test('target arithmetic accepts normal/compact values and rejects malicious and impossible targets', () => {
    const target = require('../libs/targetNumber');
    const normal = '00000000ffff0000000000000000000000000000000000000000000000000000';
    assert.equal(target({bits: '1d00ffff'}), target({target: normal}));
    assert.equal(target({bits: '02008000'}), 128);
    for (const input of [{target: {}}, {target: 'f'.repeat(65)}, {target: '0'}, {target: '-1'}, {bits: 'ff00ffff'}, {bits: '1d80ffff'}]) assert.throws(() => target(input));
});
test('API returns public pool metadata only, rejects object/oversized input, bounds SSE and cleans disconnects', () => {
    const fs = require('node:fs'), vm = require('node:vm'), {EventEmitter} = require('node:events');
    const sandbox = {module: {exports: {}}, require(name) {
        if (name === './stats.js') return function() {this.stats = {pools: {}}; this.statsString = '{}'; this.statPoolHistory = [];};
        if (name === './minerStats.js') return () => ({});
        if (name.startsWith('./')) return require('../libs/' + name.slice(2));
        return require(name);
    }};
    vm.runInNewContext(fs.readFileSync(require.resolve('../libs/api'), 'utf8'), sandbox);
    const api = new sandbox.module.exports({}, {}, {coin: {coin: {name: 'coin'}, paymentProcessing: {daemon: {password: 'secret-rpc'}}, redis: {password: 'secret-redis'}}});
    let body;
    api.handleAdminApiRequest({params: {method: 'pools'}}, {end(value) {body = value;}}, () => assert.fail());
    assert.deepEqual(JSON.parse(body), {result: {coin: {coin: {name: 'coin'}}}});
    for (const query of [{id: {}}, {search: 'x'.repeat(257)}, {id: ['worker']}]) {
        const res = response(); api.handleApiRequest({params: {method: 'workers'}, query}, res, () => assert.fail()); assert.equal(res.code, 400);
    }
    const res = new EventEmitter(); res.writeHead = () => {}; res.write = () => {};
    api.handleApiRequest({params: {method: 'live_stats'}, query: {}}, res, () => assert.fail());
    assert.equal(Object.keys(api.liveStatConnections).length, 1); res.emit('close'); assert.equal(Object.keys(api.liveStatConnections).length, 0);
    for (let i = 0; i < 256; i++) api.liveStatConnections[i] = {};
    const full = response(); full.end = () => {}; api.handleApiRequest({params: {method: 'live_stats'}, query: {}}, full, () => assert.fail()); assert.equal(full.code, 503);
});
test('miner chart template escapes hostile identifiers and administrator client does not interpolate pool HTML', () => {
    const fs = require('node:fs'), dot = require('dot');
    const template = dot.template(fs.readFileSync(require.resolve('../website/pages/miner_charts.html'), 'utf8'));
    const html = template({type: 'worker', id: '"><img src=x onerror=alert(1)>', address: '', retention: 3600, window: 60});
    assert.ok(!html.includes('<img')); assert.match(html, /&#60;img/);
    const adminSource = fs.readFileSync(require.resolve('../website/static/admin.js'), 'utf8');
    assert.ok(!adminSource.includes('data.password = password')); assert.match(adminSource, /\.text\(name\)/);
});
test('setup configuration rejects missing parameters, invalid ports, prototype keys and line injection without writing files', () => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../scripts/setup-config'), 'utf8');
    const base = {
        PORTAL__website: '{"stats":{}}', PORTAL__defaultPoolConfigs: '{}', POOL__paymentProcessing: '{}',
        ATCOIN_RPC_HOST: 'node', ATCOIN_RPC_PORT: '19332', ATCOIN_RPC_USER: 'test', ATCOIN_RPC_PASSWORD: 'synthetic',
        REDIS_PORT: '6379', WEBSITE_PORT: '8080', ATCOIN_POOL_ADDRESS: 'wallet', POOL_FEE_PERCENT: '1', ATCOIN_WALLET: 'test',
        STRATUM_PORT: '3333', STRATUM_DIFFICULTY: '1', STRATUM_VARDIFF: '{}'
    };
    function run(env) {
        const files = [];
        vm.runInNewContext(source, {process: {env, argv: []}, console: {log() {}}, require(name) {
            if (name === 'node:fs') return {existsSync() {return false;}, mkdirSync() {}, chmodSync() {}, writeFileSync(file, data) {files.push([file, data]);}};
            return require(name);
        }});
        return files;
    }
    assert.equal(run(base).length, 3);
    for (const change of [{ATCOIN_RPC_PASSWORD: ''}, {ATCOIN_RPC_HOST: 'node\nrpcallowip=0.0.0.0/0'}, {STRATUM_PORT: '0'}, {WEBSITE_PORT: '65536'}, {REDIS_PORT: '1.5'}, {PORTAL__constructor__polluted: 'true'}])
        assert.throws(() => run({...base, ...change}));
    assert.equal({}.polluted, undefined);
});
test('actual website admin routes require sessions and reject malformed/oversized JSON', async t => {
    const fs = require('node:fs'), vm = require('node:vm'), http = require('node:http');
    let server;
    const config = {redis: {}, website: {host: '127.0.0.1', port: 0, stats: {updateInterval: 60}, adminCenter: {enabled: true, password: 'a-long-test-password', secureCookies: false}}};
    function FakeApi() {
        this.stats = {stats: {pools: {}}, getGlobalStats(callback) {callback();}};
        this.liveStatConnections = {};
        this.handleAdminApiRequest = (req, res) => res.json({result: {coin: {coin: {name: 'coin'}}}});
    }
    const sandbox = {module: {exports: {}}, console, process: {env: {portalConfig: JSON.stringify(config), pools: '{}'}}, setInterval() {}, require(name) {
        if (name === 'express') return Object.assign(() => {const app = express(); app.listen = (port, host, cb) => {server = http.createServer(app).listen(0, '127.0.0.1', cb); return server;}; return app;}, {static: express.static});
        if (name === 'node-watch') return () => {};
        if (name === 'redis') return {createClient() {return {hgetall(key, cb) {cb(null, {});}, quit() {}};}};
        if (name === 'stratum-pool' || name === 'stratum-pool/lib/util.js') return {};
        if (name === './api.js') return FakeApi;
        if (name.startsWith('./')) return require('../libs/' + name.slice(2));
        return require(name);
    }};
    vm.runInNewContext(fs.readFileSync(require.resolve('../libs/website'), 'utf8'), sandbox);
    sandbox.module.exports({debug() {}, warning() {}, error() {}});
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    const call = (method, body, cookie) => fetch(base + '/api/admin/' + method, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Admin-Request': '1', ...(cookie ? {Cookie: cookie} : {})}, body});
    let res = await call('pools', '{}'); assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    res = await call('pools', '{"password":"a-long-test-password"}'); assert.equal(res.status, 401);
    res = await call('login', '{"password":"a-long-test-password"}'); assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    res = await call('pools', '{}', cookie); assert.equal(res.status, 200); assert.ok((await res.json()).result.coin);
    res = await call('login', '{broken'); assert.equal(res.status, 400);
    res = await call('login', JSON.stringify({password: 'x'.repeat(9000)})); assert.equal(res.status, 413);
    res = await fetch(base + '/get_page?id=__proto__'); assert.equal(res.status, 404);
});
test('immature RPC bounds response size, handles aborted/invalid replies once and preserves normal rewards', async t => {
    const http = require('node:http'), immature = require('../libs/immature'); let mode = 'normal';
    const server = http.createServer((req, res) => {
        req.resume(); req.on('end', () => {
            if (mode === 'large') return res.end('x'.repeat(2 * 1024 * 1024 + 1));
            if (mode === 'bad') return res.end('{broken');
            if (mode === 'abort') {res.writeHead(200, {'Content-Length': 1000}); res.write('{'); return setImmediate(() => res.destroy());}
            res.end(JSON.stringify({result: {details: [{address: 'pool', category: 'immature', amount: 1}]}}));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const client = {smembers(key, cb) {cb(null, ['block:tx:1']);}, multi() {return {exec(cb) {cb(null, [{worker: 1}]);}};}};
    const pool = {address: 'pool', paymentProcessing: {daemon: {host: '127.0.0.1', port: server.address().port}}};
    const call = () => new Promise(resolve => immature(client, 'coin', pool, (error, amounts) => resolve({error, amounts})));
    assert.equal((await call()).amounts.worker, 1);
    for (mode of ['large', 'bad', 'abort']) assert.ok((await call()).error);
});
test('money conversion and proportional rewards use exact decimals and integer division', () => {
    const {toUnits, allocate} = require('../libs/paymentMath');
    assert.equal(toUnits('90071992.54740991', 8), Number.MAX_SAFE_INTEGER);
    assert.equal(toUnits('1e-8', 8), 1);
    assert.equal(toUnits('0.000000005', 8), 1);
    assert.equal(toUnits('0.000000004', 8), 0);
    assert.equal(toUnits('1.00000001', 8), 100000001);
    for (const input of [-1, NaN, Infinity, {}, true, '1junk', '90071992.54740992']) assert.throws(() => toUnits(input, 8));
    const allocation = allocate(Number.MAX_SAFE_INTEGER, {a: '0.1', b: '0.2'});
    assert.equal(allocation.a, Number(BigInt(Number.MAX_SAFE_INTEGER) / 3n));
    assert.equal(allocation.b, Number(BigInt(Number.MAX_SAFE_INTEGER) * 2n / 3n));
    assert.equal(allocate(1000, {a: 1, b: 3}).b, 750);
    for (const shares of [{a: -1}, {a: 0}, {a: NaN}, {a: '1junk'}]) assert.throws(() => allocate(100, shares));
});
test('legacy key generator preserves uniform CSPRNG bytes and rejects zero/out-of-range scalars', () => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../website/key.html'), 'utf8');
    const validate = source.slice(source.indexOf('function isValidPrivateKey'), source.indexOf('function $id'));
    const context = {}; vm.createContext(context); vm.runInContext(validate, context);
    assert.equal(context.isValidPrivateKey('0'.repeat(64)), false);
    assert.equal(context.isValidPrivateKey('f'.repeat(64)), false);
    assert.equal(context.isValidPrivateKey('0'.repeat(63) + '1'), true);
    const random = source.slice(source.indexOf('secureRandom: function') + 'secureRandom: '.length, source.indexOf('        byteArrayToHex:')).replace(/,\s*$/, '');
    const bytes = vm.runInNewContext('(' + random + ')(32)', {Uint8Array, window: {crypto: {getRandomValues(array) {array.fill(0); array[1] = 255;}}}});
    assert.equal(bytes[0], 0); assert.equal(bytes[1], 255); assert.equal(bytes[31], 0);
});
test('pool worker authorization preserves normal names, rejects malformed names and never logs miner password', () => {
    const fs = require('node:fs'), vm = require('node:vm'), {EventEmitter} = require('node:events');
    let authorize, valid = true; const logs = [];
    const pool = new EventEmitter(); pool.start = () => {};
    pool.daemon = {cmd(method, params, callback) {callback([{response: {isvalid: valid}}]);}};
    const options = {coin: {name: 'test', algorithm: 'scrypt'}, validateWorkerUsername: true};
    const sandbox = {module: {exports: {}}, process: {env: {pools: JSON.stringify({test: options}), portalConfig: '{"redis":{}}', forkId: '0'}, on() {}}, require(name) {
        if (name === 'stratum-pool') return {createPool(options, callback) {authorize = callback; return pool;}};
        if (name === 'redis') return {createClient() {return {};}};
        if (name === './shareProcessor.js') return function() {};
        if (name.startsWith('./')) return require('../libs/' + name.slice(2));
        return require(name);
    }};
    vm.runInNewContext(fs.readFileSync(require.resolve('../libs/poolWorker'), 'utf8'), sandbox);
    new sandbox.module.exports({debug(...args) {logs.push(args.join(' '));}});
    let result;
    authorize('127.0.0.1', 3333, 'wallet.worker', 'synthetic-miner-secret', value => result = value);
    assert.equal(result.authorized, true); assert.ok(!logs.join('\n').includes('synthetic-miner-secret'));
    for (const name of [null, {}, 'wallet\nforged', 'x'.repeat(257)]) {
        authorize('127.0.0.1', 3333, name, 'x', value => result = value); assert.equal(result.authorized, false);
    }
    valid = false; authorize('127.0.0.1', 3333, 'invalid.worker', 'x', value => result = value); assert.equal(result.authorized, false);
});
