'use client'

import { useMemo } from 'react'
import { scaleLinear } from '@visx/scale'
import { LinePath, AreaClosed } from '@visx/shape'
import { useBacktest } from '../../lib/backtest/store'
import { fmtPct, fmtPctAbs } from '../../lib/backtest/format'
import { EmptyState } from './Panel'
import useSize from './useSize'

const MARGIN = { top: 8, right: 42, bottom: 18, left: 6 }

/**
 * Block bootstrap of the realised trade sequence.
 *
 * Blocks, not individual trades: consecutive trades in a trend strategy are
 * correlated, and resampling them independently produces a confidence band that
 * is far too tight. The block size is exposed because it is an assumption, not
 * a constant — the ML README's IC intervals make the same choice at ~1 trading
 * day of bars.
 */
export default function MonteCarloPanel() {
  const mc = useBacktest((s) => s.mc)
  const result = useBacktest((s) => s.result)
  const runMonteCarlo = useBacktest((s) => s.runMonteCarlo)
  const setMcOption = useBacktest((s) => s.setMcOption)
  const [ref, { width, height }] = useSize()

  const geom = useMemo(() => {
    const d = mc.data
    if (!d || width < 80 || height < 60) return null
    const innerW = Math.max(20, width - MARGIN.left - MARGIN.right)
    const innerH = Math.max(20, height - MARGIN.top - MARGIN.bottom)
    const steps = d.fan.steps
    const lo = Math.min(...d.fan.bands[0])
    const hi = Math.max(...d.fan.bands[d.fan.bands.length - 1], d.observedFinal)
    const x = scaleLinear({ domain: [0, steps - 1], range: [0, innerW] })
    const y = scaleLinear({ domain: [lo * 0.98, hi * 1.02], range: [innerH, 0] })

    const stride = Math.max(1, Math.floor(steps / Math.max(60, innerW)))
    const idx = []
    for (let i = 0; i < steps; i += stride) idx.push(i)
    if (idx[idx.length - 1] !== steps - 1) idx.push(steps - 1)

    const band = (loI, hiI) => idx.map((i) => ({ i, lo: d.fan.bands[loI][i], hi: d.fan.bands[hiI][i] }))
    return {
      x, y, innerW, innerH, idx,
      outer: band(0, 4),
      inner: band(1, 3),
      median: idx.map((i) => ({ i, v: d.fan.bands[2][i] })),
      observed: d.observedFinal,
      steps,
    }
  }, [mc.data, width, height])

  return (
    <div className="flex h-full flex-col">
      <div className="hair-b flex flex-wrap items-center gap-3 bg-panel-2 px-2 py-1.5 font-mono text-[10px] text-dim">
        <label className="flex items-center gap-1">
          block
          <input
            type="number"
            min={1}
            max={50}
            value={mc.blockSize}
            onChange={(e) => setMcOption({ blockSize: Math.max(1, Math.min(50, Number(e.target.value))) })}
            className="field !w-[42px] !px-1 !py-0.5 text-right"
          />
          trades
        </label>
        <label className="flex items-center gap-1">
          paths
          <input
            type="number"
            min={100}
            max={5000}
            step={100}
            value={mc.paths}
            onChange={(e) => setMcOption({ paths: Math.max(100, Math.min(5000, Number(e.target.value))) })}
            className="field !w-[56px] !px-1 !py-0.5 text-right"
          />
        </label>
        <button onClick={runMonteCarlo} disabled={mc.running || !result?.trades?.length} className="btn ml-auto">
          {mc.running ? 'resampling…' : 'run monte carlo'}
        </button>
      </div>

      <div ref={ref} className="relative min-h-0 flex-1">
        {mc.error ? (
          <EmptyState>{mc.error}</EmptyState>
        ) : !mc.data ? (
          <EmptyState>
            Resample the realised trade sequence in blocks to see how much of the equity curve was
            ordering luck. 5/25/50/75/95 percentile fan.
          </EmptyState>
        ) : !geom ? null : (
          <svg width={width} height={height}>
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              <AreaClosed
                data={geom.outer}
                x={(d) => geom.x(d.i)}
                y0={(d) => geom.y(d.lo)}
                y1={(d) => geom.y(d.hi)}
                yScale={geom.y}
                fill="#E8B339"
                fillOpacity={0.1}
                stroke="none"
              />
              <AreaClosed
                data={geom.inner}
                x={(d) => geom.x(d.i)}
                y0={(d) => geom.y(d.lo)}
                y1={(d) => geom.y(d.hi)}
                yScale={geom.y}
                fill="#E8B339"
                fillOpacity={0.18}
                stroke="none"
              />
              <LinePath data={geom.median} x={(d) => geom.x(d.i)} y={(d) => geom.y(d.v)} stroke="#E8B339" strokeWidth={1.3} />
              <line x1={0} x2={geom.innerW} y1={geom.y(1)} y2={geom.y(1)} stroke="#2E343D" strokeDasharray="3,3" />
              <line
                x1={0}
                x2={geom.innerW}
                y1={geom.y(geom.observed)}
                y2={geom.y(geom.observed)}
                stroke="#4A90A4"
                strokeWidth={1}
                strokeDasharray="4,2"
              />
              <text
                x={geom.innerW + 4}
                y={geom.y(geom.observed)}
                fill="#4A90A4"
                fontSize={9}
                dominantBaseline="middle"
                fontFamily="var(--font-jetbrains-mono), monospace"
              >
                actual
              </text>
              <text x={0} y={geom.innerH + 12} fill="#5A616B" fontSize={9} fontFamily="var(--font-jetbrains-mono), monospace">
                trade 0
              </text>
              <text
                x={geom.innerW}
                y={geom.innerH + 12}
                textAnchor="end"
                fill="#5A616B"
                fontSize={9}
                fontFamily="var(--font-jetbrains-mono), monospace"
              >
                trade {geom.steps - 1}
              </text>
            </g>
          </svg>
        )}
      </div>

      {mc.data && (
        <div className="hair-t grid grid-cols-2 gap-x-4 gap-y-0.5 bg-panel-2 px-2 py-1.5 font-mono text-[10px] sm:grid-cols-3">
          <Stat label="median final" value={fmtPct(mc.data.finalP50 - 1)} />
          <Stat label="5th → 95th" value={`${fmtPct(mc.data.finalP05 - 1)} → ${fmtPct(mc.data.finalP95 - 1)}`} />
          <Stat label="actual" value={fmtPct(mc.data.observedFinal - 1)} tone="text-cyan" />
          <Stat label="P(loss)" value={fmtPctAbs(mc.data.probLoss)} tone={mc.data.probLoss > 0.3 ? 'text-neg' : 'text-muted'} />
          <Stat label="median max DD" value={fmtPctAbs(mc.data.ddP50)} />
          <Stat label="95th max DD" value={fmtPctAbs(mc.data.ddP95)} tone="text-neg" />
          <p className="col-span-full mt-1 leading-snug text-dim">
            {mc.data.paths.toLocaleString()} paths, blocks of {mc.data.blockSize} trades over{' '}
            {mc.data.nTrades} realised trades. If the actual line sits near the top of the fan, the
            observed run was a good draw rather than a typical one.
          </p>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone }) {
  return (
    <span className="flex items-baseline justify-between gap-2">
      <span className="text-dim">{label}</span>
      <span className={`num ${tone || 'text-ink'}`}>{value}</span>
    </span>
  )
}
