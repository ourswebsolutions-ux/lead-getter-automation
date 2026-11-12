import { useState } from 'react'
import { Users, MailCheck, MailWarning, MailX, Sparkles, Smartphone, AtSign, Send, Mails, Inbox, Bot, ClipboardCheck } from 'lucide-react'
import { useQuery } from '../lib/rpc'
import { useNav } from '../lib/nav'
import { openWhatsApp } from '../components/WhatsAppMenu'
import { fmtNum, pct, fmtRelative } from '../lib/format'
import { Card, PageHeader, Stat, StatusPill, Segmented, Button, EmptyState } from '../components/ui'
import { TimeArea, MultiLine, HBars, fillDays } from '../components/charts'

const RANGES = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 } as const
type RangeKey = keyof typeof RANGES

export function rangeFor(k: RangeKey) {
  const to = new Date()
  const from = new Date(Date.now() - (RANGES[k] - 1) * 86400_000)
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

export const VERIF_COLORS: Record<string, string> = { safe: 'var(--green)', risky: 'var(--amber)', invalid: 'var(--red)', unknown: 'var(--chart-6)', failed: 'var(--chart-5)', unverified: 'var(--border-strong)' }

export function Dashboard() {
  const { go } = useNav()
  const [range, setRange] = useState<RangeKey>('30d')
  const r = rangeFor(range)
  const { data, loading } = useQuery<any>('analytics:dashboard', [r], { events: ['leads:changed', 'campaign:*', 'conversation:*', 'approval:*', 'whatsapp:status', 'job:finished'], poll: 60000 })
  const s = data?.stats
  const greeting = (() => {
    const h = new Date().getHours()
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  })()

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow={new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          title={greeting}
          desc="Your pipeline at a glance — every figure comes from live records."
          actions={
            <Segmented<RangeKey>
              value={range}
              onChange={setRange}
              options={[{ value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: '90d', label: '90 days' }, { value: '365d', label: '12 months' }]}
            />
          }
        />

        {s?.pendingApprovals > 0 && (
          <div className="card row mb-16" style={{ padding: '12px 16px', borderColor: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-soft)' }}>
            <ClipboardCheck size={18} color="var(--accent)" />
            <div className="grow">
              <b>{s.pendingApprovals} AI suggestion{s.pendingApprovals === 1 ? '' : 's'} waiting for your approval</b>
              <div className="muted" style={{ fontSize: 12.5 }}>Pricing and commercial replies are never sent without you.</div>
            </div>
            <Button variant="primary" onClick={() => go('agent')}>Review now</Button>
          </div>
        )}

        <div className="grid-4">
          <Stat loading={loading} label="Total leads" icon={<Users size={13} />} value={fmtNum(s?.totalLeads)} foot={`+${fmtNum(s?.newLeads)} in this period`} color="var(--chart-1)" onClick={() => go('maps')} />
          <Stat loading={loading} label="Verified emails" icon={<MailCheck size={13} />} value={fmtNum(s?.verifiedEmails)} foot={`${fmtNum(s?.unverifiedEmails)} awaiting verification`} color="var(--green)" onClick={() => go('verification')} />
          <Stat loading={loading} label="Interested prospects" icon={<Sparkles size={13} />} value={fmtNum(s?.interested)} foot={`${fmtNum(s?.repliesReceived)} replies this period`} color="var(--chart-3)" onClick={() => go('conversations', { folder: 'interested' })} />
          <Stat loading={loading} label="Messages sent" icon={<Send size={13} />} value={fmtNum((s?.whatsappSent ?? 0) + (s?.emailsSent ?? 0))} foot={`${fmtNum(s?.whatsappSent)} WhatsApp · ${fmtNum(s?.emailsSent)} email`} color="var(--chart-2)" />
        </div>

        <div className="grid-3 mt-16" style={{ gridTemplateColumns: '2fr 1fr' }}>
          <Card title="Leads discovered" sub="New leads per day across every source">
            <TimeArea data={data ? fillDays(data.leadsOverTime, data.range.from, data.range.to, { leads: 0 }) : []} dataKey="leads" name="Leads" />
          </Card>
          <Card title="System status" tight>
            <StatusRow icon={<Smartphone size={15} />} label="WhatsApp accounts" value={`${s?.activeWhatsApp ?? 0} of ${s?.totalWhatsApp ?? 0} connected`} status={s?.activeWhatsApp ? 'connected' : s?.totalWhatsApp ? 'disconnected' : null} onClick={openWhatsApp} />
            <StatusRow icon={<AtSign size={15} />} label="SMTP accounts" value={`${s?.activeSmtp ?? 0} of ${s?.totalSmtp ?? 0} healthy`} status={s?.activeSmtp ? 'ok' : s?.totalSmtp ? 'untested' : null} onClick={() => go('email-accounts')} />
            <StatusRow icon={<Send size={15} />} label="WhatsApp campaigns" value={`${s?.activeWaCampaigns ?? 0} active`} status={s?.activeWaCampaigns ? 'running' : null} onClick={() => go('wa-campaigns')} />
            <StatusRow icon={<Mails size={15} />} label="Email campaigns" value={`${s?.activeEmailCampaigns ?? 0} active`} status={s?.activeEmailCampaigns ? 'running' : null} onClick={() => go('email-campaigns')} />
            <StatusRow
              icon={<Bot size={15} />}
              label="AI provider"
              value={s?.aiProvider ? `${s.aiProvider.id}${s.aiProvider.model ? ` · ${s.aiProvider.model}` : ''}` : 'Not configured'}
              status={s?.aiProvider ? (s.aiProvider.hasKey ? s.aiProvider.status : 'unconfigured') : 'unconfigured'}
              onClick={() => go('agent', { tab: 'providers' })}
            />
            <StatusRow icon={<Inbox size={15} />} label="Pending approvals" value={fmtNum(s?.pendingApprovals)} status={s?.pendingApprovals ? 'pending' : null} onClick={() => go('agent')} />
          </Card>
        </div>

        <div className="grid-4 mt-16">
          <Stat loading={loading} label="Risky emails" icon={<MailWarning size={13} />} value={fmtNum(s?.riskyEmails)} foot="Catch-all, role or disposable" />
          <Stat loading={loading} label="Invalid emails" icon={<MailX size={13} />} value={fmtNum(s?.invalidEmails)} foot="Automatically suppressed" />
          <Stat loading={loading} label="Emails sent" icon={<Mails size={13} />} value={fmtNum(s?.emailsSent)} foot={`${fmtNum(s?.emailsFailed)} failed · ${fmtNum(s?.emailBounces)} bounced`} />
          <Stat loading={loading} label="Reply rate" icon={<Inbox size={13} />} value={pct(s?.repliesReceived ?? 0, (s?.whatsappSent ?? 0) + (s?.emailsSent ?? 0))} foot="Replies ÷ messages sent, this period" />
        </div>

        <div className="grid-2 mt-16">
          <Card title="Communication activity" sub="Outbound messages and inbound replies per day">
            <MultiLine
              data={data ? fillDays(data.activity, data.range.from, data.range.to, { whatsapp_out: 0, email_out: 0, replies: 0 }) : []}
              series={[
                { key: 'whatsapp_out', name: 'WhatsApp sent', color: 'var(--chart-3)' },
                { key: 'email_out', name: 'Emails sent', color: 'var(--chart-2)' },
                { key: 'replies', name: 'Replies', color: 'var(--chart-1)' }
              ]}
            />
          </Card>
          <Card title="Pipeline" sub="Where leads are in the outreach funnel (all time)">
            {data && <HBars rows={data.funnel.map((f: any) => ({ name: f.stage, value: f.value }))} color="var(--chart-1)" emptyText="No leads yet." />}
            {data && data.funnel[0].value > 0 && (
              <div className="row mt-16 faint" style={{ fontSize: 12, gap: 16 }}>
                <span>Contact rate <b className="num" style={{ color: 'var(--text)' }}>{pct(data.funnel[1].value, data.funnel[0].value)}</b></span>
                <span>Reply rate <b className="num" style={{ color: 'var(--text)' }}>{pct(data.funnel[2].value, data.funnel[1].value)}</b></span>
                <span>Conversion <b className="num" style={{ color: 'var(--text)' }}>{pct(data.funnel[4].value, data.funnel[1].value)}</b></span>
              </div>
            )}
          </Card>
        </div>

        <div className="grid-3 mt-16">
          <Card title="Lead sources" sub="This period">
            {data && <HBars rows={data.sources} color="var(--chart-2)" emptyText="No leads discovered in this period." />}
          </Card>
          <Card title="Industries" sub="Top categories, all leads">
            {data && <HBars rows={data.industries} color="var(--chart-5)" emptyText="No leads yet." />}
          </Card>
          <Card title="Email verification" sub="Results across all addresses">
            {data && (
              <HBars
                rows={data.verification.map((v: any) => ({ name: v.name[0].toUpperCase() + v.name.slice(1), value: v.value }))}
                colors={Object.fromEntries(Object.entries(VERIF_COLORS).map(([k, c]) => [k[0].toUpperCase() + k.slice(1), c]))}
                emptyText="No emails collected yet."
              />
            )}
          </Card>
        </div>

        <div className="grid-3 mt-16" style={{ gridTemplateColumns: '2fr 1fr' }}>
          <Card title="Campaign performance" sub="Most recent campaigns" tight>
            {!data?.campaigns?.length ? (
              <EmptyState icon={<Send size={20} />} title="No campaigns yet" desc="Create a WhatsApp or email campaign to start reaching your leads." action={<Button onClick={() => go('wa-campaigns')}>Create campaign</Button>} />
            ) : (
              <table className="tbl compact">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Sent</th>
                    <th style={{ textAlign: 'right' }}>Replied</th>
                    <th style={{ textAlign: 'right' }}>Interested</th>
                    <th style={{ width: 140 }}>Reply rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((c: any) => (
                    <tr key={c.id} className="clickable" onClick={() => go(c.channel === 'whatsapp' ? 'wa-campaigns' : 'email-campaigns', { id: c.id })}>
                      <td>
                        <div className="primary-cell truncate">{c.name}</div>
                        <div className="sub-cell">{c.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}</div>
                      </td>
                      <td><StatusPill status={c.status} /></td>
                      <td className="num" style={{ textAlign: 'right' }}>{fmtNum(c.sent)}</td>
                      <td className="num" style={{ textAlign: 'right' }}>{fmtNum(c.replied)}</td>
                      <td className="num" style={{ textAlign: 'right' }}>{fmtNum(c.interested)}</td>
                      <td>
                        <div className="row">
                          <div className="bar-mini grow"><div style={{ width: pct(c.replied, c.sent), background: 'var(--chart-3)' }} /></div>
                          <span className="num faint" style={{ fontSize: 12, width: 34, textAlign: 'right' }}>{pct(c.replied, c.sent)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Recent activity" tight>
            {!data?.recent?.length ? (
              <EmptyState title="Quiet so far" desc="Actions across the workspace will be listed here." />
            ) : (
              data.recent.map((a: any, i: number) => (
                <div key={i} className="list-row" style={{ padding: '9px 18px' }}>
                  <span className="dot" style={{ background: a.actor === 'ai' ? 'var(--chart-5)' : a.actor === 'user' ? 'var(--chart-2)' : 'var(--chart-6)' }} />
                  <span className="grow truncate" style={{ fontSize: 12.5 }}>{humanize(a.action)}</span>
                  <span className="faint" style={{ fontSize: 11.5 }}>{fmtRelative(a.created_at)}</span>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function humanize(a: string) {
  const s = a.replace(/_/g, ' ')
  return s[0].toUpperCase() + s.slice(1)
}

function StatusRow({ icon, label, value, status, onClick }: { icon: React.ReactNode; label: string; value: string; status: string | null; onClick: () => void }) {
  return (
    <div className="list-row" style={{ cursor: 'pointer', padding: '11px 18px' }} onClick={onClick}>
      <span className="faint">{icon}</span>
      <div className="grow">
        <div style={{ fontSize: 12.5, fontWeight: 550 }}>{label}</div>
        <div className="faint truncate" style={{ fontSize: 12 }}>{value}</div>
      </div>
      {status && <StatusPill status={status} />}
    </div>
  )
}
