// FILM-2015: the modal shell of the picker, Review, Deliver and the prompts.
// Focus moves in on open, Tab stays inside, Escape closes, focus returns.
import { forwardRef, useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import { trapDialogFocus } from '../../utils/dialogFocus.mjs'

export default function StudioDialog({ title, subtitle = null, onClose, size = 'md', testId, children, footer = null, closeLabel = 'Close' }) {
  const titleId = useId()
  const ref = useRef(null)

  // Focus management needs the mounted node; nothing else here is an effect.
  useEffect(() => {
    const previous = document.activeElement
    const node = ref.current
    const first = node?.querySelector('[data-autofocus]') || node?.querySelector('button:not([disabled]), input:not([disabled]), textarea, select')
    first?.focus()
    return () => previous?.focus?.()
  }, [])

  const width = size === 'full' ? 'w-[min(1400px,calc(100vw-32px))] h-[calc(100vh-48px)]' : size === 'lg' ? 'w-[min(960px,calc(100vw-32px))] max-h-[calc(100vh-48px)]' : 'w-[min(560px,calc(100vw-32px))] max-h-[calc(100vh-48px)]'

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60" data-test={testId ? `${testId}-overlay` : undefined}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-test={testId}
        className={`${width} flex flex-col overflow-hidden rounded-xl border border-sf-dark-600 bg-sf-dark-900 text-sf-text-primary shadow-2xl`}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.stopPropagation()
            onClose?.()
            return
          }
          if (event.key === 'Tab') {
            // A dialog inside another (the send confirmation) traps first.
            event.stopPropagation()
            trapDialogFocus(event, ref.current)
          }
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-sf-dark-700 px-5 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-xs text-sf-text-secondary">{subtitle}</p>}
          </div>
          {onClose && (
            <button type="button" onClick={onClose} className="rounded p-1 text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary" aria-label={closeLabel} data-test={testId ? `${testId}-close` : undefined}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-sf-dark-700 px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export const StudioButton = forwardRef(function StudioButton({ tone = 'secondary', className = '', ...props }, ref) {
  const tones = {
    primary: 'bg-sf-accent text-white hover:bg-sf-accent-hover disabled:opacity-50',
    secondary: 'bg-sf-dark-700 text-sf-text-primary hover:bg-sf-dark-600 disabled:opacity-50',
    danger: 'bg-sf-error/20 text-sf-error hover:bg-sf-error/30 disabled:opacity-50',
    ghost: 'text-sf-text-secondary hover:bg-sf-dark-700 hover:text-sf-text-primary disabled:opacity-50',
  }
  return <button ref={ref} type="button" className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent ${tones[tone]} ${className}`} {...props} />
})

export function Chip({ tone = 'muted', children, ...props }) {
  const tones = {
    muted: 'bg-sf-dark-700 text-sf-text-secondary',
    neutral: 'bg-sf-blue/20 text-sf-blue',
    busy: 'bg-sf-warning/20 text-sf-warning',
    good: 'bg-sf-success/20 text-sf-success',
    pass: 'bg-sf-success/20 text-sf-success',
    warn: 'bg-sf-warning/20 text-sf-warning',
    fail: 'bg-sf-error/20 text-sf-error',
    none: 'bg-sf-dark-700 text-sf-text-muted',
    accent: 'bg-sf-accent/20 text-sf-accent',
  }
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${tones[tone] || tones.muted}`} {...props}>{children}</span>
}
