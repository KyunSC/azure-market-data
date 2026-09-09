/**
 * Config-in-URL sharing.
 *
 * A backtest result is only meaningful next to the configuration that produced
 * it, so the link carries the whole config — plane, symbol, strategy, params,
 * costs, risk and any custom rule — rather than a result id. Anyone opening the
 * link re-runs the simulation locally and gets the same numbers.
 */

const KEY = 'c'
import { ENGINE_VERSION } from './datasets'

export function encodeConfig(state) {
  const payload = {
    engineVersion: ENGINE_VERSION,
    researchDatasetId: state.plane === 'research' && !state.example ? state.dataset?.id || state.researchDatasetId : null,
    datasetVersion: state.dataset?.version,
    example: state.example,
    plane: state.plane,
    symbol: state.plane === 'research' ? state.researchSymbol : state.liveSymbol,
    period: state.livePeriod,
    interval: state.liveInterval,
    strategyId: state.strategyId,
    params: stripRule(state.paramsByStrategy[state.strategyId]),
    costs: state.costs,
    risk: state.risk,
    rule: state.strategyId === 'custom' ? state.rule : undefined,
  }
  try {
    return base64UrlEncode(JSON.stringify(payload))
  } catch {
    return null
  }
}

export function decodeConfig(search) {
  try {
    const raw = new URLSearchParams(search).get(KEY)
    if (!raw) return null
    return JSON.parse(base64UrlDecode(raw))
  } catch {
    return null
  }
}

export function shareUrl(state) {
  const encoded = encodeConfig(state)
  if (!encoded || typeof window === 'undefined') return null
  return `${window.location.origin}${window.location.pathname}?${KEY}=${encoded}`
}

const stripRule = (params) => {
  if (!params) return {}
  const { rule, ...rest } = params
  return rest
}

function base64UrlEncode(str) {
  const b64 = btoa(unescape(encodeURIComponent(str)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  return decodeURIComponent(escape(atob(b64)))
}
