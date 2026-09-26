'use client'

import { useEffect, useState } from 'react'
// v4 of react-resizable-panels renamed the parts: Group / Panel / Separator,
// and sizes are percentages only when passed as strings (numbers are pixels).
import { Group as PanelGroup, Panel as RPanel, Separator as PanelResizeHandle } from 'react-resizable-panels'
import { useBacktest } from '../../lib/backtest/store'
import { getStrategy, FAMILIES, strategiesForPlane } from '../../lib/backtest/strategies'
import { decodeConfig } from '../../lib/backtest/share'
import TapeBar from './TapeBar'
import StrategyPanel from './StrategyPanel'
import PricePanel from './PricePanel'
import EquityPanel from './EquityPanel'
import MetricsPanel from './MetricsPanel'
import ComparePanel from './ComparePanel'
import Blotter from './Blotter'
import SweepPanel from './SweepPanel'
import WalkForwardPanel from './WalkForwardPanel'
import MonteCarloPanel from './MonteCarloPanel'
import CostPanel from './CostPanel'
import RuleBuilder from './RuleBuilder'
import PropPanel from './PropPanel'
import CommandPalette from './CommandPalette'
import ShortcutSheet from './ShortcutSheet'
import KpiStrip from './KpiStrip'
import Panel, { PanelError } from './Panel'

const TABS = [
  { id: 'blotter', label: 'blotter' },
  { id: 'sweep', label: 'sweep' },
  { id: 'wf', label: 'walk-fwd' },
  { id: 'mc', label: 'monte carlo' },
  { id: 'costs', label: 'costs' },
  { id: 'prop', label: 'prop' },
  { id: 'rules', label: 'rules' },
]

