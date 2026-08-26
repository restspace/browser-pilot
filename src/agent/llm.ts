/**
 * Provider adapter (thin, swappable). One implementation — OpenAI-compatible
 * chat completions — parameterised by named presets (zhipu, novita, openai,
 * openrouter) or a fully custom base URL. Endpoint/model ids drift; every
 * preset value is overridable by config file, env, or flag, so doc drift is
 * a config change, not a code change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from '../shared/paths.js';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; null when the model emitted unparseable JSON. */
  args: Record<string, unknown> | null;
  rawArgs: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: RawToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface RawToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /**
   * Portion of `promptTokens` that the provider served from its prompt cache
   * (OpenAI-compatible `usage.prompt_tokens_details.cached_tokens`). 0 when the
   * provider doesn't report it. `promptTokens` is the total; `cachedTokens` is a
   * subset billed at the cheaper cache-hit rate — the gap is what actually cost.
   */
  cachedTokens: number;
}

export interface Completion {
  text: string | null;
  toolCalls: ToolCall[];
  /** The assistant message exactly as returned, for appending to history. */
  assistantMessage: ChatMessage;
  usage: Usage;
}

export interface CompleteOptions {
  /**
   * Aborts the in-flight HTTP request. The loop's per-turn watchdog and the
   * daemon's `stop` preemption both drive this — without it a model that
   * reasons without emitting a tool call can consume the whole instruction
   * budget in one uninterruptible request.
   */
  signal?: AbortSignal;
}

export interface Provider {
  readonly model: string;
  complete(messages: ChatMessage[], tools: ToolDef[], opts?: CompleteOptions): Promise<Completion>;
}

export interface ProviderConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Stronger model used only to retry an instruction the routine model left
   * blocked (see runEscalatingInstruction). Empty/undefined disables escalation.
   */
  fallbackModel?: string;
  temperature?: number;
  /**
   * Extra fields merged verbatim into every chat/completions request body.
   * Escape hatch for provider-specific routing that no preset should know
   * about — e.g. OpenRouter's {"provider":{"only":["Baidu"]}} backend pin.
   * Set via BROWSER_PILOT_EXTRA_BODY as a JSON object; it is spread LAST, so
   * it can override anything, deliberately.
   */
  extraBody?: Record<string, unknown>;
  /** Env vars that were consulted for the key — for error messages. */
  keyEnvVars: string[];
}

export interface ProviderPreset {
  baseUrl: string;
  defaultModel: string;
  /** Preset escalation tier; omit where no obviously stronger sibling exists. */
  fallbackModel?: string;
  keyEnvVars: string[];
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  // Z.ai international endpoint; mainland alternative: https://open.bigmodel.cn/api/paas/v4
  // (Coding Plan subscriptions use /api/coding/paas/v4 instead.)
  zhipu: {
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.2',
    keyEnvVars: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
  },
  // Model picks are benchmarked, not guessed: deepseek-v4-flash drove the real
  // agent loop ~2x faster and ~12x cheaper than glm-5.2 at the same pass rate,
  // and glm-5.3 solved the hardest probe in the fewest turns of anything tried
  // (at glm-5.2's list price), which is what you want on the escalation path.
  novita: {
    baseUrl: 'https://api.novita.ai/openai',
    defaultModel: 'deepseek/deepseek-v4-flash',
    fallbackModel: 'zai-org/glm-5.3',
    keyEnvVars: ['NOVITA_API_KEY'],
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'z-ai/glm-5.2',
    keyEnvVars: ['OPENROUTER_API_KEY'],
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5-mini',
    keyEnvVars: ['OPENAI_API_KEY'],
  },
  // Not OpenAI-compatible — see AnthropicProvider. A stronger, pricier fallback
  // tier: useful for escalating specific instructions that a cheaper model
  // couldn't complete, without paying Anthropic prices for the whole session.
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5',
    keyEnvVars: ['ANTHROPIC_API_KEY'],
  },
};

export const DEFAULT_PROVIDER = 'zhipu';

export interface GlobalConfig {
  provider?: string;
  model?: string;
  fallbackModel?: string;
  baseUrl?: string;
  apiKey?: string;
}

