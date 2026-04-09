'use client'

import { COLOR_PRESETS, TIMEZONE_OPTIONS } from './chartDefaults'

export default function SettingsPopup({ upColor, downColor, bgColor, borderUpColor, borderDownColor, onUpColorChange, onDownColorChange, onBgColorChange, onBorderUpColorChange, onBorderDownColorChange, onClose, onReset, timezone, onTimezoneChange }) {
  const applyPreset = (preset) => {
    onUpColorChange(preset.upColor)
    onDownColorChange(preset.downColor)
    onBorderUpColorChange(preset.borderUpColor)
    onBorderDownColorChange(preset.borderDownColor)
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-popup" onClick={(e) => e.stopPropagation()}>
        <div className="settings-popup-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-section-label">Candlestick Colors</div>

        <div className="settings-presets">
          {COLOR_PRESETS.map((preset) => {
            const isActive = upColor === preset.upColor && downColor === preset.downColor
            return (
              <button
                key={preset.name}
                className={`settings-preset-button${isActive ? ' active' : ''}`}
                onClick={() => applyPreset(preset)}
              >
                <span className="settings-preset-swatch" style={{ background: preset.upColor }} />
                <span className="settings-preset-swatch" style={{ background: preset.downColor }} />
                <span>{preset.name}</span>
              </button>
            )
          })}
        </div>

        <div className="settings-color-row">
          <label>Bullish (Up)</label>
          <input
            type="color"
            value={upColor}
            onChange={(e) => onUpColorChange(e.target.value)}
          />
        </div>

        <div className="settings-color-row">
          <label>Bearish (Down)</label>
          <input
            type="color"
            value={downColor}
            onChange={(e) => onDownColorChange(e.target.value)}
          />
        </div>

        <div className="settings-section-label">Outline Colors</div>

        <div className="settings-color-row">
          <label>Bullish Outline</label>
          <div className="settings-color-with-reset">
            <input
              type="color"
              value={borderUpColor || upColor}
              onChange={(e) => onBorderUpColorChange(e.target.value)}
            />
            {borderUpColor && (
              <button className="settings-color-clear" onClick={() => onBorderUpColorChange('')} title="Reset to match candle color">✕</button>
            )}
          </div>
        </div>

        <div className="settings-color-row">
          <label>Bearish Outline</label>
          <div className="settings-color-with-reset">
            <input
              type="color"
              value={borderDownColor || downColor}
              onChange={(e) => onBorderDownColorChange(e.target.value)}
            />
            {borderDownColor && (
              <button className="settings-color-clear" onClick={() => onBorderDownColorChange('')} title="Reset to match candle color">✕</button>
            )}
          </div>
        </div>

        <div className="settings-preview">
          <div className="settings-preview-candle">
            <div className="settings-preview-wick" style={{ background: upColor }} />
            <div className="settings-preview-body" style={{ background: upColor, outline: `2px solid ${borderUpColor || upColor}` }} />
            <div className="settings-preview-wick" style={{ background: upColor }} />
          </div>
          <div className="settings-preview-candle">
            <div className="settings-preview-wick" style={{ background: downColor }} />
            <div className="settings-preview-body" style={{ background: downColor, outline: `2px solid ${borderDownColor || downColor}` }} />
            <div className="settings-preview-wick" style={{ background: downColor }} />
          </div>
        </div>

        <div className="settings-section-label">Chart Background</div>

        <div className="settings-color-row">
          <label>Background</label>
          <input
            type="color"
            value={bgColor}
            onChange={(e) => onBgColorChange(e.target.value)}
          />
        </div>

        <div className="settings-section-label">Timezone</div>

        <div className="settings-color-row">
          <label>Chart Timezone</label>
          <select
            className="settings-select"
            value={timezone}
            onChange={(e) => onTimezoneChange(e.target.value)}
          >
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
        </div>

        <button className="settings-reset-button" onClick={onReset}>
          Reset to Defaults
        </button>
      </div>
    </div>
  )
}
