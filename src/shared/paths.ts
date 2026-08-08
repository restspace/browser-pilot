import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function rootDir(): string {
  return process.env.BROWSER_PILOT_HOME || path.join(os.homedir(), '.browser-pilot');
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
    return `\\\\.\\pipe\\browser-pilot-${session}`;
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
