'use client'

import { useEffect, useRef, useState } from 'react'

/** Element size via ResizeObserver — visx needs explicit width/height, and the
 *  panels are user-resizable, so nothing can be measured once and cached. */
export default function useSize() {
  const ref = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setSize({ width: Math.floor(r.width), height: Math.floor(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, size]
}
