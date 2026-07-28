'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useBacktest } from '../../lib/backtest/store'
import { fmtDateRange } from '../../lib/backtest/format'
import { shareUrl } from '../../lib/backtest/share'

/**
 * The tape: what is loaded, how long the last run took, and how many runs this
 * session has burned.
 *
 * `runs:N` is not a vanity counter. Every run, every sweep cell and every
 * walk-forward trial increments it, so the number in front of you is the size
 * of the multiple-testing problem you have created since the page loaded. A
 * Sharpe of 2 found on run 3 and one found on run 900 are not the same claim.
 */
export default function TapeBar() {
  const dataset = useBacktest((s) => s.dataset)
  const runCount = useBacktest((s) => s.runCount)
  const lastRunMs = useBacktest((s) => s.lastRunMs)
  const running = useBacktest((s) => s.running)
  const autoRun = useBacktest((s) => s.autoRun)
  const toggleAutoRun = useBacktest((s) => s.toggleAutoRun)
  const togglePalette = useBacktest((s) => s.togglePalette)
  const toggleShortcuts = useBacktest((s) => s.toggleShortcuts)
  const [copied, setCopied] = useState(false)

  // The Clipboard API rejects on insecure origins and when permission is
  // denied, so the URL always lands in the address bar too — that copy path
  // needs no permission at all.
  const copyShare = async () => {
    const url = shareUrl(useBacktest.getState())
    if (!url) return
    try {
      window.history.replaceState(null, '', url)
    } catch { /* ignore */ }
    try {
      await navigator.clipboard.writeText(url)
      setCopied('copied')
    } catch {
      setCopied('in url bar')
    }
    setTimeout(() => setCopied(false), 1800)
  }

  const snooping = runCount > 300 ? 'text-neg' : runCount > 80 ? 'text-amber' : 'text-dim'

  return (
    <div className="hair-b relative flex flex-wrap items-center gap-x-3 gap-y-1 bg-panel px-3 py-1.5 font-mono text-[11px]">
      <Link
        href="/"
        className="tracking-[0.18em] text-amber uppercase no-underline text-glow hover:text-ink"
        title="Back to dashboard"
      >
        tape
      </Link>

      {dataset ? (
        <span className="flex flex-wrap items-center gap-x-2 text-muted">
          <span className="text-ink">{dataset.symbol}</span>
          <Sep />
          <span>{dataset.interval}</span>
          <Sep />
          <span>{fmtDateRange(dataset.start, dataset.end)}</span>
          <Sep />
          <span className="num">{dataset.n.toLocaleString()}</span>
          <span className="text-dim">bars</span>
          <Sep />
          <span className={dataset.plane === 'research' ? 'text-violet' : 'text-cyan'}>
            {dataset.plane === 'research' ? 'research plane' : 'live plane'}
          </span>
        </span>
      ) : (
        <span className="text-dim">no dataset</span>
      )}

      <span className="ml-auto flex items-center gap-3">
        <span className="text-dim">
          {running ? <span className="text-amber">running…</span> : <>{lastRunMs.toFixed(0)}ms</>}
        </span>
        <button
          onClick={() => useBacktest.getState().toggleShortcuts(true)}
          className={`${snooping} hover:text-ink`}
          title="Runs this session — every sweep cell counts. Data-snooping tally."
        >
          runs:{runCount.toLocaleString()}
        </button>
        <button
          onClick={toggleAutoRun}
          className={autoRun ? 'text-cyan' : 'text-dim'}
          title="Re-run automatically when a parameter changes"
        >
          auto{autoRun ? '✓' : '✕'}
        </button>
        <button onClick={copyShare} className="text-dim hover:text-ink" title="Copy a link that reproduces this run">
          {copied ? <span className="text-pos">{copied}</span> : 'share'}
        </button>
        <button onClick={() => toggleShortcuts(true)} className="text-dim hover:text-ink" title="Keyboard shortcuts">
          ?
        </button>
        <button onClick={() => togglePalette(true)} className="kbd hover:text-ink">
          ⌘K
        </button>
      </span>
    </div>
  )
}

const Sep = () => <span className="text-hair-bright">·</span>
