'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { useBacktest } from '../../lib/backtest/store'

const KEYS = [
  ['⌘K', 'Command palette'],
  ['R', 'Run backtest'],
  ['1 – 4', 'Strategy family: technical, gamma, model, custom'],
  ['[  ]', 'Step the focused parameter down / up'],
  ['S', 'Run parameter sweep'],
  ['W', 'Run walk-forward'],
  ['M', 'Run Monte Carlo'],
  ['A B C', 'Pin the current run to a compare slot'],
  ['?', 'This sheet'],
  ['Esc', 'Close'],
]

export default function ShortcutSheet() {
  const open = useBacktest((s) => s.shortcutsOpen)
  const toggle = useBacktest((s) => s.toggleShortcuts)
  const runCount = useBacktest((s) => s.runCount)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 backdrop-blur-[2px]"
          onClick={() => toggle(false)}
        >
          <motion.div
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            className="w-[min(460px,92vw)] rounded-[3px] border border-hair-bright bg-panel p-4"
          >
            <p className="mb-3 font-mono text-[10px] tracking-[0.14em] text-dim uppercase">keyboard</p>
            <div className="flex flex-col gap-1.5">
              {KEYS.map(([k, label]) => (
                <div key={k} className="flex items-center gap-3">
                  <span className="kbd w-[64px] text-center">{k}</span>
                  <span className="font-mono text-[11px] text-muted">{label}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 border-t border-hair pt-3 font-mono text-[10px] leading-relaxed text-dim">
              <p>
                <span className="text-amber">runs:{runCount.toLocaleString()}</span> counts every
                simulation this session — single runs, sweep cells and walk-forward trials alike.
              </p>
              <p className="mt-1">
                It is a data-snooping tally. The more of these you burn on one dataset, the more a
                good-looking Sharpe is the maximum of many draws rather than an estimate of an edge.
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
