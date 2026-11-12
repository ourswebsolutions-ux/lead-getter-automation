import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { EmptyState } from './ui'
import { BarChart3 } from 'lucide-react'

const axis = { stroke: 'var(--border-strong)', tick: { fill: 'var(--text-3)', fontSize: 11 }, tickLine: false, axisLine: false }

function Tip({ active, payload, label, names }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tip">
      <div className="l">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="row" style={{ gap: 6 }}>
          <i style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block' }} />
          <span className="muted">{names?.[p.dataKey] ?? p.dataKey}</span>
          <b className="num" style={{ marginLeft: 'auto', paddingLeft: 12 }}>{Number(p.value).toLocaleString()}</b>
        </div>
      ))}
    </div>
  )
}

/** Fills missing days so time series have a continuous axis. */
export function fillDays<T extends { day: string }>(rows: T[], from: string, to: string, zero: Omit<T, 'day'>): T[] {
  const map = new Map(rows.map((r) => [r.day, r]))
  const out: T[] = []
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10)
    out.push((map.get(k) ?? { ...zero, day: k }) as T)
  }
  return out
}
const shortDay = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

export function TimeArea({ data, dataKey, name, height = 220 }: { data: any[]; dataKey: string; name: string; height?: number }) {
  if (!data.some((d) => d[dataKey] > 0)) return <EmptyState icon={<BarChart3 size={20} />} title="No data in this range" desc="Discovered leads will chart here." />
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id={`g-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.18} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="day" tickFormatter={shortDay} minTickGap={28} {...axis} />
        <YAxis allowDecimals={false} width={44} {...axis} />
        <Tooltip content={<Tip names={{ [dataKey]: name }} />} labelFormatter={(l) => shortDay(String(l))} cursor={{ stroke: 'var(--border-strong)' }} />
        <Area type="monotone" dataKey={dataKey} stroke="var(--chart-1)" strokeWidth={2} fill={`url(#g-${dataKey})`} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function MultiLine({ data, series, height = 220 }: { data: any[]; series: { key: string; name: string; color: string }[]; height?: number }) {
  if (!data.some((d) => series.some((s) => d[s.key] > 0))) return <EmptyState icon={<BarChart3 size={20} />} title="No activity in this range" desc="Messages sent and replies received will chart here." />
  const names = Object.fromEntries(series.map((s) => [s.key, s.name]))
  return (
    <div>
      <div className="legend" style={{ marginBottom: 8 }}>
        {series.map((s) => (
          <span key={s.key}><i style={{ background: s.color }} />{s.name}</span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="day" tickFormatter={shortDay} minTickGap={28} {...axis} />
          <YAxis allowDecimals={false} width={44} {...axis} />
          <Tooltip content={<Tip names={names} />} labelFormatter={(l) => shortDay(String(l))} cursor={{ stroke: 'var(--border-strong)' }} />
          {series.map((s) => (
            <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Labelled horizontal bars (HTML) — values in text ink, bar carries the color. */
export function HBars({ rows, color = 'var(--chart-2)', colors, total, emptyText = 'No data yet' }: { rows: { name: string; value: number }[]; color?: string; colors?: Record<string, string>; total?: number; emptyText?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  if (!rows.length || rows.every((r) => !r.value)) return <div className="faint" style={{ fontSize: 12.5, padding: '12px 0' }}>{emptyText}</div>
  return (
    <div>
      {rows.map((r) => (
        <div key={r.name} className="hbar-row" title={`${r.name}: ${r.value.toLocaleString()}${total ? ` (${Math.round((r.value / total) * 100)}%)` : ''}`}>
          <span className="truncate muted">{r.name}</span>
          <div className="track">
            <div className="fill" style={{ width: `${(r.value / max) * 100}%`, background: colors?.[r.name] ?? color }} />
          </div>
          <span className="num" style={{ textAlign: 'right', fontWeight: 550 }}>{r.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}
