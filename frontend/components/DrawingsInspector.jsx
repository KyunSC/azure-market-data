'use client'

import { useEffect, useRef, useState } from 'react'
import {
  EDITABLE_FIELDS_BY_TYPE,
  indicatorDisplayLabel,
  resolveIndicator,
} from './indicators'

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

export default function DrawingsInspector({
  drawings,
  onDelete,
  onClearAll,
  activeIndicators = [],
  onToggleIndicator,
  indicatorOverrides = {},
  onUpdateIndicator,
}) {
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
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

  const indicatorMetas = activeIndicators
    .map(id => resolveIndicator(id, indicatorOverrides))
    .filter(Boolean)
  const drawingCount = drawings.length
  const indicatorCount = indicatorMetas.length
  const totalCount = drawingCount + indicatorCount

  return (
    <div className="indicator-selector" ref={dropdownRef}>
      <button
        className={`indicator-button${totalCount > 0 ? ' has-active' : ''}`}
        onClick={() => setOpen(prev => !prev)}
        title="Object Viewer"
      >
        Object Viewer{totalCount > 0 && ` (${totalCount})`}
      </button>
      {open && (
        <div className="indicator-dropdown drawings-inspector">
          {totalCount === 0 ? (
            <div className="drawings-inspector-empty">No drawings or indicators on chart</div>
          ) : (
            <>
              {indicatorCount > 0 && (
                <>
                  <div className="drawings-inspector-section">Indicators</div>
                  {indicatorMetas.map(ind => {
                    const fields = EDITABLE_FIELDS_BY_TYPE[ind.type] || []
                    const isEditing = editingId === ind.id
                    const isEditable = onUpdateIndicator != null
                    return (
                      <div key={ind.id}>
                        <div
                          className={`drawings-inspector-row${isEditable ? ' is-clickable' : ''}${isEditing ? ' is-editing' : ''}`}
                          onClick={isEditable ? () => setEditingId(prev => prev === ind.id ? null : ind.id) : undefined}
                        >
                          <span className="drawing-icon">ƒ</span>
                          <span
                            className="drawings-inspector-swatch"
                            style={{ background: ind.color || '#4A90A4' }}
                          />
                          <span className="drawings-inspector-label">{indicatorDisplayLabel(ind)}</span>
                          <span className="drawings-inspector-summary" />
                          {onToggleIndicator && (
                            <button
                              className="drawings-inspector-delete"
                              onClick={(e) => { e.stopPropagation(); onToggleIndicator(ind.id) }}
                              title="Remove"
                            >
                              ×
                            </button>
                          )}
                        </div>
                        {isEditing && isEditable && (
                          <div className="indicator-editor">
                            <label className="indicator-editor-field">
                              <span>Color</span>
                              <input
                                type="color"
                                value={ind.color || '#4A90A4'}
                                onChange={(e) => onUpdateIndicator(ind.id, { color: e.target.value })}
                              />
                            </label>
                            {fields.map(f => (
                              <label key={f.key} className="indicator-editor-field">
                                <span>{f.label}</span>
                                <input
                                  type="number"
                                  min={f.min}
                                  max={f.max}
                                  step={f.step || 1}
                                  value={ind[f.key]}
                                  onChange={(e) => {
                                    const raw = e.target.value
                                    if (raw === '') return
                                    const num = f.step && f.step < 1 ? parseFloat(raw) : parseInt(raw, 10)
                                    if (!Number.isFinite(num) || num <= 0) return
                                    onUpdateIndicator(ind.id, { [f.key]: num })
                                  }}
                                />
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </>
              )}
              {drawingCount > 0 && (
                <>
                  {indicatorCount > 0 && <div className="indicator-divider" />}
                  <div className="drawings-inspector-section">Drawings</div>
                  {drawings.map((d, idx) => {
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
                  })}
                </>
              )}
            </>
          )}
          {drawingCount > 0 && (
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
