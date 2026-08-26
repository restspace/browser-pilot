import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { resolveProviderConfig } from './agent/llm.js';
import { rootDir } from './shared/paths.js';

/**
 * `browser-pilot doctor`: diagnose a fresh install in one command, without
 * touching the daemon. Three hard checks (node version, home directory
 * writable, a launchable browser) decide the exit code; the provider/key
 * checks are advisory, because open/peek/screenshot work with no API key at
 * all and a missing key should read as "set this before `do`", not "broken".
 */

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

function playwrightVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('playwright-core/package.json') as { version: string }).version;
  } catch {
    return 'latest';
  }
}

export async function runDoctor(json: boolean): Promise<number> {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node',
    status: major >= 20 ? 'ok' : 'fail',
    detail: `v${process.versions.node}${major >= 20 ? '' : ' — browser-pilot needs Node >= 20'}`,
  });

  const home = rootDir();
  try {
    fs.mkdirSync(home, { recursive: true });
    const probe = path.join(home, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    checks.push({ name: 'home', status: 'ok', detail: home });
  } catch (err) {
    checks.push({ name: 'home', status: 'fail', detail: `${home} is not writable: ${(err as Error).message}` });
  }

  // Same channel chain the daemon uses (browser.ts), so what doctor proves is
  // what a session will do.
  const explicit = process.env.BROWSER_PILOT_EXECUTABLE;
  const channels = explicit ? [undefined] : [process.env.BROWSER_PILOT_CHANNEL || 'chrome', 'msedge', 'chromium'];
  let launched: string | null = null;
  let lastErr = '';
  for (const channel of channels) {
    try {
      const browser = await chromium.launch({ headless: true, channel: channel as string | undefined, executablePath: explicit || undefined });
      await browser.close();
      launched = explicit ? `executable ${explicit}` : `channel ${channel}`;
      break;
    } catch (err) {
      lastErr = (err as Error).message.split('\n')[0];
    }
  }
  checks.push({
    name: 'browser',
    status: launched ? 'ok' : 'fail',
    detail: launched
      ? `launches headless via ${launched}`
      : `no launchable browser (tried ${explicit ? 'BROWSER_PILOT_EXECUTABLE' : channels.join(' → ')}). ` +
        `Install Chrome or Edge, or run: npx playwright@${playwrightVersion()} install --with-deps chromium — last error: ${lastErr}`,
  });

  try {
    const config = resolveProviderConfig({});
    checks.push({
      name: 'provider',
      status: 'ok',
      detail: `${config.provider} / ${config.model}${config.fallbackModel ? ` (escalation ${config.fallbackModel})` : ''}`,
    });
    checks.push({
      name: 'api key',
      status: config.apiKey ? 'ok' : 'warn',
      detail: config.apiKey
        ? 'set'
        : `none of ${config.keyEnvVars.join(', ')} is set — open/peek/screenshot work, but \`do\` will fail until one is exported`,
    });
  } catch (err) {
    checks.push({ name: 'provider', status: 'warn', detail: (err as Error).message });
  }

  const failed = checks.some((c) => c.status === 'fail');
  if (json) {
    console.log(JSON.stringify({ ok: !failed, checks }, null, 2));
  } else {
    const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' } as const;
    for (const c of checks) console.log(`${mark[c.status]}  ${c.name.padEnd(8)} ${c.detail}`);
    console.log(failed ? '\ndoctor: FAIL — fix the FAIL lines above before using browser-pilot.' : '\ndoctor: ready.');
  }
  return failed ? 2 : 0;
}
