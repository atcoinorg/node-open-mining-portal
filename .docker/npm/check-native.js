const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const hashing = require('multi-hashing');
// Verify actual hash bytes, not just that the addon loads on this Node ABI.
const headers = [Buffer.alloc(80), Buffer.from(Array.from({length: 80}, (_, i) => i))];
for (let i = 0; i < 8; i++) {
    headers.push(Buffer.concat([crypto.createHash('sha512').update(String(i)).digest(), Buffer.alloc(16, i)]));
}
for (const header of headers) {
    const expected = crypto.scryptSync(header, header, 32, {N: 1024, r: 1, p: 1});
    assert.deepEqual(hashing.scrypt(header, 1024, 1), expected, 'Native Scrypt hash differs from reference');
}
console.log('Native Scrypt matches reference on 10 block headers');
