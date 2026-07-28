/**
 * Rule AST for the custom strategy builder.
 *
 * Nodes:
 *   { t: 'const',   v: 1.5 }
 *   { t: 'ref',     k: 'close' | 'sma:20' | 'f:net_gex' | 'ml:pred' }
 *   { t: 'cmp',     op: '>' | '<' | '>=' | '<=' | 'crossesAbove' | 'crossesBelow', a: node, b: node }
 *   { t: 'and'|'or', items: [node, ...] }
 *   { t: 'not',     item: node }
 *
 * Comparison operands are always series, so `crossesAbove` can look one bar
 * back without the UI having to model history.
 */

import { getSeries, constSeries } from './series'

export const COMPARATORS = [
  { op: '>', label: '>' },
  { op: '<', label: '<' },
  { op: '>=', label: '≥' },
  { op: '<=', label: '≤' },
  { op: 'crossesAbove', label: 'crosses above' },
  { op: 'crossesBelow', label: 'crosses below' },
]

/** Operands offered by the builder. `plane: 'research'` entries are hidden when
 *  the live plane is selected — the live API has no historical GEX. */
export const OPERAND_GROUPS = [
  {
    group: 'Price',
    items: [
      { k: 'close', label: 'Close' },
      { k: 'open', label: 'Open' },
      { k: 'high', label: 'High' },
      { k: 'low', label: 'Low' },
      { k: 'volume', label: 'Volume' },
      { k: 'typical', label: 'Typical (HLC/3)' },
    ],
  },
  {
    group: 'Indicators',
    items: [
      { k: 'sma:20', label: 'SMA 20' },
      { k: 'sma:50', label: 'SMA 50' },
      { k: 'sma:200', label: 'SMA 200' },
      { k: 'ema:21', label: 'EMA 21' },
      { k: 'ema:50', label: 'EMA 50' },
      { k: 'rsi:14', label: 'RSI 14' },
      { k: 'atr:14', label: 'ATR 14' },
      { k: 'vwap', label: 'VWAP (session)' },
      { k: 'bbUpper:20:2', label: 'BB upper (20, 2)' },
      { k: 'bbMid:20', label: 'BB mid (20)' },
      { k: 'bbLower:20:2', label: 'BB lower (20, 2)' },
    ],
  },
  {
    group: 'GEX',
    plane: 'research',
    items: [
      { k: 'f:dist_call_wall_atr', label: 'Dist to call wall (ATR)' },
      { k: 'f:dist_put_wall_atr', label: 'Dist to put wall (ATR)' },
      { k: 'f:dist_zero_gamma_atr', label: 'Dist to zero gamma (ATR)' },
      { k: 'f:above_zero_gamma', label: 'Above zero gamma (±1)' },
      { k: 'f:gamma_regime_strength', label: 'Gamma regime strength' },
      { k: 'f:net_gex', label: 'Net GEX' },
      { k: 'f:abs_gex_total', label: 'Abs GEX total' },
      { k: 'f:gex_concentration', label: 'GEX concentration' },
      { k: 'f:call_wall_strength', label: 'Call wall strength' },
      { k: 'f:put_wall_strength', label: 'Put wall strength' },
      { k: 'f:gex_age_minutes', label: 'GEX age (min)' },
    ],
  },
  {
    group: 'Baseline features',
    plane: 'research',
    items: [
      { k: 'f:rsi_14', label: 'RSI 14 (dataset)' },
      { k: 'f:realized_vol_60m', label: 'Realized vol 60m' },
      { k: 'f:volume_zscore_20', label: 'Volume z-score 20' },
      { k: 'f:close_vs_sma20', label: 'Close vs SMA20' },
      { k: 'f:close_position', label: 'Close position in bar' },
      { k: 'f:log_return_30m', label: 'Log return 30m' },
      { k: 'f:minutes_since_open', label: 'Minutes since open' },
    ],
  },
  {
    group: 'Model',
    plane: 'research',
    items: [{ k: 'ml:pred', label: 'RF OOS prediction' }],
  },
]

