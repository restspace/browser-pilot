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

  it('tells the model which page the browser is on, and flags an error page', async () => {
    const script = () =>
      scriptedProvider([{ toolCalls: [reportCall({ status: 'success', summary: 'ok', evidence: { values: {} } })] }]);
    const onPage = (url: string, title: string) =>
      ({
        ...browserStub,
        isOpen: true,
        getPage: async () => ({ url: () => url, title: async () => title }),
      }) as unknown as BrowserSession;

    const state = new SessionState('t-location');
    await runInstruction(script(), onPage('http://127.0.0.1:4180/#/tickets', 'Repair Desk'), state, 'sign in', loopOpts);
    const first = String(state.messages[0].content);
    // the caller's instruction stays first and verbatim; the location follows it
    expect(first.startsWith('sign in\n\n[browser] You are currently on http://127.0.0.1:4180/#/tickets — "Repair Desk".')).toBe(true);

    const errState = new SessionState('t-location-err');
    await runInstruction(script(), onPage('chrome-error://chromewebdata/', ''), errState, 'sign in', loopOpts);
    const err = String(errState.messages[0].content);
    expect(err).toContain('chrome-error://chromewebdata/');
    expect(err).toContain('error page');
    expect(err).toContain('do not guess');

    // no page open: nothing is launched and the instruction goes through untouched
    const closedState = new SessionState('t-location-closed');
    await runInstruction(script(), browserStub, closedState, 'sign in', loopOpts);
    expect(closedState.messages[0]).toEqual({ role: 'user', content: 'sign in' });
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
    // the abandoned call is on the record, so a resume knows the page was
    // touched. On a starved CI box the quick abandon can leave genuine budget
    // for a second (equally wedged, equally abandoned) turn — that is the
    // loop using remaining time, not a defect — so assert the invariants, not
    // an exact count.
    expect(result.actions.length).toBeGreaterThanOrEqual(1);
    expect(result.actions[0]).toEqual({ tool: 'click', args: '{"target":"#x"}', ok: false });
    expect(result.actions.every((a) => a.ok === false)).toBe(true);
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

  it('elides earlier instructions\' tool results when the next one starts', async () => {
    const state = new SessionState('t-boundary');
    const readCall = { id: 'r1', name: 'read', args: { target: '#a', what: 'text' }, rawArgs: '{}' };
    await runInstruction(
      scriptedProvider([
        { toolCalls: [readCall] },
        { toolCalls: [reportCall({ status: 'success', summary: 'first' })] },
      ]),
      browserStub,
      state,
      'first',
      loopOpts,
    );
    const toolMsg = state.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'r1')!;
    // stand in a realistically fat result, as a snapshot would produce
    toolMsg.content = 'y'.repeat(4000);

    await runInstruction(
      scriptedProvider([{ toolCalls: [reportCall({ status: 'success', summary: 'second' })] }]),
      browserStub,
      state,
      'second',
      loopOpts,
    );
    expect(toolMsg.content.length).toBeLessThan(200);
    // structure survives: the assistant tool_calls message still has its answer
    const caller = state.messages.find(
      (m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === 'r1'),
    );
    expect(caller).toBeTruthy();
    expect(state.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'r1')).toBe(true);
  });

  it('carries reported facts into the durable history line so elision does not lose them', async () => {
    const state = new SessionState('t-facts');
    await runInstruction(
      scriptedProvider([
        {
          toolCalls: [
            reportCall({
              status: 'success',
              summary: 'created it',
              evidence: { values: { projectId: 'rq-77', price: 133.33 } },
            }),
          ],
        },
      ]),
      browserStub,
      state,
      'create the project',
      loopOpts,
    );
    const line = String(state.messages.at(-1)!.content);
    expect(line).toContain('created it');
    expect(line).toContain('projectId=rq-77');
    expect(line).toContain('price=133.33');
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

  it('splits session usage per model so a two-tier run can be costed', async () => {
    const state = new SessionState('t-esc-bymodel');
    await runEscalatingInstruction(
      named('cheap', blocks()),
      named('smart', succeeds()),
      browserStub,
      state,
      'do it',
      loopOpts,
    );
    // one instruction each, at the stub's 100 prompt / 40 cached / 10 completion
    expect(Object.keys(state.usageByModel).sort()).toEqual(['cheap', 'smart']);
    expect(state.usageByModel.cheap).toEqual({
      promptTokens: 100,
      cachedTokens: 40,
      completionTokens: 10,
      instructions: 1,
    });
    expect(state.usageByModel.smart.instructions).toBe(1);
    // the split must reconcile with the session total, or costing it is guesswork
    const sum = Object.values(state.usageByModel).reduce((n, b) => n + b.promptTokens, 0);
    expect(sum).toBe(state.usage.promptTokens);
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

  it('gives the fallback more turns when the first attempt hit the turn cap', async () => {
    // primary never reports → exhausts maxTurns; fallback records what cap it got
    // neither tier ever reports, so each runs to exactly its own cap
    const acts = [{ toolCalls: [{ id: 'c1', name: 'snapshot', args: {}, rawArgs: '{}' }] }];
    const result = await runEscalatingInstruction(
      named('cheap', acts),
      named('smart', acts),
      browserStub,
      new SessionState('t-esc-turns'),
      'do it',
      { ...loopOpts, maxTurns: 4 },
    );
    expect(result.escalation?.firstAttempt.turns).toBe(4);
    expect(result.bailReason).toBe('turn-cap');
    // fallback got ceil(4 * 1.5) = 6, not another flat 4
    expect(result.turns).toBe(4 + 6);
  });

  it('does not inflate the budget when the agent chose to report blocked', async () => {
    // an agent-declared block is not evidence that more turns would have helped
    const acts = [{ toolCalls: [{ id: 'c1', name: 'snapshot', args: {}, rawArgs: '{}' }] }];
    const result = await runEscalatingInstruction(
      named('cheap', blocks()), // reports blocked on turn 1, no cap involved
      named('smart', acts), // never reports → runs to its own cap
      browserStub,
      new SessionState('t-esc-nobump'),
      'do it',
      { ...loopOpts, maxTurns: 4 },
    );
    expect(result.escalation?.firstAttempt.turns).toBe(1);
    expect(result.turns).toBe(1 + 4); // plain cap, not 6
  });

  it('blanks fat tool results without dropping the messages that answer a tool call', () => {
    const state = new SessionState('t-compact-unit');
    state.messages.push(
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'a1', type: 'function', function: { name: 'snapshot', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'a1', content: 'x'.repeat(6000) },
      { role: 'tool', tool_call_id: 'a2', content: 'ok' }, // already tiny
    );
    const { elided, charsSaved } = state.compactToolResults(0);
    expect(elided).toBe(1);
    expect(charsSaved).toBeGreaterThan(5000);
    // structure intact: the tool answer for a1 still exists, just smaller
    const answer = state.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'a1')!;
    expect(answer).toBeTruthy();
    expect(answer.content.length).toBeLessThan(300);
    // a result already cheaper than the stub is left alone
    expect(state.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'a2')!.content).toBe('ok');
    // idempotent — a second pass finds nothing left to shrink
    expect(state.compactToolResults(0).elided).toBe(0);
  });

  it('leaves earlier instructions untouched when compacting a failed attempt', async () => {
    const state = new SessionState('t-esc-scope');
    // instruction 1 succeeds and leaves a real tool result in history
    await runInstruction(
      named('cheap', [
        { toolCalls: [{ id: 'p1', name: 'read', args: { target: '#a', what: 'text' }, rawArgs: '{}' }] },
        { toolCalls: [reportCall({ status: 'success', summary: 'first done' })] },
      ]),
      browserStub,
      state,
      'first instruction',
      loopOpts,
    );
    const earlier = state.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'p1')!;
    const before = earlier.content;

    // instruction 2 blocks and escalates → only ITS results should be compacted
    await runEscalatingInstruction(
      named('cheap', [{ toolCalls: [reportCall({ status: 'blocked', summary: 'stuck' })] }]),
      named('smart', succeeds()),
      browserStub,
      state,
      'second instruction',
      loopOpts,
    );
    expect(earlier.content).toBe(before);
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
