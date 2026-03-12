'use client'

import { useState, useRef, useEffect } from 'react'
import { AVAILABLE_INDICATORS } from './indicators'

export default function IndicatorSelector({ activeIndicators, onToggle }) {
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
    <div className="indicator-selector" ref={dropdownRef}>
      <button
        className={`indicator-button${activeIndicators.length > 0 ? ' has-active' : ''}`}
        onClick={() => setOpen(prev => !prev)}
      >
        Indicators{activeIndicators.length > 0 && ` (${activeIndicators.length})`}
      </button>
      {open && (
        <div className="indicator-dropdown">
          {AVAILABLE_INDICATORS.map(ind => {
            const isActive = activeIndicators.includes(ind.id)
            return (
              <button
                key={ind.id}
                className={`indicator-option${isActive ? ' active' : ''}`}
                onClick={() => onToggle(ind.id)}
              >
                <span className="indicator-color-dot" style={{ background: ind.color }} />
                {ind.label}
              </button>
            )
          })}
          {activeIndicators.length > 0 && (
            <>
              <div className="indicator-divider" />
              <button
                className="indicator-option indicator-clear"
                onClick={() => {
                  activeIndicators.forEach(id => onToggle(id))
                  setOpen(false)
                }}
              >
                Clear All
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
