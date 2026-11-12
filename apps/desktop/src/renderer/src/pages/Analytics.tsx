import { useState } from 'react'
import { Download, Ban, Plus, Trash2 } from 'lucide-react'
import { rpc, useAction, useQuery } from '../lib/rpc'
import { fmtNum, pct, fmtDate } from '../lib/format'
import { Button, Card, PageHeader, Segmented, Stat, StatusPill, Tabs, EmptyState, Input, Select } from '../components/ui'
import { TimeArea, MultiLine, HBars, fillDays } from '../components/charts'
import { rangeFor, VERIF_COLORS } from './Dashboard'

type R = '7d' | '30d' | '90d' | '365d'

export function AnalyticsPage() {
  const [tab, setTab] = useState<'overview' | 'campaigns' | 'suppression' | 'activity'>('overview')
  const [range, setRange] = useState<R>('30d')
  const r = rangeFor(range)
  const { data } = useQuery<any>('analytics:dashboard', [r], { events: ['leads:changed', 'campaign:*', 'conversation:*'] })
  const s = data?.stats
  const exportCsv = () => {
    if (!data) return
    const rows = [['Campaign', 'Channel', 'Status', 'Sent', 'Replied', 'Interested', 'Failed', 'Reply rate'], ...data.campaigns.map((c: any) => [c.name, c.channel, c.status, c.sent, c.replied, c.interested, c.failed, pct(c.replied, c.sent)])]
    const csv = rows.map((row) => row.map((v: any) => `"${String(v).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }))
    a.download = `campaign-report-${r.from}-to-${r.to}.csv`
    a.click()
  }
  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow="Insights"
          title="Analytics & Reports"
          desc={`${fmtDate(r.from)} – ${fmtDate(r.to)}`}
          actions={<>
            <Segmented<R> value={range} onChange={setRange} options={[{ value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: '90d', label: '90 days' }, { value: '365d', label: '12 months' }]} />
            <Button icon={<Download size={14} />} onClick={exportCsv}>Export report</Button>
          </>}
        />
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'campaigns', label: 'Campaigns' }, { value: 'suppression', label: 'Opt-outs & suppression' }, { value: 'activity', label: 'Audit log' }]} />
        {tab === 'overview' && data && (
          <div className="col gap-16">
            <div className="grid-4">
              <Stat label="New leads" value={fmtNum(s.newLeads)} foot={`${fmtNum(s.totalLeads)} total`} />
              <Stat label="Messages sent" value={fmtNum(s.whatsappSent + s.emailsSent)} foot={`${fmtNum(s.whatsappSent)} WhatsApp · ${fmtNum(s.emailsSent)} email`} />
              <Stat label="Replies" value={fmtNum(s.repliesReceived)} foot={`${pct(s.repliesReceived, s.whatsappSent + s.emailsSent)} of messages sent`} />
              <Stat label="Conversion" value={pct(data.funnel[4].value, data.funnel[1].value)} foot={`${fmtNum(data.funnel[4].value)} converted of ${fmtNum(data.funnel[1].value)} contacted`} />
            </div>
            <div className="grid-2">
              <Card title="Leads over time"><TimeArea data={fillDays(data.leadsOverTime, r.from, r.to, { leads: 0 })} dataKey="leads" name="Leads" /></Card>
              <Card title="Communication activity"><MultiLine data={fillDays(data.activity, r.from, r.to, { whatsapp_out: 0, email_out: 0, replies: 0 })} series={[{ key: 'whatsapp_out', name: 'WhatsApp sent', color: 'var(--chart-3)' }, { key: 'email_out', name: 'Emails sent', color: 'var(--chart-2)' }, { key: 'replies', name: 'Replies', color: 'var(--chart-1)' }]} /></Card>
            </div>
            <div className="grid-3">
              <Card title="Lead sources"><HBars rows={data.sources} color="var(--chart-2)" emptyText="No leads in this period." /></Card>
              <Card title="Industry distribution"><HBars rows={data.industries} color="var(--chart-5)" /></Card>
              <Card title="Verification results"><HBars rows={data.verification.map((v: any) => ({ name: v.name[0].toUpperCase() + v.name.slice(1), value: v.value }))} colors={Object.fromEntries(Object.entries(VERIF_COLORS).map(([k, c]) => [k[0].toUpperCase() + k.slice(1), c]))} /></Card>
            </div>
            <Card title="Outreach funnel"><HBars rows={data.funnel.map((f: any) => ({ name: f.stage, value: f.value }))} color="var(--chart-1)" /></Card>
          </div>
        )}
        {tab === 'campaigns' && (
          <Card tight>
            {!data?.campaigns?.length ? <EmptyState title="No campaigns yet" /> : (
              <table className="tbl">
                <thead><tr><th>Campaign</th><th>Channel</th><th>Status</th><th style={{ textAlign: 'right' }}>Sent</th><th style={{ textAlign: 'right' }}>Replied</th><th style={{ textAlign: 'right' }}>Interested</th><th style={{ textAlign: 'right' }}>Failed</th><th style={{ width: 160 }}>Reply rate</th></tr></thead>
                <tbody>{data.campaigns.map((c: any) => (
                  <tr key={c.id}>
                    <td className="primary-cell">{c.name}</td><td>{c.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}</td><td><StatusPill status={c.status} /></td>
                    <td className="num" style={{ textAlign: 'right' }}>{fmtNum(c.sent)}</td><td className="num" style={{ textAlign: 'right' }}>{fmtNum(c.replied)}</td><td className="num" style={{ textAlign: 'right' }}>{fmtNum(c.interested)}</td><td className="num" style={{ textAlign: 'right' }}>{fmtNum(c.failed)}</td>
                    <td><div className="row"><div className="bar-mini grow"><div style={{ width: pct(c.replied, c.sent), background: 'var(--chart-3)' }} /></div><span className="num faint" style={{ fontSize: 12, width: 36, textAlign: 'right' }}>{pct(c.replied, c.sent)}</span></div></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </Card>
        )}
        {tab === 'suppression' && <Suppression />}
        {tab === 'activity' && <AuditLog />}
      </div>
    </div>
  )
}

function Suppression() {
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('email')
  const [addr, setAddr] = useState('')
  const { data, reload } = useQuery<any[]>('suppression:list', [channel])
  const { run } = useAction()
  return (
    <Card title={<span className="row"><Ban size={14} /> Suppression list</span>} sub="Never contacted again: opt-outs, hard bounces, invalid addresses and manual blocks." actions={<Segmented value={channel} onChange={setChannel} options={[{ value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }]} />} tight>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); run('a', () => rpc('suppression:add', channel, addr, 'Manual'), { success: 'Added' }).then(() => { setAddr(''); reload() }) }}>
        <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={channel === 'email' ? 'email@domain.com' : 'Phone with country code, digits only'} style={{ width: 320 }} />
        <Button type="submit" icon={<Plus size={14} />} disabled={!addr.trim()}>Add</Button>
      </form>
      {!data?.length ? <EmptyState title="Nothing suppressed" /> : (
        <div style={{ maxHeight: 520, overflow: 'auto' }}>
          <table className="tbl compact">
            <thead><tr><th>Address</th><th>Reason</th><th>Added</th><th /></tr></thead>
            <tbody>{data.map((s) => (
              <tr key={s.address}><td className="mono">{s.address}</td><td>{s.reason}</td><td className="faint">{fmtDate(s.created_at, true)}</td><td style={{ textAlign: 'right' }}><Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} title="Remove from suppression" onClick={() => run('r', () => rpc('suppression:remove', channel, s.address)).then(reload)} /></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function AuditLog() {
  const [limit, setLimit] = useState('200')
  const { data } = useQuery<any[]>('app:activity', [Number(limit)])
  return (
    <Card title="Audit log" sub="Security-relevant actions by you, the AI and the system" actions={<Select value={limit} onChange={setLimit} options={['100', '200', '1000'].map((v) => ({ value: v, label: `Last ${v}` }))} />} tight>
      {!data?.length ? <EmptyState title="No activity yet" /> : (
        <div style={{ maxHeight: 560, overflow: 'auto' }}>
          <table className="tbl compact">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
            <tbody>{data.map((a) => (
              <tr key={a.id}><td className="faint">{fmtDate(a.created_at, true)}</td><td><span className={`pill ${a.actor === 'ai' ? 'violet' : a.actor === 'user' ? 'blue' : ''}`}>{a.actor}</span></td><td>{a.action.replace(/_/g, ' ')}</td><td className="faint">{a.entity ? `${a.entity} ${a.entity_id ?? ''}` : ''}</td><td className="faint truncate" style={{ maxWidth: 260 }}>{a.detail ?? ''}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
