'use client'

import { useEffect, useMemo, useState } from 'react'
import { latestTrendState, TREND_COLORS } from './indicators'

// (label, interval, period) tuples. Periods are picked to give >= 200 bars on
// each timeframe so the 200 EMA is fully warmed up. 4h is server-aggregated
// from 1h so 1y of 1h data → ~437 4h bars; 1wk + max → a few hundred weeks.
const ALL_TIMEFRAMES = [
  { label: 'M15', interval: '15m', period: '3mo' },
  { label: 'M30', interval: '30m', period: '3mo' },
  { label: 'H1',  interval: '1h',  period: '1y'  },
  { label: 'H4',  interval: '4h',  period: '1y'  },
  { label: 'D',   interval: '1d',  period: '2y'  },
  { label: 'W',   interval: '1wk', period: 'max' },
]

const REFRESH_MS = 5 * 60 * 1000
const CONFIG_KEY = 'trendLogicTable:config'
const DEFAULT_CONFIG = {
  fastPeriod: 21,
  slowPeriod: 200,
  enabledLabels: ALL_TIMEFRAMES.map(tf => tf.label),
}

function loadConfig() {
  if (typeof window === 'undefined') return DEFAULT_CONFIG
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY)
    if (!raw) return DEFAULT_CONFIG
    const parsed = JSON.parse(raw)
    const validLabels = new Set(ALL_TIMEFRAMES.map(tf => tf.label))
    const enabledLabels = Array.isArray(parsed.enabledLabels)
      ? parsed.enabledLabels.filter(l => validLabels.has(l))
      : []
    return {
      fastPeriod: Number(parsed.fastPeriod) > 0 ? Math.floor(Number(parsed.fastPeriod)) : DEFAULT_CONFIG.fastPeriod,
      slowPeriod: Number(parsed.slowPeriod) > 0 ? Math.floor(Number(parsed.slowPeriod)) : DEFAULT_CONFIG.slowPeriod,
      enabledLabels: enabledLabels.length > 0 ? enabledLabels : DEFAULT_CONFIG.enabledLabels,
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

async function fetchHistorical(symbol, period, interval, signal) {
  const url = `/api/historical?symbol=${encodeURIComponent(symbol)}&period=${period}&interval=${interval}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data : []
}

export default function TrendLogicTable({ symbol }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [states, setStates] = useState({})
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    setConfig(loadConfig())
  }, [])

  const timeframes = useMemo(
    () => ALL_TIMEFRAMES.filter(tf => config.enabledLabels.includes(tf.label)),
    [config.enabledLabels]
  )

  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()

    const load = async () => {
      setLoading(true)
      const results = await Promise.allSettled(
        timeframes.map(tf => fetchHistorical(symbol, tf.period, tf.interval, ctrl.signal))
      )
      if (cancelled) return
      const next = {}
      for (let i = 0; i < timeframes.length; i++) {
        const tf = timeframes[i]
        const r = results[i]
        if (r.status === 'fulfilled') {
          const bars = r.value.map(d => ({ close: Number(d.close), time: d.time }))
            .filter(d => Number.isFinite(d.close))
          next[tf.label] = latestTrendState(bars, config.fastPeriod, config.slowPeriod)
        } else {
          next[tf.label] = null
        }
      }
      setStates(next)
      setLoading(false)
    }

    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      ctrl.abort()
      window.clearInterval(timer)
    }
  }, [symbol, timeframes, config.fastPeriod, config.slowPeriod])

  const saveConfig = (next) => {
    setConfig(next)
    try {
      window.localStorage.setItem(CONFIG_KEY, JSON.stringify(next))
    } catch {}
  }

  const renderCell = (state) => {
    if (state == null) return { label: loading ? '…' : 'N/A', color: TREND_COLORS.neutral, muted: true }
    if (state === 'bullish') return { label: 'BULLISH', color: TREND_COLORS.bullish }
    if (state === 'bearish') return { label: 'BEARISH', color: TREND_COLORS.bearish }
    return { label: 'NEUTRAL', color: TREND_COLORS.neutral, muted: true }
  }

  return (
    <>
      <table
        className="trend-logic-table"
        onDoubleClick={() => setEditing(true)}
        title="Double-click to configure"
      >
        <thead>
          <tr>
            <th>TF</th>
            <th>{`STATE (${config.fastPeriod}/${config.slowPeriod})`}</th>
          </tr>
        </thead>
        <tbody>
          {timeframes.map(tf => {
            const cell = renderCell(states[tf.label])
            return (
              <tr key={tf.label}>
                <td className="trend-tf">{tf.label}</td>
                <td
                  className={`trend-state${cell.muted ? ' muted' : ''}`}
                  style={cell.muted ? undefined : { background: cell.color, color: '#0d1b2a' }}
                >
                  {cell.label}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {editing && (
        <TrendLogicEditor
          config={config}
          onSave={(next) => { saveConfig(next); setEditing(false) }}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  )
}

const ALLOWED_CONTROL_KEYS = new Set([
  'Backspace', 'Delete', 'Tab', 'Escape', 'Enter', 'Home', 'End',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
])

function blockNonDigitKeys(e) {
  if (e.ctrlKey || e.metaKey) return
  if (ALLOWED_CONTROL_KEYS.has(e.key)) return
  if (/^[0-9]$/.test(e.key)) return
  e.preventDefault()
}

function handleDigitPaste(setValue) {
  return (e) => {
    e.preventDefault()
    const text = (e.clipboardData || window.clipboardData).getData('text') || ''
    setValue(text.replace(/[^0-9]/g, ''))
  }
}

function TrendLogicEditor({ config, onSave, onClose }) {
  const [fast, setFast] = useState(String(config.fastPeriod))
  const [slow, setSlow] = useState(String(config.slowPeriod))
  const [enabled, setEnabled] = useState(new Set(config.enabledLabels))
  const [error, setError] = useState(null)

  const toggle = (label) => {
    setEnabled(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  const submit = (e) => {
    e.preventDefault()
    const fp = Math.floor(Number(fast))
    const sp = Math.floor(Number(slow))
    if (!Number.isFinite(fp) || fp < 1) return setError('Fast EMA must be a positive integer')
    if (!Number.isFinite(sp) || sp <= fp) return setError('Slow EMA must be greater than Fast EMA')
    const labels = ALL_TIMEFRAMES.map(t => t.label).filter(l => enabled.has(l))
    if (labels.length === 0) return setError('Select at least one timeframe')
    onSave({ fastPeriod: fp, slowPeriod: sp, enabledLabels: labels })
  }

  return (
    <div className="trend-logic-editor-backdrop" onClick={onClose}>
      <form
        className="trend-logic-editor"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3>EMA Trend Friend Pro</h3>
        <div className="editor-row">
          <label>
            Fast EMA
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={fast}
              onChange={(e) => setFast(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={blockNonDigitKeys}
              onPaste={handleDigitPaste(setFast)}
            />
          </label>
          <label>
            Slow EMA
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={slow}
              onChange={(e) => setSlow(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={blockNonDigitKeys}
              onPaste={handleDigitPaste(setSlow)}
            />
          </label>
        </div>
        <fieldset className="tf-fieldset">
          <legend>Timeframes</legend>
          <div className="tf-toggles">
            {ALL_TIMEFRAMES.map(tf => (
              <label key={tf.label} className="tf-toggle">
                <input
                  type="checkbox"
                  checked={enabled.has(tf.label)}
                  onChange={() => toggle(tf.label)}
                />
                {tf.label}
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p className="editor-error">{error}</p>}
        <div className="editor-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </div>
      </form>
    </div>
  )
}
