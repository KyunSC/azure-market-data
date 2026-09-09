'use client'

import { useBacktest } from '../../lib/backtest/store'
import { getStrategy, strategiesForPlane, FAMILIES } from '../../lib/backtest/strategies'
import { LIVE_SYMBOLS, LIVE_PERIODS, LIVE_INTERVALS } from '../../lib/backtest/datasets'
import Panel from './Panel'

/**
 * The left column: dataset, strategy, parameters, costs, risk.
 *
 * Nothing here is hand-written per strategy. The parameter inputs are rendered
 * from `strategy.params`, which is the same schema the sweep axes and the
 * command palette read, so adding a knob to a strategy makes it appear in all
 * three places at once.
 */
export default function StrategyPanel() {
  const plane = useBacktest((s) => s.plane)
  const setPlane = useBacktest((s) => s.setPlane)
  const strategyId = useBacktest((s) => s.strategyId)
  const setStrategy = useBacktest((s) => s.setStrategy)
  const run = useBacktest((s) => s.run)
  const running = useBacktest((s) => s.running)
  const dataset = useBacktest((s) => s.dataset)

  const strategy = getStrategy(strategyId)
  const available = strategiesForPlane(plane, dataset)

  return (
    <Panel
      label="strategy"
      right={<span className="text-dim">{strategy.family}</span>}
      className="h-full"
      delay={0.02}
    >
      <div className="flex flex-col gap-4 p-2.5">
        <DatasetSection plane={plane} setPlane={setPlane} />

        <Section title="family">
          <div className="grid grid-cols-4 gap-1">
            {FAMILIES.map((f) => {
              const first = available.find((s) => s.family === f.id)
              const active = strategy.family === f.id
              return (
                <button
                  key={f.id}
                  disabled={!first}
                  onClick={() => first && setStrategy(first.id)}
                  className={`btn !px-1 text-[10px] ${active ? 'btn-active' : ''}`}
                  title={first ? `${f.label} — press ${f.hotkey}` : 'Needs the research plane'}
                >
                  {f.label}
                </button>
              )
            })}
          </div>
        </Section>

        <Section title="model">
          <div className="flex flex-col gap-1">
            {available
              .filter((s) => s.family === strategy.family)
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => setStrategy(s.id)}
                  className={`flex flex-col items-start rounded-[2px] border px-2 py-1.5 text-left transition-colors ${
                    s.id === strategyId
                      ? 'border-amber-dim bg-amber/8 text-ink'
                      : 'border-hair bg-panel-2 text-muted hover:border-hair-bright hover:text-ink'
                  }`}
                >
                  <span className="font-mono text-[11px]">{s.label}</span>
                  <span className="mt-0.5 text-[10px] leading-snug text-dim">{s.blurb}</span>
                </button>
              ))}
          </div>
        </Section>

        <ParamSection />
        <CostSection />
        <RiskSection />

        <button
          onClick={run}
          disabled={running || !dataset}
          className="btn btn-primary w-full py-2 text-[12px]"
          title="Run backtest (R)"
        >
          {running ? 'running…' : '▸ run'}
        </button>
      </div>
    </Panel>
  )
}

function Section({ title, children, right }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] tracking-[0.14em] text-dim uppercase">
        <span>{title}</span>
        <span className="h-px flex-1 bg-hair" />
        {right}
      </div>
      {children}
    </div>
  )
}

