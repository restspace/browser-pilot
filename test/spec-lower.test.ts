import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { flowToSpec } from '../src/spec/ir.js';
import type { SpecFlow, SpecSegment, SpecStep } from '../src/spec/ir.js';
import { specToFlow, stageForReplay } from '../src/spec/lower.js';
import { SkillStore } from '../src/skills/store.js';
import type { Skill } from '../src/skills/store.js';

// --- hand-built fixtures ----------------------------------------------------
// Same shapes as test/spec-lift.test.ts's fixtures (segment()/step() there),
// reproduced here rather than imported: lift's helpers are test-local by
// design (that file's own header explains why) and lower's round trip goes
// through flowToSpec, not liftFlowFile, so there is no shared dependency to
// reuse.

function segment(id: string, extra: Partial<SpecSegment> = {}): SpecSegment {
  return {
    id,
    template: `do the ${id} thing with {{v1}}`,
    params: { v1: { example: 'foo', usedIn: [1] } },
    preconditions: { urlPattern: 'http://localhost:5173/x' },
    steps: [
      {
        tool: 'click',
        args: { target: '{{v1}}' },
        locators: { target: [{ kind: 'role', role: 'button', name: '{{v1}}', seen: 1 } as any] },
      },
      {
        tool: 'loop',
        args: {},
        locators: {},
        while: [{ kind: 'css', selector: '.row', seen: 1 } as any],
        max: 10,
        body: [
          {
            tool: 'click',
            args: { target: 'Delete' },
            locators: { target: [{ kind: 'text', text: 'Delete', seen: 1 } as any] },
          },
        ],
      },
    ],
    ...extra,
  };
}

function step(id: string, extra: Partial<SpecStep> = {}): SpecStep {
  return {
    id,
    instruction: `Step ${id}`,
    params: { v1: 'literal', v2: '{{someVar}}', v3: '{{01-open.title}}' },
    outputs: ['title'],
    segments: [segment(`${id}-seg`)],
    ...extra,
  };
}

const HAND_BUILT_SPECS: SpecFlow[] = [
  // minimal: one step, no segments (no converged procedure)
  {
    version: 1,
    name: 'minimal',
    origin: 'http://localhost:5173',
    startUrl: 'http://localhost:5173/',
    vars: [],
    steps: [step('01-open', { segments: [] })],
  },
  // multi-step, single-segment-per-step
  {
    version: 1,
    name: 'full',
    origin: 'http://localhost:5173',
    startUrl: 'http://localhost:5173/project-manager',
    vars: ['name', 'client'],
    steps: [
      step('01-open', { params: {}, outputs: [] }),
      step('02-create', {
        params: { v1: '{{name}}', v2: '{{client}}' },
        outputs: ['id', 'url'],
        segments: [
          segment('02-create-seg', {
            derived: { d1: { step: 2, at: 'id', example: '42' } },
          }),
        ],
      }),
    ],
  },
  // multi-segment procedure (chain) on one step
  {
    version: 1,
    name: 'chained',
    origin: 'http://localhost:5173',
    startUrl: 'http://localhost:5173/sign-in',
    vars: ['user'],
    steps: [
      step('01-signin', {
        params: { v1: '{{user}}' },
        outputs: ['landed'],
        segments: [
          segment('01-signin-a', { preconditions: { urlPattern: 'http://localhost:5173/sign-in' } }),
          segment('01-signin-b', { preconditions: { urlPattern: 'http://localhost:5173/home' } }),
          segment('01-signin-c', {
            preconditions: { urlPattern: 'http://localhost:5173/home', requireText: ['{{v1}}'] },
          }),
        ],
      }),
    ],
  },
  // no steps at all
  {
    version: 1,
    name: 'empty',
    origin: 'http://localhost:5173',
    startUrl: 'http://localhost:5173/',
    vars: [],
    steps: [],
  },
];

function wrapSkillAsFlow(skill: Skill): SpecFlow {
  const derived = skill.derived;
  const segments: SpecSegment[] =
    skill.seq == null || skill.seq.index === 0
      ? [
          {
            id: skill.id,
            template: skill.template,
            params: skill.params,
            preconditions: skill.preconditions.requireText
              ? { urlPattern: skill.preconditions.urlPattern, requireText: skill.preconditions.requireText }
              : { urlPattern: skill.preconditions.urlPattern },
            steps: skill.steps,
            ...(derived ? { derived } : {}),
          },
        ]
      : [];
  return {
    version: 1,
    name: `skill-${skill.id}`,
    origin: skill.origin,
    startUrl: skill.preconditions.urlPattern,
    vars: Object.keys(skill.params),
    steps: [
      {
        id: '01-run',
        instruction: skill.template,
        params: Object.fromEntries(Object.keys(skill.params).map((k) => [k, `{{${k}}}`])),
        outputs: [],
        segments,
      },
    ],
  };
}

