import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import Groq from 'groq-sdk'
import { GoogleGenAI } from '@google/genai'
import { db } from '../../db'
import { secrets } from '../../security/secrets'
import { getSettings } from '../../core/settings'
import { logger } from '../../core/logger'
import type { ProviderId } from '@shared/settings'

const log = logger('ai')

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface GenerateRequest {
  purpose: string
  system: string
  messages: ChatMessage[]
  json?: boolean
  maxTokens?: number
  provider?: ProviderId
  model?: string
  /** Allow the configured fallback provider for this call (default true). */
  allowFallback?: boolean
}

export interface GenerateResult {
  text: string
  provider: ProviderId
  model: string
  inputTokens: number
  outputTokens: number
  fellBack: boolean
}

export const PROVIDERS: { id: ProviderId; name: string; suggested: string[]; docs: string }[] = [
  { id: 'anthropic', name: 'Anthropic Claude', suggested: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], docs: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', suggested: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'], docs: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', name: 'Google Gemini', suggested: ['gemini-2.5-pro', 'gemini-2.5-flash'], docs: 'https://aistudio.google.com/apikey' },
  { id: 'groq', name: 'Groq', suggested: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'], docs: 'https://console.groq.com/keys' }
]

export const keyName = (p: ProviderId) => `ai.${p}.key`

function apiKey(p: ProviderId): string {
  const k = secrets.get(keyName(p))
  if (!k) throw new Error(`No API key configured for ${p}. Add it in AI Sales Agent → Providers.`)
  return k
}

/** OpenAI reasoning models reject custom temperature. */
function openaiSupportsTemperature(model: string): boolean {
  return !/^(o\d|gpt-5)/i.test(model)
}

async function callProvider(p: ProviderId, model: string, req: GenerateRequest): Promise<Omit<GenerateResult, 'fellBack'>> {
  const { temperature, maxTokens } = getSettings().ai
  const max = req.maxTokens ?? maxTokens
  if (p === 'anthropic') {
    const client = new Anthropic({ apiKey: apiKey(p), maxRetries: 2, timeout: 120_000 })
    const system = req.json ? `${req.system}\n\nRespond with a single valid JSON object only — no prose, no code fences.` : req.system
    // Claude 4.6+/5.x: sampling parameters are not accepted, so temperature is intentionally omitted.
    const res = await client.messages.create({
      model,
      max_tokens: Math.max(max, 2048),
      system,
      messages: req.messages,
      ...(/^claude-(opus|sonnet|haiku|fable)-5/.test(model) ? { output_config: { effort: 'low' as const } } : {})
    })
    if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer this request.')
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    return { text, provider: p, model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
  }
  if (p === 'openai' || p === 'groq') {
    const client: any = p === 'openai' ? new OpenAI({ apiKey: apiKey(p), maxRetries: 2, timeout: 120_000 }) : new Groq({ apiKey: apiKey(p), maxRetries: 2, timeout: 120_000 })
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      ...(p === 'openai' ? { max_completion_tokens: max } : { max_tokens: max }),
      ...(p === 'groq' || openaiSupportsTemperature(model) ? { temperature } : {}),
      ...(req.json ? { response_format: { type: 'json_object' } } : {})
    })
    return {
      text: res.choices?.[0]?.message?.content ?? '',
      provider: p,
      model,
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0
    }
  }
  if (p === 'gemini') {
    const ai = new GoogleGenAI({ apiKey: apiKey(p) })
    const res = await ai.models.generateContent({
      model,
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      config: {
        systemInstruction: req.system,
        temperature,
        maxOutputTokens: Math.max(max, 2048),
        ...(req.json ? { responseMimeType: 'application/json' } : {})
      }
    })
    return {
      text: res.text ?? '',
      provider: p,
      model,
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0
    }
  }
  throw new Error(`Unknown provider ${p}`)
}

function recordUsage(r: { provider: string; model: string; purpose: string; inputTokens?: number; outputTokens?: number; latency: number; ok: boolean; error?: string }) {
  db().run(
    'INSERT INTO ai_usage (provider, model, purpose, input_tokens, output_tokens, latency_ms, ok, error) VALUES (?,?,?,?,?,?,?,?)',
    r.provider, r.model, r.purpose, r.inputTokens ?? 0, r.outputTokens ?? 0, r.latency, r.ok ? 1 : 0, r.error?.slice(0, 500) ?? null
  )
}

function resolveModel(p: ProviderId, override?: string): string {
  if (override) return override
  const row = db().get<{ default_model: string | null }>('SELECT default_model FROM ai_providers WHERE id = ?', p)
  return row?.default_model || PROVIDERS.find((x) => x.id === p)!.suggested[0]
}

export function aiConfigured(): boolean {
  const p = getSettings().ai.defaultProvider
  return !!p && secrets.has(keyName(p))
}

