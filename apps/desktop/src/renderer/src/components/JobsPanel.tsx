import { useState } from 'react'
import { Pause, Play, X, ScrollText, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { rpc, useQuery, useAction } from '../lib/rpc'
import { fmtRelative } from '../lib/format'
import { Button, Card, EmptyState, Modal, Progress, StatusPill } from './ui'
import type { Job } from '@shared/types'

export function JobsPanel({ types, title = 'Background tasks', emptyText = 'Tasks you start appear here with live progress.', limit = 8, onResult }: {
  types: string[]
  title?: string
  emptyText?: string
  limit?: number
  onResult?: (job: Job) => React.ReactNode
}) {
  const { data: jobs, loading } = useQuery<Job[]>('jobs:list', [{ types, limit }], { events: ['job:*'] })
  const [logsFor, setLogsFor] = useState<Job | null>(null)
  const { data: logs } = useQuery<any[]>('jobs:logs', [logsFor?.id], { enabled: !!logsFor, events: ['job:*'] })
  const { run } = useAction()
  return (
    <Card title={title} sub="Runs in the background — you can leave this page." tight>
      {loading && !jobs ? (
        <div style={{ padding: 18 }} className="col gap-12">
          <div className="skel" style={{ height: 14 }} />
          <div className="skel" style={{ height: 14, width: '70%' }} />
        </div>
      ) : !jobs?.length ? (
        <EmptyState icon={<Clock size={20} />} title="No tasks yet" desc={emptyText} />
      ) : (
        jobs.map((j) => {
          const active = ['queued', 'running', 'paused'].includes(j.status)
          let result: any = null
          try {
            result = j.result ? JSON.parse(j.result) : null
          } catch {
            /* ignore */
          }
          return (
            <div key={j.id} className="list-row" style={{ alignItems: 'flex-start' }}>
              <div style={{ marginTop: 2 }}>
                {j.status === 'completed' ? <CheckCircle2 size={16} color="var(--green)" /> : j.status === 'failed' ? <XCircle size={16} color="var(--red)" /> : <StatusPill status={j.status} label="" />}
              </div>
              <div className="grow col gap-4">
                <div className="row">
                  <div className="truncate grow" style={{ fontWeight: 550 }}>{j.title}</div>
                  <StatusPill status={j.status} />
                </div>
                {active && <Progress value={j.progress} total={j.total} indeterminate={j.status === 'queued'} />}
                <div className="faint" style={{ fontSize: 12 }}>
                  {j.error ? <span style={{ color: 'var(--red)' }}>{j.error}</span> : j.message ?? (j.status === 'queued' ? 'Waiting to start…' : '')}
                  {j.total > 0 && active && <span className="num"> · {j.progress}/{j.total}</span>}
                  <span> · {fmtRelative(j.created_at)}</span>
                </div>
                {result && j.status === 'completed' && (onResult ? onResult(j) : <ResultLine r={result} />)}
              </div>
              <div className="row gap-4">
                {j.status === 'running' && <Button size="sm" variant="ghost" iconOnly icon={<Pause size={14} />} title="Pause" onClick={() => run('p', () => rpc('jobs:pause', j.id))} />}
                {(j.status === 'paused' || j.status === 'failed') && <Button size="sm" variant="ghost" iconOnly icon={<Play size={14} />} title="Resume" onClick={() => run('r', () => rpc('jobs:resume', j.id))} />}
                {active && <Button size="sm" variant="ghost" iconOnly icon={<X size={14} />} title="Cancel" onClick={() => run('c', () => rpc('jobs:cancel', j.id))} />}
                <Button size="sm" variant="ghost" iconOnly icon={<ScrollText size={14} />} title="Logs" onClick={() => setLogsFor(j)} />
              </div>
            </div>
          )
        })
      )}
      <Modal open={!!logsFor} onClose={() => setLogsFor(null)} title="Task log" desc={logsFor?.title} size="wide">
        {!logs?.length ? (
          <div className="faint">No log entries.</div>
        ) : (
          <div className="mono" style={{ maxHeight: 420, overflow: 'auto', lineHeight: 1.7 }}>
            {logs.map((l, i) => (
              <div key={i} style={{ color: l.level === 'error' ? 'var(--red)' : l.level === 'warn' ? 'var(--amber)' : 'var(--text-2)' }}>
                <span className="faint">{l.created_at.slice(11, 19)}</span> {l.message}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </Card>
  )
}

function ResultLine({ r }: { r: Record<string, any> }) {
  const parts = Object.entries(r)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${v.toLocaleString()} ${k.replace(/_/g, ' ')}`)
  if (!parts.length) return null
  return <div style={{ fontSize: 12 }} className="muted">{parts.join(' · ')}</div>
}
