'use strict';
function decimal(value) {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid monetary decimal');
    const text = String(value);
    if (text.length > 128) throw new Error('Decimal too long');
    const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/i.exec(text);
    if (!match) throw new Error('Invalid positive decimal');
    const exponent = Number(match[3] || 0) - (match[2] || '').length;
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 512) throw new Error('Decimal scale out of range');
    return {coefficient: BigInt(match[1] + (match[2] || '')), exponent};
}
function toUnits(value, precision) {
    const part = decimal(value), exponent = part.exponent + precision;
    let units;
    if (exponent >= 0) units = part.coefficient * 10n ** BigInt(exponent);
    else {
        const divisor = 10n ** BigInt(-exponent);
        units = part.coefficient / divisor;
        if (part.coefficient % divisor * 2n >= divisor) units++;
    }
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe monetary amount');
    return Number(units);
}
function allocate(reward, shares) {
    if (!Number.isSafeInteger(reward) || reward < 0) throw new Error('Unsafe reward');
    const entries = Object.entries(shares).map(([name, value]) => {
        const part = decimal(value);
        if (!Number.isFinite(Number(value)) || Number(value) <= 0 || part.coefficient <= 0n) throw new Error('Invalid round shares');
        return {name, ...part};
    });
    if (!entries.length) throw new Error('Empty round');
    const scale = entries.reduce((minimum, entry) => Math.min(minimum, entry.exponent), Infinity);
    const weights = entries.map(entry => entry.coefficient * 10n ** BigInt(entry.exponent - scale));
    const total = weights.reduce((sum, weight) => sum + weight, 0n);
    const result = Object.create(null);
    entries.forEach((entry, index) => {result[entry.name] = Number(BigInt(reward) * weights[index] / total);});
    return result;
}
module.exports = {toUnits, allocate};
