'use client'

export default function SettingsPopup({ upColor, downColor, bgColor, onUpColorChange, onDownColorChange, onBgColorChange, onClose, onReset }) {
  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-popup" onClick={(e) => e.stopPropagation()}>
        <div className="settings-popup-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-section-label">Candlestick Colors</div>

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

        <div className="settings-preview">
          <div className="settings-preview-candle">
            <div className="settings-preview-wick" style={{ background: upColor }} />
            <div className="settings-preview-body" style={{ background: upColor }} />
            <div className="settings-preview-wick" style={{ background: upColor }} />
          </div>
          <div className="settings-preview-candle">
            <div className="settings-preview-wick" style={{ background: downColor }} />
            <div className="settings-preview-body" style={{ background: downColor }} />
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

        <button className="settings-reset-button" onClick={onReset}>
          Reset to Defaults
        </button>
      </div>
    </div>
  )
}
