import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage, Completion, Provider, ToolDef } from '../src/agent/llm.js';
import { runInstruction } from '../src/agent/loop.js';
import type { BrowserSession } from '../src/daemon/browser.js';
import { SessionState } from '../src/daemon/state.js';

let tmpHome: string;
beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-'));
  process.env.BROWSER_PILOT_HOME = tmpHome;
});
afterAll(() => {
  delete process.env.BROWSER_PILOT_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Provider stub that plays back scripted completions. */
function scriptedProvider(script: Array<Partial<Completion> & { toolCalls?: Completion['toolCalls'] }>): Provider {
  let i = 0;
  return {
    model: 'stub',
    async complete(_messages: ChatMessage[], _tools: ToolDef[]): Promise<Completion> {
      const step = script[Math.min(i++, script.length - 1)];
      const toolCalls = step.toolCalls ?? [];
      return {
        text: step.text ?? null,
        toolCalls,
        assistantMessage: {
          role: 'assistant',
          content: step.text ?? null,
          ...(toolCalls.length
            ? {
                tool_calls: toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: c.rawArgs },
                })),
              }
            : {}),
        },
        usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 40 },
      };
    },
  };
}

function reportCall(args: Record<string, unknown>) {
  return { id: 'c1', name: 'report', args, rawArgs: JSON.stringify(args) };
}

// report-only scripts never touch the browser, so a hollow stub suffices
const browserStub = { dialogs: { drain: () => [] } } as unknown as BrowserSession;

const loopOpts = { maxTurns: 5, timeoutMs: 30_000, screenshotDir: os.tmpdir() };

describe('agent loop', () => {
  it('finishes on a valid report and carries history + usage into the session', async () => {
    const state = new SessionState('t-valid');
    const provider = scriptedProvider([
      { toolCalls: [reportCall({ status: 'success', summary: 'did the thing', evidence: { values: { id: 'k7' } } })] },
    ]);
    const result = await runInstruction(provider, browserStub, state, 'do the thing', loopOpts);
    expect(result.report.status).toBe('success');
    expect(result.turns).toBe(1);
    expect(result.usage.promptTokens).toBe(100);
    // cached-token accounting flows from the completion into the result and the session rollup
    expect(result.usage.cachedTokens).toBe(40);
    expect(state.usage.cachedTokens).toBe(40);
    expect(state.usage.instructions).toBe(1);
    // history keeps the instruction and a compact report line for instruction N+1
    expect(state.messages[0]).toEqual({ role: 'user', content: 'do the thing' });
    expect(JSON.stringify(state.messages.at(-1))).toContain('did the thing');
  });

  it('feeds schema errors back for one retry, then accepts the corrected report', async () => {
    const state = new SessionState('t-retry');
    const provider = scriptedProvider([
      { toolCalls: [reportCall({ status: 'nailed it', summary: 'x' })] }, // invalid enum
      { toolCalls: [reportCall({ status: 'success', summary: 'fixed' })] },
    ]);
    const result = await runInstruction(provider, browserStub, state, 'x', loopOpts);
    expect(result.report.status).toBe('success');
    expect(result.report.summary).toBe('fixed');
    const rejection = state.messages.find((m) => m.role === 'tool' && m.content.includes('report rejected'));
    expect(rejection).toBeTruthy();
  });

  it('declares blocked after a second invalid report', async () => {
    const state = new SessionState('t-invalid2');
    const provider = scriptedProvider([{ toolCalls: [reportCall({ status: 'bogus', summary: 'x' })] }]);
    const result = await runInstruction(provider, browserStub, state, 'x', loopOpts);
    expect(result.report.status).toBe('blocked');
    expect(result.transcriptTail?.length).toBeGreaterThan(0);
  });

  it('declares blocked at the turn cap, warns near it, and flags possible partial completion', async () => {
    const state = new SessionState('t-cap');
    const provider = scriptedProvider([{ text: 'thinking out loud, no tools' }]);
    const result = await runInstruction(provider, browserStub, state, 'x', { ...loopOpts, maxTurns: 3 });
    expect(result.report.status).toBe('blocked');
    expect(result.report.summary).toMatch(/turn cap \(3\)/i);
    expect(result.report.summary).toMatch(/partially complete/i);
    // the near-cap "report now" nudge was injected before the cap was hit
    const nudged = state.messages.some(
      (m) => m.role === 'user' && typeof m.content === 'string' && /turn\(s\) left/i.test(m.content),
    );
    expect(nudged).toBe(true);
  });

  it('returns an ordered actions log on bail-out so a caller can resume safely', async () => {
    const state = new SessionState('t-actions');
    const snap = { id: 'c1', name: 'snapshot', args: {}, rawArgs: '{}' };
    const provider = scriptedProvider([{ toolCalls: [snap] }]); // never reports → caps
    const result = await runInstruction(provider, browserStub, state, 'go', { ...loopOpts, maxTurns: 2 });
    expect(result.report.status).toBe('blocked');
    expect(result.actions?.length).toBeGreaterThan(0);
    expect(result.actions?.[0].tool).toBe('snapshot');
    // clean successes stay lean — no actions log
    const ok = new SessionState('t-actions-ok');
    const okResult = await runInstruction(
      scriptedProvider([{ toolCalls: [reportCall({ status: 'success', summary: 'done' })] }]),
      browserStub,
      ok,
      'go',
      loopOpts,
    );
    expect(okResult.actions).toBeUndefined();
  });
});

