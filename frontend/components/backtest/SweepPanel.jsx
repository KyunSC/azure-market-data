'use client'

import { useMemo, useState } from 'react'
import { scaleLinear } from '@visx/scale'
import { useBacktest } from '../../lib/backtest/store'
import { getStrategy, sweepableParams } from '../../lib/backtest/strategies'
import { fmtSigned, fmtPct, fmtParam, signClass } from '../../lib/backtest/format'
import { Select } from './StrategyPanel'
import { EmptyState } from './Panel'
import useSize from './useSize'

const MARGIN = { top: 8, right: 12, bottom: 26, left: 42 }

/**
 * Two-parameter Sharpe surface.
 *
 * The number that matters here is not the best cell — it is the distance
 * between the best cell and the median one. A surface with one bright pixel in
 * a field of noise is a lottery ticket; a broad plateau is a parameter the
 * strategy is genuinely insensitive to. Both readings are printed under the
 * grid so the shape cannot be admired without the caveat.
 */
export default function SweepPanel() {
  const strategyId = useBacktest((s) => s.strategyId)
  const sweep = useBacktest((s) => s.sweep)
  const setSweepAxis = useBacktest((s) => s.setSweepAxis)
  const setSweepSteps = useBacktest((s) => s.setSweepSteps)
  const runSweep = useBacktest((s) => s.runSweep)
  const applySweepCell = useBacktest((s) => s.applySweepCell)
  const params = useBacktest((s) => s.paramsByStrategy[s.strategyId])
  const [ref, { width, height }] = useSize()
  const [hover, setHover] = useState(null)

  const numeric = sweepableParams(strategyId)
  const schema = getStrategy(strategyId).params

  const grid = useMemo(() => {
    const data = sweep.data
    if (!data || width < 80 || height < 80) return null
    const innerW = Math.max(20, width - MARGIN.left - MARGIN.right)
    const innerH = Math.max(20, height - MARGIN.top - MARGIN.bottom)
    const cw = innerW / data.xValues.length
    const ch = innerH / data.yValues.length
    // Diverging around zero, anchored on the larger tail so a single outlier
    // cannot make everything else look flat.
    const bound = Math.max(Math.abs(data.min), Math.abs(data.max), 0.5)
    const color = scaleLinear({ domain: [-bound, 0, bound], range: ['#ff6b6b', '#171A1F', '#4caf50'] })
    return { data, innerW, innerH, cw, ch, color, bound }
  }, [sweep.data, width, height])

  const current = { x: params?.[sweep.xKey], y: params?.[sweep.yKey] }

  return (
    <div className="flex h-full flex-col">
      <div className="hair-b flex flex-wrap items-center gap-2 bg-panel-2 px-2 py-1.5">
        <Axis label="x" value={sweep.xKey} options={numeric} onChange={(v) => setSweepAxis('xKey', v)} />
        <Axis label="y" value={sweep.yKey} options={numeric} onChange={(v) => setSweepAxis('yKey', v)} />
        <label className="flex items-center gap-1 font-mono text-[10px] text-dim">
          steps
          <input
            type="number"
            min={3}
            max={24}
            value={sweep.steps}
            onChange={(e) => setSweepSteps(Math.max(3, Math.min(24, Number(e.target.value))))}
            className="field !w-[42px] !px-1 !py-0.5 text-right"
          />
          <span className="text-dim">= {sweep.steps * sweep.steps} runs</span>
        </label>
        <button onClick={runSweep} disabled={sweep.running || numeric.length < 1} className="btn ml-auto">
          {sweep.running ? `sweeping ${(sweep.progress * 100).toFixed(0)}%` : 'run sweep'}
        </button>
      </div>

      {sweep.running && (
        <div className="h-[2px] w-full bg-hair">
          <div className="h-full bg-amber transition-[width] duration-150" style={{ width: `${sweep.progress * 100}%` }} />
        </div>
      )}

      <div ref={ref} className="relative min-h-0 flex-1">
        {sweep.error ? (
          <EmptyState>{sweep.error}</EmptyState>
        ) : !sweep.data ? (
          <EmptyState>
            Pick two parameters and sweep them. Each cell is one full backtest; the counter in the tape
            will jump by {sweep.steps * sweep.steps}.
          </EmptyState>
        ) : !grid ? null : (
          <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              {grid.data.cells.map((c) => {
                const isBest = grid.data.best && c.xi === grid.data.best.xi && c.yi === grid.data.best.yi
                const isCurrent = c.x === current.x && c.y === current.y
                return (
                  <rect
                    key={`${c.xi}-${c.yi}`}
                    x={c.xi * grid.cw}
                    y={grid.innerH - (c.yi + 1) * grid.ch}
                    width={Math.max(1, grid.cw - 1)}
                    height={Math.max(1, grid.ch - 1)}
                    fill={Number.isFinite(c.sharpe) ? grid.color(c.sharpe) : '#131519'}
                    stroke={isBest ? '#E8B339' : isCurrent ? '#4A90A4' : 'transparent'}
                    strokeWidth={isBest || isCurrent ? 1.5 : 0}
                    className="cursor-pointer"
                    onMouseEnter={() => setHover(c)}
                    onClick={() => applySweepCell(c)}
                  />
                )
              })}

              {grid.data.yValues.map((v, i) =>
                i % Math.ceil(grid.data.yValues.length / 6) === 0 ? (
                  <text
                    key={`y${i}`}
                    x={-6}
                    y={grid.innerH - (i + 0.5) * grid.ch}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill="#5A616B"
                    fontSize={9}
                    fontFamily="var(--font-jetbrains-mono), monospace"
                  >
                    {fmtParam(v)}
                  </text>
                ) : null,
              )}
              {grid.data.xValues.map((v, i) =>
                i % Math.ceil(grid.data.xValues.length / 6) === 0 ? (
                  <text
                    key={`x${i}`}
                    x={(i + 0.5) * grid.cw}
                    y={grid.innerH + 12}
                    textAnchor="middle"
                    fill="#5A616B"
                    fontSize={9}
                    fontFamily="var(--font-jetbrains-mono), monospace"
                  >
                    {fmtParam(v)}
                  </text>
                ) : null,
              )}
              <text x={grid.innerW / 2} y={grid.innerH + 24} textAnchor="middle" fill="#5A616B" fontSize={9} fontFamily="var(--font-jetbrains-mono), monospace">
                {labelFor(schema, grid.data.xKey)}
              </text>
              <text
                transform={`translate(${-34},${grid.innerH / 2}) rotate(-90)`}
                textAnchor="middle"
                fill="#5A616B"
                fontSize={9}
                fontFamily="var(--font-jetbrains-mono), monospace"
              >
                {labelFor(schema, grid.data.yKey)}
              </text>
            </g>
          </svg>
        )}

        {hover && (
          <div className="pointer-events-none absolute top-2 right-2 rounded-[2px] border border-hair bg-panel-3/95 px-2 py-1 font-mono text-[10px]">
            <div className="text-muted">
              {labelFor(schema, sweep.xKey)} <span className="text-ink">{fmtParam(hover.x)}</span> ·{' '}
              {labelFor(schema, sweep.yKey)} <span className="text-ink">{fmtParam(hover.y)}</span>
            </div>
            <div className={signClass(hover.sharpe)}>Sharpe {fmtSigned(hover.sharpe)}</div>
            <div className="text-dim">
              ret {fmtPct(hover.totalReturn)} · dd {(hover.maxDd * 100).toFixed(1)}% · {hover.nTrades} trades
            </div>
            <div className="text-dim">click to load</div>
          </div>
        )}
      </div>

      {sweep.data && (
        <div className="hair-t flex flex-wrap items-center gap-x-4 gap-y-1 bg-panel-2 px-2 py-1 font-mono text-[10px]">
          <span className="text-dim">
            best <span className={signClass(sweep.data.best?.sharpe)}>{fmtSigned(sweep.data.best?.sharpe)}</span>
          </span>
          <span className="text-dim">
            median <span className={signClass(sweep.data.median)}>{fmtSigned(sweep.data.median)}</span>
          </span>
          <span className="text-dim">
            iqr {fmtSigned(sweep.data.p25)} → {fmtSigned(sweep.data.p75)}
          </span>
          <span className="text-dim">{sweep.data.trials} trials</span>
          <span className="ml-auto max-w-[52ch] text-right leading-snug text-dim">
            Best-of-{sweep.data.trials} is a maximum, not an estimate. Quote the median unless the whole
            neighbourhood is green.
          </span>
        </div>
      )}
    </div>
  )
}

function Axis({ label, value, options, onChange }) {
  return (
    <label className="flex items-center gap-1 font-mono text-[10px] text-dim">
      {label}
      <div className="w-[124px]">
        <Select value={value || ''} onChange={onChange} options={options.map((p) => ({ value: p.key, label: p.label }))} />
      </div>
    </label>
  )
}

const labelFor = (schema, key) => schema.find((p) => p.key === key)?.label || key
