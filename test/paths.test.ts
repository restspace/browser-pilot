import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aliasLegacyEnv, rootDir } from '../src/shared/paths.js';

// Every var the BROWSER_PILOT_* → SLEEP_WALKER_* → SITELOOPER_* renames kept
// working, plus the home-dir fallback that stops a rename orphaning an
// existing install.
const VARS = [
  'SITELOOPER_MODEL', 'SLEEP_WALKER_MODEL', 'BROWSER_PILOT_MODEL',
  'SITELOOPER_PROVIDER', 'SLEEP_WALKER_PROVIDER', 'BROWSER_PILOT_PROVIDER',
  'SITELOOPER_HOME', 'SLEEP_WALKER_HOME', 'BROWSER_PILOT_HOME',
];

describe('legacy env + home compatibility', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    for (const v of VARS) delete process.env[v];
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('a legacy BROWSER_PILOT_* var is copied to its SITELOOPER_* name when the new one is unset', () => {
    process.env.BROWSER_PILOT_MODEL = 'legacy-model';
    aliasLegacyEnv();
    expect(process.env.SITELOOPER_MODEL).toBe('legacy-model');
  });

  it('a legacy SLEEP_WALKER_* var is copied to its SITELOOPER_* name when the new one is unset', () => {
    process.env.SLEEP_WALKER_MODEL = 'sw-model';
    aliasLegacyEnv();
    expect(process.env.SITELOOPER_MODEL).toBe('sw-model');
  });

  it('the more recent legacy prefix wins over the older one', () => {
    process.env.SLEEP_WALKER_PROVIDER = 'sw';
    process.env.BROWSER_PILOT_PROVIDER = 'bp';
    aliasLegacyEnv();
    expect(process.env.SITELOOPER_PROVIDER).toBe('sw');
  });

  it('the new name always wins when both are set', () => {
    process.env.BROWSER_PILOT_PROVIDER = 'old';
    process.env.SITELOOPER_PROVIDER = 'new';
    aliasLegacyEnv();
    expect(process.env.SITELOOPER_PROVIDER).toBe('new');
  });

  it('rootDir honors a legacy BROWSER_PILOT_HOME via the alias', () => {
    process.env.BROWSER_PILOT_HOME = path.join(os.tmpdir(), 'sw-legacy-home');
    aliasLegacyEnv();
    expect(rootDir()).toBe(process.env.BROWSER_PILOT_HOME);
  });

  it('with no env set, an existing legacy home is used before creating ~/.sitelooper', () => {
    // Point HOME at a temp dir where only the legacy home exists.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-home-'));
    const realHomedir = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      fs.mkdirSync(path.join(fakeHome, '.browser-pilot'));
      expect(rootDir()).toBe(path.join(fakeHome, '.browser-pilot'));
      // The more recent legacy home wins over the older one.
      fs.mkdirSync(path.join(fakeHome, '.sleep-walker'));
      expect(rootDir()).toBe(path.join(fakeHome, '.sleep-walker'));
      // Once the new home exists, it takes precedence.
      fs.mkdirSync(path.join(fakeHome, '.sitelooper'));
      expect(rootDir()).toBe(path.join(fakeHome, '.sitelooper'));
    } finally {
      (os as { homedir: () => string }).homedir = realHomedir;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
