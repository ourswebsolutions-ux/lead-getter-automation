import { readFileSync, writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import Papa from 'papaparse'
import ExcelJS from 'exceljs'
import { db } from '../db'
import { upsertLead, leadIdsForFilter, normalizeEmail } from './leads'
import { queueVerification } from './verification'
import { getSettings } from '../core/settings'
import { bus } from '../core/events'
import type { LeadFilter, LeadInput } from '@shared/types'

const MAX_IMPORT_BYTES = 50 * 1024 * 1024
const MAX_ROWS = 200_000

/** Reads CSV/XLSX into an array of string records. Formulas are read as values; nothing is executed. */
export async function readTable(file: string): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const buf = readFileSync(file)
  if (buf.length > MAX_IMPORT_BYTES) throw new Error('File is larger than 50 MB')
  const ext = extname(file).toLowerCase()
  if (ext === '.csv' || ext === '.txt') {
    const parsed = Papa.parse<Record<string, string>>(buf.toString('utf8').replace(/^﻿/, ''), { header: true, skipEmptyLines: true })
    return { headers: parsed.meta.fields ?? [], rows: parsed.data.slice(0, MAX_ROWS) }
  }
  if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    const ws = wb.worksheets[0]
    if (!ws) return { headers: [], rows: [] }
    const headers: string[] = []
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => (headers[col - 1] = cellText(cell.value).trim() || `Column ${col}`))
    const rows: Record<string, string>[] = []
    ws.eachRow((row, n) => {
      if (n === 1 || rows.length >= MAX_ROWS) return
      const rec: Record<string, string> = {}
      headers.forEach((h, i) => (rec[h] = cellText(row.getCell(i + 1).value).trim()))
      if (Object.values(rec).some(Boolean)) rows.push(rec)
    })
    return { headers, rows }
  }
  throw new Error('Unsupported file type — use .csv or .xlsx')
}

function cellText(v: any): string {
  if (v == null) return ''
  if (typeof v === 'object') {
    if ('text' in v) return String(v.text)
    if ('result' in v) return String(v.result ?? '')
    if ('richText' in v) return v.richText.map((r: any) => r.text).join('')
    if (v instanceof Date) return v.toISOString()
    if ('hyperlink' in v) return String(v.hyperlink)
  }
  return String(v)
}

const FIELD_HINTS: Record<string, RegExp> = {
  business_name: /^(business|company|organi[sz]ation|name|business name|company name|account|title|podcast)$/i,
  contact_name: /contact|full ?name|person|owner|first ?name/i,
  job_title: /job|position|designation|role/i,
  email: /e-?mail/i,
  phone: /phone|mobile|tel|whatsapp|contact number/i,
  website: /web|url|site|domain/i,
  address: /address|street/i,
  city: /city|town/i,
  state: /state|province|region/i,
  country: /country/i,
  postal_code: /zip|postal|post ?code/i,
  industry: /industry|sector/i,
  business_category: /category|type/i,
  linkedin_url: /linkedin/i,
  tags: /tags?|labels?/i,
  notes: /notes?|comments?/i
}

export function guessMapping(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [field, re] of Object.entries(FIELD_HINTS)) {
    const h = headers.find((x) => re.test(x.trim()) && !Object.values(map).includes(x))
    if (h) map[field] = h
  }
  return map
}

