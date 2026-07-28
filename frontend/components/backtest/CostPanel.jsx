'use client'

import { useMemo } from 'react'
import { scaleLinear } from '@visx/scale'
import { LinePath } from '@visx/shape'
import { useBacktest } from '../../lib/backtest/store'
import { fmtSigned, fmtPct, signClass } from '../../lib/backtest/format'
import { EmptyState } from './Panel'
import useSize from './useSize'

const MARGIN = { top: 10, right: 14, bottom: 22, left: 34 }

/**
 * Sharpe against a slippage ladder.
 *
 * Intraday strategies die here more often than anywhere else in the terminal: a
 * 5m mean-reversion rule that trades 800 times can look excellent at 0 bp and be
 * worthless at 3. The break-even slippage — where the curve crosses zero — is
 * the number worth quoting next to any Sharpe on this page.
 */
export default function CostPanel() {
  const data = useBacktest((s) => s.costCurve)
  const runCostCurve = useBacktest((s) => s.runCostCurve)
  const costs = useBacktest((s) => s.costs)
  const setCosts = useBacktest((s) => s.setCosts)
  const result = useBacktest((s) => s.result)
  const [ref, { width, height }] = useSize()

  const geom = useMemo(() => {
    if (!data?.length || width < 60 || height < 60) return null
    const innerW = Math.max(20, width - MARGIN.left - MARGIN.right)
    const innerH = Math.max(20, height - MARGIN.top - MARGIN.bottom)
    const sharpes = data.map((d) => d.sharpe)
    const lo = Math.min(0, ...sharpes)
    const hi = Math.max(0, ...sharpes)
    const pad = (hi - lo) * 0.1 || 0.5
    return {
      innerW,
      innerH,
      x: scaleLinear({ domain: [data[0].slippageBps, data[data.length - 1].slippageBps], range: [0, innerW] }),
      y: scaleLinear({ domain: [lo - pad, hi + pad], range: [innerH, 0] }),
    }
  }, [data, width, height])

  // Slippage at which Sharpe crosses zero. `null` means the strategy never
  // cleared zero even at no cost — reporting "0.00 bp" there would read as a
  // knife-edge result rather than what it is: no edge to erode.
  const breakEven = useMemo(() => {
    if (!data?.length) return null
    if (data[0].sharpe <= 0) return null
    for (let i = 1; i < data.length; i++) {
      if (data[i - 1].sharpe > 0 && data[i].sharpe <= 0) {
        const a = data[i - 1]
        const b = data[i]
        const t = a.sharpe / (a.sharpe - b.sharpe)
        return a.slippageBps + t * (b.slippageBps - a.slippageBps)
      }
    }
    return Infinity
  }, [data])

  return (
    <div className="flex h-full flex-col">
      <div className="hair-b flex flex-wrap items-center gap-3 bg-panel-2 px-2 py-1.5 font-mono text-[10px] text-dim">
        <label className="flex flex-1 items-center gap-2">
          slippage
          <input
            type="range"
            min={0}
            max={12}
            step={0.25}
            value={costs.slippageBps}
            onChange={(e) => setCosts({ slippageBps: Number(e.target.value) })}
            className="h-[3px] max-w-[220px] flex-1 cursor-pointer appearance-none rounded bg-hair-bright accent-amber"
          />
          <span className="num w-10 text-ink">{costs.slippageBps.toFixed(2)}</span>
          bp
        </label>
        {result && (
          <span>
            live Sharpe <span className={`num ${signClass(result.metrics.sharpe)}`}>{fmtSigned(result.metrics.sharpe)}</span>
          </span>
        )}
        <button onClick={runCostCurve} className="btn">
          {data ? 'recompute ladder' : 'run cost ladder'}
        </button>
      </div>

      <div ref={ref} className="relative min-h-0 flex-1">
        {!data ? (
          <EmptyState>
            Re-run the same strategy across a slippage ladder. An edge that only exists at zero cost is
            not an edge.
          </EmptyState>
        ) : !geom ? null : (
          <svg width={width} height={height}>
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              <line x1={0} x2={geom.innerW} y1={geom.y(0)} y2={geom.y(0)} stroke="#2E343D" />
              <LinePath data={data} x={(d) => geom.x(d.slippageBps)} y={(d) => geom.y(d.sharpe)} stroke="#E8B339" strokeWidth={1.4} />
              {data.map((d) => (
                <circle
                  key={d.slippageBps}
                  cx={geom.x(d.slippageBps)}
                  cy={geom.y(d.sharpe)}
                  r={2}
                  fill={d.sharpe >= 0 ? '#4caf50' : '#ff6b6b'}
                />
              ))}
              <line
                x1={geom.x(Math.min(costs.slippageBps, data[data.length - 1].slippageBps))}
                x2={geom.x(Math.min(costs.slippageBps, data[data.length - 1].slippageBps))}
                y1={0}
                y2={geom.innerH}
                stroke="#4A90A4"
                strokeDasharray="2,3"
              />
              {[0, geom.innerH].map((yy, i) => (
                <text key={i} x={-6} y={i === 0 ? 8 : geom.innerH} textAnchor="end" fill="#5A616B" fontSize={9} fontFamily="var(--font-jetbrains-mono), monospace">
                  {i === 0 ? fmtSigned(geom.y.invert(0), 1) : fmtSigned(geom.y.invert(geom.innerH), 1)}
                </text>
              ))}
              {data.map((d, i) =>
                i % 2 === 0 ? (
                  <text
                    key={d.slippageBps}
                    x={geom.x(d.slippageBps)}
                    y={geom.innerH + 12}
                    textAnchor="middle"
                    fill="#5A616B"
                    fontSize={9}
                    fontFamily="var(--font-jetbrains-mono), monospace"
                  >
                    {d.slippageBps}
                  </text>
                ) : null,
              )}
              <text x={geom.innerW} y={geom.innerH + 12} textAnchor="end" fill="#5A616B" fontSize={9} fontFamily="var(--font-jetbrains-mono), monospace">
                bp
              </text>
            </g>
          </svg>
        )}
      </div>

      {data && (
        <div className="hair-t flex flex-wrap items-center gap-x-4 bg-panel-2 px-2 py-1 font-mono text-[10px] text-dim">
          <span>
            break-even slippage{' '}
            <span className={breakEven === null || breakEven < 2 ? 'text-neg' : breakEven === Infinity ? 'text-pos' : 'text-amber'}>
              {breakEven === null
                ? 'none — negative at 0 bp'
                : breakEven === Infinity
                  ? '> ladder'
                  : `${breakEven.toFixed(2)} bp`}
            </span>
          </span>
          <span>
            at 0 bp <span className={signClass(data[0].sharpe)}>{fmtSigned(data[0].sharpe)}</span> · at{' '}
            {data[data.length - 1].slippageBps} bp{' '}
            <span className={signClass(data[data.length - 1].sharpe)}>{fmtSigned(data[data.length - 1].sharpe)}</span>
          </span>
          <span>
            {data[0].nTrades} trades · {fmtPct(data[0].totalReturn)} gross-ish
          </span>
        </div>
      )}
    </div>
  )
}