function DatasetSection({ plane, setPlane }) {
  const liveSymbol = useBacktest((s) => s.liveSymbol)
  const livePeriod = useBacktest((s) => s.livePeriod)
  const liveInterval = useBacktest((s) => s.liveInterval)
  const setLive = useBacktest((s) => s.setLive)
  const researchSymbol = useBacktest((s) => s.researchSymbol)
  const setResearchSymbol = useBacktest((s) => s.setResearchSymbol)
  const researchIndex = useBacktest((s) => s.researchIndex)
  const dataset = useBacktest((s) => s.dataset)

  const researchSets = researchIndex?.datasets || []
  const example = useBacktest((s) => s.example)
  const setExample = useBacktest((s) => s.setExample)
  const refreshDataset = useBacktest((s) => s.refreshDataset)
  const loading = useBacktest((s) => s.datasetLoading)

  return (
    <Section title="dataset">
      <div className="mb-1.5 grid grid-cols-2 gap-1">
        <button onClick={() => setPlane('live')} className={`btn ${plane === 'live' ? 'btn-active' : ''}`}>
          live
        </button>
        <button onClick={() => setPlane('research')} className={`btn ${plane === 'research' ? 'btn-active' : ''}`}>
          research
        </button>
      </div>

      {plane === 'live' ? (
        <div className="grid grid-cols-3 gap-1">
          <Select value={liveSymbol} onChange={(v) => setLive({ liveSymbol: v })} options={LIVE_SYMBOLS} />
          <Select value={livePeriod} onChange={(v) => setLive({ livePeriod: v })} options={LIVE_PERIODS} />
          <Select value={liveInterval} onChange={(v) => setLive({ liveInterval: v })} options={LIVE_INTERVALS} />
        </div>
      ) : (
        <Select
          value={researchSymbol}
          onChange={setResearchSymbol}
          options={researchSets.length ? researchSets.map((d) => d.symbol) : ['QQQ', 'SPY']}
        />
      )}

      <p className="mt-1.5 text-[10px] leading-snug text-dim">
        {plane === 'research' ? (
          <>
            {example ? 'Bundled example data. Historical coverage is fixed.' : 'Published historical OHLCV, GEX and optional model predictions.'}
          </>
        ) : (
          <>
            OHLCV straight from <span className="text-muted">/api/historical</span>. No historical GEX:
            the gamma endpoint only ever returns the current snapshot.
          </>
        )}
      </p>
      {plane === 'research' && (
        <label className="flex items-center gap-2 text-[10px] text-muted">
          <input type="checkbox" checked={example} onChange={e => setExample(e.target.checked)} />
          Use bundled examples
        </label>
      )}
      <button className="btn mt-2" disabled={loading} onClick={refreshDataset}>
        {loading ? 'Loading dataset…' : 'Refresh dataset'}
      </button>
      {dataset && <p className="mt-2 text-[10px] text-muted">
        {new Date(dataset.start).toISOString().slice(0, 10)} → {new Date(dataset.end).toISOString().slice(0, 10)} · {dataset.n.toLocaleString()} bars
        {dataset.generatedAt && <> · Generated {dataset.generatedAt.slice(0, 10)}</>}
        {dataset.version && <> · Version {dataset.version.slice(0, 8)}</>}
        {(dataset.cached || researchIndex?.cached) && <> · Offline cached data (up to 24 hours old)</>}
        {dataset.quality?.predictionValidation === 'legacy-unverified' && <> · Legacy model predictions; training overlap has not been verified.</>}
        {dataset.plane === 'live' && <> · Exploratory snapshot; shared links reload current history.</>}
      </p>}
      {plane === 'research' && dataset?.plane === 'research' && dataset.ml && (
        <p className="mt-1 text-[10px] leading-snug text-dim">
          Model: <span className="text-muted">{dataset.ml.model}</span>, {dataset.ml.horizon}.
        </p>
      )}
    </Section>
  )
}

function ParamSection() {
  const strategyId = useBacktest((s) => s.strategyId)
  const params = useBacktest((s) => s.paramsByStrategy[s.strategyId])
  const setParam = useBacktest((s) => s.setParam)
  const resetParams = useBacktest((s) => s.resetParams)
  const focusedParam = useBacktest((s) => s.focusedParam)
  const setFocusedParam = useBacktest((s) => s.setFocusedParam)
  const setTab = useBacktest((s) => s.setTab)

  const schema = getStrategy(strategyId).params.filter((p) => !p.hidden)

  return (
    <Section
      title="parameters"
      right={
        <button onClick={resetParams} className="text-[10px] text-dim hover:text-ink">
          reset
        </button>
      }
    >
      <div className="flex flex-col gap-1.5">
        {schema.map((p) => (
          <ParamField
            key={p.key}
            schema={p}
            value={params?.[p.key]}
            focused={focusedParam === p.key}
            onFocus={() => setFocusedParam(p.key)}
            onChange={(v) => setParam(p.key, v)}
          />
        ))}
        {strategyId === 'custom' && (
          <button onClick={() => setTab('rules')} className="btn mt-1 w-full">
            open rule builder
          </button>
        )}
      </div>
    </Section>
  )
}

/** One row per schema entry. Number params also get `[` / `]` stepping when
 *  focused, which is how the keyboard-first param search works. */
