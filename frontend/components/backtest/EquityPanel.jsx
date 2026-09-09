'use client'

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { scaleLinear } from '@visx/scale'
import { LinePath, AreaClosed } from '@visx/shape'
import { LinearGradient } from '@visx/gradient'
import { AxisBottom, AxisLeft } from '@visx/axis'
import { useBacktest } from '../../lib/backtest/store'
import { fmtMoney, fmtPct, fmtDate, fmtTime } from '../../lib/backtest/format'
import Panel, { EmptyState } from './Panel'
import useSize from './useSize'

const MARGIN = { top: 6, right: 46, bottom: 16, left: 4 }
const DD_SHARE = 0.3

/**
 * Equity over the traded window, with the buy-and-hold ghost behind it and the
 * drawdown well underneath. Drawdown gets its own panel rather than a second
 * y-axis because the shape of the underwater periods is the part people skim
 * past when it is squeezed onto the same scale.
 */
export default function EquityPanel() {
  const result = useBacktest((s) => s.result)
  const dataset = useBacktest((s) => s.dataset)
  const wf = useBacktest((s) => s.wf.data)
  const [ref, { width, height }] = useSize()
  const [hover, setHover] = useState(null)

  const geom = useMemo(() => {
    if (!result || !dataset || width < 60 || height < 60) return null
    const start = result.windowStart
    const end = result.windowEnd
    const n = end - start + 1
    if (n < 2) return null

    const innerW = Math.max(10, width - MARGIN.left - MARGIN.right)
    const innerH = Math.max(10, height - MARGIN.top - MARGIN.bottom)
    const eqH = innerH * (1 - DD_SHARE) - 6
    const ddH = innerH * DD_SHARE

    // Downsample to roughly one point per pixel — a 3k-point path at 400px
    // wide is 2.5k wasted DOM coordinates.
    const stride = Math.max(1, Math.floor(n / Math.max(80, innerW)))
    const pts = []
    let lo = Infinity
    let hi = -Infinity
    for (let i = start; i <= end; i += stride) {
      const e = result.equity[i]
      const b = result.buyHold[i]
      lo = Math.min(lo, e, b)
      hi = Math.max(hi, e, b)
      pts.push({ i, e, b, dd: result.metrics.ddCurve[i - start] ?? 0 })
    }
    if (pts[pts.length - 1].i !== end) {
      pts.push({ i: end, e: result.equity[end], b: result.buyHold[end], dd: result.metrics.ddCurve[end - start] ?? 0 })
    }

    const x = scaleLinear({ domain: [start, end], range: [0, innerW] })
    const pad = (hi - lo) * 0.06 || 1
    const y = scaleLinear({ domain: [lo - pad, hi + pad], range: [eqH, 0] })
    const yDd = scaleLinear({ domain: [Math.min(-0.0001, -result.metrics.maxDd * 1.05), 0], range: [ddH, 0] })

    const stitched = wf?.stitched
      ? pts.map((p) => ({ i: p.i, v: wf.stitched[p.i] })).filter((p) => Number.isFinite(p.v))
      : null

    return { pts, x, y, yDd, innerW, innerH, eqH, ddH, start, end, stitched }
  }, [result, dataset, width, height, wf])

  const onMove = (e) => {
    if (!geom) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left - MARGIN.left
    const idx = Math.round(geom.x.invert(Math.max(0, Math.min(geom.innerW, px))))
    const p = geom.pts.reduce((a, b) => (Math.abs(b.i - idx) < Math.abs(a.i - idx) ? b : a), geom.pts[0])
    setHover(p)
  }

  return (
    <Panel
      label="equity + drawdown"
      right={
        result ? (
          <span className="flex items-center gap-2 text-[9px]">
            <Legend color="#E8B339" label="strategy" />
            <Legend color="#5A616B" label={`${dataset?.symbol} hold`} dashed />
            {geom?.stitched && <Legend color="#7C6BD6" label="wf oos" />}
          </span>
        ) : null
      }
      className="h-full"
      scroll={false}
      delay={0.08}
    >
      <div ref={ref} className="relative h-full w-full">
        {!result ? (
          <EmptyState>Run a strategy to draw its equity curve.</EmptyState>
        ) : !geom ? null : (
          <>
            <svg
              width={width}
              height={height}
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
              className="cursor-crosshair"
            >
              <LinearGradient id="bt-eq-fill" from="#E8B339" fromOpacity={0.16} to="#E8B339" toOpacity={0} />
              <LinearGradient id="bt-dd-fill" from="#ff6b6b" fromOpacity={0.06} to="#ff6b6b" toOpacity={0.28} />

              <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
                {/* equity */}
                <AreaClosed
                  data={geom.pts}
                  x={(d) => geom.x(d.i)}
                  y={(d) => geom.y(d.e)}
                  yScale={geom.y}
                  fill="url(#bt-eq-fill)"
                  stroke="none"
                />
                <LinePath
                  data={geom.pts}
                  x={(d) => geom.x(d.i)}
                  y={(d) => geom.y(d.b)}
                  stroke="#5A616B"
                  strokeWidth={1}
                  strokeDasharray="3,3"
                />
                {geom.stitched && (
                  <LinePath
                    data={geom.stitched}
                    x={(d) => geom.x(d.i)}
                    y={(d) => geom.y(d.v)}
                    stroke="#7C6BD6"
                    strokeWidth={1.25}
                    strokeOpacity={0.9}
                  />
                )}
                <LinePath data={geom.pts} x={(d) => geom.x(d.i)} y={(d) => geom.y(d.e)}>
                  {({ path }) => (
                    <motion.path
                      key={`${result.config.strategyId}-${result.metrics.finalEquity.toFixed(2)}`}
                      d={path(geom.pts) || ''}
                      fill="none"
                      stroke="#E8B339"
                      strokeWidth={1.4}
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.7, ease: 'easeOut' }}
                    />
                  )}
                </LinePath>
                <line x1={0} x2={geom.innerW} y1={geom.y(result.config.costs.initialCapital)} y2={geom.y(result.config.costs.initialCapital)} stroke="#2E343D" strokeWidth={1} />
                <AxisLeft
                  scale={geom.y}
                  left={geom.innerW}
                  numTicks={3}
                  hideAxisLine
                  hideTicks
                  tickLabelProps={() => ({
                    fill: '#5A616B',
                    fontSize: 9,
                    fontFamily: 'var(--font-jetbrains-mono), monospace',
                    dx: 4,
                    textAnchor: 'start',
                  })}
                  tickFormat={(v) => `${(v / 1000).toFixed(0)}k`}
                />

                {/* drawdown */}
                <g transform={`translate(0,${geom.eqH + 6})`}>
                  <AreaClosed
                    data={geom.pts}
                    x={(d) => geom.x(d.i)}
                    y={(d) => geom.yDd(d.dd)}
                    yScale={geom.yDd}
                    fill="url(#bt-dd-fill)"
                    stroke="#ff6b6b"
                    strokeWidth={0.75}
                    strokeOpacity={0.55}
                  />
                  <AxisLeft
                    scale={geom.yDd}
                    left={geom.innerW}
                    numTicks={2}
                    hideAxisLine
                    hideTicks
                    tickLabelProps={() => ({
                      fill: '#5A616B',
                      fontSize: 9,
                      fontFamily: 'var(--font-jetbrains-mono), monospace',
                      dx: 4,
                      textAnchor: 'start',
                    })}
                    tickFormat={(v) => `${(v * 100).toFixed(0)}%`}
                  />
                </g>

                <AxisBottom
                  top={geom.innerH}
                  scale={geom.x}
                  numTicks={Math.max(2, Math.floor(geom.innerW / 110))}
                  stroke="#22262D"
                  tickStroke="#22262D"
                  tickLabelProps={() => ({
                    fill: '#5A616B',
                    fontSize: 9,
                    fontFamily: 'var(--font-jetbrains-mono), monospace',
                    textAnchor: 'middle',
                  })}
                  tickFormat={(v) => fmtDate(dataset.time[Math.round(v)])}
                />

                {hover && (
                  <line
                    x1={geom.x(hover.i)}
                    x2={geom.x(hover.i)}
                    y1={0}
                    y2={geom.innerH}
                    stroke="#4A90A4"
                    strokeWidth={1}
                    strokeDasharray="2,3"
                  />
                )}
              </g>
            </svg>

            {hover && (
              <div className="pointer-events-none absolute top-1 left-1 rounded-[2px] border border-hair bg-panel-3/95 px-2 py-1 font-mono text-[10px]">
                <div className="text-dim">{fmtTime(dataset.time[hover.i])}</div>
                <div className="text-amber">{fmtMoney(hover.e)}</div>
                <div className="text-dim">
                  b&h {fmtMoney(hover.b)} · dd <span className="text-neg">{fmtPct(hover.dd)}</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  )
}

function Legend({ color, label, dashed }) {
  return (
    <span className="flex items-center gap-1 text-dim">
      <svg width="12" height="4">
        <line x1="0" y1="2" x2="12" y2="2" stroke={color} strokeWidth="1.5" strokeDasharray={dashed ? '3,2' : undefined} />
      </svg>
      {label}
    </span>
  )
}
