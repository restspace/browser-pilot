import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../agent/llm.js';
import { ensureSessionDir } from '../shared/paths.js';

const ELIDED = '[elided older tool result — re-inspect the page if needed]';
const FAILED_ATTEMPT_STUB =
  '[tool result from the previous, unsuccessful attempt — elided; its outcome is summarised in the handoff message, and the page can be re-observed if you need this]';
const SNAPSHOT_STUB =
  '[snapshot superseded by a newer snapshot or navigation — its @refs are stale; re-snapshot if you need fresh refs]';

/** Every placeholder a tool result may already hold, so passes don't restub each other. */
const STUBS = new Set([ELIDED, FAILED_ATTEMPT_STUB, SNAPSHOT_STUB]);

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
  /**
   * The same totals split by model id. A session can bill against more than one
   * model — escalation retries a blocked instruction on a stronger (pricier)
   * tier — and those tiers can differ in price by an order of magnitude, so a
   * single aggregate cannot be costed. Keyed by the model that produced them.
   */
  usageByModel: Record<string, { promptTokens: number; completionTokens: number; cachedTokens: number; instructions: number }> = {};
  /**
   * Learning-mode rollup across the session's instructions, so a caller can
   * read the deterministic fraction the way it reads token usage: from
   * `config`, independent of how each `do` printed its result.
   */
  skills = {
    instructions: 0,
    offered: 0,
    invoked: 0,
    fullReplays: 0,
    repaired: 0,
    refused: 0,
    tierA: 0,
    stepsReplayed: 0,
    deterministicActions: 0,
    totalActions: 0,
    compiled: 0,
    merged: 0,
    variants: 0,
  };

  recordSkill(
    skill: {
      listed: string[];
      invoked?: string;
      stepsReplayed: number;
      stepsTotal: number;
      repaired: boolean;
      refused: boolean;
      tier?: 'A' | 'B';
      deterministicActions: number;
      totalActions: number;
    },
    learned?: { compiled?: string; merged?: string; variantOf?: string } | null,
  ): void {
    const k = this.skills;
    k.instructions += 1;
    if (skill.listed.length) k.offered += 1;
    if (skill.invoked && !skill.refused) {
      k.invoked += 1;
      if (skill.stepsReplayed === skill.stepsTotal) k.fullReplays += 1;
      if (skill.repaired) k.repaired += 1;
      if (skill.tier === 'A') k.tierA += 1;
    }
    if (skill.refused) k.refused += 1;
    k.stepsReplayed += skill.stepsReplayed;
    k.deterministicActions += skill.deterministicActions;
    k.totalActions += skill.totalActions;
    if (learned?.compiled) k.compiled += 1;
    if (learned?.merged) k.merged += 1;
    if (learned?.variantOf) k.variants += 1;
  }

  /** Fold one instruction's usage into both the session total and its model's bucket. */
  recordUsage(
    model: string,
    usage: { promptTokens: number; completionTokens: number; cachedTokens: number },
  ): void {
    this.usage.promptTokens += usage.promptTokens;
    this.usage.completionTokens += usage.completionTokens;
    this.usage.cachedTokens += usage.cachedTokens;
    this.usage.instructions += 1;
    const bucket = (this.usageByModel[model] ??= {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      instructions: 0,
    });
    bucket.promptTokens += usage.promptTokens;
    bucket.completionTokens += usage.completionTokens;
    bucket.cachedTokens += usage.cachedTokens;
    bucket.instructions += 1;
  }

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
   * Replace tool-result payloads from `fromIndex` onward with a short stub.
   *
   * Used at the escalation handoff. The retry prompt already carries the
   * distilled record of the failed attempt (its report, its ordered actions,
   * where it left the browser), so re-sending the raw transcript underneath
   * that is pure duplication — and the escalation model re-reads it on EVERY
   * turn at a much higher cache rate. Measured on a real 10-step run: the
   * fallback's cached history re-reads alone were 45% of the whole run's cost.
   *
   * Structure is preserved rather than pruned: an assistant message carrying
   * tool_calls must still be answered by a tool message with the matching id,
   * or the next request is malformed. So results are blanked, never dropped.
   */
  compactToolResults(fromIndex: number): { elided: number; charsSaved: number } {
    return this.blankToolResults(fromIndex, FAILED_ATTEMPT_STUB);
  }

  /**
   * Blank every tool result already in history, at the start of a new
   * instruction.
   *
   * Raw tool output is worth a lot during the instruction that produced it and
   * very little afterwards: it describes a page state that has usually moved
   * on, while the durable conclusion survives as the `[report]` line. Left in
   * place it is re-sent on every turn of every later instruction — measured
   * across a 10-step session, context per turn grew from 6.1k to 30.3k tokens,
   * plateauing only when trimHistory's size cap forced the same elision under
   * pressure. Doing it at the boundary keeps the growth flat instead.
   */
  elidePriorToolResults(): { elided: number; charsSaved: number } {
    return this.blankToolResults(0, ELIDED);
  }

  /**
   * Replace tool-result payloads with `stub` from `fromIndex` onward.
   * Structure is preserved rather than pruned: an assistant message carrying
   * tool_calls must still be answered by a tool message with the matching id,
   * or the next request is malformed. Results already at or below the stub's
   * size are left alone, which also makes repeat calls idempotent.
   */
  private blankToolResults(fromIndex: number, stub: string): { elided: number; charsSaved: number } {
    let elided = 0;
    let charsSaved = 0;
    for (let i = Math.max(0, fromIndex); i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role !== 'tool') continue;
      // Never restub an existing stub: a later, blunter pass would otherwise
      // overwrite a more specific explanation with a vaguer one.
      if (STUBS.has(m.content)) continue;
      if (m.content.length <= stub.length) continue;
      charsSaved += m.content.length - stub.length;
      m.content = stub;
      elided++;
    }
    return { elided, charsSaved };
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
