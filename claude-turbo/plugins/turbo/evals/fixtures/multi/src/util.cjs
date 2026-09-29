'use strict';
exports.clamp = function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); };
exports.fmt = (n) => n.toFixed(2);
