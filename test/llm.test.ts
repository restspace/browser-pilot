import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROVIDER_PRESETS,
  readGlobalConfig,
  resolveProviderConfig,
  writeGlobalConfig,
} from '../src/agent/llm.js';

const ENV_VARS = [
  'BROWSER_PILOT_HOME',
  'BROWSER_PILOT_PROVIDER',
  'BROWSER_PILOT_MODEL',
  'BROWSER_PILOT_BASE_URL',
  'BROWSER_PILOT_API_KEY',
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
  process.env.BROWSER_PILOT_HOME = tmpHome;
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

  it('fallback model follows the same flag > env > file > preset precedence', () => {
    writeGlobalConfig({ provider: 'novita', fallbackModel: 'file-fallback' });
    expect(resolveProviderConfig().fallbackModel).toBe('file-fallback');
    process.env.BROWSER_PILOT_FALLBACK_MODEL = 'env-fallback';
    expect(resolveProviderConfig().fallbackModel).toBe('env-fallback');
    expect(resolveProviderConfig({ fallbackModel: 'flag-fallback' }).fallbackModel).toBe('flag-fallback');
    delete process.env.BROWSER_PILOT_FALLBACK_MODEL;
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
    process.env.BROWSER_PILOT_MODEL = 'env-model';
    expect(resolveProviderConfig().model).toBe('env-model');
    // flag beats env; provider switch keeps the field overrides that were set
    const cfg = resolveProviderConfig({ provider: 'zhipu', model: 'flag-model' });
    expect(cfg.provider).toBe('zhipu');
    expect(cfg.model).toBe('flag-model');
    expect(cfg.baseUrl).toBe(PROVIDER_PRESETS.zhipu.baseUrl);
  });

  it('generic BROWSER_PILOT_API_KEY works for any provider; preset var wins', () => {
    process.env.BROWSER_PILOT_API_KEY = 'generic';
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
