import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * The env vars renamed BROWSER_PILOT_* → SLEEP_WALKER_* at the sleep-walker
 * rename. The suffix is shared; only the prefix changed.
 */
const RENAMED_ENV_SUFFIXES = [
  'API_KEY', 'BASE_URL', 'CHANNEL', 'COMPONENTS_FILE', 'EXECUTABLE',
  'EXTRA_BODY', 'FALLBACK_EXTRA_BODY', 'FALLBACK_MODEL', 'FLOWS_DIR',
  'HEADED', 'HOME', 'MODEL', 'PROVIDER', 'RECORD', 'RESOLVE_WAIT_MS',
  'SCRIPT', 'SKILLS', 'SKILLS_DIR',
];

/**
 * Backward compatibility for the BROWSER_PILOT_* → SLEEP_WALKER_* rename.
 * Every renamed var still works: if the new name is unset and the legacy one
 * is set, copy it across. Call once at each process entry (CLI main, daemon
 * main) before any config is read; the CLI spawns the daemon with
 * `env: process.env`, so the daemon inherits whatever the CLI aliased.
 * Idempotent. Existing 0.3.0 installs and the cloud run-prompts (which export
 * BROWSER_PILOT_*) keep working unchanged.
 */
export function aliasLegacyEnv(): void {
  for (const suffix of RENAMED_ENV_SUFFIXES) {
    const next = `SLEEP_WALKER_${suffix}`;
    const legacy = `BROWSER_PILOT_${suffix}`;
    if (process.env[next] === undefined && process.env[legacy] !== undefined) {
      process.env[next] = process.env[legacy];
    }
  }
}

export function rootDir(): string {
  if (process.env.SLEEP_WALKER_HOME) return process.env.SLEEP_WALKER_HOME;
  const preferred = path.join(os.homedir(), '.sleep-walker');
  // Don't orphan an existing install: if the new home doesn't exist yet but
  // the pre-rename one does, keep using it. A user who has neither gets the
  // new default; a fresh `SLEEP_WALKER_HOME` always wins.
  if (!fs.existsSync(preferred)) {
    const legacy = path.join(os.homedir(), '.browser-pilot');
    if (fs.existsSync(legacy)) return legacy;
  }
  return preferred;
}

export function sessionsDir(): string {
  return path.join(rootDir(), 'sessions');
}

export function sessionDir(session: string): string {
  return path.join(sessionsDir(), session);
}

export function ensureSessionDir(session: string): string {
  const dir = sessionDir(session);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Named pipe on Windows, unix socket elsewhere. */
export function socketPath(session: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\sleep-walker-${session}`;
  }
  return path.join(sessionDir(session), 'daemon.sock');
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validateSessionName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid session name "${name}" (allowed: letters, digits, - and _)`);
  }
  return name;
}
