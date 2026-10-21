'use strict';
module.exports = function(response) {
    let target;
    if (response.target != null) {
        if (typeof response.target !== 'string' || !/^[a-f0-9]{1,64}$/i.test(response.target)) throw new Error('Invalid target');
        target = BigInt('0x' + response.target);
    } else {
        if (typeof response.bits !== 'string' || !/^[a-f0-9]{8}$/i.test(response.bits)) throw new Error('Invalid compact target');
        const compact = parseInt(response.bits, 16), exponent = compact >>> 24;
        if (compact & 0x00800000 || exponent > 32) throw new Error('Invalid compact target');
        const mantissa = BigInt(compact & 0x007fffff);
        target = exponent <= 3 ? mantissa >> BigInt(8 * (3 - exponent)) : mantissa << BigInt(8 * (exponent - 3));
    }
    if (target <= 0n) throw new Error('Invalid zero target');
    return Number(target);
};
