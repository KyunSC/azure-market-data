/**
 * Strategy registry.
 *
 * Every strategy exposes a declarative `params` schema. That schema is the only
 * description of a strategy's knobs anywhere in the app: the control panel
 * renders its inputs from it, the sweep panel populates its axis dropdowns from
 * it, and the command palette builds its "jump to param" entries from it. Add a
 * param to the schema and all three follow — there is no per-strategy UI.
 *
 * Contract:
 *   prepare(ds, params) -> state        (optional, hoists per-run precompute)
 *   warmup(params, ds)  -> bar index    (optional, bars to skip)
 *   signal(i, state, ds, params, prev) -> -1 | 0 | 1   target position
 */

import smaCross from './smaCross'
import bbReversion from './bbReversion'
import vwapReversion from './vwapReversion'
import gexWallFade from './gexWallFade'
import gexRegime from './gexRegime'
import mlSignal from './mlSignal'
import custom from './custom'

export const STRATEGIES = [smaCross, bbReversion, vwapReversion, gexWallFade, gexRegime, mlSignal, custom]

export const FAMILIES = [
  { id: 'ta', label: 'Technical', hotkey: '1' },
  { id: 'gex', label: 'Gamma', hotkey: '2' },
  { id: 'ml', label: 'Model', hotkey: '3' },
  { id: 'custom', label: 'Custom', hotkey: '4' },
]

export function getStrategy(id) {
  return STRATEGIES.find((s) => s.id === id) || STRATEGIES[0]
}

export function defaultParams(id) {
  const s = getStrategy(id)
  const out = {}
  for (const p of s.params) out[p.key] = p.default
  return out
}

/** Numeric params only — the sweep can only step a continuous axis. */
export function sweepableParams(id) {
  return getStrategy(id).params.filter((p) => p.type === 'number')
}

export function strategiesForPlane(plane) {
  return STRATEGIES.filter((s) => s.plane !== 'research' || plane === 'research')
}
