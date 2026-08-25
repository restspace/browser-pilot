/**
 * Unit tests for navigation-by-recorded-destination (PLAN-replay-v2 "order of
 * application" rung 3): a navigation step whose clicked affordance is gone
 * (session-local UI like a recents list) substitutes a goto to the concrete
 * destination its recording captured — and only then.
 */
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { replaySkill } from '../src/skills/replay.js';
import type { Skill } from '../src/skills/store.js';

/** The minimal Page surface replaySkill touches on this path. */
function fakePage(state: { url: string }): Page {
  return {
    url: () => state.url,
    evaluate: async () => undefined,
  } as unknown as Page;
}

function navSkill(expectPattern: string): Skill {
  return {
    id: 's_test',
    origin: 'http://h:1',
    template: 'open the dashboard',
    params: {},
    preconditions: { urlPattern: 'http://h:1/' },
    steps: [
      {
        tool: 'click',
        args: { target: '@e1' },
        // A locator that cannot resolve on the fake page (getByRole throws).
        locators: { target: [{ kind: 'role', role: 'link', name: 'Service Health' } as never] },
        expect: { urlPattern: expectPattern },
      },
    ],
    stats: { uses: 1, successes: 1, partial: 0, created: 't', failedAtStep: {}, fallthroughs: 0 },
    status: 'validated',
    provenance: { session: 's', instruction: 'i', created: 't' },
  };
}

function run(skill: Skill, state: { url: string }, gotos: string[]) {
  return replaySkill(skill, {}, {
    page: fakePage(state),
    exec: async (tool, args) => {
      if (tool === 'goto') {
        gotos.push(String(args.url));
        state.url = String(args.url);
      }
      return { result: 'ok' };
    },
  });
}

describe('navigation by recorded destination', () => {
  it('substitutes a goto when the target is gone and the destination is concrete', async () => {
    const state = { url: 'http://h:1/' };
    const gotos: string[] = [];
    const res = await run(navSkill('http://h:1/d/uid7/service-health'), state, gotos);
    expect(gotos).toEqual(['http://h:1/d/uid7/service-health']);
    expect(res.ok).toBe(true);
    expect(res.fallthroughs).toBe(1);
    expect(res.misses[0].used).toContain('goto');
    expect(res.warnings.join(' ')).toContain('recorded destination');
  });

  it('refuses when the destination still carries a volatile segment', async () => {
    const state = { url: 'http://h:1/' };
    const gotos: string[] = [];
    const res = await run(navSkill('http://h:1/d/:id/service-health'), state, gotos);
    expect(gotos).toEqual([]);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe(1);
  });

  it('refuses when the step was not a move (destination is the current page)', async () => {
    // A dialog-opening click on the same page must never turn into a reload.
    const state = { url: 'http://h:1/d/uid7/service-health' };
    const gotos: string[] = [];
    const res = await run(navSkill('http://h:1/d/uid7/service-health'), state, gotos);
    expect(gotos).toEqual([]);
    expect(res.ok).toBe(false);
  });

  it('uses a derived value bound earlier in the same replay', async () => {
    const state = { url: 'http://h:1/' };
    const gotos: string[] = [];
    const skill = navSkill('http://h:1/d/{{d1}}/service-health');
    const res = await replaySkill(skill, { d1: 'live9' }, {
      page: fakePage(state),
      exec: async (tool, args) => {
        if (tool === 'goto') {
          gotos.push(String(args.url));
          state.url = String(args.url);
        }
        return { result: 'ok' };
      },
    });
    expect(gotos).toEqual(['http://h:1/d/live9/service-health']);
    expect(res.ok).toBe(true);
  });
});