/** Imports leads with a column mapping {field: header}. Returns counts; queues verification if enabled. */
export function importLeads(rows: Record<string, string>[], mapping: Record<string, string>, opts: { tag?: string; category?: string } = {}) {
  let created = 0
  let merged = 0
  let skipped = 0
  const newEmailIds: number[] = []
  const get = (r: Record<string, string>, f: string) => (mapping[f] ? (r[mapping[f]] ?? '').toString().trim() : '')
  for (const r of rows) {
    const emails = get(r, 'email').split(/[;,\s]+/).map(normalizeEmail).filter((e): e is string => !!e)
    const name = get(r, 'business_name') || get(r, 'contact_name') || (emails[0] ? emails[0].split('@')[1] : '')
    if (!name) {
      skipped++
      continue
    }
    const input: LeadInput = {
      business_name: name.slice(0, 300),
      contact_name: get(r, 'contact_name') || null,
      job_title: get(r, 'job_title') || null,
      phone: get(r, 'phone') || null,
      website: get(r, 'website') || null,
      address: get(r, 'address') || null,
      city: get(r, 'city') || null,
      state: get(r, 'state') || null,
      country: get(r, 'country') || null,
      postal_code: get(r, 'postal_code') || null,
      industry: get(r, 'industry') || null,
      business_category: get(r, 'business_category') || null,
      linkedin_url: get(r, 'linkedin_url') || null,
      source: 'import',
      emails: emails.map((e) => ({ email: e, source_url: 'import' })),
      tags: [...get(r, 'tags').split(/[;,|]/).map((t) => t.trim()).filter(Boolean), ...(opts.tag ? [opts.tag] : [])],
      category: opts.category || null
    }
    try {
      const res = upsertLead(input)
      if (res.created) created++
      else merged++
      newEmailIds.push(...res.newEmailIds)
      const notes = get(r, 'notes')
      if (notes) db().run('UPDATE leads SET notes = COALESCE(notes, ?) WHERE id = ?', notes, res.id)
    } catch {
      skipped++
    }
  }
  let verification = 0
  if (getSettings().verification.autoVerify && newEmailIds.length) verification = queueVerification(newEmailIds, { label: `Verify imported emails` }).count
  bus.publish('leads:changed', {})
  return { created, merged, skipped, verificationQueued: verification }
}

const EXPORT_COLUMNS: [string, string][] = [
  ['id', 'Lead ID'], ['business_name', 'Business Name'], ['contact_name', 'Contact Name'], ['job_title', 'Job Title'],
  ['category', 'Category'], ['business_category', 'Business Category'], ['industry', 'Industry'], ['emails', 'Emails'],
  ['email_status', 'Email Verification'], ['phone', 'Phone'], ['website', 'Website'], ['address', 'Address'], ['city', 'City'],
  ['state', 'State'], ['country', 'Country'], ['postal_code', 'Postal Code'], ['source', 'Source'], ['source_url', 'Source URL'],
  ['linkedin_url', 'LinkedIn'], ['rating', 'Rating'], ['review_count', 'Reviews'], ['outreach_status', 'Outreach Status'],
  ['tags', 'Tags'], ['notes', 'Notes'], ['discovered_at', 'Discovered']
]

/** Spreadsheet formula-injection guard for exported cells. */
export function safeCell(v: unknown): string | number {
  if (v == null) return ''
  if (typeof v === 'number') return v
  const s = String(v)
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}

export function exportRows(input: { leadIds?: number[]; filter?: LeadFilter }) {
  const ids = input.leadIds?.length ? input.leadIds : leadIdsForFilter(input.filter ?? {})
  if (!ids.length) return []
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    out.push(
      ...db().all(
        `SELECT l.*, c.name category,
           (SELECT group_concat(ea.email, '; ') FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = l.id) emails,
           (SELECT group_concat(ea.email || ': ' || ea.verification_status, '; ') FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = l.id) email_status,
           (SELECT group_concat(tag, ', ') FROM lead_tags t WHERE t.lead_id = l.id) tags
         FROM leads l LEFT JOIN lead_categories c ON c.id = l.category_id WHERE l.id IN (${chunk.map(() => '?').join(',')})`,
        ...chunk
      )
    )
  }
  return out
}

export async function writeExport(file: string, rows: Record<string, unknown>[], columns: [string, string][] = EXPORT_COLUMNS): Promise<number> {
  if (file.toLowerCase().endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook()
    wb.creator = 'Lead Generation'
    const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.columns = columns.map(([key, header]) => ({ header, key, width: Math.min(48, Math.max(12, header.length + 4)) }))
    ws.getRow(1).font = { bold: true }
    for (const r of rows) ws.addRow(Object.fromEntries(columns.map(([k]) => [k, safeCell(r[k])])))
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }
    await wb.xlsx.writeFile(file)
  } else {
    const csv = Papa.unparse({ fields: columns.map(([, h]) => h), data: rows.map((r) => columns.map(([k]) => safeCell(r[k]))) })
    writeFileSync(file, '﻿' + csv, 'utf8')
  }
  return rows.length
}

export const VERIFICATION_COLUMNS: [string, string][] = [
  ['email', 'Email'], ['status', 'Status'], ['reason', 'Reason'], ['business_name', 'Business'], ['created_at', 'Verified At']
]
