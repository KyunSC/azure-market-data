/**
 * NEGATIVE CONTROL. Enters long or short at pseudo-random bars and holds for a
 * fixed number of bars. It has no information, so its walk-forward numbers are
 * the noise floor every real spec on the leaderboard should be read against.
 */
const hash = (i, seed) => {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed, 0xc2b2ae35)
  h ^= h >>> 13
  h = Math.imul(h, 0x27d4eb2f)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export default {
  id: 'control-random-entry',
  family: 'control',
  rationale: 'Negative control: random direction and timing, fixed holding period. Anything that cannot beat this is noise.',
  params: [
    { key: 'seed', values: [1, 2, 3, 4, 5, 6] },
    { key: 'rate', values: [0.02, 0.05] },
  ],
  risk: { maxBars: 6, flatAtSessionEnd: true },
  signal(i, s, ds, p, prev) {
    if (prev !== 0) return prev
    const u = hash(i, p.seed)
    if (u < p.rate / 2) return 1
    if (u < p.rate) return -1
    return 0
  },
}
