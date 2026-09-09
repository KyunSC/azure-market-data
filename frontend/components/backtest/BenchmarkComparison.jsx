'use client'

import { useEffect, useMemo, useState } from 'react'
import { useBacktest } from '../../lib/backtest/store'
import { BENCHMARKS, dailyStrategy, compareBenchmark } from '../../lib/backtest/benchmark'
import { fmtPct, fmtPctAbs, fmtSigned, signClass } from '../../lib/backtest/format'

export default function BenchmarkComparison() {
  const dataset = useBacktest(s => s.dataset)
  const result = useBacktest(s => s.result)
  const symbol = useBacktest(s => s.benchmarkSymbol)
  const setSymbol = useBacktest(s => s.setBenchmarkSymbol)
  const [request, setRequest] = useState(null)
  const [retry, setRetry] = useState(0)
  const selected = BENCHMARKS.find(item => item.symbol === symbol) || BENCHMARKS[0]

  useEffect(() => {
    if (!dataset || !result) return
    const controller = new AbortController()
    setRequest({ result, symbol, loading: true })
    async function load() {
      try {
        const observations = dailyStrategy(dataset, result)
        const dates = [...observations.keys()].sort()
        if (dates.length < 2) throw new Error('Need at least two trading days with daily or near-close strategy marks.')
        const params = new URLSearchParams({ symbol, start: dates[0], end: dates.at(-1) })
        const response = await fetch(`/api/backtest/benchmark?${params}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`Benchmark history unavailable (${response.status}).`)
        const payload = await response.json()
        if (payload.symbol !== symbol) throw new Error('Benchmark symbol mismatch')
        const data = compareBenchmark(observations, payload)
        if (!controller.signal.aborted) setRequest({ result, symbol, data })
      } catch (error) {
        if (!controller.signal.aborted) setRequest({ result, symbol, error: error.message })
      }
    }
    load()
    return () => controller.abort()
  }, [dataset, result, symbol, retry])

  const current = request?.result === result && request?.symbol === symbol ? request : null
  const data = current?.data
  const chart = useMemo(() => {
    if (!data) return null
    const values = data.points.flatMap(point => [point.strategy, point.benchmark])
    const min = Math.min(...values, 1)
    const max = Math.max(...values, 1)
    const span = max - min || 0.01
    const start = Date.parse(data.dates[0])
    const duration = Date.parse(data.dates.at(-1)) - start
    const path = key => data.points.map((point, i) => `${i ? 'L' : 'M'}${4 + (Date.parse(point.date) - start) / duration * 292},${66 - (point[key] - min) / span * 60}`).join(' ')
    return { strategy: path('strategy'), benchmark: path('benchmark') }
  }, [data])

  return <div className="hair-b p-2 text-[10px]">
    <div className="flex items-center justify-between gap-2">
      <label htmlFor="buy-hold-benchmark" className="text-muted">Buy & hold benchmark</label>
      <select id="buy-hold-benchmark" value={symbol} onChange={e => setSymbol(e.target.value)} className="min-w-0 rounded border border-hair bg-panel-2 px-1 py-1 text-ink">
        {BENCHMARKS.map(item => <option key={item.symbol} value={item.symbol}>{item.label}</option>)}
      </select>
    </div>
    {!result ? <p className="mt-2 text-dim">Run a strategy to compare it with holding {selected.label}.</p>
      : current?.error ? <p role="status" className="mt-2 text-dim">{current.error} <button className="btn" onClick={() => setRetry(value => value + 1)}>Retry</button></p>
      : !data ? <p role="status" className="mt-2 text-dim">Loading benchmark…</p>
      : <>
        <svg viewBox="0 0 300 72" className="mt-2 h-[72px] w-full" role="img" aria-label={`Strategy versus holding ${selected.label}, both starting at 1`}>
          <path d={chart.strategy} fill="none" stroke="#E8B339" strokeWidth="1.5" />
          <path d={chart.benchmark} fill="none" stroke="#4A90A4" strokeWidth="1.5" strokeDasharray="4 3" />
        </svg>
        <table className="w-full font-mono text-[10px]">
          <thead className="text-dim"><tr><th className="text-left font-normal">Holding</th><th className="text-right font-normal">Return</th><th className="text-right font-normal">DD</th><th className="text-right font-normal">Sharpe</th></tr></thead>
          <tbody>{[['Strategy', data.strategy, 'text-amber'], [selected.label, data.benchmark, 'text-cyan']].map(([label, metrics, color]) =>
            <tr key={label}><td className={color}>{label}</td><td className={`text-right ${signClass(metrics.totalReturn)}`}>{fmtPct(metrics.totalReturn, 1)}</td><td className="text-right text-neg">{fmtPctAbs(metrics.maxDd)}</td><td className="text-right">{metrics.sharpe === null ? '—' : fmtSigned(metrics.sharpe)}</td></tr>
          )}</tbody>
        </table>
        <p className="mt-1 text-muted">Strategy minus benchmark: <span className={signClass(data.strategy.totalReturn - data.benchmark.totalReturn)}>{fmtSigned((data.strategy.totalReturn - data.benchmark.totalReturn) * 100)} pp</span></p>
        <p className="mt-1 text-dim">{data.dates[0]} → {data.dates.at(-1)} · {data.dates.length} common dates. Both rebased to 1 at the first observation.</p>
        {dataset.interval !== '1d' && <p className="mt-1 text-dim">Strategy uses its last available mark near 16:00 ET, which may precede the benchmark’s daily close.</p>}
      </>}
    <p className="mt-1 text-dim">Benchmark: adjusted closes, fully invested, no trading costs. {selected.currency} returns; no FX conversion. Strategy retains its configured costs.</p>
  </div>
}
