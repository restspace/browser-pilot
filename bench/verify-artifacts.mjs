/**
 * Artifact-level checks on a finished sweep.
 *
 *   node bench/verify-artifacts.mjs fwrd23l [--dir bench/results]
 *
 * Sweep-to-sweep comparison cannot validate a fix: recording is model-driven,
 * so each sweep compiles a DIFFERENT procedure. fwrd19l produced three
 * `wait_for` steps with text="..." targets; fwrd20l and fwrd21l produced none,
 * and the drift that vanished with them looked like a fix. Step counts moved
 * 7/8/7 across three runs of the same task. Cost deltas between sweeps compare
 * different artifacts.
 *
 * What IS comparable is what the run produced. These checks read the compiled
 * store, the exported flow and the replay results, and answer questions with
 * one right answer regardless of which procedure the model happened to record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { RunLedger, scanForLeaks, fatal, describeLeaks, identifierLike } from '../dist/skills/ledger.js';
import { publishedOutputs } from '../dist/skills/learn.js';

const args = process.argv.slice(2);
const tag = args.find((a) => !a.startsWith('--'));
const dir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'bench/results';
if (!tag) {
  console.error('usage: node bench/verify-artifacts.mjs <sweep-tag> [--dir bench/results]');
  process.exit(2);
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

const flowPath = path.join(dir, 'flows', `${tag}.json`);
const skillsDir = path.join(dir, `${tag}-skills`);
if (!exists(flowPath)) {
  console.error(`no flow at ${flowPath} — did run 1 export?`);
  process.exit(2);
}
const flow = read(flowPath);
const store = exists(skillsDir)
  ? fs.readdirSync(skillsDir).filter((f) => f.endsWith('.json')).flatMap((f) => read(path.join(skillsDir, f)))
  : [];

/**
 * The recording run's ledger, reconstructed from what it left behind. The
 * daemon's own ledger is not persisted, so this approximates it from the three
 * sources that survive: the runid (the sweep names run 1 `<tag>-n1`), every
 * value the recording run REPORTED, and the id-like parts of every url its
 * instructions mention. It can only under-report, never invent — a value it
 * misses is a leak this check cannot see, not a false alarm.
 */
function recordingLedger() {
  const l = new RunLedger();
  l.add(`${tag}-n1`, { from: 'var', name: 'runid' });
  for (const st of flow.steps ?? []) {
    for (const [name, value] of Object.entries(st.recorded ?? {})) {
      // Only REFERENCES, not every reported word. The recording run reported
      // status 'Ready', which is also half of the app's own `status-to-Ready`
      // test hook and its `Mark Ready` button — flagging those would be the
      // over-slotting the plan warns about, where a run value and an app
      // constant happen to coincide.
      if (typeof value === 'string' && identifierLike(value)) l.add(value, { from: 'output', step: st.id, name }, { known: true });
    }
  }
  for (const sk of store) {
    const text = `${sk.provenance?.instruction ?? ''} ${sk.preconditions?.urlPattern ?? ''}`;
    for (const url of text.match(/https?:\/\/[^\s'")]+/g) ?? []) {
      const parts = [];
      try {
        const u = new URL(url);
        u.pathname.split('/').filter(Boolean).forEach((v, i) => parts.push({ label: `p${i}`, value: decodeURIComponent(v) }));
        u.hash.replace(/^#\/?/, '').split('/').filter(Boolean).forEach((v, i) => parts.push({ label: `h${i}`, value: decodeURIComponent(v) }));
      } catch {
        continue;
      }
      // A stored pattern's own {{v3}} marker is not a value.
      l.addUrlIds(url, 'recorded', parts.filter((p) => !p.value.includes('{{')));
    }
  }
  return l;
}

let failed = false;
const fail = (m) => {
  failed = true;
  console.log(`FAIL  ${m}`);
};
const pass = (m) => console.log(`ok    ${m}`);

// 1. No value this run made may sit in a locator or a precondition, where it
//    moves a step onto another record without saying so.
const ledger = recordingLedger();
const leaks = [];
for (const sk of store) leaks.push(...scanForLeaks(sk, ledger, sk.id));
leaks.push(...scanForLeaks(flow, ledger, 'flow'));
const fatalLeaks = leaks.filter(fatal);
if (fatalLeaks.length) {
  fail(`${fatalLeaks.length} fatal leak(s) — a run value reached a locator or precondition`);
  console.log(describeLeaks(fatalLeaks.slice(0, 12)));
} else {
  pass(`no fatal leaks (${leaks.length} non-fatal, in reportTemplate/urlPattern/expectations)`);
}

// 2. Every {{step.output}} a later step depends on must be one a ZERO-MODEL
//    replay republishes. A tier-A replay honestly drops recorded values it
//    could not re-observe, so a ref to a model-named report value dies exactly
//    when the replay is at its best — and the step that needed it skips the
//    zero-model path entirely (fwrd21l: one such ref cost four steps).
const byId = new Map(store.map((s) => [s.id, s]));
/** What a ZERO-MODEL replay of this step republishes: labelled reads, plus report values that are pure slot fills. */
const publishes = new Map(
  flow.steps.map((s) => {
    const sk = s.skill ? byId.get(s.skill) : null;
    if (!sk) return [s.id, new Set(Object.keys(s.recorded ?? {}))];
    // A step's pin may be the HEAD of a segment chain whose later segment does
    // the read, so union the whole chain — the same rule the daemon's own
    // lintFlowRefs applies.
    const chain = sk.seq?.chain ? store.filter((o) => o.seq?.chain === sk.seq.chain) : [sk];
    return [s.id, new Set(chain.flatMap(publishedOutputs))];
  }),
);
const fragile = new Set();
for (const step of flow.steps) {
  for (const text of [step.instruction, ...Object.values(step.params ?? {})]) {
    for (const [, sid, out] of String(text).matchAll(/\{\{([\w-]+)\.([\w.#-]+)\}\}/g)) {
      if (out === 'url' || out.startsWith('url.')) continue; // provenance: republished every run
      const can = publishes.get(sid);
      if (!can || can.has(out) || can.has(out.split('#')[0])) continue;
      fragile.add(`${step.id} needs {{${sid}.${out}}}, which a tier-A replay of ${sid} does not republish`);
    }
  }
}
if (fragile.size) {
  fail(`${fragile.size} reference(s) depend on a value a zero-model replay will not republish`);
  for (const f of [...fragile].slice(0, 10)) console.log(`      ${f}`);
} else {
  pass('every cross-step reference is provenance-backed or re-observed');
}

// 3. How much of each replay ran without the model at all. Reported, not
//    asserted: the right number depends on the procedure the run recorded, and
//    a threshold here would just be another way of comparing two sweeps.
for (const f of fs.readdirSync(dir).filter((n) => /^\Q\E/.test(n) === false && n.startsWith(`${tag}-n`) && n.endsWith('-flowrun.json'))) {
  const run = read(path.join(dir, f));
  const steps = run.steps ?? [];
  const a = steps.filter((s) => s.tier === 'A').length;
  const turns = steps.reduce((n, s) => n + (s.turns ?? 0), 0);
  console.log(`      ${f.replace(`${tag}-`, '').replace('-flowrun.json', '')}: tier A ${a}/${steps.length}, ${turns} model turns, ${run.passed}/${run.total} passed`);
}

process.exit(failed ? 1 : 0);