const CONFIG_KEYS: (keyof GlobalConfig)[] = ['provider', 'model', 'fallbackModel', 'baseUrl', 'apiKey'];

export function globalConfigPath(): string {
  return path.join(rootDir(), 'config.json');
}

export function readGlobalConfig(): GlobalConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(globalConfigPath(), 'utf8'));
    const out: GlobalConfig = {};
    for (const key of CONFIG_KEYS) {
      if (typeof raw[key] === 'string' && raw[key]) out[key] = raw[key];
    }
    return out;
  } catch {
    return {};
  }
}

export function writeGlobalConfig(updates: GlobalConfig): GlobalConfig {
  for (const key of Object.keys(updates)) {
    if (!CONFIG_KEYS.includes(key as keyof GlobalConfig)) {
      throw new Error(`unknown config key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`);
    }
  }
  const merged = { ...readGlobalConfig(), ...updates };
  for (const key of CONFIG_KEYS) {
    if (merged[key] === '') delete merged[key]; // setting to "" clears a key
  }
  fs.mkdirSync(rootDir(), { recursive: true });
  fs.writeFileSync(globalConfigPath(), JSON.stringify(merged, null, 2));
  return merged;
}

export interface ProviderOverrides {
  provider?: string;
  baseUrl?: string;
  model?: string;
  fallbackModel?: string;
  apiKey?: string;
  temperature?: number;
}

/**
 * Precedence per field: explicit override (flag) > env > global config file >
 * provider preset. The preset is chosen the same way, then supplies defaults
 * for whatever remains unset.
 */
export function resolveProviderConfig(overrides: ProviderOverrides = {}): ProviderConfig {
  const file = readGlobalConfig();
  const provider =
    overrides.provider || process.env.BROWSER_PILOT_PROVIDER || file.provider || DEFAULT_PROVIDER;
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) {
    throw new Error(
      `unknown provider "${provider}" (available: ${Object.keys(PROVIDER_PRESETS).join(', ')}; ` +
        `or use any OpenAI-compatible endpoint via BROWSER_PILOT_BASE_URL / config set baseUrl)`,
    );
  }
  const keyEnvVars = [...preset.keyEnvVars, 'BROWSER_PILOT_API_KEY'];
  const apiKey =
    overrides.apiKey ||
    keyEnvVars.map((v) => process.env[v]).find(Boolean) ||
    file.apiKey ||
    '';
  return {
    provider,
    baseUrl: overrides.baseUrl || process.env.BROWSER_PILOT_BASE_URL || file.baseUrl || preset.baseUrl,
    model: overrides.model || process.env.BROWSER_PILOT_MODEL || file.model || preset.defaultModel,
    // "none"/"off" is how a caller disables a preset's escalation tier without
    // having to clear a config key it never set.
    fallbackModel: normalizeFallback(
      overrides.fallbackModel ||
        process.env.BROWSER_PILOT_FALLBACK_MODEL ||
        file.fallbackModel ||
        preset.fallbackModel,
    ),
    apiKey,
    temperature: overrides.temperature ?? 0,
    extraBody: parseExtraBody(process.env.BROWSER_PILOT_EXTRA_BODY),
    keyEnvVars,
  };
}

function parseExtraBody(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the throw below
  }
  // A malformed value silently ignored would defeat the point of setting it:
  // the caller believes a routing pin is in force when it is not.
  throw new Error('BROWSER_PILOT_EXTRA_BODY must be a JSON object');
}

function normalizeFallback(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || /^(none|off|false)$/i.test(trimmed)) return undefined;
  return trimmed;
}

export class OpenAICompatProvider implements Provider {
  readonly model: string;

  constructor(private config: ProviderConfig) {
    this.model = config.model;
  }

