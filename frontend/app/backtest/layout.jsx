import './backtest.css'
import { JetBrains_Mono, Inter } from 'next/font/google'

// next/font downloads at build time and serves the files from our own origin —
// no runtime request to a font CDN, and no layout shift from a late swap.
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
})

const sans = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata = {
  title: 'Backtester — Market Data',
  description: 'Client-side strategy backtester over live OHLCV and historical gamma exposure.',
}

export default function BacktestLayout({ children }) {
  // Deliberately outside `.app` — the terminal is full-bleed, unlike the
  // max-width dashboard shell.
  return (
    <div className={`${mono.variable} ${sans.variable} bt-root`}>{children}</div>
  )
}
