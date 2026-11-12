import { useState } from 'react'
import { Globe, Search, ExternalLink, Phone } from 'lucide-react'
import { rpc, useAction, useEvent, useQuery } from '../../lib/rpc'
import { splitList } from '../../lib/format'
import { Button, Card, Field, Textarea, Segmented, Callout, EmptyState, Select } from '../../components/ui'
import { DiscoveryLayout } from './shared'
import { useNav } from '../../lib/nav'

export function WebsitePage() {
  const { go } = useNav()
  const [mode, setMode] = useState<'urls' | 'leads'>('urls')
  const [urls, setUrls] = useState('')
  const [maxPages, setMaxPages] = useState(8)
  const [live, setLive] = useState<any[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const { data: noEmail } = useQuery<{ total: number }>('leads:list', [{ hasWebsite: true, hasEmail: false }, { limit: 1 }], { events: ['leads:changed'] })
  const { busy, run } = useAction()

  useEvent('extraction:result', (p) => setLive((l) => [p.result, ...l].slice(0, 200)))
  useEvent('extraction:page', (p) => setCurrent(p.url))
  useEvent('job:finished', () => setCurrent(null))

  const start = async () => {
    setLive([])
    if (mode === 'urls') {
      const list = splitList(urls)
      if (!list.length) return
      await run('s', () => rpc('discovery:start', 'website', { urls: list, maxPages }), { success: `Scanning ${list.length} website${list.length > 1 ? 's' : ''}` })
    } else {
      const ids = await rpc<number[]>('leads:idsForFilter', { hasWebsite: true, hasEmail: false })
      if (!ids.length) return
      await run('s', () => rpc('discovery:start', 'website', { urls: [], leadIds: ids, maxPages }), { success: `Scanning ${ids.length} lead websites` })
    }
  }

  return (
    <DiscoveryLayout
      title="Website Email Extraction"
      desc="Scan public business websites and their contact pages for emails and phone numbers."
      jobTypes={['extract_websites']}
      source="website"
      form={
        <>
          <Card
            title={<span className="row"><Globe size={14} /> Extract contacts</span>}
            footer={<Button variant="primary" icon={<Search size={14} />} loading={busy === 's'} disabled={mode === 'urls' ? !splitList(urls).length : !noEmail?.total} onClick={start}>Start extraction</Button>}
          >
            <div className="col gap-16">
              <Segmented value={mode} onChange={setMode} options={[{ value: 'urls', label: 'Website list' }, { value: 'leads', label: `Leads without email (${noEmail?.total ?? 0})` }]} />
              {mode === 'urls' ? (
                <Field label="Websites" hint="One per line. New websites become leads; existing ones are enriched.">
                  <Textarea rows={8} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={'acmedental.com\nhttps://www.example-motors.co.uk'} />
                </Field>
              ) : (
                <Callout>Scans the websites of <b>{noEmail?.total ?? 0}</b> leads that have a website but no email yet, and attaches what it finds.</Callout>
              )}
              <Field label="Pages per website" hint="Contact, about and team pages are visited first.">
                <Select value={maxPages} onChange={(v) => setMaxPages(Number(v))} options={[3, 5, 8, 12, 20].map((n) => ({ value: n, label: `Up to ${n} pages` }))} />
              </Field>
              <Callout>Respects robots.txt and crawl-delay, stays on the same domain, and pauses between requests. Emails are deduplicated and queued for verification.</Callout>
            </div>
          </Card>
          <Card title="Live results" sub={current ? <span className="truncate" style={{ display: 'block', maxWidth: 420 }}>Reading {current}</span> : 'Results from the current run'} tight>
            {!live.length ? (
              <EmptyState icon={<Globe size={20} />} title="No results yet" desc="Emails appear here with the page they were found on." />
            ) : (
              <div style={{ maxHeight: 520, overflow: 'auto' }}>
                {live.map((r, i) => (
                  <div key={i} className="list-row" style={{ alignItems: 'flex-start' }}>
                    <div className="grow col gap-4">
                      <div className="row">
                        <b className="truncate">{r.url.replace(/^https?:\/\//, '')}</b>
                        <span className="faint" style={{ fontSize: 11.5 }}>{r.pages} page{r.pages === 1 ? '' : 's'}{r.blocked ? ` · ${r.blocked} blocked by robots.txt` : ''}</span>
                      </div>
                      {r.emails.length ? (
                        r.emails.map((e: any) => (
                          <div key={e.email} className="row" style={{ fontSize: 12.5 }}>
                            <span style={{ fontWeight: 550 }}>{e.email}</span>
                            <span className="pill">{e.kind}</span>
                            <span className="faint truncate" style={{ fontSize: 11.5 }}>from {new URL(e.sourceUrl).pathname || '/'}</span>
                          </div>
                        ))
                      ) : (
                        <span className="faint" style={{ fontSize: 12.5 }}>{r.errors?.[0] ?? 'No public email found'}</span>
                      )}
                      {r.phones?.slice(0, 2).map((p: any) => (
                        <div key={p.phone} className="row faint" style={{ fontSize: 12 }}><Phone size={11} /> {p.phone}</div>
                      ))}
                    </div>
                    {r.leadId && <Button size="sm" variant="ghost" iconOnly icon={<ExternalLink size={13} />} title="Open lead" onClick={() => go('leads', { open: r.leadId })} />}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      }
    />
  )
}
