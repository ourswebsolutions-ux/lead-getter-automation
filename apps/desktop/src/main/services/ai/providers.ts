import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import Groq from 'groq-sdk'
import { GoogleGenAI } from '@google/genai'
import { db } from '../../db'
import { secrets } from '../../security/secrets'
import { getSettings } from '../../core/settings'
import { logger } from '../../core/logger'
import { bus } from '../../core/events'
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
  /** JSON Schema for constrained output where the model supports strict structured outputs (else plain JSON mode). */
  schema?: { name: string; schema: Record<string, unknown> }
}

/** Models with strict structured outputs (constrained decoding). Groq: console.groq.com/docs/structured-outputs */
export function supportsStrictSchema(p: ProviderId, model: string): boolean {
  if (p === 'groq') return /^(openai\/gpt-oss-(20b|120b)|qwen\/qwen3\.8)/.test(model)
  if (p === 'openai') return /^(gpt-4o|gpt-4\.1|gpt-5|o[134])/.test(model)
  // Claude structured outputs (output_config.format): Fable/Mythos 5.x, Opus 5.5/5/4.8, Sonnet 5.5/5, Haiku 5.5/4.5, Opus 4.5/4.1.
  if (p === 'anthropic') return /^claude-(fable-5|mythos-5|opus-5|opus-4-[158]|sonnet-5|haiku-5-5|haiku-4-5)/.test(model)
  // Gemini 2.x+ takes a JSON Schema in responseJsonSchema.
  if (p === 'gemini') return /^gemini-([2-9]|\d{2})/.test(model)
  return false
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
  { id: 'groq', name: 'Groq', suggested: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'], docs: 'https://console.groq.com/keys' }
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
    const strict = !!(req.json && req.schema && supportsStrictSchema(p, model))
    const system = req.json && !strict ? `${req.system}\n\nRespond with a single valid JSON object only — no prose, no code fences.` : req.system
    const output_config = {
      ...(/^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model) ? { effort: 'low' as const } : {}),
      ...(strict ? { format: { type: 'json_schema' as const, schema: req.schema!.schema } } : {})
    }
    // Claude 4.6+/5.x: sampling parameters are not accepted, so temperature is intentionally omitted.
    const params = { model, max_tokens: Math.max(max, 2048), system, messages: req.messages, ...(Object.keys(output_config).length ? { output_config } : {}) }
    // Models with safety classifiers: if one declines, the API re-runs the request on a suitable fallback model in the same call.
    const res: any = /^claude-(fable-5-[12]|mythos-5-[12]|opus-5-5|opus-5|sonnet-5-5)$/.test(model)
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as any)
      : await client.messages.create(params)
    if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer this request.')
    const text = res.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('')
    return { text, provider: p, model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
  }
  if (p === 'openai' || p === 'groq') {
    const client: any = p === 'openai' ? new OpenAI({ apiKey: apiKey(p), maxRetries: 2, timeout: 120_000 }) : new Groq({ apiKey: apiKey(p), maxRetries: 2, timeout: 120_000 })
    const res = await createCompletion(client, {
      model,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      ...(p === 'openai' ? { max_completion_tokens: max } : { max_tokens: max }),
      ...(p === 'groq' || openaiSupportsTemperature(model) ? { temperature } : {}),
      ...(req.json
        ? {
            response_format:
              req.schema && supportsStrictSchema(p, model)
                ? { type: 'json_schema', json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema } }
                : { type: 'json_object' }
          }
        : {}),
      // gpt-oss on Groq: low reasoning keeps answers fast and within the free tier's token-per-minute limit.
      // Groq reasoning models (docs: console.groq.com/docs/reasoning): gpt-oss takes low|medium|high; Qwen takes none..high
      // and needs reasoning off (or parsed/hidden) with JSON mode.
      ...(p === 'groq' && /gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
      ...(p === 'groq' && /^qwen\//.test(model) ? { reasoning_effort: 'none' } : {})
    }, p)
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
        ...(req.json ? { responseMimeType: 'application/json' } : {}),
        ...(req.json && req.schema && supportsStrictSchema(p, model) ? { responseJsonSchema: req.schema.schema } : {})
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

export const isDailyLimit = (e: any) => /tokens per day|requests per day|\bTPD\b|\bRPD\b/i.test(String(e?.message))
let lastLimitNotice = 0

export const isModelGone = (e: any) => e?.status === 404 || /model_not_found|does not exist|decommissioned|no longer supported/i.test(String(e?.message))

/** Picks a model the provider still offers (suggested ones first), saves it as the default and tells the user. */
async function replacementModel(p: ProviderId, gone: string): Promise<string | null> {
  try {
    const available = await listModels(p)
    const pick = PROVIDERS.find((x) => x.id === p)!.suggested.find((m) => m !== gone && available.includes(m)) ?? null
    if (!pick) return null
    db().run('UPDATE ai_providers SET default_model = ? WHERE id = ?', pick, p)
    log.warn(`Model ${gone} is no longer available on ${p}; switched to ${pick}`)
    bus.publish('notify', { title: 'AI model updated', body: `${gone} is no longer offered by ${p}. Now using ${pick}.` })
    return pick
  } catch {
    return null
  }
}

/** Groq rejects a JSON-mode answer that isn't JSON (400 json_validate_failed) but returns the text: keep it so the JSON repair step can fix it. */
async function createCompletion(client: any, body: any, p: ProviderId): Promise<any> {
  try {
    return await client.chat.completions.create(body)
  } catch (e: any) {
    const failed = e?.error?.error?.failed_generation ?? e?.error?.failed_generation
    if (p === 'groq' && typeof failed === 'string') return { choices: [{ message: { content: failed } }], usage: {} }
    throw e
  }
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
    try {
      return { ...(await attempt(primary, resolveModel(primary, req.model))), fellBack: false }
    } catch (e: any) {
      // The saved model was retired by the provider: switch to one that exists and try once more.
      const replacement = !req.model && isModelGone(e) ? await replacementModel(primary, resolveModel(primary)) : null
      if (replacement) return { ...(await attempt(primary, replacement)), fellBack: false }
      // Free plans limit tokens per day per model: use the provider's next recommended model until the limit resets.
      if (!req.model && isDailyLimit(e)) {
        const current = resolveModel(primary)
        for (const m of PROVIDERS.find((x) => x.id === primary)!.suggested.filter((m) => m !== current)) {
          try {
            const r = await attempt(primary, m)
            if (Date.now() - lastLimitNotice > 3600_000) {
              lastLimitNotice = Date.now()
              bus.publish('notify', { title: 'AI daily limit reached', body: `${current} hit its daily limit; using ${m} until it resets.` })
            }
            return { ...r, fellBack: true }
          } catch (e2) {
            if (!isDailyLimit(e2) && !isModelGone(e2)) throw e2
          }
        }
      }
      throw e
    }
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
