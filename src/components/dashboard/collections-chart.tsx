import { formatMonthMy } from '@/lib/format-my'

interface Point {
  month: string
  collectedSen: number
}

/** Whole ringgit when exact, otherwise with sen (integer arithmetic only). */
const label = (sen: number) => `RM ${String(Math.floor(sen / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${sen % 100 === 0 ? '' : `.${String(sen % 100).padStart(2, '0')}`}`

/**
 * Bar chart of real collections per Malaysia calendar month, drawn with plain elements (no chart library).
 * It is decorative for assistive technology: the same numbers are in the table beside it.
 */
export function CollectionsChart({ points }: { points: Point[] }) {
  const max = Math.max(1, ...points.map((p) => p.collectedSen))
  return (
    <div aria-hidden="true" className="relative" data-testid="collections-chart">
      <div className="absolute inset-x-0 top-6 bottom-7 flex flex-col justify-between">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="border-t border-dashed border-border" />
        ))}
      </div>
      <div className="relative flex h-60 items-stretch gap-2 sm:gap-4">
        {points.map((p) => {
          const pct = Math.round((p.collectedSen / max) * 100)
          return (
            <div key={p.month} className="flex min-w-0 flex-1 flex-col items-center">
              <span className="h-6 max-w-full truncate text-[11px] font-medium text-muted-foreground-strong num sm:text-xs">{p.collectedSen > 0 ? label(p.collectedSen) : ''}</span>
              <div className="flex w-full flex-1 items-end justify-center">
                <div
                  className={p.collectedSen > 0 ? 'w-full max-w-14 rounded-t-md bg-primary' : 'w-full max-w-14 rounded-t-sm bg-border'}
                  style={{ height: p.collectedSen > 0 ? `${Math.max(pct, 3)}%` : '3px' }}
                />
              </div>
              <span className="mt-2 h-5 text-xs whitespace-nowrap text-muted-foreground-strong">{formatMonthMy(p.month).split(' ')[0]}<span className="hidden sm:inline"> {p.month.slice(0, 4)}</span></span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
