/**
 * NEGATIVE CONTROL at a longer holding period. control-random-entry holds 6
 * bars (30 min); most GEX specs hold for hours, and the noise floor of a
 * walk-forward Sharpe depends on holding period and exposure.
 */
const hash = (i, seed) => {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed, 0xc2b2ae35)
  h ^= h >>> 13
  h = Math.imul(h, 0x27d4eb2f)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export default {
  id: 'control-random-entry-long-hold',
  family: 'control',
  rationale: 'Negative control: random direction and timing held up to 24 bars (2 hours), the holding period of the wall and regime specs. Its spread across seeds is the noise floor for multi-hour specs.',
  params: [
    { key: 'seed', values: [11, 12, 13, 14, 15, 16] },
    { key: 'rate', values: [0.01, 0.02] },
  ],
  risk: { maxBars: 24, flatAtSessionEnd: true },
  signal(i, s, ds, p, prev) {
    if (prev !== 0) return prev
    const u = hash(i, p.seed)
    if (u < p.rate / 2) return 1
    if (u < p.rate) return -1
    return 0
  },
}
