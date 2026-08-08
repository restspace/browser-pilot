import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../agent/llm.js';
import { ensureSessionDir } from '../shared/paths.js';

const ELIDED = '[elided older tool result — re-inspect the page if needed]';
const SNAPSHOT_STUB =
  '[snapshot superseded by a newer snapshot or navigation — its @refs are stale; re-snapshot if you need fresh refs]';

/**
 * Per-session agent memory: one running message history (instruction N+1 sees
 * 1..N), the app briefing, and notes. Briefing and notes are persisted to the
 * session dir so they survive daemon restarts; history is in-memory only.
 */
export class SessionState {
  messages: ChatMessage[] = [];
  briefing = '';
  notes: string[] = [];
  usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, instructions: 0 };

  constructor(readonly session: string) {
    this.load();
  }

  private metaPath(): string {
    return path.join(ensureSessionDir(this.session), 'memory.json');
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.metaPath(), 'utf8'));
      this.briefing = typeof raw.briefing === 'string' ? raw.briefing : '';
      this.notes = Array.isArray(raw.notes) ? raw.notes.filter((n: unknown) => typeof n === 'string') : [];
    } catch {
      // first run for this session
    }
  }

  save(): void {
    fs.writeFileSync(this.metaPath(), JSON.stringify({ briefing: this.briefing, notes: this.notes }, null, 2));
  }

  setBriefing(text: string, append: boolean): void {
    this.briefing = append && this.briefing ? this.briefing + '\n\n' + text : text;
    this.save();
  }

  addNote(text: string): void {
    this.notes.push(text);
    this.save();
  }

  /**
   * Trim history when it outgrows the budget: elide old tool results (the
   * bulk — snapshots etc.), keeping the agent's own text and everything
   * recent. Notes live in the system prompt so they always survive trimming.
   */
  trimHistory(maxChars = 150_000, keepRecent = 30): void {
    const size = () => this.messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
    if (size() <= maxChars) return;
    const cutoff = Math.max(0, this.messages.length - keepRecent);
    for (let i = 0; i < cutoff; i++) {
      const m = this.messages[i];
      if (m.role === 'tool' && m.content !== ELIDED && m.content.length > 200) {
        m.content = ELIDED;
      }
    }
    // Still too big (very long sessions): drop oldest turns entirely, but
    // never split an assistant tool_calls message from its tool results.
    while (size() > maxChars && this.messages.length > keepRecent) {
      this.messages.shift();
      while (this.messages.length && this.messages[0].role === 'tool') this.messages.shift();
    }
  }

  /**
   * Stub out snapshot tool-results that are no longer the current view. A
   * snapshot's `@ref` handles go stale the moment the page navigates or a newer
   * snapshot is taken, so an old full snapshot (up to ~2k tokens) is dead weight
   * re-sent on every remaining turn. Called per-turn from the loop — after a new
   * snapshot (pass its call id as `keep` so it survives) or after navigation
   * (omit `keep` to stub them all). Only touches snapshot results; other tool
   * output and the running trim in trimHistory are unaffected.
   */
  elideSnapshots(keep?: string): void {
    const snapshotIds = new Set<string>();
    for (const m of this.messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const c of m.tool_calls) if (c.function.name === 'snapshot') snapshotIds.add(c.id);
      }
    }
    for (const m of this.messages) {
      if (
        m.role === 'tool' &&
        m.tool_call_id !== keep &&
        snapshotIds.has(m.tool_call_id) &&
        m.content !== SNAPSHOT_STUB
      ) {
        m.content = SNAPSHOT_STUB;
      }
    }
  }
}
