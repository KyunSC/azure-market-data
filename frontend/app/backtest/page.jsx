'use client'

import dynamic from 'next/dynamic'

// visx + framer-motion + cmdk + lightweight-charts are a meaningful download.
// Loading the terminal only on this route keeps them out of the dashboard's
// bundle entirely.
const BacktestTerminal = dynamic(() => import('../../components/backtest/BacktestTerminal'), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center font-mono text-xs tracking-[0.2em] text-dim uppercase">
      loading terminal…
    </div>
  ),
})

export default function BacktestPage() {
  return <BacktestTerminal />
}