function ParamField({ schema, value, onChange, focused, onFocus }) {
  const label = (
    <span className="w-[92px] shrink-0 truncate font-mono text-[11px] text-muted" title={schema.label}>
      {schema.label}
    </span>
  )

  if (schema.type === 'boolean') {
    return (
      <div className="flex items-center gap-2" onMouseDown={onFocus}>
        {label}
        <button
          onClick={() => onChange(!value)}
          className={`btn flex-1 !py-1 ${value ? 'btn-active' : ''}`}
        >
          {value ? 'on' : 'off'}
        </button>
      </div>
    )
  }

  if (schema.type === 'select') {
    return (
      <div className="flex items-center gap-2" onMouseDown={onFocus}>
        {label}
        <div className="flex-1">
          <Select value={value} onChange={onChange} options={schema.options} />
        </div>
      </div>
    )
  }

  return (
    <div
      className={`flex items-center gap-2 rounded-[2px] px-1 py-0.5 -mx-1 ${focused ? 'bg-amber/6 ring-1 ring-amber-dim/40' : ''}`}
      onMouseDown={onFocus}
    >
      {label}
      <input
        type="range"
        min={schema.min}
        max={schema.max}
        step={schema.step}
        value={value ?? schema.default}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-[3px] flex-1 cursor-pointer appearance-none rounded bg-hair-bright accent-amber"
      />
      <input
        type="number"
        min={schema.min}
        max={schema.max}
        step={schema.step}
        value={value ?? schema.default}
        onChange={(e) => onChange(Number(e.target.value))}
        className="field !w-[54px] !px-1 !py-0.5 text-right"
      />
    </div>
  )
}

function CostSection() {
  const costs = useBacktest((s) => s.costs)
  const setCosts = useBacktest((s) => s.setCosts)

  return (
    <Section title="costs">
      <div className="flex flex-col gap-1.5">
        <NumRow
          label="Slippage (bp)"
          value={costs.slippageBps}
          min={0}
          max={20}
          step={0.5}
          onChange={(v) => setCosts({ slippageBps: v })}
          hint="Drag this up and watch the edge die — the single most honest control on the page."
        />
        <NumRow label="Commission ($)" value={costs.commissionPerTrade} min={0} max={10} step={0.1} onChange={(v) => setCosts({ commissionPerTrade: v })} />
        <NumRow label="Capital ($)" value={costs.initialCapital} min={1000} max={1000000} step={1000} onChange={(v) => setCosts({ initialCapital: v })} />
        <NumRow label="Size (× equity)" value={costs.sizePct} min={0.1} max={3} step={0.1} onChange={(v) => setCosts({ sizePct: v })} />
      </div>
    </Section>
  )
}

function RiskSection() {
  const risk = useBacktest((s) => s.risk)
  const setRisk = useBacktest((s) => s.setRisk)

  return (
    <Section title="exits">
      <div className="flex flex-col gap-1.5">
        <NumRow label="Stop (%)" value={risk.stopPct} min={0} max={10} step={0.05} onChange={(v) => setRisk({ stopPct: v })} hint="0 disables" />
        <NumRow label="Target (%)" value={risk.targetPct} min={0} max={10} step={0.05} onChange={(v) => setRisk({ targetPct: v })} hint="0 disables" />
        <NumRow label="Max bars" value={risk.maxBars} min={0} max={200} step={1} onChange={(v) => setRisk({ maxBars: v })} hint="0 disables" />
        <div className="flex items-center gap-2">
          <span className="w-[92px] shrink-0 font-mono text-[11px] text-muted">Flat at close</span>
          <button onClick={() => setRisk({ flatAtSessionEnd: !risk.flatAtSessionEnd })} className={`btn flex-1 !py-1 ${risk.flatAtSessionEnd ? 'btn-active' : ''}`}>
            {risk.flatAtSessionEnd ? 'on' : 'off'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-[92px] shrink-0 font-mono text-[11px] text-muted">Allow shorts</span>
          <button onClick={() => setRisk({ allowShort: !risk.allowShort })} className={`btn flex-1 !py-1 ${risk.allowShort ? 'btn-active' : ''}`}>
            {risk.allowShort ? 'on' : 'off'}
          </button>
        </div>
      </div>
    </Section>
  )
}

function NumRow({ label, value, min, max, step, onChange, hint }) {
  return (
    <div className="flex items-center gap-2" title={hint}>
      <span className="w-[92px] shrink-0 truncate font-mono text-[11px] text-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-[3px] flex-1 cursor-pointer appearance-none rounded bg-hair-bright accent-amber"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="field !w-[68px] !px-1 !py-0.5 text-right"
      />
    </div>
  )
}

export function Select({ value, onChange, options }) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field cursor-pointer pr-5">
        {opts.map((o) => (
          <option key={o.value} value={o.value} className="bg-panel text-ink">
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-[8px] text-dim">▼</span>
    </div>
  )
}
