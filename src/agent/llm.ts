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

export interface Provider {
  readonly model: string;
  complete(messages: ChatMessage[], tools: ToolDef[]): Promise<Completion>;
}

export interface ProviderConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  /** Env vars that were consulted for the key — for error messages. */
  keyEnvVars: string[];
}

export interface ProviderPreset {
  baseUrl: string;
  defaultModel: string;
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
  novita: {
    baseUrl: 'https://api.novita.ai/openai',
    defaultModel: 'zai-org/glm-5.2',
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
};

export const DEFAULT_PROVIDER = 'zhipu';

export interface GlobalConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

const CONFIG_KEYS: (keyof GlobalConfig)[] = ['provider', 'model', 'baseUrl', 'apiKey'];

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
    apiKey,
    temperature: overrides.temperature ?? 0,
    keyEnvVars,
  };
}

export class OpenAICompatProvider implements Provider {
  readonly model: string;

  constructor(private config: ProviderConfig) {
    this.model = config.model;
  }

  async complete(messages: ChatMessage[], tools: ToolDef[]): Promise<Completion> {
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
    };

    const url = this.config.baseUrl.replace(/\/$/, '') + '/chat/completions';
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
          await sleep(1000 * (attempt + 1));
          continue;
        }
        if (!res.ok) {
          throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        }
        return parseCompletion((await res.json()) as Record<string, any>);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('LLM HTTP 4')) throw err;
        lastErr = err as Error;
        await sleep(1000 * (attempt + 1));
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