  async complete(messages: ChatMessage[], tools: ToolDef[], opts: CompleteOptions = {}): Promise<Completion> {
    if (!this.config.apiKey) {
      throw new Error(
        `no API key for provider "${this.config.provider}": set ${this.config.keyEnvVars.join(' or ')} ` +
          `(or \`browser-pilot config set apiKey <key>\`)`,
      );
    }
    const body = {
      model: this.config.model,
      temperature: this.config.temperature,
      messages,
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
      // Spread last on purpose: extraBody is the caller's explicit override
      // channel (see ProviderConfig.extraBody) and must win over defaults.
      ...this.config.extraBody,
    };

    const url = this.config.baseUrl.replace(/\/$/, '') + '/chat/completions';
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_LLM_ATTEMPTS; attempt++) {
      if (opts.signal?.aborted) throw new Error('LLM request aborted');
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
          // A 429 against a per-minute cap needs minute-scale patience, not
          // seconds: flow-replay recovery fires requests far faster than the
          // interactive loop and killed whole flowruns on OpenRouter's
          // 20 rpm tier (fwgr2-n2/n3). Honor the server's own hint first.
          await sleep(retryDelayMs(res, attempt), opts.signal);
          continue;
        }
        if (!res.ok) {
          throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        }
        return parseCompletion((await res.json()) as Record<string, any>);
      } catch (err) {
        // An abort is a decision, not a transport failure — never retry it.
        if (opts.signal?.aborted) throw new Error('LLM request aborted');
        if (err instanceof Error && err.message.startsWith('LLM HTTP 4')) throw err;
        lastErr = err as Error;
        await sleep(1000 * (attempt + 1), opts.signal);
      }
    }
    throw lastErr ?? new Error('LLM request failed');
  }
}

function parseCompletion(json: Record<string, any>): Completion {
  const choice = json.choices?.[0];
  const msg = choice?.message;
  if (!msg) throw new Error(`LLM returned no choices: ${JSON.stringify(json).slice(0, 300)}`);
  const rawCalls: RawToolCall[] = (msg.tool_calls ?? []).filter((c: any) => c?.function?.name);
  const toolCalls: ToolCall[] = rawCalls.map((c, i) => {
    let args: Record<string, unknown> | null = null;
    try {
      args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
    } catch {
      args = null;
    }
    return { id: c.id || `call_${i}`, name: c.function.name, args, rawArgs: c.function.arguments ?? '' };
  });
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: msg.content ?? null,
    ...(rawCalls.length
      ? {
          tool_calls: rawCalls.map((c, i) => ({
            id: c.id || `call_${i}`,
            type: 'function' as const,
            function: { name: c.function.name, arguments: c.function.arguments ?? '' },
          })),
        }
      : {}),
  };
  return {
    text: msg.content ?? null,
    toolCalls,
    assistantMessage,
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      // Both OpenAI and z.ai/novita nest the cache hit here; absent → 0.
      cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

/**
 * Anthropic Messages API adapter. A genuinely different wire format from the
 * OpenAI-compatible providers above (system is a top-level field, not a
 * message; tool calls/results are typed content blocks, not a role:'tool'
 * message; usage splits fresh vs. cache-write vs. cache-read tokens instead
 * of reporting one total with a cached subset) — so this translates rather
 * than reusing OpenAICompatProvider. No SDK dependency: same thin-fetch style
 * as the rest of this file.
 */
export class AnthropicProvider implements Provider {
  readonly model: string;
  private baseUrl: string;

  constructor(private config: ProviderConfig) {
    this.model = config.model;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  async complete(messages: ChatMessage[], tools: ToolDef[], opts: CompleteOptions = {}): Promise<Completion> {
    if (!this.config.apiKey) {
      throw new Error(
        `no API key for provider "${this.config.provider}": set ${this.config.keyEnvVars.join(' or ')} ` +
          `(or \`browser-pilot config set apiKey <key>\`)`,
      );
    }
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const anthMessages = toAnthropicMessages(messages.filter((m) => m.role !== 'system'));
    // Prompt caching: unlike the OpenAI-compatible providers above (which cache
    // automatically server-side), Anthropic only caches up to an explicit
    // cache_control breakpoint. Without one, every turn re-bills the entire
    // growing conversation at full price. Two breakpoints: the system prompt
    // (large, stable across the whole session) and the last content block of
    // the latest message (so each turn's identical prefix — everything before
    // this turn's new content — hits cache on the next call).
    const lastMsg = anthMessages[anthMessages.length - 1];
    const lastBlock = lastMsg?.content[lastMsg.content.length - 1];
    if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };

    const body = {
      model: this.config.model,
      max_tokens: 8192,
      ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
      messages: anthMessages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      tool_choice: { type: 'auto' },
    };

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_LLM_ATTEMPTS; attempt++) {
      if (opts.signal?.aborted) throw new Error('LLM request aborted');
      try {
        const res = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
          await sleep(retryDelayMs(res, attempt), opts.signal);
          continue;
        }
        if (!res.ok) {
          throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        }
        return parseAnthropicCompletion((await res.json()) as Record<string, any>);
      } catch (err) {
        if (opts.signal?.aborted) throw new Error('LLM request aborted');
        if (err instanceof Error && err.message.startsWith('LLM HTTP 4')) throw err;
        lastErr = err as Error;
        await sleep(1000 * (attempt + 1), opts.signal);
      }
    }
    throw lastErr ?? new Error('LLM request failed');
  }
}

