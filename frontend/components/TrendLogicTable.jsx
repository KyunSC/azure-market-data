'use client'

import { useEffect, useState } from 'react'
import { latestTrendState, TREND_COLORS } from './indicators'

// (label, interval, period) tuples. Periods are picked to give >= 200 bars on
// each timeframe so the 200 EMA is fully warmed up. 4h is server-aggregated
// from 1h so 1y of 1h data → ~437 4h bars; 1wk + max → a few hundred weeks.
const TIMEFRAMES = [
  { label: 'M15', interval: '15m', period: '3mo' },
  { label: 'M30', interval: '30m', period: '3mo' },
  { label: 'H1',  interval: '1h',  period: '1y'  },
  { label: 'H4',  interval: '4h',  period: '1y'  },
  { label: 'D',   interval: '1d',  period: '2y'  },
  { label: 'W',   interval: '1wk', period: 'max' },
]

const REFRESH_MS = 5 * 60 * 1000

async function fetchHistorical(symbol, period, interval, signal) {
  const url = `/api/historical?symbol=${encodeURIComponent(symbol)}&period=${period}&interval=${interval}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data : []
}

export default function TrendLogicTable({ symbol }) {
  const [states, setStates] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()

    const load = async () => {
      const results = await Promise.allSettled(
        TIMEFRAMES.map(tf => fetchHistorical(symbol, tf.period, tf.interval, ctrl.signal))
      )
      if (cancelled) return
      const next = {}
      for (let i = 0; i < TIMEFRAMES.length; i++) {
        const tf = TIMEFRAMES[i]
        const r = results[i]
        if (r.status === 'fulfilled') {
          const bars = r.value.map(d => ({ close: Number(d.close), time: d.time }))
            .filter(d => Number.isFinite(d.close))
          next[tf.label] = latestTrendState(bars)
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
  }, [symbol])

  const renderCell = (state) => {
    if (state == null) return { label: loading ? '…' : 'N/A', color: TREND_COLORS.neutral, muted: true }
    if (state === 'bullish') return { label: 'BULLISH', color: TREND_COLORS.bullish }
    if (state === 'bearish') return { label: 'BEARISH', color: TREND_COLORS.bearish }
    return { label: 'NEUTRAL', color: TREND_COLORS.neutral, muted: true }
  }

  return (
    <table className="trend-logic-table">
      <thead>
        <tr>
          <th>TF</th>
          <th>STATE</th>
        </tr>
      </thead>
      <tbody>
        {TIMEFRAMES.map(tf => {
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
  )
}
