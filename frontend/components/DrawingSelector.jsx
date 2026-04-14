'use client'

import { useState, useRef, useEffect } from 'react'

const DRAWING_TOOLS = [
  { id: 'trendline', label: 'Trend Line', icon: '/' },
  { id: 'horizontal', label: 'Horizontal Line', icon: '―' },
  { id: 'rectangle', label: 'Rectangle', icon: '▭' },
  { id: 'rect-ray', label: 'Rectangle Ray', icon: '▭⟶' },
  { id: 'ray', label: 'Ray', icon: '⟶' },
  { id: 'volume-profile', label: 'Volume Profile', icon: '▥' },
]

export default function DrawingSelector({ activeTool, onSelectTool, onClearAll, drawingCount }) {
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

  const handleSelect = (id) => {
    if (activeTool === id) {
      onSelectTool(null)
    } else {
      onSelectTool(id)
    }
    setOpen(false)
  }

  return (
    <div className="indicator-selector" ref={dropdownRef}>
      <button
        className={`indicator-button${activeTool ? ' has-active' : ''}`}
        onClick={() => setOpen(prev => !prev)}
        title={activeTool ? `Draw: ${DRAWING_TOOLS.find(t => t.id === activeTool)?.label}` : 'Drawing Tools'}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
      </button>
      {open && (
        <div className="indicator-dropdown">
          {DRAWING_TOOLS.map(tool => (
            <button
              key={tool.id}
              className={`indicator-option${activeTool === tool.id ? ' active' : ''}`}
              onClick={() => handleSelect(tool.id)}
            >
              <span className="drawing-icon">{tool.icon}</span>
              {tool.label}
            </button>
          ))}
          {drawingCount > 0 && (
            <>
              <div className="indicator-divider" />
              <button
                className="indicator-option indicator-clear"
                onClick={() => {
                  onClearAll()
                  setOpen(false)
                }}
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
