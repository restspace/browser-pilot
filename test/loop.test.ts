import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage, Completion, Provider, ToolDef } from '../src/agent/llm.js';
import { runEscalatingInstruction, runInstruction } from '../src/agent/loop.js';
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

/**
 * Provider that never answers until aborted — stands in for a model burning the
 * whole budget on reasoning without emitting a tool call.
 */
function hangingProvider(onCall?: () => void): Provider {
  return {
    model: 'stub',
    complete(_messages, _tools, opts) {
      onCall?.();
      return new Promise((_resolve, reject) => {
        if (opts?.signal?.aborted) return reject(new Error('LLM request aborted'));
        opts?.signal?.addEventListener('abort', () => reject(new Error('LLM request aborted')), { once: true });
      });
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
    // acts every turn but never reports → runs out of turns rather than stalling
    const provider = scriptedProvider([{ toolCalls: [{ id: 'c1', name: 'snapshot', args: {}, rawArgs: '{}' }] }]);
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

describe('turn watchdog', () => {
  it('aborts a turn that produces no tool call and nudges the model into acting', async () => {
    const state = new SessionState('t-watchdog');
    let calls = 0;
    const provider: Provider = {
      model: 'stub',
      complete(messages, tools, opts) {
        // first turn hangs (pure reasoning), the retry after the nudge reports
        if (calls++ === 0) return hangingProvider().complete(messages, tools, opts);
        return scriptedProvider([{ toolCalls: [reportCall({ status: 'success', summary: 'done' })] }]).complete(
          messages,
          tools,
          opts,
        );
      },
    };
    const result = await runInstruction(provider, browserStub, state, 'x', { ...loopOpts, turnTimeoutMs: 50 });
    expect(result.report.status).toBe('success');
    expect(calls).toBe(2);
    const nudge = state.messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && /aborted after \d+s/.test(m.content),
    );
    expect(nudge).toBeTruthy();
  });

  it('gives up quickly instead of burning the whole budget when every turn stalls', async () => {
    const state = new SessionState('t-stall');
    let calls = 0;
    const started = Date.now();
    const result = await runInstruction(hangingProvider(() => calls++), browserStub, state, 'x', {
      ...loopOpts,
      maxTurns: 30,
      timeoutMs: 60_000,
      turnTimeoutMs: 50,
    });
    expect(result.report.status).toBe('blocked');
    expect(result.report.summary).toMatch(/stalled/i);
    // bailed after a handful of turns, nowhere near the 60s instruction budget
    expect(calls).toBe(3);
    expect(Date.now() - started).toBeLessThan(5_000);
    // and it says plainly that nothing ran, rather than pointing at an empty log
    expect(result.actions).toEqual([]);
    expect(result.report.summary).toMatch(/no tool call ran/i);
    expect(result.transcriptTail?.join('\n')).toMatch(/no tool call issued/);
  });

  it('reports a timeout, not a stall, when the instruction deadline is what expired', async () => {
    const state = new SessionState('t-deadline');
    const result = await runInstruction(hangingProvider(), browserStub, state, 'x', {
      ...loopOpts,
      timeoutMs: 100,
      turnTimeoutMs: 60_000,
    });
    expect(result.report.status).toBe('blocked');
    expect(result.report.summary).toMatch(/timed out after/i);
    expect(result.report.summary).toMatch(/0 tool call/);
  });

  it('abandons a wedged tool call at the deadline instead of waiting it out', async () => {
    const state = new SessionState('t-wedged');
    // getPage never settles — stands in for any tool that hangs inside Playwright
    const wedgedBrowser = {
      dialogs: { drain: () => [] },
      isOpen: false,
      getPage: () => new Promise(() => {}),
    } as unknown as BrowserSession;
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'click', args: { target: '#x' }, rawArgs: '{"target":"#x"}' }] },
    ]);
    const started = Date.now();
    const result = await runInstruction(provider, wedgedBrowser, state, 'x', {
      ...loopOpts,
      timeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.report.status).toBe('blocked');
    expect(result.report.summary).toMatch(/timed out after/i);
    // the abandoned call is on the record, so a resume knows the page was touched
    expect(result.actions).toEqual([{ tool: 'click', args: '{"target":"#x"}', ok: false }]);
    expect(result.transcriptTail?.some((line) => /abandoned/.test(line))).toBe(true);
  });

  it('stops promptly when the caller aborts mid-turn', async () => {
    const state = new SessionState('t-abort');
    const controller = new AbortController();
    const running = runInstruction(hangingProvider(() => setTimeout(() => controller.abort(), 10)), browserStub, state, 'x', {
      ...loopOpts,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const result = await running;
    expect(result.report.status).toBe('blocked');
    expect(result.report.summary).toMatch(/was stopped/i);
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

/** Names the provider so escalation assertions can tell the two tiers apart. */
function named(model: string, script: Parameters<typeof scriptedProvider>[0]): Provider {
  return { ...scriptedProvider(script), model };
}

describe('escalate-on-blocked', () => {
  const blocks = (summary = 'could not find the supplier') => [
    { toolCalls: [reportCall({ status: 'blocked', summary })] },
  ];
  const succeeds = (summary = 'done on the second tier') => [
    { toolCalls: [reportCall({ status: 'success', summary })] },
  ];

  it('retries a blocked instruction on the fallback and returns its result', async () => {
    const state = new SessionState('t-esc-rescue');
    const primary = named('cheap', blocks());
    const fallback = named('smart', succeeds());
    const result = await runEscalatingInstruction(primary, fallback, browserStub, state, 'do it', loopOpts);

    expect(result.report.status).toBe('success');
    expect(result.escalation).toMatchObject({ from: 'cheap', to: 'smart', rescued: true });
    expect(result.escalation?.reason).toMatch(/could not find the supplier/);
    expect(result.escalation?.firstAttempt.status).toBe('blocked');
  });

  it('bills BOTH attempts so escalation cannot hide its cost', async () => {
    const state = new SessionState('t-esc-usage');
    const result = await runEscalatingInstruction(
      named('cheap', blocks()),
      named('smart', succeeds()),
      browserStub,
      state,
      'do it',
      loopOpts,
    );
    // one turn each, at the stub's 100/10/40 per completion
    expect(result.turns).toBe(2);
    expect(result.usage.promptTokens).toBe(200);
    expect(result.usage.completionTokens).toBe(20);
    expect(result.usage.cachedTokens).toBe(80);
  });

  it('tells the fallback it is resuming a live session, not starting clean', async () => {
    const state = new SessionState('t-esc-prompt');
    await runEscalatingInstruction(
      named('cheap', blocks('gave up probing the autocomplete')),
      named('smart', succeeds()),
      browserStub,
      state,
      'create the order',
      loopOpts,
    );
    const handoff = state.messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('RESUMING'),
    );
    expect(handoff).toBeTruthy();
    const text = String(handoff!.content);
    // must carry the original ask, the reason it stalled, and the double-apply guard
    expect(text).toContain('create the order');
    expect(text).toContain('gave up probing the autocomplete');
    expect(text).toMatch(/before you repeat any state-changing action/i);
  });

  it('does NOT retry a verified failure — that is an answer, not a dead end', async () => {
    const state = new SessionState('t-esc-failure');
    let fallbackCalled = false;
    const fallback: Provider = {
      model: 'smart',
      async complete() {
        fallbackCalled = true;
        throw new Error('fallback must not run');
      },
    };
    const result = await runEscalatingInstruction(
      named('cheap', [{ toolCalls: [reportCall({ status: 'failure', summary: 'price was 125, expected 133.33' })] }]),
      fallback,
      browserStub,
      state,
      'check the price',
      loopOpts,
    );
    expect(result.report.status).toBe('failure');
    expect(fallbackCalled).toBe(false);
    expect(result.escalation).toBeUndefined();
  });

  it('does NOT retry after an operator stop — the run was killed on purpose', async () => {
    const state = new SessionState('t-esc-stopped');
    let fallbackCalled = false;
    const fallback: Provider = {
      model: 'smart',
      async complete() {
        fallbackCalled = true;
        return { text: null, toolCalls: [], assistantMessage: { role: 'assistant', content: null }, usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 } };
      },
    };
    const controller = new AbortController();
    controller.abort();
    const result = await runEscalatingInstruction(
      named('cheap', blocks()),
      fallback,
      browserStub,
      state,
      'do it',
      { ...loopOpts, signal: controller.signal },
    );
    expect(result.report.status).toBe('blocked');
    expect(fallbackCalled).toBe(false);
    expect(result.escalation).toBeUndefined();
  });

  it('skips escalation when there is no fallback, or it is the same model', async () => {
    const noFallback = await runEscalatingInstruction(
      named('cheap', blocks()),
      null,
      browserStub,
      new SessionState('t-esc-none'),
      'do it',
      loopOpts,
    );
    expect(noFallback.escalation).toBeUndefined();

    const sameModel = await runEscalatingInstruction(
      named('cheap', blocks()),
      named('cheap', succeeds()),
      browserStub,
      new SessionState('t-esc-same'),
      'do it',
      loopOpts,
    );
    expect(sameModel.escalation).toBeUndefined();
    expect(sameModel.report.status).toBe('blocked');
  });

  it('records an unrescued escalation rather than pretending it worked', async () => {
    const result = await runEscalatingInstruction(
      named('cheap', blocks()),
      named('smart', blocks('still stuck')),
      browserStub,
      new SessionState('t-esc-nofix'),
      'do it',
      loopOpts,
    );
    expect(result.report.status).toBe('blocked');
    expect(result.escalation).toMatchObject({ rescued: false, to: 'smart' });
  });
});
