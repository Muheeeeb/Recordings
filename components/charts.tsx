'use client'

import { useState } from 'react'

/* Marks follow the shared spec: bars capped at 24px with a 4px rounded
 * data-end squared off at the baseline, 1px solid recessive gridlines, and a
 * 2px surface gap between neighbours. Every chart here plots a single series,
 * so no legend is needed — the heading says what is being measured. */

const BAR_MAX = 24
const RADIUS = 4

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`
  return n.toLocaleString()
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  return `${Math.round(n / 1024)} KB`
}

export function formatDay(day: number): string {
  const s = String(day)
  const date = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function StatTile({
  label,
  value,
  sub,
  hero = false,
}: {
  label: string
  value: string
  sub?: string
  hero?: boolean
}) {
  return (
    <div className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] px-4 py-3.5">
      <div className="text-[13px] text-[var(--muted)]">{label}</div>
      <div
        className={`mt-1 font-semibold tracking-tight text-[var(--ink)] ${
          hero ? 'text-4xl' : 'text-2xl'
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[13px] text-[var(--ink-2)]">{sub}</div>}
    </div>
  )
}

type Tip = { x: number; y: number; title: string; lines: string[] } | null

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-2.5 py-1.5 text-[12px] shadow-lg"
      style={{ left: tip.x, top: tip.y - 8 }}
    >
      <div className="font-medium text-[var(--ink)]">{tip.title}</div>
      {tip.lines.map((l) => (
        <div key={l} className="text-[var(--ink-2)]">
          {l}
        </div>
      ))}
    </div>
  )
}

/** Vertical columns — recordings per calendar day. */
export function DayChart({
  data,
  onSelect,
  selected,
}: {
  data: { day: number; count: number; bytes: number }[]
  onSelect?: (day: number) => void
  selected?: number | null
}) {
  const [tip, setTip] = useState<Tip>(null)
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-[var(--muted)]">No data yet.</p>
  }

  const max = Math.max(...data.map((d) => d.count))
  const step = Math.pow(10, Math.floor(Math.log10(max)))
  const top = Math.ceil(max / step) * step
  const ticks = [0, top / 2, top]

  const H = 180
  const slot = 100 / data.length

  return (
    <div className="relative" onMouseLeave={() => setTip(null)}>
      <div className="flex">
        <div
          className="flex w-12 shrink-0 flex-col justify-between pr-2 text-right text-[11px] tabular-nums text-[var(--muted)]"
          style={{ height: H }}
        >
          {[...ticks].reverse().map((t) => (
            <span key={t}>{compact(t)}</span>
          ))}
        </div>

        <div className="relative flex-1" style={{ height: H }}>
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute inset-x-0 border-t"
              style={{
                bottom: `${(t / top) * 100}%`,
                borderColor: t === 0 ? 'var(--baseline)' : 'var(--grid)',
              }}
            />
          ))}

          <div className="absolute inset-0 flex items-end">
            {data.map((d) => {
              const h = (d.count / top) * H
              // With a day selected the others recede, so the comparison stays
              // readable instead of the selection being the only thing visible.
              const dimmed = selected != null && selected !== d.day
              return (
                <div
                  key={d.day}
                  className={`flex h-full items-end justify-center ${onSelect ? 'cursor-pointer' : ''}`}
                  style={{ width: `${slot}%` }}
                  onClick={() => onSelect?.(d.day)}
                  onMouseEnter={(e) => {
                    const box = e.currentTarget.parentElement!.getBoundingClientRect()
                    const cell = e.currentTarget.getBoundingClientRect()
                    setTip({
                      x: cell.left - box.left + cell.width / 2,
                      y: H - h,
                      title: formatDay(d.day),
                      lines: [
                        `${d.count.toLocaleString()} recordings`,
                        bytes(d.bytes),
                        ...(onSelect ? ['click to filter to this day'] : []),
                      ],
                    })
                  }}
                >
                  <div
                    className="w-full transition-opacity hover:opacity-80"
                    style={{
                      maxWidth: BAR_MAX,
                      height: Math.max(h, 2),
                      background: 'var(--series-1)',
                      opacity: dimmed ? 0.35 : 1,
                      borderRadius: `${RADIUS}px ${RADIUS}px 0 0`,
                      marginInline: 'auto',
                      // 2px of surface keeps neighbouring columns apart without
                      // drawing a stroke around the mark.
                      boxShadow: '0 0 0 2px var(--surface)',
                    }}
                    aria-label={`${formatDay(d.day)}: ${d.count} recordings`}
                  />
                </div>
              )
            })}
          </div>
          <Tooltip tip={tip} />
        </div>
      </div>

      <div className="mt-2 flex pl-12">
        {data.map((d) => (
          <div
            key={d.day}
            className="text-center text-[11px] text-[var(--muted)]"
            style={{ width: `${slot}%` }}
          >
            {formatDay(d.day)}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Horizontal bars — long category names read better on this axis. */
export function GroupChart({
  data,
}: {
  data: { name: string; count: number; bytes: number }[]
}) {
  const [tip, setTip] = useState<Tip>(null)
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-[var(--muted)]">No data yet.</p>
  }
  const max = Math.max(...data.map((d) => d.count))

  return (
    <div className="relative space-y-3" onMouseLeave={() => setTip(null)}>
      {data.map((d) => (
        <div key={d.name}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="truncate text-[13px] text-[var(--ink-2)]">
              {d.name.replace(/_/g, ' ')}
            </span>
            {/* Direct label at the bar's tip: with one series per row there is
                no legend, so the value rides the mark. */}
            <span className="shrink-0 text-[13px] font-medium tabular-nums text-[var(--ink)]">
              {d.count.toLocaleString()}
            </span>
          </div>
          <div
            className="relative h-2.5 w-full overflow-hidden rounded-full"
            style={{ background: 'var(--series-1-wash)' }}
            onMouseEnter={(e) => {
              const box = e.currentTarget.getBoundingClientRect()
              const parent = e.currentTarget.offsetParent as HTMLElement
              const pbox = parent.getBoundingClientRect()
              setTip({
                x: box.left - pbox.left + box.width / 2,
                y: box.top - pbox.top,
                title: d.name.replace(/_/g, ' '),
                lines: [`${d.count.toLocaleString()} recordings`, bytes(d.bytes)],
              })
            }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max((d.count / max) * 100, 1)}%`,
                background: 'var(--series-1)',
              }}
            />
          </div>
        </div>
      ))}
      <Tooltip tip={tip} />
    </div>
  )
}
