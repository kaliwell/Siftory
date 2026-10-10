import { useEffect, useRef, useState } from 'react'

interface VirtualGridOptions {
  itemCount: number
  minColumnWidth: number
  rowHeight: number
  gap: number
  overscanRows?: number
  resetToken?: unknown
}

interface VirtualGridRange {
  columns: number
  endIndex: number
  offsetTop: number
  startIndex: number
  totalHeight: number
}

interface VirtualGridRangeInput {
  clientHeight: number
  columns: number
  gap: number
  itemCount: number
  overscanRows: number
  rowHeight: number
  scrollTop: number
}

const EMPTY_RANGE: VirtualGridRange = {
  columns: 1,
  endIndex: 0,
  offsetTop: 0,
  startIndex: 0,
  totalHeight: 0,
}

export function computeVirtualGridRange({
  clientHeight,
  columns,
  gap,
  itemCount,
  overscanRows,
  rowHeight,
  scrollTop,
}: VirtualGridRangeInput): VirtualGridRange {
  const safeColumns = Math.max(1, columns)
  const rowCount = Math.ceil(itemCount / safeColumns)
  const rowStride = rowHeight + gap
  const totalHeight = rowCount > 0 ? rowCount * rowHeight + Math.max(0, rowCount - 1) * gap : 0
  const startRow = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowStride) - overscanRows)
  const endRow = Math.min(
    rowCount,
    Math.ceil((Math.max(0, scrollTop) + clientHeight) / rowStride) + overscanRows,
  )
  return {
    columns: safeColumns,
    startIndex: Math.min(itemCount, startRow * safeColumns),
    endIndex: Math.min(itemCount, endRow * safeColumns),
    offsetTop: startRow * rowStride,
    totalHeight,
  }
}

export function useVirtualGrid({
  itemCount,
  minColumnWidth,
  rowHeight,
  gap,
  overscanRows = 3,
  resetToken,
}: VirtualGridOptions) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentTopRef = useRef(0)
  const scrollingRef = useRef(false)
  const [range, setRange] = useState<VirtualGridRange>(EMPTY_RANGE)
  const [isScrolling, setIsScrolling] = useState(false)

  useEffect(() => {
    scrollingRef.current = false
    // On cold start most search panels have no results. Even assigning
    // `scrollTop = 0` on those empty panes can force Chromium to lay out the
    // entire transparent workspace while several panels are mounting.
    if (itemCount <= 0) return
    if (rootRef.current && rootRef.current.scrollTop !== 0) rootRef.current.scrollTop = 0
    setIsScrolling(false)
  }, [itemCount, resetToken])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    // Empty result panels are common during startup. Measuring their geometry
    // forces a full workspace layout even though there is nothing to virtualize.
    // Do not enqueue even an identity state update here: React may flush other
    // pending panel effects while evaluating it, attributing a full layout pass
    // to an otherwise empty grid.
    if (itemCount <= 0) return

    const update = () => {
      frameRef.current = null
      const content = contentRef.current
      const width = Math.max(1, content?.clientWidth || root.clientWidth)
      const columns = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
      const localScrollTop = Math.max(0, root.scrollTop - contentTopRef.current)
      const activeOverscan = scrollingRef.current ? Math.min(1, overscanRows) : overscanRows

      const nextRange = computeVirtualGridRange({
        clientHeight: root.clientHeight,
        columns,
        gap,
        itemCount,
        overscanRows: activeOverscan,
        rowHeight,
        scrollTop: localScrollTop,
      })
      setRange((current) =>
        current.columns === nextRange.columns &&
        current.startIndex === nextRange.startIndex &&
        current.endIndex === nextRange.endIndex &&
        current.offsetTop === nextRange.offsetTop &&
        current.totalHeight === nextRange.totalHeight
          ? current
          : nextRange,
      )
    }

    const scheduleUpdate = () => {
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(update)
    }
    const measureContentTop = () => {
      const content = contentRef.current
      if (!content) {
        contentTopRef.current = 0
        return
      }
      const rootRect = root.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      contentTopRef.current = contentRect.top - rootRect.top + root.scrollTop
    }
    const handleScroll = () => {
      scrollingRef.current = true
      setIsScrolling(true)
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current)
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null
        scrollingRef.current = false
        setIsScrolling(false)
        scheduleUpdate()
      }, 120)
      scheduleUpdate()
    }
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            measureContentTop()
            scheduleUpdate()
          })
    resizeObserver?.observe(root)
    if (contentRef.current) resizeObserver?.observe(contentRef.current)
    root.addEventListener('scroll', handleScroll, { passive: true })
    measureContentTop()
    update()

    return () => {
      root.removeEventListener('scroll', handleScroll)
      resizeObserver?.disconnect()
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current)
    }
  }, [gap, itemCount, minColumnWidth, overscanRows, rowHeight])

  return { contentRef, isScrolling, rootRef, ...range }
}
