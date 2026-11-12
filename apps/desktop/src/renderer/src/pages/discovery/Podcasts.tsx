import { useState } from 'react'
import { Mic, Search } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { Button, Card, Field, Select, SwitchRow, TagInput, Checkbox, Callout } from '../../components/ui'
import { DiscoveryLayout } from './shared'

const PLATFORMS: { id: string; label: string; note: string; key?: string[] }[] = [
  { id: 'listennotes', label: 'Listen Notes', note: 'Official API · includes listed contact emails on paid plans', key: ['listenNotes'] },
  { id: 'spotify', label: 'Spotify', note: 'Official Web API · emails parsed from public show descriptions', key: ['spotifyId', 'spotifySecret'] },
  { id: 'deezer', label: 'Deezer', note: 'Public API · podcast search currently unavailable from Deezer (checked at run time)' },
  { id: 'apple', label: 'Apple Podcasts', note: 'Public directory · owner email read from the RSS feed' },
  { id: 'playerfm', label: 'Player FM', note: 'Public pages · best effort, markup may change' },
  { id: 'pandora', label: 'Pandora', note: 'No public API · best effort, results may be sparse' }
]

export function PodcastsPage() {
  const [platforms, setPlatforms] = useState<string[]>(['apple', 'deezer'])
  const [keywords, setKeywords] = useState<string[]>([])
  const [country, setCountry] = useState('US')
  const [max, setMax] = useState(100)
  const [rss, setRss] = useState(true)
  const { data: keys } = useQuery<Record<string, string | null>>('secrets:status', [])
  const { busy, run } = useAction()
  const configured = (p: (typeof PLATFORMS)[number]) => !p.key || p.key.every((k) => keys?.[k])
  const start = () => run('s', () => rpc('discovery:start', 'podcasts', { platforms, keywords, country, maxPerPlatform: max, rssLookup: rss }), { success: 'Podcast search started' })
  return (
    <DiscoveryLayout
      title="Podcast Leads"
      desc="Find podcast hosts and publishers with publicly listed contact emails."
      jobTypes={['discover_podcasts']}
      source="podcast"
      form={
        <Card
          title={<span className="row"><Mic size={14} /> New search</span>}
          footer={<Button variant="primary" icon={<Search size={14} />} loading={busy === 's'} disabled={!keywords.length || !platforms.length} onClick={start}>Start search</Button>}
        >
          <div className="col gap-16">
            <Field label="Topics or keywords">
              <TagInput value={keywords} onChange={setKeywords} placeholder="e.g. entrepreneurship, real estate investing" />
            </Field>
            <Field label="Platforms">
              <div className="col gap-4">
                {PLATFORMS.map((p) => (
                  <div key={p.id} className="row" style={{ padding: '6px 0' }}>
                    <Checkbox
                      checked={platforms.includes(p.id)}
                      onChange={(v) => setPlatforms(v ? [...platforms, p.id] : platforms.filter((x) => x !== p.id))}
                      label={<span style={{ fontWeight: 550 }}>{p.label}</span>}
                    />
                    <span className="faint grow" style={{ fontSize: 12 }}>{p.note}</span>
                    {p.key && <span className={`pill ${configured(p) ? 'green' : 'amber'}`}>{configured(p) ? 'Key set' : 'Needs key'}</span>}
                  </div>
                ))}
              </div>
            </Field>
            <div className="grid-2">
              <Field label="Market / country">
                <Select value={country} onChange={setCountry} options={['US', 'GB', 'CA', 'AU', 'IN', 'PK', 'AE', 'DE', 'FR', 'ES'].map((c) => ({ value: c, label: c }))} />
              </Field>
              <Field label="Max shows per platform">
                <Select value={max} onChange={(v) => setMax(Number(v))} options={[50, 100, 200, 500].map((n) => ({ value: n, label: String(n) }))} />
              </Field>
            </div>
            <SwitchRow title="Look up RSS feeds for emails" desc="Reads each show’s public RSS feed for the owner contact email when the platform doesn’t list one." on={rss} onChange={setRss} />
            {platforms.some((id) => !configured(PLATFORMS.find((p) => p.id === id)!)) && <Callout kind="warn">Some selected platforms need API keys (Settings → Integrations). They will be skipped with an error in the task log.</Callout>}
          </div>
        </Card>
      }
    />
  )
}
