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
      >
        {findLabel(chartType)}
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
