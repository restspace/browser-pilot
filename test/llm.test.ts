import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OpenAICompatProvider,
  PROVIDER_PRESETS,
  readGlobalConfig,
  resolveProviderConfig,
  writeGlobalConfig,
} from '../src/agent/llm.js';

const ENV_VARS = [
  'SITELOOPER_HOME',
  'SITELOOPER_PROVIDER',
  'SITELOOPER_MODEL',
  'SITELOOPER_BASE_URL',
  'SITELOOPER_EXTRA_BODY',
  'SITELOOPER_FALLBACK_EXTRA_BODY',
  'SITELOOPER_API_KEY',
  'GLM_API_KEY',
  'ZHIPU_API_KEY',
  'NOVITA_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
];

let saved: Record<string, string | undefined>;
let tmpHome: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_VARS.map((v) => [v, process.env[v]]));
  for (const v of ENV_VARS) delete process.env[v];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-llm-'));
  process.env.SITELOOPER_HOME = tmpHome;
});

afterEach(() => {
  for (const v of ENV_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('provider resolution', () => {
  it('defaults to the zhipu preset', () => {
    const cfg = resolveProviderConfig();
    expect(cfg.provider).toBe('zhipu');
    expect(cfg.baseUrl).toBe(PROVIDER_PRESETS.zhipu.baseUrl);
    expect(cfg.model).toBe('glm-5.2');
    expect(cfg.apiKey).toBe('');
  });

  it('novita preset carries its own base URL, model naming, and key env var', () => {
    process.env.NOVITA_API_KEY = 'nk-123';
    const cfg = resolveProviderConfig({ provider: 'novita' });
    expect(cfg.baseUrl).toBe('https://api.novita.ai/openai');
    expect(cfg.model).toBe('deepseek/deepseek-v4-flash');
    expect(cfg.apiKey).toBe('nk-123');
    expect(cfg.keyEnvVars).toContain('NOVITA_API_KEY');
  });

  it('novita preset supplies a stronger escalation model than its routine one', () => {
    const cfg = resolveProviderConfig({ provider: 'novita' });
    expect(cfg.fallbackModel).toBe('zai-org/glm-5.3');
    expect(cfg.fallbackModel).not.toBe(cfg.model);
  });

  it('presets without an escalation tier leave fallbackModel unset', () => {
    expect(resolveProviderConfig({ provider: 'zhipu' }).fallbackModel).toBeUndefined();
  });

  it('extraBody is main-model calibration: the fallback tier reads its own env var', () => {
    // The bench's Baidu routing pin was measured for deepseek-v4-flash; when
    // the glm-5.3 escalation tier inherited it, a 3.9s relabel call became
    // 25.5s and blew the 75s timebox on 3 of 4 live runs. So the two tiers
    // read separate env vars and neither inherits the other's.
    process.env.SITELOOPER_EXTRA_BODY = '{"provider":{"order":["Baidu"]}}';
    const cfg = resolveProviderConfig();
    expect(cfg.extraBody).toEqual({ provider: { order: ['Baidu'] } });
    expect(cfg.fallbackExtraBody).toBeUndefined();
    process.env.SITELOOPER_FALLBACK_EXTRA_BODY = '{"provider":{"order":["Novita"]}}';
    expect(resolveProviderConfig().fallbackExtraBody).toEqual({ provider: { order: ['Novita'] } });
  });

  it('a malformed fallback extra body fails loudly, naming its own env var', () => {
    process.env.SITELOOPER_FALLBACK_EXTRA_BODY = 'not json';
    expect(() => resolveProviderConfig()).toThrow('SITELOOPER_FALLBACK_EXTRA_BODY');
  });

  it('fallback model follows the same flag > env > file > preset precedence', () => {
    writeGlobalConfig({ provider: 'novita', fallbackModel: 'file-fallback' });
    expect(resolveProviderConfig().fallbackModel).toBe('file-fallback');
    process.env.SITELOOPER_FALLBACK_MODEL = 'env-fallback';
    expect(resolveProviderConfig().fallbackModel).toBe('env-fallback');
    expect(resolveProviderConfig({ fallbackModel: 'flag-fallback' }).fallbackModel).toBe('flag-fallback');
    delete process.env.SITELOOPER_FALLBACK_MODEL;
  });

  it('"none" disables escalation without needing to clear a config key', () => {
    for (const off of ['none', 'off', 'FALSE', '  ']) {
      expect(resolveProviderConfig({ provider: 'novita', fallbackModel: off }).fallbackModel).toBeUndefined();
    }
  });

  it('rejects unknown providers with the available list', () => {
    expect(() => resolveProviderConfig({ provider: 'nope' })).toThrow(/novita/);
  });

  it('precedence per field: flag > env > config file > preset', () => {
    writeGlobalConfig({ provider: 'novita', model: 'file-model' });
    // file only
    expect(resolveProviderConfig().provider).toBe('novita');
    expect(resolveProviderConfig().model).toBe('file-model');
    // env beats file
    process.env.SITELOOPER_MODEL = 'env-model';
    expect(resolveProviderConfig().model).toBe('env-model');
    // flag beats env; provider switch keeps the field overrides that were set
    const cfg = resolveProviderConfig({ provider: 'zhipu', model: 'flag-model' });
    expect(cfg.provider).toBe('zhipu');
    expect(cfg.model).toBe('flag-model');
    expect(cfg.baseUrl).toBe(PROVIDER_PRESETS.zhipu.baseUrl);
  });

  it('generic SITELOOPER_API_KEY works for any provider; preset var wins', () => {
    process.env.SITELOOPER_API_KEY = 'generic';
    expect(resolveProviderConfig({ provider: 'novita' }).apiKey).toBe('generic');
    process.env.NOVITA_API_KEY = 'specific';
    expect(resolveProviderConfig({ provider: 'novita' }).apiKey).toBe('specific');
  });
});

describe('global config file', () => {
  it('set merges, empty string clears, unknown keys rejected', () => {
    writeGlobalConfig({ provider: 'novita' });
    writeGlobalConfig({ model: 'm1' });
    expect(readGlobalConfig()).toEqual({ provider: 'novita', model: 'm1' });
    writeGlobalConfig({ model: '' });
    expect(readGlobalConfig()).toEqual({ provider: 'novita' });
    expect(() => writeGlobalConfig({ bogus: 'x' } as never)).toThrow(/unknown config key/);
  });

  it('missing or corrupt file reads as empty config', () => {
    expect(readGlobalConfig()).toEqual({});
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'config.json'), '{not json');
    expect(readGlobalConfig()).toEqual({});
  });
});

describe('per-request reasoning effort', () => {
  const baseConfig = {
    baseUrl: 'https://example.test/api/v1',
    apiKey: 'k',
    model: 'm',
    keyEnvVars: ['X'],
    temperature: 0,
  };
  const stubFetch = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    };
    return { bodies, fetchImpl };
  };

  it('openrouter maps effort to the reasoning field; user extraBody still wins', async () => {
    const { bodies, fetchImpl } = stubFetch();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const p = new OpenAICompatProvider({ ...baseConfig, provider: 'openrouter' } as never);
      await p.complete([{ role: 'user', content: 'hi' }], [], { effort: 'low' });
      expect(bodies[0].reasoning).toEqual({ effort: 'low' });
      const p2 = new OpenAICompatProvider({
        ...baseConfig,
        provider: 'openrouter',
        extraBody: { reasoning: { max_tokens: 9 } },
      } as never);
      await p2.complete([{ role: 'user', content: 'hi' }], [], { effort: 'low' });
      expect(bodies[1].reasoning).toEqual({ max_tokens: 9 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('other openai-compat hosts never see the field — unknown keys can 400', async () => {
    const { bodies, fetchImpl } = stubFetch();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const p = new OpenAICompatProvider({ ...baseConfig, provider: 'novita' } as never);
      await p.complete([{ role: 'user', content: 'hi' }], [], { effort: 'low' });
      expect('reasoning' in bodies[0]).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
