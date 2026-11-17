export function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US').format(n)
}
export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}
/** SQLite stores UTC "YYYY-MM-DD HH:MM:SS"; convert to a Date. */
export function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d
}
export function fmtDate(s: string | null | undefined, withTime = false): string {
  const d = parseDate(s)
  if (!d) return '—'
  return d.toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })
}
export function fmtRelative(s: string | null | undefined): string {
  const d = parseDate(s)
  if (!d) return '—'
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < -45) {
    const ahead = -diff
    if (ahead < 3600) return `in ${Math.round(ahead / 60)}m`
    if (ahead < 86400) return `in ${Math.round(ahead / 3600)}h`
    return `in ${Math.round(ahead / 86400)}d`
  }
  if (diff < 45) return 'just now'
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
export function fmtTime(s: string | null | undefined): string {
  const d = parseDate(s)
  return d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''
}
export function initials(name: string | null | undefined): string {
  if (!name) return '?'
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}
const AVATAR_COLORS = ['#c2410c', '#0f766e', '#4338ca', '#a21caf', '#0369a1', '#b45309', '#15803d', '#be123c', '#475569']
export function avatarColor(seed: string): string {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
export function pct(a: number, b: number): string {
  if (!b) return '0%'
  return `${Math.round((a / b) * 100)}%`
}
export function splitList(s: string): string[] {
  return s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)
}
export const SOURCE_LABEL: Record<string, string> = {
  google_maps: 'Google Maps', linkedin: 'LinkedIn', apollo: 'Apollo', website: 'Website', podcast: 'Podcast', import: 'Import', manual: 'Manual', inbound: 'Inbound'
}
export const STATUS_LABEL: Record<string, string> = {
  new: 'New', contacted: 'Contacted', replied: 'Replied', interested: 'Interested', not_interested: 'Not interested', converted: 'Converted', do_not_contact: 'Do not contact'
}
