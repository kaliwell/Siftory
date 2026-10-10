import React, { useState, useEffect, useRef } from 'react'
import { safeEval } from '../services/safeEval'
import { useStore } from '../stores/useStore'
import DraggablePanel from './DraggablePanel'
import { DEFAULT_CALC_W, DEFAULT_CALC_H } from '../types'
import { useLinkedMove } from '../hooks/useLinkedMove'

const OPS = ['+', '−', '×', '÷']

function evaluate(expr: string): number {
  return safeEval(expr)
}

function formatResult(n: number): string {
  return isNaN(n) ? '\u2007Error\u2007' : String(n)
}

const CalculatorPanel: React.FC = () => {
  const calcPos = useStore((s) => s.calcPos)
  const setCalcPos = useStore((s) => s.setCalcPos)
  const setCalcSize = useStore((s) => s.setCalcSize)
  const calcSize = useStore((s) => s.calcSize)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels['calc'] ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility['calc'] ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)
  const handleMove = useLinkedMove('calc', calcPos, setCalcPos, linkedMove)

  const [expr, setExpr] = useState('0')
  const [fresh, setFresh] = useState(true)

  const isOp = (ch: string) => OPS.includes(ch)

  const input = (n: string) => {
    if (fresh) {
      setExpr(n)
      setFresh(false)
      return
    }
    if (expr === '0') {
      setExpr(n)
      return
    }
    setExpr(expr + n)
  }

  const inputParen = (p: string) => {
    // After =, start fresh
    if (fresh) {
      if (p === '(') {
        setExpr('(')
        setFresh(false)
        return
      }
      // ')' after = is meaningless — ignore
      return
    }
    // If display is just '0', replace with '('
    if (expr === '0' && p === '(') {
      setExpr('(')
      setFresh(false)
      return
    }
    if (expr === '0' && p === ')') return // can't close without open

    // Implicit multiplication: number or ) before ( → insert ×
    if (p === '(') {
      const last = expr.slice(-1)
      if (/\d/.test(last) || last === ')') {
        setExpr(expr + '×(')
        return
      }
      setExpr(expr + '(')
      return
    }

    // Closing paren: just append
    setExpr(expr + p)
  }

  const operate = (o: string) => {
    // After an error, ignore operator — user must clear or type a number
    if (fresh && !/^\d/.test(expr)) return
    const last = expr.slice(-1)
    // Don't allow operator right after '(' (except negative sign)
    if (last === '(' && o !== '−') return
    if (isOp(last)) {
      setExpr(expr.slice(0, -1) + o)
    } else {
      setExpr(expr + o)
    }
  }

  const calc = () => {
    setExpr(formatResult(evaluate(expr)))
    setFresh(true)
  }

  const clear = () => {
    setExpr('0')
    setFresh(true)
  }

  // ── Keyboard support ─────────────────────────────────
  const exprRef = useRef(expr)
  const freshRef = useRef(fresh)
  exprRef.current = expr
  freshRef.current = fresh

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      const ex = exprRef.current
      const fr = freshRef.current

      if (e.key >= '0' && e.key <= '9') {
        if (fr) {
          setExpr(e.key)
          setFresh(false)
        } else if (ex === '0') setExpr(e.key)
        else setExpr(ex + e.key)
        return
      }
      switch (e.key) {
        case '+': {
          const last = ex.slice(-1)
          if (last === '(') break // no op after (
          if (isOp(last)) setExpr(ex.slice(0, -1) + '+')
          else setExpr(ex + '+')
          break
        }
        case '-': {
          const last = ex.slice(-1)
          if (isOp(last)) setExpr(ex.slice(0, -1) + '−')
          else setExpr(ex + '−')
          break
        }
        case '*': {
          const last = ex.slice(-1)
          if (last === '(') break
          if (isOp(last)) setExpr(ex.slice(0, -1) + '×')
          else setExpr(ex + '×')
          break
        }
        case '/': {
          const last = ex.slice(-1)
          if (last === '(') break
          if (isOp(last)) setExpr(ex.slice(0, -1) + '÷')
          else setExpr(ex + '÷')
          break
        }
        case 'Enter':
          setExpr(formatResult(evaluate(ex)))
          setFresh(true)
          break
        case 'Escape':
          setExpr('0')
          setFresh(true)
          break
        case '(': {
          if (fr) {
            setExpr('(')
            setFresh(false)
            break
          }
          if (ex === '0') {
            setExpr('(')
            setFresh(false)
            break
          }
          const l = ex.slice(-1)
          // Implicit multiplication: 3( → 3×(
          if (/\d/.test(l) || l === ')') {
            setExpr(ex + '×(')
            break
          }
          setExpr(ex + '(')
          break
        }
        case ')': {
          if (fr) break // ')' after = is meaningless
          if (ex === '0') break // no open paren
          setExpr(ex + ')')
          break
        }
        case '.': {
          if (fr) {
            setExpr('.')
            setFresh(false)
          } else if (ex === '0') setExpr('.')
          else setExpr(ex + '.')
          break
        }
        case 'Backspace': {
          if (ex.length <= 1) {
            setExpr('0')
            setFresh(true)
          } else setExpr(ex.slice(0, -1))
          break
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const display = expr

  const btn = (label: string, action: () => void, cls = '') => (
    <button
      key={label}
      className={cls}
      onClick={action}
      style={{
        flex: 1,
        minWidth: 36,
        padding: '5px 0',
        fontSize: 13,
      }}
    >
      {label}
    </button>
  )

  return (
    <DraggablePanel
      panelId="calc"
      title="Calculator"
      x={calcPos.x}
      y={calcPos.y}
      w={calcSize.w}
      h={calcSize.h}
      defaultX={340}
      defaultY={480}
      defaultW={DEFAULT_CALC_W}
      defaultH={DEFAULT_CALC_H}
      onMove={handleMove}
      onResize={(w, h) => setCalcSize(w, h)}
      locked={locked}
      onToggleLock={() => togglePanelLocked('calc')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('calc')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4 }}>
        {/* Display */}
        <div
          style={{
            textAlign: 'right',
            padding: '8px 12px',
            fontSize: 18,
            fontFamily: 'Consolas, monospace',
            background: 'rgba(0,0,0,0.2)',
            borderRadius: 4,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          {display}
        </div>

        {/* Row 1 */}
        <div style={{ display: 'flex', gap: 3 }}>
          {btn('C', clear, 'calc-op')}
          {btn('(', () => inputParen('('), 'calc-op')}
          {btn(')', () => inputParen(')'), 'calc-op')}
          {btn('÷', () => operate('÷'), 'calc-op')}
        </div>
        {/* Row 2 */}
        <div style={{ display: 'flex', gap: 3 }}>
          {btn('7', () => input('7'))}
          {btn('8', () => input('8'))}
          {btn('9', () => input('9'))}
          {btn('×', () => operate('×'), 'calc-op')}
        </div>
        {/* Row 3 */}
        <div style={{ display: 'flex', gap: 3 }}>
          {btn('4', () => input('4'))}
          {btn('5', () => input('5'))}
          {btn('6', () => input('6'))}
          {btn('−', () => operate('−'), 'calc-op')}
        </div>
        {/* Row 4 */}
        <div style={{ display: 'flex', gap: 3 }}>
          {btn('1', () => input('1'))}
          {btn('2', () => input('2'))}
          {btn('3', () => input('3'))}
          {btn('+', () => operate('+'), 'calc-op')}
        </div>
        {/* Row 5 */}
        <div style={{ display: 'flex', gap: 3 }}>
          {btn('0', () => input('0'))}
          {btn('.', () => input('.'))}
          {btn(
            '⌫',
            () => {
              if (expr.length <= 1) {
                setExpr('0')
                setFresh(true)
              } else setExpr(expr.slice(0, -1))
            },
            'calc-op',
          )}
          {btn('=', calc, 'calc-eq')}
        </div>
      </div>
    </DraggablePanel>
  )
}

export default CalculatorPanel
