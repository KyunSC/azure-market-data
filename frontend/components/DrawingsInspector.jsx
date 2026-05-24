'use client'

import { useEffect, useRef, useState } from 'react'

const TYPE_META = {
  trendline:        { label: 'Trend Line',     icon: '/'   },
  horizontal:       { label: 'Horizontal',     icon: '―'   },
  rectangle:        { label: 'Rectangle',      icon: '▭'   },
  'rect-ray':       { label: 'Rectangle Ray',  icon: '▭⟶'  },
  ray:              { label: 'Ray',            icon: '⟶'   },
  'volume-profile': { label: 'Volume Profile', icon: '▥'   },
}

const fmtPrice = (p) => {
  if (p == null || !Number.isFinite(p)) return '—'
  return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Per-type summary string. Time isn't shown — for the user inspecting their own
// drawings the price level is what carries the actual signal.
function summarize(d) {
  const s = d.start?.price, e = d.end?.price
  switch (d.type) {
    case 'horizontal':      return `$${fmtPrice(s)}`
    case 'trendline':
    case 'ray':             return `$${fmtPrice(s)} → $${fmtPrice(e)}`
    case 'rectangle':
    case 'rect-ray':        return `$${fmtPrice(Math.min(s, e))} ↔ $${fmtPrice(Math.max(s, e))}`
    case 'volume-profile':  return 'time-range profile'
    default:                return ''
  }
}

export default function DrawingsInspector({ drawings, onDelete, onClearAll }) {
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

  const count = drawings.length

  return (
    <div className="indicator-selector" ref={dropdownRef}>
      <button
        className={`indicator-button${count > 0 ? ' has-active' : ''}`}
        onClick={() => setOpen(prev => !prev)}
        title="Inspect Drawings"
      >
        Drawings{count > 0 && ` (${count})`}
      </button>
      {open && (
        <div className="indicator-dropdown drawings-inspector">
          {count === 0 ? (
            <div className="drawings-inspector-empty">No drawings on chart</div>
          ) : (
            drawings.map((d, idx) => {
              const meta = TYPE_META[d.type] || { label: d.type, icon: '?' }
              return (
                <div key={idx} className="drawings-inspector-row">
                  <span className="drawing-icon">{meta.icon}</span>
                  <span
                    className="drawings-inspector-swatch"
                    style={{ background: d.color || '#4A90A4' }}
                  />
                  <span className="drawings-inspector-label">{meta.label}</span>
                  <span className="drawings-inspector-summary">{summarize(d)}</span>
                  <button
                    className="drawings-inspector-delete"
                    onClick={() => onDelete(idx)}
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              )
            })
          )}
          {count > 0 && (
            <>
              <div className="indicator-divider" />
              <button
                className="indicator-option indicator-clear"
                onClick={() => { onClearAll(); setOpen(false) }}
              >
                Clear All Drawings
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
