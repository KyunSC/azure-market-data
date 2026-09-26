'use client'

import { useMemo, useState } from 'react'
import { scaleLinear } from '@visx/scale'
import { useBacktest } from '../../lib/backtest/store'
import { fmtMoney, fmtMoneySigned, fmtPctAbs, fmtDate, signClass } from '../../lib/backtest/format'
import { EmptyState } from './Panel'
import useSize from './useSize'

const MARGIN = { top: 8, right: 10, bottom: 18, left: 10 }
const BINS = 24

const OUTCOMES = [
  { id: 'failed', label: 'eval failed', tone: 'text-neg' },
  { id: 'eval-open', label: 'eval unfinished', tone: 'text-dim', title: 'Data ran out mid-evaluation — excluded from every rate' },
  { id: 'funded-breached', label: 'funded, breached', tone: 'text-amber' },
  { id: 'funded-open', label: 'funded, data ended', tone: 'text-muted', title: 'Payouts so far are a lower bound' },
  { id: 'graduated', label: 'moved to live', tone: 'text-pos', title: 'Hit the payout count that moves the account to live — not simulated further' },
]

/**
 * Prop-account economics for the current run.
 *
 * The headline is EV per purchase — expected trader take after the split, minus
 * the fee — shown beside what the same contracts made on your own capital over
 * the same days. A strategy can lose money in cash and still be worth buying
 * accounts for: the fee is the most a failed evaluation can cost, while a good
 * week still pays out.
 */
