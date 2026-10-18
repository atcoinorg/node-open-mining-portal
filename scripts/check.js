const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const portal = require('../config.json');
const pool = require('../pool_configs/atcoin.json');
function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => res.statusCode === 200 ? resolve(data) : reject(new Error('HTTP ' + res.statusCode)));
        });
        req.setTimeout(10000, () => req.destroy(new Error('HTTP timeout')));
        req.on('error', reject);
        req.end(body);
    });
}
async function main() {
    const rpc = pool.paymentProcessing.daemon;
    const result = JSON.parse(await request({hostname: rpc.host, port: rpc.port, path: rpc.path,
        method: 'POST', auth: rpc.user + ':' + rpc.password},
        JSON.stringify({id: 1, method: 'getaddressinfo', params: [pool.address]})));
    assert.equal(result.error, null);
    assert.equal(result.result.ismine, true);
    console.log('Wallet owns pool address: OK');
    await request({hostname: '127.0.0.1', port: portal.website.port, path: '/'});
    console.log('Website: HTTP 200');
    for (const workerName of [pool.address, pool.address + '.gromada']) {
    await new Promise((resolve, reject) => {
        const socket = net.connect(Number(Object.keys(pool.ports)[0]), '127.0.0.1');
        const received = new Set();
        let buffer = '';
        socket.setTimeout(10000, () => socket.destroy(new Error('Stratum timeout')));
        socket.on('error', reject);
        socket.on('close', () => {
            if (received.size !== 3) reject(new Error('Stratum closed before completing checks'));
        });
        socket.on('connect', () => {
            socket.write(JSON.stringify({id: 1, method: 'mining.subscribe', params: ['portal-check']}) + '\n');
            socket.write(JSON.stringify({id: 2, method: 'mining.authorize', params: [workerName, 'x']}) + '\n');
        });
        socket.on('data', chunk => {
            buffer += chunk;
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                try {
                    const message = JSON.parse(line);
                    if (message.id === 1) { assert.ok(message.result); received.add('subscribe'); }
                    if (message.id === 2) { assert.equal(message.result, true); received.add('authorize'); }
                    if (message.method === 'mining.notify') received.add('job');
                    if (received.size === 3) { socket.end(); resolve(); }
                } catch (error) { socket.destroy(); reject(error); }
            }
        });
    });
    console.log('Stratum subscription, authorization and mining job (' + workerName + '): OK');
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
