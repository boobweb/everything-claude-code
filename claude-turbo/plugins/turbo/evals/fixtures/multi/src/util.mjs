export function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
export const fmt = (n) => n.toFixed(2);
export default class Timer {
  constructor(ms) { this.ms = ms; }
  start() { this.t0 = Date.now(); }
}
