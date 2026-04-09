export const DEFAULT_CHART_COLORS = {
  upColor: '#4caf50',
  downColor: '#ff6b6b',
  bgColor: '#1a1a2e',
  borderUpColor: '',
  borderDownColor: '',
}

export const COLOR_PRESETS = [
  { name: 'Green / Red', upColor: '#4caf50', downColor: '#ff6b6b', borderUpColor: '', borderDownColor: '' },
  { name: 'Blue / White', upColor: '#2196f3', downColor: '#ffffff', borderUpColor: '', borderDownColor: '' },
  { name: 'White / Black', upColor: '#ffffff', downColor: '#000000', borderUpColor: '#ffffff', borderDownColor: '#ffffff' },
]

export const CHART_COLORS_STORAGE_KEY = 'candlestick-chart-colors'

export const TIMEZONE_OPTIONS = [
  { label: 'Eastern (ET)', value: 'America/New_York' },
  { label: 'Central (CT)', value: 'America/Chicago' },
  { label: 'Mountain (MT)', value: 'America/Denver' },
  { label: 'Pacific (PT)', value: 'America/Los_Angeles' },
  { label: 'UTC', value: 'UTC' },
]

export const DEFAULT_TIMEZONE = 'America/New_York'
export const TIMEZONE_STORAGE_KEY = 'chart-timezone'
