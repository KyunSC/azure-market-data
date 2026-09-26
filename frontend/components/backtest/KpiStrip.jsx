'use client'

import { useBacktest } from '../../lib/backtest/store'
import { signClass } from '../../lib/backtest/format'
import { Headline } from './MetricsPanel'

/**
 * Simple view's answer to "did it make money?": one row of the headline
 * numbers. The full MetricsPanel (and the honesty notes) live in Advanced.
 */
export default function KpiStrip() {
  const result = useBacktest((s) => s.result)
  const setAdvanced = useBacktest((s) => s.setAdvanced)

  const m = result?.metrics
  const bh = result?.buyHold
  const bhReturn = bh ? bh[result.windowEnd] / bh[result.windowStart] - 1 : NaN
  const vsHold = m ? m.totalReturn - bhReturn : NaN

  return (
    <div className="panel flex-row items-stretch">
      <div className="grid flex-1 grid-cols-3 gap-px bg-hair sm:grid-cols-6">
        <Cell>
          <Headline label="Total return" value={m ? m.totalReturn * 100 : NaN} suffix="%" tone={m && signClass(m.totalReturn)} />
        </Cell>
        <Cell>
          <Headline
            label="vs buy & hold"
            value={vsHold * 100}
            suffix="%"
            tone={signClass(vsHold)}
            title="Strategy total return minus holding the same symbol over the same window"
          />
        </Cell>
        <Cell>
          <Headline label="Sharpe" value={m ? m.sharpe : NaN} tone={m && signClass(m.sharpe)} title="Annualised, from per-bar returns" />
        </Cell>
        <Cell>
          <Headline label="Max drawdown" value={m ? m.maxDd * 100 : NaN} dp={1} suffix="%" tone={m ? 'text-neg' : undefined} />
        </Cell>
        <Cell>
          <Headline label="Win rate" value={m ? m.hitRate * 100 : NaN} dp={1} suffix="%" />
        </Cell>
        <Cell>
          <Headline label="Trades" value={m ? m.nTrades : NaN} dp={0} />
        </Cell>
      </div>
      <button
        onClick={() => setAdvanced(true)}
        className="hair-l shrink-0 px-3 font-mono text-[10px] tracking-[0.12em] text-dim uppercase hover:bg-panel-2 hover:text-ink"
        title="Open the advanced view with every metric, sweeps, walk-forward and Monte Carlo"
      >
        details ▸
      </button>
    </div>
  )
}

const Cell = ({ children }) => <div className="bg-panel">{children}</div>
