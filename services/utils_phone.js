exports.toE164IL = (raw) => {
    if (!raw) return raw;
    if (raw.startsWith('+972')) return raw;
    return raw.replace(/^0/, '+972');
};