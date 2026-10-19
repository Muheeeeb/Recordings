'use client'

import { bytes, compact } from './charts'

/**
 * Dialers with their folders nested underneath.
 *
 * Two separate bar charts — one for dialers, one for folders — hid the thing
 * that actually matters: which dialer a folder belongs to. Nesting shows the
 * split and the detail in one pass, and each row filters to itself.
 */

type Row = { name: string; count: number; bytes: number }

export function DialerBreakdown({
  dialers,
  groups,
  groupDialer,
  activeDialer,
  activeGroup,
  onPickDialer,
  onPickGroup,
}: {
  dialers: Row[]
  groups: Row[]
  /** Which dialer owns a folder, so folders sit under the right heading. */
  groupDialer: (group: string) => string
  activeDialer: string
  activeGroup: string
  onPickDialer: (dialer: string) => void
  onPickGroup: (group: string) => void
}) {
  if (dialers.length === 0) {
    return <p className="py-10 text-center text-sm text-[var(--muted)]">No recordings in range.</p>
  }

  const max = Math.max(...dialers.map((d) => d.count), 1)

  return (
    <div className="space-y-5">
      {dialers.map((dialer) => {
        const owned = groups
          .filter((g) => groupDialer(g.name) === dialer.name)
          .sort((a, b) => b.count - a.count)
        const selected = activeDialer === dialer.name

        return (
          <div key={dialer.name}>
            <button
              onClick={() => onPickDialer(selected ? '' : dialer.name)}
              className="group w-full text-left"
            >
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span
                  className={`text-[15px] font-semibold ${
                    selected ? 'text-[var(--series-1)]' : 'text-[var(--ink)]'
                  } group-hover:text-[var(--series-1)]`}
                >
                  {dialer.name}
                </span>
                <span className="shrink-0 text-right">
                  <span className="text-[15px] font-semibold tabular-nums text-[var(--ink)]">
                    {dialer.count.toLocaleString()}
                  </span>
                  <span className="ml-2 text-[12px] text-[var(--muted)]">
                    {bytes(dialer.bytes)}
                  </span>
                </span>
              </div>
              <div
                className="h-2.5 w-full overflow-hidden rounded-full"
                style={{ background: 'var(--series-1-wash)' }}
              >
                <div
                  className="h-full rounded-full transition-opacity group-hover:opacity-80"
                  style={{
                    width: `${Math.max((dialer.count / max) * 100, 1)}%`,
                    background: 'var(--series-1)',
                    opacity: activeDialer && !selected ? 0.4 : 1,
                  }}
                />
              </div>
            </button>

            <ul className="mt-2 space-y-0.5 pl-3">
              {owned.map((g) => {
                const on = activeGroup === g.name
                return (
                  <li key={g.name}>
                    <button
                      onClick={() => onPickGroup(on ? '' : g.name)}
                      className={`flex w-full items-baseline justify-between gap-3 rounded px-2 py-1 text-[13px] hover:bg-[var(--plane)] ${
                        on ? 'bg-[var(--plane)]' : ''
                      }`}
                    >
                      <span
                        className={`truncate ${
                          on ? 'text-[var(--series-1)]' : 'text-[var(--ink-2)]'
                        }`}
                      >
                        {g.name.replace(/_/g, ' ')}
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--muted)]">
                        {compact(g.count)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
