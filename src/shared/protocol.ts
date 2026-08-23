/**
 * CLI <-> daemon wire protocol: newline-delimited JSON over a named pipe
 * (Windows) / unix domain socket.
 */

export type CommandName =
  | 'ping'
  | 'do'
  | 'open'
  | 'brief'
  | 'note'
  | 'peek'
  | 'screenshot'
  | 'config'
  | 'reset'
  | 'script'
  | 'var'
  | 'flow'
  | 'run'
  | 'stop';

export interface Request {
  id: number;
  command: CommandName;
  args: Record<string, unknown>;
}

/** Streamed while a command runs (only consumed under --verbose). */
export interface ProgressFrame {
  id: number;
  type: 'progress';
  message: string;
}

export interface ResultFrame {
  id: number;
  type: 'result';
  ok: boolean;
  /** Present when ok === false. */
  error?: string;
  /** `infra` errors map to exit code 2 on the CLI side. */
  errorKind?: 'infra' | 'command';
  data?: unknown;
}

export type Frame = ProgressFrame | ResultFrame;

export function encodeFrame(frame: Frame | Request): string {
  return JSON.stringify(frame) + '\n';
}

/**
 * Incremental NDJSON decoder. Feed it raw socket chunks; it yields complete
 * parsed frames and buffers partial lines.
 */
export class LineDecoder<T> {
  private buffer = '';

  push(chunk: string | Buffer): T[] {
    this.buffer += chunk.toString('utf8');
    const out: T[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      out.push(JSON.parse(line) as T);
    }
    return out;
  }
}