export function operandLabel(k) {
  for (const g of OPERAND_GROUPS) {
    const hit = g.items.find((i) => i.k === k)
    if (hit) return hit.label
  }
  return k
}

export const emptyRule = () => ({ t: 'and', items: [] })

export const newCompare = (a = 'close', op = '>', b = 'sma:20') => ({
  t: 'cmp',
  op,
  a: { t: 'ref', k: a },
  b: typeof b === 'number' ? { t: 'const', v: b } : { t: 'ref', k: b },
})

export function isEmpty(node) {
  if (!node) return true
  if (node.t === 'and' || node.t === 'or') return !node.items?.length
  return false
}

/** Resolve every series a rule touches once, up front. */
function operandSeries(node, ds, n) {
  if (!node) return constSeries(n, Number.NaN)
  if (node.t === 'const') return constSeries(n, node.v)
  return getSeries(ds, node.k)
}

/**
 * Compile an AST into `(i) => boolean`. Compilation resolves series eagerly so
 * the returned predicate is a tight array read per bar — a sweep can call it a
 * few hundred thousand times.
 */
export function compileRule(node, ds) {
  const n = ds.close.length
  if (isEmpty(node)) return () => false

  switch (node.t) {
    case 'cmp': {
      const a = operandSeries(node.a, ds, n)
      const b = operandSeries(node.b, ds, n)
      switch (node.op) {
        case '>': return (i) => a[i] > b[i]
        case '<': return (i) => a[i] < b[i]
        case '>=': return (i) => a[i] >= b[i]
        case '<=': return (i) => a[i] <= b[i]
        case 'crossesAbove': return (i) => i > 0 && a[i - 1] <= b[i - 1] && a[i] > b[i]
        case 'crossesBelow': return (i) => i > 0 && a[i - 1] >= b[i - 1] && a[i] < b[i]
        default: return () => false
      }
    }
    case 'and': {
      const fns = node.items.map((c) => compileRule(c, ds))
      return (i) => fns.every((f) => f(i))
    }
    case 'or': {
      const fns = node.items.map((c) => compileRule(c, ds))
      return (i) => fns.some((f) => f(i))
    }
    case 'not': {
      const f = compileRule(node.item, ds)
      return (i) => !f(i)
    }
    default:
      return () => false
  }
}

/** Human-readable rendering for the live pseudocode preview. */
export function describeRule(node, depth = 0) {
  if (isEmpty(node)) return '—'
  switch (node.t) {
    case 'const': return formatConst(node.v)
    case 'ref': return operandLabel(node.k)
    case 'cmp': {
      const opLabel = COMPARATORS.find((c) => c.op === node.op)?.label || node.op
      return `${describeRule(node.a, depth + 1)} ${opLabel} ${describeRule(node.b, depth + 1)}`
    }
    case 'and':
    case 'or': {
      const joiner = node.t === 'and' ? ' AND ' : ' OR '
      const body = node.items.map((c) => describeRule(c, depth + 1)).join(joiner)
      return depth > 0 ? `(${body})` : body
    }
    case 'not':
      return `NOT (${describeRule(node.item, depth + 1)})`
    default:
      return '?'
  }
}

function formatConst(v) {
  if (Math.abs(v) >= 1000) return v.toLocaleString()
  return String(v)
}

/** Series keys a rule depends on — used to warn when a rule references
 *  research-only data while the live plane is loaded. */
export function ruleRefs(node, acc = new Set()) {
  if (!node) return acc
  if (node.t === 'ref') acc.add(node.k)
  if (node.t === 'cmp') {
    ruleRefs(node.a, acc)
    ruleRefs(node.b, acc)
  }
  if (node.items) node.items.forEach((c) => ruleRefs(c, acc))
  if (node.item) ruleRefs(node.item, acc)
  return acc
}
