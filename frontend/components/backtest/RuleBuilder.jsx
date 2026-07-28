'use client'

import { useState } from 'react'
import { useBacktest } from '../../lib/backtest/store'
import { COMPARATORS, OPERAND_GROUPS, newCompare, describeRule, isEmpty, operandLabel } from '../../lib/backtest/ruleAst'
import { EmptyState } from './Panel'

const TABS = [
  { slot: 'entryLong', label: 'entry long' },
  { slot: 'exitLong', label: 'exit long' },
  { slot: 'entryShort', label: 'entry short' },
  { slot: 'exitShort', label: 'exit short' },
]

/**
 * Chip-row rule builder.
 *
 * Rows rather than drag-and-drop nodes: a condition is `[operand] [op]
 * [operand]`, rows join with AND/OR, and the whole thing stays dense enough to
 * read at a glance. Dragging boxes around would need three times the space to
 * express the same rule.
 */
export default function RuleBuilder() {
  const rule = useBacktest((s) => s.rule)
  const setRule = useBacktest((s) => s.setRule)
  const plane = useBacktest((s) => s.plane)
  const strategyId = useBacktest((s) => s.strategyId)
  const setStrategy = useBacktest((s) => s.setStrategy)
  const [tab, setTab] = useState('entryLong')

  const node = rule[tab] || { t: 'and', items: [] }
  const items = node.items || []

  const update = (patch) => setRule(tab, { ...node, ...patch })
  const setItem = (i, next) => update({ items: items.map((it, idx) => (idx === i ? next : it)) })
  const addItem = () => update({ items: [...items, newCompare()] })
  const removeItem = (i) => update({ items: items.filter((_, idx) => idx !== i) })

  return (
    <div className="flex h-full flex-col">
      <div className="hair-b flex flex-wrap items-center gap-1 bg-panel-2 px-2 py-1.5">
        {TABS.map((t) => (
          <button
            key={t.slot}
            onClick={() => setTab(t.slot)}
            className={`btn !px-2 !py-0.5 ${tab === t.slot ? 'btn-active' : ''}`}
          >
            {t.label}
            {!isEmpty(rule[t.slot]) && <span className="ml-1 text-amber">•</span>}
          </button>
        ))}
        <button
          onClick={() => update({ t: node.t === 'and' ? 'or' : 'and' })}
          className="btn !px-2 !py-0.5"
          title="Join the rows with AND or OR"
        >
          join: {node.t}
        </button>
        {strategyId !== 'custom' && (
          <button onClick={() => setStrategy('custom')} className="btn btn-primary ml-auto !px-2 !py-0.5">
            use these rules
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {!items.length ? (
          <EmptyState action={<button onClick={addItem} className="btn">add condition</button>}>
            No conditions on this leg. An empty exit leg means the position is held until the entry
            condition stops being true.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-1.5">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="w-8 shrink-0 text-right font-mono text-[9px] text-dim">
                  {i === 0 ? 'if' : node.t}
                </span>
                <ConditionRow value={item} plane={plane} onChange={(next) => setItem(i, next)} />
                <button onClick={() => removeItem(i)} className="px-1 font-mono text-[11px] text-dim hover:text-neg" title="Remove">
                  ×
                </button>
              </div>
            ))}
            <button onClick={addItem} className="btn mt-1 self-start !px-2 !py-0.5">
              + condition
            </button>
          </div>
        )}
      </div>

      <div className="hair-t bg-panel-2 px-2 py-1.5">
        <p className="font-mono text-[9px] tracking-[0.12em] text-dim uppercase">compiled</p>
        <pre className="mt-1 overflow-x-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-amber">
{`long:  if (${describeRule(rule.entryLong)})  →  +1
       exit when (${describeRule(rule.exitLong)})
short: if (${describeRule(rule.entryShort)})  →  -1
       exit when (${describeRule(rule.exitShort)})`}
        </pre>
        {plane !== 'research' && usesResearchOperands(rule) && (
          <p className="mt-1 font-mono text-[10px] text-neg">
            These rules reference GEX or model columns, which only exist on the research plane.
          </p>
        )}
      </div>
    </div>
  )
}

function ConditionRow({ value, onChange, plane }) {
  const isConst = value.b?.t === 'const'

  return (
    <div className="flex flex-1 flex-wrap items-center gap-1">
      <OperandPicker value={value.a} plane={plane} onChange={(a) => onChange({ ...value, a })} />
      <select
        value={value.op}
        onChange={(e) => onChange({ ...value, op: e.target.value })}
        className="chip cursor-pointer text-amber"
      >
        {COMPARATORS.map((c) => (
          <option key={c.op} value={c.op} className="bg-panel text-ink">
            {c.label}
          </option>
        ))}
      </select>
      <OperandPicker value={value.b} plane={plane} onChange={(b) => onChange({ ...value, b })} allowConst />
      {!isConst ? (
        <button
          onClick={() => onChange({ ...value, b: { t: 'const', v: 0 } })}
          className="px-1 font-mono text-[9px] text-dim hover:text-ink"
          title="Compare against a number instead"
        >
          #
        </button>
      ) : (
        <button
          onClick={() => onChange({ ...value, b: { t: 'ref', k: 'sma:20' } })}
          className="px-1 font-mono text-[9px] text-dim hover:text-ink"
          title="Compare against a series instead"
        >
          ƒ
        </button>
      )}
    </div>
  )
}

function OperandPicker({ value, onChange, plane, allowConst }) {
  if (value?.t === 'const') {
    return (
      <input
        type="number"
        step="any"
        value={value.v}
        onChange={(e) => onChange({ t: 'const', v: Number(e.target.value) })}
        className="field !w-[80px] !px-1 !py-0.5 text-right"
      />
    )
  }

  const groups = OPERAND_GROUPS.filter((g) => g.plane !== 'research' || plane === 'research')

  return (
    <select
      value={value?.k || 'close'}
      onChange={(e) =>
        onChange(e.target.value === '__const' ? { t: 'const', v: 0 } : { t: 'ref', k: e.target.value })
      }
      className="chip max-w-[190px] cursor-pointer"
      title={operandLabel(value?.k)}
    >
      {groups.map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.items.map((it) => (
            <option key={it.k} value={it.k} className="bg-panel text-ink">
              {it.label}
            </option>
          ))}
        </optgroup>
      ))}
      {allowConst && <option value="__const">number…</option>}
    </select>
  )
}

function usesResearchOperands(rule) {
  const researchKeys = new Set(
    OPERAND_GROUPS.filter((g) => g.plane === 'research').flatMap((g) => g.items.map((i) => i.k)),
  )
  const walk = (n) => {
    if (!n) return false
    if (n.t === 'ref') return researchKeys.has(n.k)
    if (n.t === 'cmp') return walk(n.a) || walk(n.b)
    if (n.items) return n.items.some(walk)
    if (n.item) return walk(n.item)
    return false
  }
  return Object.values(rule).some(walk)
}
