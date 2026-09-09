'use client'

import { useEffect } from 'react'
import { Command } from 'cmdk'
import { useBacktest } from '../../lib/backtest/store'
import { strategiesForPlane, getStrategy } from '../../lib/backtest/strategies'
import { LIVE_SYMBOLS, LIVE_INTERVALS, LIVE_PERIODS } from '../../lib/backtest/datasets'

/**
 * ⌘K. Everything reachable by mouse is reachable here, including the parameter
 * list — which is generated from the strategy schema, so it never falls behind
 * the panel it mirrors.
 */
export default function CommandPalette() {
  const open = useBacktest((s) => s.paletteOpen)
  const togglePalette = useBacktest((s) => s.togglePalette)
  const plane = useBacktest((s) => s.plane)
  const strategyId = useBacktest((s) => s.strategyId)
  const dataset = useBacktest((s) => s.dataset)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        togglePalette()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [togglePalette])

  if (!open) return null

  const s = useBacktest.getState()
  const strategy = getStrategy(strategyId)
  const close = () => togglePalette(false)
  const act = (fn) => () => {
    fn()
    close()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/70 pt-[12vh] backdrop-blur-[2px]" onClick={close}>
      <Command
        label="Command palette"
        onClick={(e) => e.stopPropagation()}
        // The global shortcut handler ignores keys typed into inputs, and the
        // palette's search box is one — so Escape has to be handled here or the
        // overlay stays up and swallows every click behind it.
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            close()
          }
        }}
        className="w-[min(560px,92vw)] overflow-hidden rounded-[3px] border border-hair-bright bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        loop
      >
        <Command.Input
          autoFocus
          placeholder="run, switch strategy, jump to a parameter…"
          className="w-full border-b border-hair bg-panel-2 px-3 py-2.5 font-mono text-[12px] text-ink placeholder:text-dim"
        />
        <Command.List className="max-h-[52vh] overflow-auto p-1">
          <Command.Empty className="p-4 text-center font-mono text-[11px] text-dim">nothing matches</Command.Empty>

          <Group heading="run">
            <Item onSelect={act(s.run)} shortcut="R">Run backtest</Item>
            <Item onSelect={act(s.runSweep)}>Run parameter sweep</Item>
            <Item onSelect={act(s.runWalkForward)}>Run walk-forward</Item>
            <Item onSelect={act(s.runMonteCarlo)}>Run Monte Carlo</Item>
            <Item onSelect={act(s.runCostCurve)}>Run cost ladder</Item>
            <Item onSelect={act(s.toggleAutoRun)}>Toggle auto-run on parameter change</Item>
          </Group>

          <Group heading="strategy">
            {strategiesForPlane(plane, dataset).map((st) => (
              <Item key={st.id} onSelect={act(() => s.setStrategy(st.id))} active={st.id === strategyId}>
                {st.label} <span className="text-dim">— {st.blurb}</span>
              </Item>
            ))}
          </Group>

          <Group heading="parameters">
            {strategy.params
              .filter((p) => !p.hidden && p.type === 'number')
              .map((p) => (
                <Item
                  key={p.key}
                  onSelect={act(() => s.setFocusedParam(p.key))}
                  shortcut="[ ]"
                >
                  Focus {p.label} <span className="text-dim">= {s.currentParams()[p.key]}</span>
                </Item>
              ))}
          </Group>

          <Group heading="dataset">
            <Item onSelect={act(() => s.setPlane('research'))} active={plane === 'research'}>
              Research plane — historical GEX + model predictions
            </Item>
            <Item onSelect={act(() => s.setPlane('live'))} active={plane === 'live'}>
              Live plane — /api/historical
            </Item>
            {plane === 'research'
              ? ['QQQ', 'SPY'].map((sym) => (
                  <Item key={sym} onSelect={act(() => s.setResearchSymbol(sym))}>
                    Load {sym} research dataset
                  </Item>
                ))
              : LIVE_SYMBOLS.map((sym) => (
                  <Item key={sym} onSelect={act(() => s.setLive({ liveSymbol: sym }))}>
                    Load {sym}
                  </Item>
                ))}
            {plane === 'live' &&
              LIVE_INTERVALS.map((iv) => (
                <Item key={iv} onSelect={act(() => s.setLive({ liveInterval: iv }))}>
                  Interval {iv}
                </Item>
              ))}
            {plane === 'live' &&
              LIVE_PERIODS.map((p) => (
                <Item key={p} onSelect={act(() => s.setLive({ livePeriod: p }))}>
                  Period {p}
                </Item>
              ))}
          </Group>

          <Group heading="panels">
            {[
              ['blotter', 'Trade blotter'],
              ['sweep', 'Parameter sweep'],
              ['wf', 'Walk-forward'],
              ['mc', 'Monte Carlo'],
              ['costs', 'Cost sensitivity'],
              ['rules', 'Rule builder'],
            ].map(([id, label]) => (
              <Item key={id} onSelect={act(() => s.setTab(id))}>
                Show {label}
              </Item>
            ))}
          </Group>

          <Group heading="compare">
            {['A', 'B', 'C'].map((slot) => (
              <Item key={slot} onSelect={act(() => s.saveSlot(slot))}>
                Pin current run to slot {slot}
              </Item>
            ))}
          </Group>

          <Group heading="sweep cells">
            {(s.sweep.data?.cells || [])
              .slice()
              .sort((a, b) => b.sharpe - a.sharpe)
              .slice(0, 8)
              .map((c, i) => (
                <Item key={i} onSelect={act(() => s.applySweepCell(c))}>
                  Load {s.sweep.xKey}={c.x}, {s.sweep.yKey}={c.y}{' '}
                  <span className="text-dim">— Sharpe {c.sharpe.toFixed(2)}</span>
                </Item>
              ))}
          </Group>
        </Command.List>
      </Command>
    </div>
  )
}

function Group({ heading, children }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[9px] [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-dim [&_[cmdk-group-heading]]:uppercase"
    >
      {children}
    </Command.Group>
  )
}

function Item({ children, onSelect, shortcut, active }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className={`flex cursor-pointer items-center gap-2 rounded-[2px] px-2 py-1.5 font-mono text-[11px] ${
        active ? 'text-amber' : 'text-muted'
      } data-[selected=true]:bg-panel-3 data-[selected=true]:text-ink`}
    >
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <span className="kbd">{shortcut}</span>}
    </Command.Item>
  )
}