export default function PropPanel() {
  const prop = useBacktest((s) => s.prop)
  const setProp = useBacktest((s) => s.setProp)
  const result = useBacktest((s) => s.result)
  const running = useBacktest((s) => s.running)
  const [source, setSource] = useState('bootstrap')

  if (!prop.enabled) {
    return (
      <EmptyState action={<button className="btn" onClick={() => setProp({ enabled: true })}>switch to prop firm</button>}>
        Prop mode trades NQ/ES futures under Lucid Trading&apos;s rules and prices each account, so you can see
        whether a strategy pays as a funded account even when it doesn&apos;t on your own capital.
      </EmptyState>
    )
  }
  const pr = result?.prop
  if (!pr) return <EmptyState>{running ? 'Simulating accounts…' : 'Run the strategy to simulate prop accounts.'}</EmptyState>

  const plan = pr.plan
  const s = source === 'bootstrap' && pr.bootstrap ? pr.bootstrap : pr.historical
  const inst = result.config?.costs?.instrument

  return (
    <div className="flex h-full flex-col">
      <div className="hair-b flex flex-wrap items-center gap-3 bg-panel-2 px-2 py-1.5 font-mono text-[10px] text-dim">
        <span className="text-muted">
          {plan.planLabel} {plan.sizeLabel} · {fmtMoney(s.cost)}
          {inst && <> · {inst.contracts} × {inst.contract}</>}
        </span>
        <span className="flex-1" />
        <div className="flex gap-1">
          {['bootstrap', 'historical'].map((id) => (
            <button key={id} onClick={() => setSource(id)} disabled={id === 'bootstrap' && !pr.bootstrap} className={`btn !px-2 !py-0.5 ${source === id ? 'btn-active' : ''}`}>
              {id}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid grid-cols-2 gap-px bg-hair sm:grid-cols-4">
          <Tile label="EV / purchase" value={fmtMoneySigned(s.ev)} tone={signClass(s.ev)} title={`Mean trader take ${fmtMoney(s.meanTake)} − ${fmtMoney(s.cost)} fee. 5–95%: ${fmtMoneySigned(s.evP05)} to ${fmtMoneySigned(s.evP95)}`} />
          <Tile label={plan.hasEval ? 'Pass rate' : 'Evaluation'} value={plan.hasEval ? fmtPctAbs(s.passRate) : 'none'} sub={plan.hasEval && Number.isFinite(s.medianDaysToPass) ? `median ${s.medianDaysToPass.toFixed(0)} days` : null} />
          <Tile label="P(any payout)" value={fmtPctAbs(s.pPayout)} sub={`${s.meanPayouts?.toFixed(2) ?? '—'} payouts avg`} />
          <Tile label="Cost / funded acct" value={Number.isFinite(s.costPerFunded) ? fmtMoney(s.costPerFunded) : '∞'} sub={plan.hasEval ? 'fee ÷ pass rate' : 'fee'} />
        </div>

        <div className="hair-t grid grid-cols-1 gap-px bg-hair sm:grid-cols-2">
          <div className="bg-panel px-2 py-1.5">
            <p className="font-mono text-[9px] tracking-[0.14em] text-dim uppercase">own capital · same contracts, same days</p>
            <p className={`num text-[14px] ${signClass(pr.historical.meanCashPnl)}`}>
              {fmtMoneySigned(pr.historical.meanCashPnl)} <span className="text-[10px] text-dim">avg per historical attempt window</span>
            </p>
            <p className="text-[10px] text-dim">
              Whole run: <span className={signClass(pr.cashPnl)}>{fmtMoneySigned(pr.cashPnl)}</span> over {pr.days} days ({pr.activeDays} traded)
            </p>
          </div>
          <div className="bg-panel px-2 py-1.5">
            <p className="font-mono text-[9px] tracking-[0.14em] text-dim uppercase">as a prop account</p>
            <p className={`num text-[14px] ${signClass(pr.historical.ev)}`}>
              {fmtMoneySigned(pr.historical.ev)} <span className="text-[10px] text-dim">net per purchase, historical starts</span>
            </p>
            <p className="text-[10px] text-dim">{verdict(pr)}</p>
          </div>
        </div>

        <div className="hair-t flex flex-wrap gap-x-3 gap-y-0.5 px-2 py-1.5 font-mono text-[10px]">
          {OUTCOMES.map((o) => (
            <span key={o.id} className={o.tone} title={o.title}>
              {o.label} <span className="num">{s.outcomes[o.id] || 0}</span>
            </span>
          ))}
          <span className="text-dim" title="Share of simulated days that hit the daily loss limit">
            DLL days <span className="num">{fmtPctAbs(s.dllHitRate)}</span>
          </span>
        </div>

        <NetHistogram nets={s.nets} cost={s.cost} />

        <div className="hair-t bg-panel-2 p-2 text-[10px] leading-snug text-dim">
          <p className="font-mono text-[9px] tracking-[0.12em] uppercase">honesty</p>
          <p className="mt-1">
            {source === 'bootstrap' && pr.bootstrap
              ? `${pr.bootstrap.paths} purchases on ${pr.bootstrap.blockSize}-day blocks resampled from ${pr.days} days, up to ${pr.bootstrap.horizon} days each. Only as good as the days it resamples.`
              : `${pr.historical.attempts} purchases, one per session start. Neighbouring starts share almost every day, so these are far from independent.`}
            {s.censored > 0 && ` ${s.censored} ran out of data mid-evaluation and are excluded.`}
            {s.fundedOpen > 0 && ` ${s.fundedOpen} were still funded when data ended — their payouts are a lower bound.`}
          </p>
          <p className="mt-1">
            Rules are replayed on bar extremes: a bar that touches a limit is assumed to hit it, and within a bar the
            high comes before the low. News and the 5-second hold rule are not modelled.
            {inst?.priceScale !== 1 && ` Futures are priced from ETF bars × ${inst?.priceScale} — a proxy that ignores basis and rolls.`}
            {plan.overridden?.length > 0 && ` Edited rules: ${plan.overridden.join(', ')}.`}
          </p>
        </div>

        {pr.historical.list && <AttemptTable list={pr.historical.list} cost={s.cost} />}
      </div>
    </div>
  )
}

function verdict(pr) {
  const cash = pr.historical.meanCashPnl
  const ev = pr.historical.ev
  if (!Number.isFinite(ev)) return 'Not enough resolved attempts to judge.'
  if (ev > 0 && cash <= 0) return 'Prop-only edge: the fee caps the losing paths while the winners still pay out.'
  if (ev > 0 && cash > 0) return 'Profitable both ways — compare the numbers for which uses capital better.'
  if (ev <= 0 && cash > 0) return 'Works on your own capital but the rules or payout caps eat it as a prop account.'
  return 'Loses both ways.'
}

function Tile({ label, value, tone, sub, title }) {
  return (
    <div className="flex flex-col gap-0.5 bg-panel px-2 py-1.5" title={title}>
      <span className="font-mono text-[9px] tracking-[0.14em] text-dim uppercase">{label}</span>
      <span className={`num text-[17px] leading-none ${tone || 'text-ink'}`}>{value}</span>
      {sub && <span className="text-[10px] text-dim">{sub}</span>}
    </div>
  )
}

/** Net $ per purchase. Losses bottom out at −fee, which is the whole point. */
function NetHistogram({ nets, cost }) {
  const [ref, { width }] = useSize()
  const [hover, setHover] = useState(null)
  const height = 120

  const geom = useMemo(() => {
    if (!nets?.length || width < 80) return null
    const lo = nets[0]
    const hi = Math.max(nets[nets.length - 1], lo + 1)
    const w = (hi - lo) / BINS
    const bins = Array.from({ length: BINS }, (_, b) => ({ b, from: lo + b * w, to: lo + (b + 1) * w, n: 0 }))
    for (const v of nets) bins[Math.min(BINS - 1, Math.floor((v - lo) / w))].n++
    const innerW = width - MARGIN.left - MARGIN.right
    const innerH = height - MARGIN.top - MARGIN.bottom
    const x = scaleLinear({ domain: [lo, hi], range: [0, innerW] })
    const y = scaleLinear({ domain: [0, Math.max(...bins.map((b) => b.n))], range: [innerH, 0] })
    return { bins, x, y, innerW, innerH, lo, hi }
  }, [nets, width])

  return (
    <div className="hair-t px-2 py-1.5">
      <p className="font-mono text-[9px] tracking-[0.14em] text-dim uppercase">net $ per purchase (take − {fmtMoney(cost)} fee)</p>
      <div ref={ref} className="relative" style={{ height }}>
        {geom && (
          <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              {geom.bins.map((b) => {
                const x0 = geom.x(b.from) + 1
                const w = Math.max(1, geom.x(b.to) - geom.x(b.from) - 2)
                const h = geom.innerH - geom.y(b.n)
                const mid = (b.from + b.to) / 2
                return (
                  <g key={b.b} onMouseEnter={() => setHover(b)}>
                    <rect x={x0 - 1} y={0} width={w + 2} height={geom.innerH} fill="transparent" />
                    {b.n > 0 && (
                      <rect x={x0} y={geom.y(b.n)} width={w} height={h} rx={Math.min(2, w / 2)} fill={mid >= 0 ? '#4caf50' : '#ff6b6b'} opacity={hover && hover.b !== b.b ? 0.45 : 0.85} />
                    )}
                  </g>
                )
              })}
              {geom.lo < 0 && geom.hi > 0 && (
                <line x1={geom.x(0)} x2={geom.x(0)} y1={0} y2={geom.innerH} stroke="#5A616B" strokeDasharray="2,3" />
              )}
              <line x1={0} x2={geom.innerW} y1={geom.innerH} y2={geom.innerH} stroke="#2E343D" />
              {[geom.lo, geom.hi].map((v, i) => (
                <text key={i} x={i ? geom.innerW : 0} y={geom.innerH + 12} textAnchor={i ? 'end' : 'start'} fill="#5A616B" fontSize={9} fontFamily="var(--font-jetbrains-mono), monospace">
                  {fmtMoneySigned(v)}
                </text>
              ))}
            </g>
          </svg>
        )}
        {hover && geom && (
          <div
            className="pointer-events-none absolute top-1 rounded-[2px] border border-hair-bright bg-panel px-1.5 py-1 font-mono text-[10px] text-muted"
            style={{ left: Math.min(width - 150, Math.max(0, MARGIN.left + geom.x(hover.from))) }}
          >
            <div className="text-ink">{fmtMoneySigned(hover.from)} to {fmtMoneySigned(hover.to)}</div>
            <div>
              {hover.n} purchase{hover.n === 1 ? '' : 's'} · {fmtPctAbs(hover.n / nets.length)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function AttemptTable({ list, cost }) {
  return (
    <div className="hair-t">
      <p className="px-2 pt-1.5 font-mono text-[9px] tracking-[0.14em] text-dim uppercase">historical purchases</p>
      <table className="w-full font-mono text-[10px]">
        <thead className="text-dim">
          <tr className="text-left">
            <th className="px-2 py-1 font-normal">start</th>
            <th className="px-2 py-1 font-normal">outcome</th>
            <th className="px-2 py-1 text-right font-normal">eval d</th>
            <th className="px-2 py-1 text-right font-normal">funded d</th>
            <th className="px-2 py-1 text-right font-normal">payouts</th>
            <th className="px-2 py-1 text-right font-normal">net</th>
            <th className="px-2 py-1 text-right font-normal" title="Same contracts on your own capital over the same days">cash</th>
          </tr>
        </thead>
        <tbody>
          {list.map((a) => {
            const o = OUTCOMES.find((x) => x.id === a.outcome)
            const net = a.take - cost
            return (
              <tr key={a.startDay} className="border-t border-hair text-muted">
                <td className="px-2 py-0.5">{fmtDate(a.startTime)}</td>
                <td className={`px-2 py-0.5 ${o?.tone || ''}`}>{o?.label || a.outcome}</td>
                <td className="num px-2 py-0.5 text-right">{a.evalDays}</td>
                <td className="num px-2 py-0.5 text-right">{a.fundedDays}</td>
                <td className="num px-2 py-0.5 text-right" title={a.payouts.map((p) => fmtMoney(p)).join(' + ')}>{a.payouts.length}</td>
                <td className={`num px-2 py-0.5 text-right ${a.outcome === 'eval-open' ? 'text-dim' : signClass(net)}`}>{fmtMoneySigned(net)}</td>
                <td className={`num px-2 py-0.5 text-right ${signClass(a.cashPnl)}`}>{fmtMoneySigned(a.cashPnl)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