export async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const settings = getSettings().ai
  const primary = req.provider ?? settings.defaultProvider
  if (!primary) throw new Error('No AI provider selected. Configure one in AI Sales Agent → Providers.')
  const attempt = async (p: ProviderId, model: string) => {
    const t0 = Date.now()
    try {
      const r = await callProvider(p, model, req)
      recordUsage({ provider: p, model, purpose: req.purpose, inputTokens: r.inputTokens, outputTokens: r.outputTokens, latency: Date.now() - t0, ok: true })
      return r
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      recordUsage({ provider: p, model, purpose: req.purpose, latency: Date.now() - t0, ok: false, error: msg })
      db().run("UPDATE ai_providers SET status = 'error', last_error = ? WHERE id = ?", msg.slice(0, 500), p)
      throw e
    }
  }
  try {
    return { ...(await attempt(primary, resolveModel(primary, req.model))), fellBack: false }
  } catch (e) {
    const fb = settings.fallbackProvider
    if (req.allowFallback !== false && settings.fallbackEnabled && fb && fb !== primary && secrets.has(keyName(fb))) {
      log.warn(`Primary provider ${primary} failed; using configured fallback ${fb}`)
      // Fallback always uses that provider's own configured default model — never a silent model swap within a provider.
      return { ...(await attempt(fb, resolveModel(fb))), fellBack: true }
    }
    throw e
  }
}

/** Parses JSON from model output, tolerating code fences or leading prose. */
export function parseJson<T = any>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try {
    return JSON.parse(t)
  } catch {
    const start = t.indexOf('{')
    const end = t.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1))
    throw new Error('AI response was not valid JSON')
  }
}

export async function generateJson<T = any>(req: Omit<GenerateRequest, 'json'>): Promise<T & { _meta: GenerateResult }> {
  const r = await generate({ ...req, json: true })
  try {
    return { ...parseJson<T>(r.text), _meta: r }
  } catch {
    // One repair attempt.
    const r2 = await generate({
      ...req,
      json: true,
      messages: [...req.messages, { role: 'assistant', content: r.text }, { role: 'user', content: 'That was not valid JSON. Return only the corrected JSON object.' }]
    })
    return { ...parseJson<T>(r2.text), _meta: r2 }
  }
}

// ---------------------------------------------------------------- management

export async function listModels(p: ProviderId): Promise<string[]> {
  if (p === 'anthropic') {
    const client = new Anthropic({ apiKey: apiKey(p) })
    const out: string[] = []
    for await (const m of client.models.list({ limit: 100 })) out.push(m.id)
    return out
  }
  if (p === 'openai' || p === 'groq') {
    const client: any = p === 'openai' ? new OpenAI({ apiKey: apiKey(p) }) : new Groq({ apiKey: apiKey(p) })
    const res = await client.models.list()
    const data = res.data ?? []
    return data.map((m: any) => m.id).filter((id: string) => p === 'groq' || /^(gpt|o\d|chatgpt)/.test(id)).sort()
  }
  const ai = new GoogleGenAI({ apiKey: apiKey(p) })
  const out: string[] = []
  const pager = await ai.models.list()
  for await (const m of pager) {
    if ((m.supportedActions ?? []).includes('generateContent') && m.name) out.push(m.name.replace(/^models\//, ''))
  }
  return out
}

export async function testProvider(p: ProviderId): Promise<{ ok: boolean; message: string; models: string[] }> {
  try {
    const models = await listModels(p)
    const model = resolveModel(p)
    const r = await callProvider(p, model, { purpose: 'connection_test', system: 'Reply with the single word: OK', messages: [{ role: 'user', content: 'Connection test' }], maxTokens: 20 })
    recordUsage({ provider: p, model, purpose: 'connection_test', inputTokens: r.inputTokens, outputTokens: r.outputTokens, latency: 0, ok: true })
    db().run("UPDATE ai_providers SET status = 'ok', last_error = NULL, last_tested_at = datetime('now'), enabled = 1 WHERE id = ?", p)
    return { ok: true, message: `Connected. ${model} replied: “${r.text.trim().slice(0, 40)}”`, models }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    db().run("UPDATE ai_providers SET status = 'error', last_error = ?, last_tested_at = datetime('now') WHERE id = ?", msg.slice(0, 500), p)
    return { ok: false, message: msg, models: [] }
  }
}

export function providerStatus() {
  const rows = db().all<any>('SELECT * FROM ai_providers')
  return PROVIDERS.map((p) => {
    const r = rows.find((x) => x.id === p.id) ?? {}
    return { ...p, ...r, hasKey: secrets.has(keyName(p.id)), keyPreview: secrets.mask(keyName(p.id)) }
  })
}

export function saveProvider(p: ProviderId, patch: { apiKey?: string | null; defaultModel?: string | null; enabled?: boolean }) {
  if (patch.apiKey !== undefined) {
    secrets.set(keyName(p), patch.apiKey)
    db().run("UPDATE ai_providers SET status = ? WHERE id = ?", patch.apiKey ? 'unconfigured' : 'unconfigured', p)
  }
  if (patch.defaultModel !== undefined) db().run('UPDATE ai_providers SET default_model = ? WHERE id = ?', patch.defaultModel, p)
  if (patch.enabled !== undefined) db().run('UPDATE ai_providers SET enabled = ? WHERE id = ?', patch.enabled ? 1 : 0, p)
}

export function usageSummary(days = 30) {
  return {
    byProvider: db().all(
      `SELECT provider, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(1 - ok) errors
       FROM ai_usage WHERE created_at >= datetime('now', ?) GROUP BY provider, model ORDER BY calls DESC`,
      `-${days} days`
    ),
    recent: db().all('SELECT * FROM ai_usage ORDER BY id DESC LIMIT 100'),
    errors: db().all('SELECT * FROM ai_usage WHERE ok = 0 ORDER BY id DESC LIMIT 50')
  }
}