/**
 * Our internal history is OpenAI-shaped (role:'tool' per call, tool_calls on
 * the assistant message). Anthropic instead wants tool_use/tool_result as
 * typed content blocks, with all of one assistant turn's tool_results merged
 * into a single following user message — so consecutive role:'tool' entries
 * (one per call in that turn) are collapsed here rather than sent as
 * separate messages.
 */
function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: any[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && prev.content.every((b) => b.type === 'tool_result')) {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
      continue;
    }
    if (m.role !== 'assistant') continue; // 'system' — caller already strips these; defensive only
    const content: any[] = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const tc of m.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        /* malformed args — send empty input rather than fail the whole request */
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
    out.push({ role: 'assistant', content });
  }
  return out;
}

function parseAnthropicCompletion(json: Record<string, any>): Completion {
  const blocks: any[] = json.content ?? [];
  if (!blocks.length && !json.usage) {
    throw new Error(`LLM returned no content: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const textBlocks = blocks.filter((b) => b.type === 'text');
  const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');
  const text = textBlocks.length ? textBlocks.map((b) => b.text).join('\n') : null;

  const toolCalls: ToolCall[] = toolUseBlocks.map((b) => ({
    id: b.id,
    name: b.name,
    args: (b.input ?? {}) as Record<string, unknown>,
    rawArgs: JSON.stringify(b.input ?? {}),
  }));

  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: text,
    ...(toolUseBlocks.length
      ? {
          tool_calls: toolUseBlocks.map((b) => ({
            id: b.id,
            type: 'function' as const,
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          })),
        }
      : {}),
  };

  const u = json.usage ?? {};
  return {
    text,
    toolCalls,
    assistantMessage,
    usage: {
      // Our Usage.promptTokens is documented as the TOTAL prompt (OpenAI
      // convention); Anthropic's input_tokens is only the fresh portion, so
      // fold cache writes/reads back in to keep that contract, and surface
      // reads (the cheap-billed subset) as cachedTokens same as the other
      // providers.
      promptTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      completionTokens: u.output_tokens ?? 0,
      cachedTokens: u.cache_read_input_tokens ?? 0,
    },
  };
}

/** Backoff sleep that gives up early if the request is aborted mid-wait. */
const MAX_LLM_ATTEMPTS = 5;

/**
 * How long to wait before retrying a 429/5xx. The server's own hint wins
 * (Retry-After seconds, or an X-RateLimit-Reset epoch-ms as OpenRouter
 * sends); otherwise escalate on a scale that can outlast a per-MINUTE rate
 * cap rather than a transient blip. Capped so a bad header cannot wedge a
 * turn for longer than the caller's own deadlines.
 */
function retryDelayMs(res: { status: number; headers: { get(name: string): string | null } }, attempt: number): number {
  const cap = 65_000;
  const retryAfter = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, cap);
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > Date.now()) return Math.min(reset - Date.now() + 500, cap);
  if (res.status === 429) return Math.min(5_000 * 2 ** attempt, cap);
  return 1_000 * (attempt + 1);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
