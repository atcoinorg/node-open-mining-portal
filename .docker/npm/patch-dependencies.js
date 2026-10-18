// Compatibility fixes for the locked stratum-pool dependency.
const fs = require('node:fs');

function ensure(file, marker, before, after) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes(marker)) return;
    if (!source.includes(before)) throw new Error('Upstream code changed: ' + file);
    fs.writeFileSync(file, source.replace(before, after));
}

ensure(
    'node_modules/stratum-pool/lib/daemon.js',
    "path: instance.path || '/'",
    "method: 'POST', auth: instance.user + ':' + instance.password,",
    "method: 'POST', path: instance.path || '/', auth: instance.user + ':' + instance.password,"
);

// Current upstream handles ATCOIN bech32/bech32m addresses itself. Keep this
// assertion so an incompatible dependency update fails during image creation.
const util = fs.readFileSync('node_modules/stratum-pool/lib/util.js', 'utf8');
if (!util.includes("if (/^atcoin1/i.test(addr))")) {
    throw new Error('stratum-pool does not support ATCOIN witness addresses');
}
