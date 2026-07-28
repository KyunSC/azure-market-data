'use client'

import { useRef, useState, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useBacktest } from '../../lib/backtest/store'
import { fmtTime, fmtMoneySigned, fmtPct, fmtNum, signClass } from '../../lib/backtest/format'
import { EmptyState } from './Panel'

const COLS = [
  { key: 'n', label: '#', w: 'w-9', align: 'text-right' },
  { key: 'side', label: 'side', w: 'w-12', align: 'text-left' },
  { key: 'entryTime', label: 'entry', w: 'w-24', align: 'text-left' },
  { key: 'entryPrice', label: 'in', w: 'w-16', align: 'text-right' },
  { key: 'exitTime', label: 'exit', w: 'w-24', align: 'text-left' },
  { key: 'exitPrice', label: 'out', w: 'w-16', align: 'text-right' },
  { key: 'bars', label: 'bars', w: 'w-12', align: 'text-right' },
  { key: 'pnlPct', label: 'ret', w: 'w-16', align: 'text-right' },
  { key: 'pnl', label: 'p/l', w: 'w-20', align: 'text-right' },
  { key: 'mae', label: 'mae', w: 'w-14', align: 'text-right' },
  { key: 'reason', label: 'exit why', w: 'w-16', align: 'text-left' },
]

/**
 * Every fill the engine made. Virtualized because a 5m mean-reversion strategy
 * over three months produces thousands of rows, and the whole point of the
 * blotter is that you can scroll it looking for the trade that broke the curve.
 */
export default function Blotter() {
  const result = useBacktest((s) => s.result)
  const selectTrade = useBacktest((s) => s.selectTrade)
  const selected = useBacktest((s) => s.selectedTrade)
  const parentRef = useRef(null)
  const [sort, setSort] = useState({ key: null, dir: 1 })

  const trades = useMemo(() => {
    const list = result?.trades ? result.trades.map((t, i) => ({ ...t, n: i + 1 })) : []
    if (!sort.key) return list
    return [...list].sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      if (typeof av === 'string') return sort.dir * av.localeCompare(bv)
      return sort.dir * (av - bv)
    })
  }, [result, sort])

  const rowVirtualizer = useVirtualizer({
    count: trades.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 12,
  })

  if (!result) return <EmptyState>No run yet.</EmptyState>
  if (!trades.length) {
    return (
      <EmptyState>
        The strategy never entered. Loosen the entry condition, or check that the warm-up period is not
        eating the whole sample.
      </EmptyState>
    )
  }

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }))

  return (
    <div className="flex h-full flex-col">
      <div className="hair-b flex gap-2 bg-panel-2 px-2 py-1 font-mono text-[9px] tracking-[0.1em] text-dim uppercase">
        {COLS.map((c) => (
          <button
            key={c.key}
            onClick={() => toggleSort(c.key)}
            className={`${c.w} ${c.align} shrink-0 hover:text-ink ${sort.key === c.key ? 'text-amber' : ''}`}
          >
            {c.label}
            {sort.key === c.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}
          </button>
        ))}
      </div>

      <div ref={parentRef} className="flex-1 overflow-auto">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((v) => {
            const t = trades[v.index]
            const isSel = selected && selected.entryIdx === t.entryIdx
            return (
              <div
                key={v.key}
                onClick={() => selectTrade(t)}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: v.size, transform: `translateY(${v.start}px)` }}
                className={`flex cursor-pointer items-center gap-2 px-2 font-mono text-[10px] ${
                  isSel ? 'bg-amber/10' : v.index % 2 ? 'bg-panel-2/40' : ''
                } hover:bg-panel-3`}
                title="Click to pan the chart to this trade"
              >
                <span className="w-9 shrink-0 text-right text-dim">{t.n}</span>
                <span className={`w-12 shrink-0 ${t.side === 'long' ? 'text-pos' : 'text-neg'}`}>{t.side}</span>
                <span className="w-24 shrink-0 text-muted">{fmtTime(t.entryTime)}</span>
                <span className="w-16 shrink-0 text-right text-muted">{fmtNum(t.entryPrice, 2)}</span>
                <span className="w-24 shrink-0 text-muted">{fmtTime(t.exitTime)}</span>
                <span className="w-16 shrink-0 text-right text-muted">{fmtNum(t.exitPrice, 2)}</span>
                <span className="w-12 shrink-0 text-right text-dim">{t.bars}</span>
                <span className={`w-16 shrink-0 text-right ${signClass(t.pnlPct)}`}>{fmtPct(t.pnlPct)}</span>
                <span className={`w-20 shrink-0 text-right ${signClass(t.pnl)}`}>{fmtMoneySigned(t.pnl, 0)}</span>
                <span className="w-14 shrink-0 text-right text-dim">{fmtPct(t.mae, 1)}</span>
                <span className="w-16 shrink-0 text-dim">{t.reason}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="hair-t flex items-center gap-3 bg-panel-2 px-2 py-1 font-mono text-[9px] text-dim">
        <span>{trades.length} trades</span>
        <span>· exits: {summariseReasons(trades)}</span>
        <span className="ml-auto">click a row to pan the chart</span>
      </div>
    </div>
  )
}

function summariseReasons(trades) {
  const counts = {}
  for (const t of trades) counts[t.reason] = (counts[t.reason] || 0) + 1
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')
}