describe('history trimming', () => {
  it('elides old tool results but keeps recent messages and assistant text', () => {
    const state = new SessionState('t-trim');
    for (let i = 0; i < 60; i++) {
      state.messages.push({ role: 'assistant', content: `summary ${i}` });
      state.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'snapshot '.repeat(500) });
    }
    const lastToolBefore = state.messages.at(-1);
    state.trimHistory(100_000, 30);
    const total = state.messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
    expect(total).toBeLessThanOrEqual(100_000);
    // recent tail untouched
    expect(state.messages.at(-1)).toEqual(lastToolBefore);
    // old tool bulk elided, assistant summaries survive
    expect(state.messages.some((m) => m.role === 'tool' && m.content.includes('elided'))).toBe(true);
    expect(state.messages.some((m) => m.role === 'assistant' && m.content === 'summary 59')).toBe(true);
  });

  it('elideSnapshots stubs superseded snapshots but keeps the latest and non-snapshot results', () => {
    const state = new SessionState('t-snap-elide');
    const snapMsg = (id: string) => [
      { role: 'assistant' as const, content: null, tool_calls: [{ id, type: 'function' as const, function: { name: 'snapshot', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: id, content: `- button "Save" [@e1]\n`.repeat(300) },
    ];
    state.messages.push(...snapMsg('s1'));
    state.messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'r1', content: '"Acme Ltd"' },
    );
    state.messages.push(...snapMsg('s2'));

    // A newer snapshot supersedes the older one; the latest and the read survive.
    state.elideSnapshots('s2');
    const byId = (id: string) => state.messages.find((m) => m.role === 'tool' && m.tool_call_id === id)!;
    expect(byId('s1').content).toMatch(/superseded/);
    expect(byId('s2').content).not.toMatch(/superseded/);
    expect(byId('r1').content).toBe('"Acme Ltd"');

    // Navigation (no id kept) staleness-stubs every remaining snapshot.
    state.elideSnapshots();
    expect(byId('s2').content).toMatch(/superseded/);
    expect(byId('r1').content).toBe('"Acme Ltd"');
  });

  it('notes and briefing persist to disk across state instances', () => {
    const a = new SessionState('t-persist');
    a.setBriefing('the guide', false);
    a.addNote('runid is k7x2');
    const b = new SessionState('t-persist');
    expect(b.briefing).toBe('the guide');
    expect(b.notes).toEqual(['runid is k7x2']);
  });
});
