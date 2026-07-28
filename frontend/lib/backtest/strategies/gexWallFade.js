import { getSeries } from '../series'

/**
 * Fade the gamma walls.
 *
 * Feature signs come straight from `functions/ml/build_dataset.py`:
 *   dist_call_wall_atr = (close - call_wall) / atr   → 0 means price is *at* the wall
 *   dist_put_wall_atr  = (close - put_wall)  / atr
 *   above_zero_gamma   = sign(close - zero_gamma)    → +1 long-gamma regime
 *
 * The trade thesis is only coherent in the long-gamma regime, where dealers
 * hedge against the move and walls act as pins. Below zero gamma the same walls
 * are accelerants, so the regime gate is on by default rather than a nicety.
 */
export default {
  id: 'gexWallFade',
  label: 'GEX Wall Fade',
  family: 'gex',
  plane: 'research',
  blurb: 'Short into the call wall, buy the put wall, only while price sits above zero gamma.',
  params: [
    { key: 'band', label: 'Band (ATR)', type: 'number', default: 0.5, min: 0.05, max: 3, step: 0.05 },
    { key: 'exitBand', label: 'Exit (ATR)', type: 'number', default: 1.5, min: 0.1, max: 6, step: 0.1 },
    { key: 'minWallStrength', label: 'Min wall strength', type: 'number', default: 0.1, min: 0, max: 0.9, step: 0.01 },
    { key: 'regimeGate', label: 'Require +gamma', type: 'boolean', default: true },
    { key: 'shortSide', label: 'Short side', type: 'boolean', default: true },
  ],

  warmup: () => 1,

  prepare(ds) {
    return {
      call: getSeries(ds, 'f:dist_call_wall_atr'),
      put: getSeries(ds, 'f:dist_put_wall_atr'),
      regime: getSeries(ds, 'f:above_zero_gamma'),
      callStrength: getSeries(ds, 'f:call_wall_strength'),
      putStrength: getSeries(ds, 'f:put_wall_strength'),
    }
  },

  signal(i, s, ds, p, prev) {
    const dCall = s.call[i]
    const dPut = s.put[i]
    if (Number.isNaN(dCall) || Number.isNaN(dPut)) return 0

    // Exit once price has travelled back away from the wall it was fading.
    if (prev > 0) return dPut >= p.exitBand ? 0 : 1
    if (prev < 0) return dCall <= -p.exitBand ? 0 : -1

    if (p.regimeGate && !(s.regime[i] > 0)) return 0

    const nearCall = Math.abs(dCall) <= p.band && s.callStrength[i] >= p.minWallStrength
    const nearPut = Math.abs(dPut) <= p.band && s.putStrength[i] >= p.minWallStrength

    if (nearPut && !nearCall) return 1
    if (nearCall && !nearPut) return p.shortSide ? -1 : 0
    return 0
  },
}
