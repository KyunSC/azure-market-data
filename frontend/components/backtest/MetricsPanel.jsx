'use client'

import { useEffect, useRef, useState } from 'react'
import { animate } from 'framer-motion'
import { useBacktest } from '../../lib/backtest/store'
import { fmtSigned, fmtPct, fmtPctAbs, fmtRatio, fmtMoney, signClass } from '../../lib/backtest/format'
import Panel, { EmptyState } from './Panel'

/** Metric values count from their previous reading to the new one, so a
 *  parameter nudge shows you the direction it moved rather than a hard swap. */
function useCountUp(value, dp = 2) {
  const [display, setDisplay] = useState(Number.isFinite(value) ? value : 0)
  const prev = useRef(Number.isFinite(value) ? value : 0)

  useEffect(() => {
    if (!Number.isFinite(value)) {
      setDisplay(value)
      return
    }
    const controls = animate(prev.current, value, {
      duration: 0.35,
      ease: 'easeOut',
      onUpdate: (v) => setDisplay(v),
    })
    prev.current = value
    return () => controls.stop()
  }, [value])

  return Number.isFinite(display) ? display.toFixed(dp) : '—'
}

function Headline({ label, value, dp = 2, tone, suffix = '', title }) {
  const shown = useCountUp(value, dp)
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1.5" title={title}>
      <span className="font-mono text-[9px] tracking-[0.14em] text-dim uppercase">{label}</span>
      <span className={`num text-[17px] leading-none ${tone || 'text-ink'}`}>
        {shown === '—' ? '—' : `${shown}${suffix}`}
      </span>
    </div>
  )
}

function Row({ label, value, tone, title }) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-2 py-[3px]" title={title}>
      <span className="font-mono text-[10px] text-dim">{label}</span>
      <span className={`num text-[11px] ${tone || 'text-muted'}`}>{value}</span>
    </div>
  )
}

export default function MetricsPanel() {
  const result = useBacktest((s) => s.result)
  const dataset = useBacktest((s) => s.dataset)
  const strategyId = useBacktest((s) => s.strategyId)
  const sweep = useBacktest((s) => s.sweep.data)
  const runCount = useBacktest((s) => s.runCount)

  if (!result) {
    return (
      <Panel label="metrics" className="h-full" delay={0.06}>
        <EmptyState>No run yet. Press R or hit ▸ RUN.</EmptyState>
      </Panel>
    )
  }

  const m = result.metrics
  const isOos = strategyId === 'mlSignal' && dataset?.ml
  const bh = result.buyHold
  const bhReturn = bh ? bh[result.windowEnd] / bh[result.windowStart] - 1 : null

  return (
    <Panel
      label="metrics"
      right={
        isOos ? (
          <span className="rounded-[2px] border border-pos/40 px-1 text-[9px] text-pos">OOS</span>
        ) : (
          <span className="text-[9px] text-dim">in-sample</span>
        )
      }
      className="h-full"
      delay={0.06}
    >
      <div className="grid grid-cols-2 gap-px bg-hair">
        <div className="bg-panel">
          <Headline
            label="Sharpe"
            value={m.sharpe}
            tone={signClass(m.sharpe)}
            title="Annualised, from per-bar returns"
          />
        </div>
        <div className="bg-panel">
          <Headline label="Sortino" value={m.sortino} tone={signClass(m.sortino)} />
        </div>
        <div className="bg-panel">
          <Headline label="Max DD" value={m.maxDd * 100} dp={1} suffix="%" tone="text-neg" title={`Longest underwater stretch: ${m.maxDdDuration} bars`} />
        </div>
        <div className="bg-panel">
          <Headline label="Hit rate" value={m.hitRate * 100} dp={1} suffix="%" />
        </div>
        <div className="bg-panel">
          <Headline label="Profit factor" value={Number.isFinite(m.profitFactor) ? m.profitFactor : 0} tone={m.profitFactor >= 1 ? 'text-pos' : 'text-neg'} />
        </div>
        <div className="bg-panel">
          <Headline label="Trades" value={m.nTrades} dp={0} />
        </div>
      </div>

      <div className="hair-t py-1">
        <Row label="Total return" value={fmtPct(m.totalReturn)} tone={signClass(m.totalReturn)} />
        <Row label="Buy & hold" value={bhReturn === null ? '—' : fmtPct(bhReturn)} tone="text-dim" />
        <Row label="CAGR" value={fmtPct(m.cagr)} tone={signClass(m.cagr)} />
        <Row label="Final equity" value={fmtMoney(m.finalEquity)} />
        <Row label="Ann. vol" value={fmtPctAbs(m.volAnn)} />
        <Row label="Calmar" value={fmtRatio(m.calmar)} />
        <Row label="Expectancy / trade" value={fmtMoney(m.expectancy, 2)} tone={signClass(m.expectancy)} />
        <Row label="Avg win / loss" value={`${fmtMoney(m.avgWin, 0)} / ${fmtMoney(m.avgLoss, 0)}`} />
        <Row label="Exposure" value={fmtPctAbs(m.exposure)} title="Share of bars holding a position" />
        <Row label="Turnover / yr" value={m.turnover.toFixed(0)} />
        <Row label="Avg bars held" value={m.avgBarsHeld.toFixed(1)} />
        <Row label="DD duration" value={`${m.maxDdDuration} bars`} />
      </div>

      <div className="hair-t bg-panel-2 p-2">
        <p className="font-mono text-[9px] tracking-[0.12em] text-dim uppercase">honesty</p>
        <div className="mt-1 flex flex-col gap-1 text-[10px] leading-snug text-dim">
          {sweep ? (
            <p>
              Sweep best Sharpe <span className={`num ${signClass(sweep.best?.sharpe)}`}>{fmtSigned(sweep.best?.sharpe)}</span> vs
              median <span className={`num ${signClass(sweep.median)}`}>{fmtSigned(sweep.median)}</span> over{' '}
              <span className="num">{sweep.trials}</span> combinations. The median is the honest estimate;
              the best cell is the maximum of {sweep.trials} draws.
            </p>
          ) : (
            <p>Run a sweep to see how much of this number is parameter luck.</p>
          )}
          <p>
            <span className="num">{runCount.toLocaleString()}</span> simulation{runCount === 1 ? '' : 's'} this session.
            {runCount > 80 && ' At this count, treat a single good Sharpe as a hypothesis to test elsewhere.'}
          </p>
          {isOos && (
            <p className="text-pos/80">
              ML positions are taken only on walk-forward out-of-sample bars — the training stretches
              produce no trades.
            </p>
          )}
        </div>
      </div>
    </Panel>
  )
}
