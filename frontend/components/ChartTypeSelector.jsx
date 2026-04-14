'use client'

import { useState, useRef, useEffect } from 'react'

const CHART_TYPES = [
  { group: 'Bars', items: [
    { id: 'ohlc', label: 'OHLC Bars' },
    { id: 'hlc', label: 'HLC Bars' },
    { id: 'highlow', label: 'High/Low Bars' },
  ]},
  { group: 'Candlesticks', items: [
    { id: 'candlestick', label: 'Candlesticks' },
    { id: 'candlestick-trend', label: 'Candlesticks (Trend)' },
    { id: '3d-candlestick', label: '3D Candlesticks' },
    { id: 'hollow', label: 'Candlesticks (Hollow)' },
    { id: 'candlestick-flat', label: 'Candlesticks (Flat)' },
  ]},
  { group: 'Line', items: [
    { id: 'line', label: 'Line' },
    { id: 'line-shaded', label: 'Line (Shaded)' },
    { id: 'line-gradient', label: 'Line (Gradient)' },
    { id: 'square-line', label: 'Square Line' },
    { id: 'square-line-shaded', label: 'Square Line (Shaded)' },
    { id: 'square-line-gradient', label: 'Square Line (Gradient)' },
  ]},
]

function findLabel(id) {
  for (const group of CHART_TYPES) {
    const item = group.items.find(t => t.id === id)
    if (item) return item.label
  }
  return 'Candlesticks'
}

export default function ChartTypeSelector({ chartType, onSelect }) {
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="chart-type-selector" ref={dropdownRef}>
      <button
        className="chart-type-button"
        onClick={() => setOpen(prev => !prev)}
        title={findLabel(chartType)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="6" width="4" height="12" rx="0.5" />
          <line x1="6" y1="4" x2="6" y2="6" />
          <line x1="6" y1="18" x2="6" y2="20" />
          <rect x="10" y="3" width="4" height="14" rx="0.5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="17" x2="12" y2="20" />
          <rect x="16" y="8" width="4" height="8" rx="0.5" />
          <line x1="18" y1="5" x2="18" y2="8" />
          <line x1="18" y1="16" x2="18" y2="21" />
        </svg>
      </button>
      {open && (
        <div className="chart-type-dropdown">
          {CHART_TYPES.map((group, gi) => (
            <div key={group.group}>
              {gi > 0 && <div className="chart-type-divider" />}
              <div className="chart-type-group-label">{group.group}</div>
              {group.items.map(t => (
                <button
                  key={t.id}
                  className={`chart-type-option${t.id === chartType ? ' active' : ''}`}
                  onClick={() => {
                    onSelect(t.id)
                    setOpen(false)
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
