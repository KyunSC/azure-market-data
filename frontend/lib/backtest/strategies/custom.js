import { compileRule, isEmpty } from '../ruleAst'

/**
 * Runs the rule-builder AST.
 *
 * The AST lives in the run config (`params.rule`) rather than in module state,
 * so a custom strategy survives the trip into the worker and back out into a
 * shareable URL like any other strategy.
 */
export default {
  id: 'custom',
  label: 'Custom Rules',
  family: 'custom',
  blurb: 'Entry and exit conditions assembled in the rule builder.',
  params: [
    { key: 'direction', label: 'Direction', type: 'select', default: 'long', options: [
      { value: 'long', label: 'Long only' },
      { value: 'short', label: 'Short only' },
      { value: 'both', label: 'Long & short' },
    ] },
    { key: 'warmupBars', label: 'Warm-up bars', type: 'number', default: 50, min: 0, max: 400, step: 1 },
    { key: 'rule', label: 'Rules', type: 'rule', default: null, hidden: true },
  ],

  warmup: (p) => Math.round(p.warmupBars ?? 50),

  prepare(ds, p) {
    const rule = p.rule || {}
    return {
      entryLong: isEmpty(rule.entryLong) ? null : compileRule(rule.entryLong, ds),
      exitLong: isEmpty(rule.exitLong) ? null : compileRule(rule.exitLong, ds),
      entryShort: isEmpty(rule.entryShort) ? null : compileRule(rule.entryShort, ds),
      exitShort: isEmpty(rule.exitShort) ? null : compileRule(rule.exitShort, ds),
    }
  },

  signal(i, s, ds, p, prev) {
    const wantLong = p.direction !== 'short'
    const wantShort = p.direction !== 'long'

    if (prev > 0) {
      if (s.exitLong && s.exitLong(i)) return 0
      if (!s.exitLong && s.entryLong && !s.entryLong(i)) return 0
      return 1
    }
    if (prev < 0) {
      if (s.exitShort && s.exitShort(i)) return 0
      if (!s.exitShort && s.entryShort && !s.entryShort(i)) return 0
      return -1
    }

    if (wantLong && s.entryLong && s.entryLong(i)) return 1
    if (wantShort && s.entryShort && s.entryShort(i)) return -1
    return 0
  },
}