export default function BacktestTerminal() {
  const activeTab = useBacktest((s) => s.activeTab)
  const setTab = useBacktest((s) => s.setTab)
  const datasetError = useBacktest((s) => s.datasetError)
  const datasetNotice = useBacktest((s) => s.datasetNotice)
  const setExample = useBacktest((s) => s.setExample)
  const advanced = useBacktest((s) => s.advanced)
  const runError = useBacktest((s) => s.runError)
  const configError = useBacktest((s) => s.configError)
  const loadDataset = useBacktest((s) => s.loadDataset)
  const wide = useWide()

  // Boot: restore a shared config, learn what research datasets exist, load.
  useEffect(() => {
    const store = useBacktest.getState()
    // UI preference first, so a shared link that needs advanced can override it.
    store.restoreUi()
    store.hydrate(decodeConfig(window.location.search))
    store.loadDataset()
  }, [])

  useKeyboard()

  const tabs = (
    <div className="flex items-center gap-1 overflow-x-auto">
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={`btn !px-2 !py-0.5 ${activeTab === t.id ? 'btn-active' : ''}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )

  const tabBody = (
    <>
      {activeTab === 'blotter' && <Blotter />}
      {activeTab === 'sweep' && <SweepPanel />}
      {activeTab === 'wf' && <WalkForwardPanel />}
      {activeTab === 'mc' && <MonteCarloPanel />}
      {activeTab === 'costs' && <CostPanel />}
      {activeTab === 'rules' && <RuleBuilder />}
      {activeTab === 'prop' && <PropPanel />}
    </>
  )

  const errors = (
    <>
      {datasetNotice && !datasetError && (
        <div className="mx-2 mt-2 flex items-center gap-2 rounded-[2px] border border-amber-dim/60 bg-amber/5 px-2 py-1.5 font-mono text-[11px] text-amber">
          <span className="flex-1">{datasetNotice}</span>
          <button onClick={() => setExample(false)} className="btn !px-2 !py-0.5">
            retry server
          </button>
        </div>
      )}
      {datasetError && (
        <PanelError>
          {datasetError}
          <button onClick={loadDataset} className="btn ml-2 !px-2 !py-0.5">
            retry
          </button>
        </PanelError>
      )}
      {runError && <PanelError>{runError}</PanelError>}
      {configError && <PanelError>{configError}</PanelError>}
    </>
  )

  return (
    <div className="scanlines relative flex h-screen flex-col overflow-hidden">
      <TapeBar />
      {errors}

      {!advanced ? (
        <SimpleLayout wide={wide} />
      ) : wide ? (
        <PanelGroup orientation="horizontal" className="min-h-0 flex-1 gap-0 p-1.5">
          <RPanel defaultSize="19" minSize="14" maxSize="32" className="min-h-0">
            <div className="h-full overflow-hidden">
              <StrategyPanel />
            </div>
          </RPanel>
          <PanelResizeHandle className="bt-resize-handle mx-1 rounded" />

          <RPanel defaultSize="57" minSize="30" className="min-h-0">
            <PanelGroup orientation="vertical">
              <RPanel defaultSize="40" minSize="18">
                <PricePanel />
              </RPanel>
              <PanelResizeHandle className="bt-resize-handle my-1 rounded" />
              <RPanel defaultSize="28" minSize="14">
                <EquityPanel />
              </RPanel>
              <PanelResizeHandle className="bt-resize-handle my-1 rounded" />
              <RPanel defaultSize="32" minSize="16">
                <Panel label="analysis" right={tabs} className="h-full" scroll={false} delay={0.12}>
                  {tabBody}
                </Panel>
              </RPanel>
            </PanelGroup>
          </RPanel>
          <PanelResizeHandle className="bt-resize-handle mx-1 rounded" />

          <RPanel defaultSize="24" minSize="16" maxSize="38" className="min-h-0">
            <PanelGroup orientation="vertical">
              <RPanel defaultSize="68" minSize="30">
                <MetricsPanel />
              </RPanel>
              <PanelResizeHandle className="bt-resize-handle my-1 rounded" />
              <RPanel defaultSize="32" minSize="16">
                <ComparePanel />
              </RPanel>
            </PanelGroup>
          </RPanel>
        </PanelGroup>
      ) : (
        // Under 1024px the resizable grid stops being usable — stack instead.
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-1.5">
          <div className="h-[320px] shrink-0">
            <PricePanel />
          </div>
          <div className="h-[220px] shrink-0">
            <EquityPanel />
          </div>
          <div className="shrink-0">
            <MetricsPanel />
          </div>
          <div className="h-[380px] shrink-0">
            <Panel label="analysis" right={tabs} className="h-full" scroll={false}>
              {tabBody}
            </Panel>
          </div>
          <div className="shrink-0">
            <StrategyPanel />
          </div>
          <div className="h-[240px] shrink-0">
            <ComparePanel />
          </div>
        </div>
      )}

      <CommandPalette />
      <ShortcutSheet />
    </div>
  )
}

/** Default view: setup on the left; results (headline numbers, price, equity,
 *  trades) on the right. Everything else sits behind the Advanced toggle. */
function SimpleLayout({ wide }) {
  const trades = (
    <Panel label="trades" className="h-full" scroll={false} delay={0.12}>
      <Blotter />
    </Panel>
  )

  if (!wide) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-1.5">
        <div className="shrink-0">
          <KpiStrip />
        </div>
        <div className="h-[320px] shrink-0">
          <PricePanel />
        </div>
        <div className="h-[220px] shrink-0">
          <EquityPanel />
        </div>
        <div className="shrink-0">
          <StrategyPanel />
        </div>
        <div className="h-[320px] shrink-0">{trades}</div>
      </div>
    )
  }

  return (
    <PanelGroup orientation="horizontal" className="min-h-0 flex-1 gap-0 p-1.5">
      <RPanel defaultSize="22" minSize="16" maxSize="34" className="min-h-0">
        <div className="h-full overflow-hidden">
          <StrategyPanel />
        </div>
      </RPanel>
      <PanelResizeHandle className="bt-resize-handle mx-1 rounded" />

      <RPanel defaultSize="78" minSize="40" className="min-h-0">
        <div className="flex h-full min-h-0 flex-col gap-1.5">
          <KpiStrip />
          <PanelGroup orientation="vertical" className="min-h-0 flex-1">
            <RPanel defaultSize="45" minSize="20">
              <PricePanel />
            </RPanel>
            <PanelResizeHandle className="bt-resize-handle my-1 rounded" />
            <RPanel defaultSize="30" minSize="15">
              <EquityPanel />
            </RPanel>
            <PanelResizeHandle className="bt-resize-handle my-1 rounded" />
            <RPanel defaultSize="25" minSize="12">
              {trades}
            </RPanel>
          </PanelGroup>
        </div>
      </RPanel>
    </PanelGroup>
  )
}

function useWide() {
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const apply = () => setWide(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return wide
}

/** Keyboard-first: run, family switch, param stepping, panel jumps. Typing in a
 *  field always wins — no shortcut fires while an input has focus. */
function useKeyboard() {
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey) return
      const s = useBacktest.getState()

      switch (e.key) {
        case 'r':
        case 'R':
          e.preventDefault()
          s.run()
          break
        case '[':
          e.preventDefault()
          s.nudgeFocusedParam(-1)
          break
        case ']':
          e.preventDefault()
          s.nudgeFocusedParam(1)
          break
        case 's':
          s.setAdvanced(true)
          s.setTab('sweep')
          s.runSweep()
          break
        case 'w':
          s.setAdvanced(true)
          s.setTab('wf')
          s.runWalkForward()
          break
        case 'm':
          s.setAdvanced(true)
          s.setTab('mc')
          s.runMonteCarlo()
          break
        case 'a':
        case 'b':
        case 'c':
          s.setAdvanced(true)
          s.saveSlot(e.key.toUpperCase())
          break
        case '?':
          s.toggleShortcuts(true)
          break
        case 'Escape':
          s.togglePalette(false)
          s.toggleShortcuts(false)
          break
        default: {
          const fam = FAMILIES.find((f) => f.hotkey === e.key)
          if (fam) {
            const first = strategiesForPlane(s.plane, s.dataset).find((st) => st.family === fam.id)
            if (first && getStrategy(s.strategyId).family !== fam.id) s.setStrategy(first.id)
          }
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
