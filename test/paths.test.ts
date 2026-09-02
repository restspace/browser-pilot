import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aliasLegacyEnv, rootDir } from '../src/shared/paths.js';

// Every var the BROWSER_PILOT_* → SLEEP_WALKER_* rename kept working, plus the
// home-dir fallback that stops the rename orphaning an existing install.
const VARS = ['SLEEP_WALKER_MODEL', 'BROWSER_PILOT_MODEL', 'SLEEP_WALKER_PROVIDER', 'BROWSER_PILOT_PROVIDER', 'SLEEP_WALKER_HOME', 'BROWSER_PILOT_HOME'];

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

  it('a legacy BROWSER_PILOT_* var is copied to its SLEEP_WALKER_* name when the new one is unset', () => {
    process.env.BROWSER_PILOT_MODEL = 'legacy-model';
    aliasLegacyEnv();
    expect(process.env.SLEEP_WALKER_MODEL).toBe('legacy-model');
  });

  it('the new name always wins when both are set', () => {
    process.env.BROWSER_PILOT_PROVIDER = 'old';
    process.env.SLEEP_WALKER_PROVIDER = 'new';
    aliasLegacyEnv();
    expect(process.env.SLEEP_WALKER_PROVIDER).toBe('new');
  });

  it('rootDir honors a legacy BROWSER_PILOT_HOME via the alias', () => {
    process.env.BROWSER_PILOT_HOME = path.join(os.tmpdir(), 'sw-legacy-home');
    aliasLegacyEnv();
    expect(rootDir()).toBe(process.env.BROWSER_PILOT_HOME);
  });

  it('with no env set, an existing ~/.browser-pilot is used before creating ~/.sleep-walker', () => {
    // Point HOME at a temp dir where only the legacy home exists.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-home-'));
    const realHomedir = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      fs.mkdirSync(path.join(fakeHome, '.browser-pilot'));
      expect(rootDir()).toBe(path.join(fakeHome, '.browser-pilot'));
      // Once the new home exists, it takes precedence.
      fs.mkdirSync(path.join(fakeHome, '.sleep-walker'));
      expect(rootDir()).toBe(path.join(fakeHome, '.sleep-walker'));
    } finally {
      (os as { homedir: () => string }).homedir = realHomedir;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
