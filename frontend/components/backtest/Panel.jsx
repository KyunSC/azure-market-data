'use client'

import { motion } from 'framer-motion'

/**
 * Panel shell. Every panel in the terminal wears the same 10px tracked label,
 * so the eye can find a panel by its title strip alone.
 */
export default function Panel({ label, right, children, className = '', bodyClassName = '', delay = 0, scroll = true }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay, ease: [0.22, 0.61, 0.36, 1] }}
      className={`panel ${className}`}
    >
      {label && (
        <header className="panel-label">
          <span className="flex-1 truncate">{label}</span>
          {right}
        </header>
      )}
      <div className={`panel-body ${scroll ? '' : 'overflow-hidden'} ${bodyClassName}`}>{children}</div>
    </motion.section>
  )
}

export function EmptyState({ children, action }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="max-w-[38ch] font-mono text-[11px] leading-relaxed text-dim">{children}</p>
      {action}
    </div>
  )
}

export function PanelError({ children }) {
  return (
    <div className="m-2 rounded-[2px] border border-neg/40 bg-neg/5 p-2 font-mono text-[11px] text-neg">
      {children}
    </div>
  )
}
