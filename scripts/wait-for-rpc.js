const http = require('node:http');
const pool = require('../pool_configs/atcoin.json');
const rpc = pool.daemons[0];
function ready() {
    return new Promise(resolve => {
        const req = http.request({hostname: rpc.host, port: rpc.port, method: 'POST',
            auth: rpc.user + ':' + rpc.password}, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(res.statusCode === 200 && !result.error && !!result.result?.previousblockhash);
                } catch { resolve(false); }
            });
        });
        req.setTimeout(10000, () => req.destroy());
        req.on('error', () => resolve(false));
        req.end(JSON.stringify({id: 1, method: 'getblocktemplate', params: [{rules: ['segwit']}]}));
    });
}
(async () => {
    while (!await ready()) {
        console.log('Waiting for ATCOIN to connect, synchronize and provide a mining template…');
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    console.log('ATCOIN mining RPC is ready');
})();
