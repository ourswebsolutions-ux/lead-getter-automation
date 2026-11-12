# AI providers

AI Sales Agent → **AI providers**. Each provider uses its **official SDK** with your own API key:

| Provider | SDK | Suggested models | Get a key |
|---|---|---|---|
| Anthropic Claude | `@anthropic-ai/sdk` | `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-5-5` | console.anthropic.com |
| OpenAI | `openai` | any chat model your key can use | platform.openai.com/api-keys |
| Google Gemini | `@google/genai` | `gemini-2.5-pro`, `gemini-2.5-flash` | aistudio.google.com/apikey |
| Groq | `groq-sdk` | `llama-3.3-70b-versatile`, … | console.groq.com/keys |

**Test connection** lists every model available to your key (via each provider's models endpoint) and sends a tiny test prompt. A ChatGPT or Claude.ai subscription does **not** include API credits.

## Behaviour

* **Default provider/model** are used for all AI work. Temperature and max tokens are configurable; temperature is not sent to Claude 5-family models (they reject sampling parameters) or to OpenAI reasoning models.
* **Fallback** (optional): only if the default provider fails, the explicitly chosen fallback provider is used **with its own configured default model**. The app never silently switches models within a provider. Anthropic's server-side model fallback is deliberately not enabled, for the same reason.
* **Usage & logs** shows calls, input/output tokens, latency and errors per provider/model.
* Claude refusals (`stop_reason: "refusal"`) surface as errors instead of empty replies.

## What the agent does

1. **Research** — reads up to 5 pages of the lead's site and returns summary, business model, services, digital presence, opportunities and recommended solutions (from *your* services).
2. **Outreach** — first-touch email/WhatsApp message using research, your strategy, tone, language and templates.
3. **Conversations** — answers like a business developer, one question at a time, keeps a running memory (summary + structured requirements), detects interest/not-interested.
4. **Suggestion Mode** — on any pricing/budget question the agent stops, scopes the project, picks service keys, and the app computes the range from **AI Sales Agent → Pricing rules**. Without rules, no figures are produced and you are asked to configure pricing. Nothing commercial is sent without **Approve & send**.
5. **Human takeover** — Pause AI, Take over, Resume; manual replies always allowed; AI drafts are discarded if anyone wrote after drafting began.

Configure your company, services, signature, tone and whether routine replies auto-send under **Company & persona**.
