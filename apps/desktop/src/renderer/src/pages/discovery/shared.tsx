import type { ReactNode } from 'react'
import { KeyRound, ArrowRight, History, Trash2 } from 'lucide-react'
import { rpc, useQuery } from '../../lib/rpc'
import { useNav } from '../../lib/nav'
import { fmtRelative, fmtNum } from '../../lib/format'
import { Button, Callout, Card, PageHeader, StatusPill, confirmDialog } from '../../components/ui'
import { JobsPanel } from '../../components/JobsPanel'

export function DiscoveryLayout({ title, desc, eyebrow = 'Discovery', form, jobTypes, source, children }: {
  title: string; desc: string; eyebrow?: string; form: ReactNode; jobTypes: string[]; source: string; children?: ReactNode
}) {
  const { go } = useNav()
  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader eyebrow={eyebrow} title={title} desc={desc}  />
        <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 1.05fr) minmax(0, 1fr)', alignItems: 'start' }}>
          <div className="col gap-16">{form}</div>
          <div className="col gap-16">
            <JobsPanel types={jobTypes} />
            <SearchHistory source={source} />
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

export function SearchHistory({ source }: { source: string }) {
  const { data, reload } = useQuery<any[]>('discovery:history', [source], { events: ['job:finished', 'discovery:*'] })
  if (!data?.length) return null
  const clearAll = async () => {
    if (await confirmDialog({ title: 'Clear search history?', body: 'Only the list of past searches is removed. The leads they found are kept.', confirm: 'Clear' })) {
      await rpc('discovery:clearHistory', source)
      reload()
    }
  }
  return (
    <Card title={<span className="row"><History size={14} /> Search history</span>} tight actions={<Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={clearAll}>Clear</Button>}>
      {data.slice(0, 8).map((h) => {
        let p: any = {}
        try {
          p = JSON.parse(h.params)
        } catch {
          /* ignore */
        }
        const label = p.keywords ? [].concat(p.keywords).join(', ') : p.jobTitles?.length ? p.jobTitles.join(', ') : p.count ? `${p.count} websites` : 'Search'
        return (
          <div key={h.id} className="list-row" style={{ padding: '10px 18px' }}>
            <div className="grow">
              <div className="truncate" style={{ fontWeight: 550, fontSize: 12.5 }}>{label}</div>
              <div className="faint" style={{ fontSize: 11.5 }}>
                {p.locations?.length ? `${p.locations.slice(0, 3).join(', ')}${p.locations.length > 3 ? '…' : ''} · ` : ''}
                {fmtRelative(h.created_at)}
              </div>
            </div>
            <div className="faint num" style={{ fontSize: 12, textAlign: 'right' }}>
              {fmtNum(h.result_count)} found
              <br />
              <span style={{ color: 'var(--green)' }}>{fmtNum(h.new_count)} new</span>
            </div>
            {h.job_status && h.job_status !== 'completed' && <StatusPill status={h.job_status} />}
            <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} title="Remove from history" onClick={() => rpc('discovery:deleteHistory', [h.id]).then(reload)} />
          </div>
        )
      })}
    </Card>
  )
}

/** Shows whether the integration keys needed by this page are configured. */
export function KeyNotice({ names, label, docs }: { names: string[]; label: string; docs?: ReactNode }) {
  const { go } = useNav()
  const { data } = useQuery<Record<string, string | null>>('secrets:status', [])
  if (!data) return null
  const missing = names.filter((n) => !data[n])
  if (!missing.length)
    return (
      <Callout kind="ok" icon={<KeyRound size={15} />}>
        <b>{label}</b> is configured. {docs}
      </Callout>
    )
  return (
    <Callout kind="warn" icon={<KeyRound size={15} />}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <b>{label} is not configured.</b> {docs}
        </div>
        <Button size="sm" onClick={() => go('settings', { tab: 'integrations' })}>Configure</Button>
      </div>
    </Callout>
  )
}