const FWAT2_SKILLS_PATH = path.join(__dirname, '..', 'bench', 'results-published', 'fwat2-skills', 'localhost_5173.json');
const fwat2Skills: Skill[] = JSON.parse(fs.readFileSync(FWAT2_SKILLS_PATH, 'utf8'));

function tempStoreDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sitelooper-spec-lower-'));
}

describe('specToFlow: round trip via flowToSpec (in-memory store)', () => {
  it.each(HAND_BUILT_SPECS.map((spec) => [spec.name, spec] as const))('hand-built spec "%s"', (_name, spec) => {
    const { flow, skills } = specToFlow(spec);
    const store = new SkillStore(tempStoreDir());
    for (const skill of skills) store.put(skill);
    const { spec: roundTripped } = flowToSpec(flow, store);
    expect(roundTripped).toEqual(spec);
  });

  it('round-trips every skill in the fwat2 store, wrapped as a one-step flow', () => {
    expect(fwat2Skills.length).toBeGreaterThan(0);
    for (const skill of fwat2Skills) {
      const spec = wrapSkillAsFlow(skill);
      const { flow, skills } = specToFlow(spec);
      const store = new SkillStore(tempStoreDir());
      for (const s of skills) store.put(s);
      const { spec: roundTripped } = flowToSpec(flow, store);
      expect(roundTripped).toEqual(spec);
    }
  });
});

describe('specToFlow: shape of the produced Flow/Skill[]', () => {
  it('gives every skill status validated and zeroed stats', () => {
    const { skills } = specToFlow(HAND_BUILT_SPECS[1]);
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.status).toBe('validated');
      expect(skill.stats).toEqual({ uses: 0, successes: 0, partial: 0, created: skill.stats.created, failedAtStep: {}, fallthroughs: 0 });
    }
  });

  it('does not set seq on a single-segment procedure', () => {
    const { skills } = specToFlow(HAND_BUILT_SPECS[1]);
    for (const skill of skills) expect(skill.seq).toBeUndefined();
  });

  it('sets seq with a shared chain id and 0-based index for a multi-segment procedure', () => {
    const chainedSpec = HAND_BUILT_SPECS[2];
    const { skills } = specToFlow(chainedSpec);
    expect(skills).toHaveLength(3);
    const chainId = chainedSpec.steps[0].segments[0].id;
    skills.forEach((skill, i) => {
      expect(skill.seq).toEqual({ chain: chainId, index: i, of: 3 });
    });
  });

  it('points the flow step at the first segment id', () => {
    const chainedSpec = HAND_BUILT_SPECS[2];
    const { flow } = specToFlow(chainedSpec);
    expect(flow.steps[0].skill).toBe(chainedSpec.steps[0].segments[0].id);
  });

  it('leaves skill unset on a step with no converged procedure', () => {
    const { flow, skills } = specToFlow(HAND_BUILT_SPECS[0]);
    expect(flow.steps[0].skill).toBeUndefined();
    expect(skills).toHaveLength(0);
  });
});

describe('stageForReplay', () => {
  it('writes skills into the given store and returns a flow flowToSpec resolves against it', () => {
    const spec = HAND_BUILT_SPECS[1];
    const store = new SkillStore(tempStoreDir());
    const flow = stageForReplay(spec, store);
    const { spec: roundTripped } = flowToSpec(flow, store);
    expect(roundTripped).toEqual(spec);
  });

  it('persists to disk: a fresh SkillStore instance on the same dir resolves the same spec', () => {
    const spec = HAND_BUILT_SPECS[2];
    const dir = tempStoreDir();
    const flow = stageForReplay(spec, new SkillStore(dir));
    const reopened = new SkillStore(dir);
    const { spec: roundTripped } = flowToSpec(flow, reopened);
    expect(roundTripped).toEqual(spec);
  });

  it('stages every fwat2 skill for replay and round-trips through a reopened store', () => {
    for (const skill of fwat2Skills) {
      const spec = wrapSkillAsFlow(skill);
      const dir = tempStoreDir();
      const flow = stageForReplay(spec, new SkillStore(dir));
      const reopened = new SkillStore(dir);
      const { spec: roundTripped } = flowToSpec(flow, reopened);
      expect(roundTripped).toEqual(spec);
    }
  });
});
