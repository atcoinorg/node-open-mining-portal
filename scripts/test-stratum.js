'use strict';
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const root = path.dirname(require.resolve('stratum-pool/package.json'));
// These suites bind only loopback fake RPC/Stratum servers and use temporary files.
for (const name of ['stratum', 'jobs', 'authorize', 'daemon', 'pool', 'setup-rpc']) {
    const result = spawnSync(process.execPath, [path.join(root, 'test', name + '.test.js')], {stdio: 'inherit'});
    if (result.error || result.status !== 0) {
        console.error('Stratum regression suite failed: ' + name);
        process.exitCode = 1;
        break;
    }
}
