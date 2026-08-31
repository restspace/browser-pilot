#!/usr/bin/env node
/**
 * Rebuild a flow from a RECORDED session, offline, and fingerprint the result.
 *
 *   node bench/rebuild-flow.mjs --tag fwod25 --dir bench/results-published
 *   node bench/rebuild-flow.mjs --tag fwod25 --baseline bench/fixtures/fwod25.json
 *
 * WHY THIS EXISTS
 *
 * `bench/sweep.mjs --from` already A/Bs a REPLAY-path change: it reuses an
 * earlier sweep's recording, so two runs differ only in code. Its own comment
 * states the precondition it cannot meet —
 *
 *   "A fix in the recorder, in compile, or in buildFlow changes what run 1
 *    PRODUCES and must be measured with a fresh recording."
 *
 * — and a fresh recording is model-driven, so every sweep compiles a DIFFERENT
 * procedure. That is not a control. fwod25 is what it costs: 50 minutes and
 * three runs to test one recording-path change, and the answer was unreadable,
 * because the recording bore no resemblance to fwod24's. Its flow came out with
 * zero outputs, zero cross-step references and seven literal `S00021`, and
 * nothing in it could be attributed to the change under test.
 *
 * So hold the recording constant instead of the code. A published `script.jsonl`
 * is a complete, deterministic record of one run: every instruction, every step
 * with its target and result, every report. Everything that happens AFTER the
 * model speaks — flattenComposedValues, backfillReadValues, slug, cites,
 * compile, buildFlow, lintFlowRefs — is a pure function of it. Replay that half
 * offline, in seconds, for free, against as many past recordings as we have.
 *
 * WHAT IT CANNOT TELL YOU
 *
 * The naming ask is a live exchange: this reports which values it WOULD hold a
 * report for (`unnamedReadValues`, the real predicate), but not what a model
 * would answer. That part needs a model — one instruction of one, not a sweep.
 * Everything downstream of the answer is covered here.
 *
 * The fingerprint is deliberately the things that have actually gone wrong:
 * how many cross-step references a flow carries, what each step publishes,
 * and how many record identities are still frozen in as literals.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** dist/ is imported by URL: a bare Windows path is not a legal ESM specifier. */
const dist = (rel) => pathToFileURL(path.join(root, 'dist', rel)).href;
const { buildFlow, lintFlowRefs } = await import(dist('skills/flow.js'));
const { SkillStore } = await import(dist('skills/store.js'));
const { bindSkill, publishedOutputs } = await import(dist('skills/learn.js'));
const { compileSkills } = await import(dist('skills/compile.js'));
const { backfillReadValues, flattenComposedValues, unnamedReadValues } = await import(dist('agent/report.js'));

const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const tag = arg('--tag');
const dir = path.resolve(arg('--dir', 'bench/results-published'));
const baselineFile = arg('--baseline');
const writeBaseline = argv.includes('--write-baseline');

if (!tag) {
  console.error('usage: rebuild-flow.mjs --tag <sweepTag> [--dir <published>] [--baseline <file>] [--write-baseline]');
  process.exit(2);
}

/** Every recorded session for the tag, newest run last: fwod25-n1, fwod25-n2, … */
function sessions() {
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${tag}-n`) && f.endsWith('-script.jsonl'))
    .sort()
    .map((f) => ({ runid: f.slice(0, -'-script.jsonl'.length), file: path.join(dir, f) }));
}

function readEntries(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

/**
 * The reads one instruction made, in the shape the loop passes to the report
 * helpers. Mirrors ScriptRecorder.readsThisInstruction — same filters, so what
 * this reports is what the live path would have seen.
 */
function readsOf(steps) {
  const out = [];
  for (const e of steps) {
    if (e.k !== 'step' || (e.tool !== 'read' && e.tool !== 'read_all') || typeof e.result !== 'string') continue;
    if (e.args?.target === '(read-back)') continue;
    let parsed;
    try {
      parsed = JSON.parse(e.result);
    } catch {
      parsed = e.result;
    }
    const values = (Array.isArray(parsed) ? parsed : [parsed]).filter((v) => typeof v === 'string');
    if (values.length) out.push({ target: String(e.args?.target ?? ''), values });
  }
  return out;
}

/** Split a session into its instructions, each with the steps and report that followed. */
function groups(entries) {
  const out = [];
  let cur = null;
  for (const e of entries) {
    if (e.k === 'instruction') {
      cur = { instruction: e.text ?? '', steps: [], report: null };
      out.push(cur);
    } else if (!cur) continue;
    else if (e.k === 'report') cur.report = e;
    else cur.steps.push(e);
  }
  return out;
}

function startUrlOf(entries) {
  for (const e of entries) {
    if (e.k === 'instruction' && e.url) return e.url;
    if (e.k === 'step' && e.tool === 'goto' && typeof e.args?.url === 'string') return e.args.url;
  }
  return null;
}

const recompile = !argv.includes('--published-skills');

/**
 * Skills COMPILED FROM THE RECORDING, not read off the published store.
 *
 * The published store was built by whatever code ran that sweep, so reading it
 * makes every compile.ts change invisible here — the first cut of this file did
 * exactly that and reported "no diff" for a change that rewrote which reads
 * survive compilation. Recompiling closes that: compile.ts, and everything it
 * decides about labels and published outputs, is now under the gate.
 *
 * Each instruction's skill is registered under the id the RECORDING pinned, so
 * `step.skill` on the flow still resolves. Segmented compiles keep their own
 * ids for the tail; only the head takes the pinned one.
 */
function storeFrom(entries, known) {
  const skills = [];
  // knownValues ACCUMULATES through a session. The daemon compiles each
  // instruction with `this.ledger.all()`, and the ledger banks every value a
  // report named (server.ts noteMintedIds), so instruction 6 is compiled
  // knowing what instructions 1-5 produced. Passing only the runid made later
  // skills far poorer: s_c995ae bound 1 param here against 4 in the store, and
  // the rebuilt flow carried 10 cross-step references against the 19 that
  // shipped. That gap was my reconstruction, not a regression.
  const known2 = { ...known };
  let cur = null;
  for (const e of entries) {
    if (e.k === 'instruction') cur = { instruction: e.text ?? '', entries: [e] };
    else if (!cur) continue;
    else if (e.k === 'report') {
      if (e.status === 'success') {
        try {
          const compiled = compileSkills({
            entries: cur.entries,
            instruction: cur.instruction,
            report: { status: e.status, summary: e.summary ?? '', evidence: { values: e.values ?? {} } },
            session: 'rebuild',
            // The daemon compiles with the session's known values (the runid it
            // was given, values it minted). Without them discoverSlots finds
            // fewer slots, so fewer step params carry a reference and the
            // rebuilt flow looks a third emptier than the one that shipped.
            knownValues: known2,
          });
          if (compiled.length && e.skill) compiled[0].id = e.skill;
          skills.push(...compiled);
        } catch {
          /* a recording compile.ts cannot handle is itself a finding, but not a crash */
        }
        // Bank this instruction's reported values for the NEXT compile, exactly
        // as the daemon's ledger does.
        for (const [name, value] of Object.entries(e.values ?? {})) known2[name] = String(value);
      }
      cur = null;
    } else cur.entries.push(e);
  }
  return {
    get: (id) => skills.find((s) => s.id === id) ?? null,
    list: (origin) => skills.filter((s) => s.origin === origin),
  };
}

const published = fs.existsSync(path.join(dir, `${tag}-skills`)) ? new SkillStore(path.join(dir, `${tag}-skills`)) : null;

const report = { tag, runs: [] };

for (const { runid, file } of sessions()) {
  const entries = readEntries(file);
  const gs = groups(entries);
  const run = { runid, instructions: [], flow: null };

  for (const [i, g] of gs.entries()) {
    if (!g.report) continue;
    const reads = readsOf(g.steps);
    // The recorded report's `values` are already POST-backfill, so re-deriving
    // the pipeline from them would score the old code's output. Reconstruct the
    // report as the model returned it: summary plus whatever the model itself
    // named. A value the backfill added is one no read-target could name, and
    // that is precisely what we want to re-decide.
    const modelValues = {};
    for (const [k, v] of Object.entries(g.report.values ?? {})) {
      // A backfilled name is a slug of a read target; a model's name is not.
      if (!reads.some((r) => slugLike(r.target) === k.replace(/_\d+$/, ''))) modelValues[k] = v;
    }
    const rebuilt = {
      status: g.report.status,
      summary: g.report.summary ?? '',
      ...(Object.keys(modelValues).length ? { evidence: { values: modelValues } } : {}),
    };
    const wouldAsk = unnamedReadValues(rebuilt, reads);
    flattenComposedValues(rebuilt);
    const promoted = backfillReadValues(rebuilt, reads);
    run.instructions.push({
      n: i + 1,
      status: g.report.status,
      instruction: g.instruction.slice(0, 60),
      reads: reads.length,
      modelNamed: Object.keys(modelValues),
      wouldAsk,
      // What the recording ACTUALLY did about the ask, once a run carries it.
      askedForReal: g.report.namingAsk ?? null,
      promoted,
      finalNames: Object.keys(rebuilt.evidence?.values ?? {}),
    });
  }

  const startUrl = startUrlOf(entries);
  const store = recompile ? storeFrom(entries, { runid }) : published;
  if (startUrl && store) {
    const publishedOutputsOf = (id) => {
      const sk = store.get(id);
      if (!sk) return null;
      const chain = sk.seq ? store.list(sk.origin).filter((s) => s.seq?.chain === sk.seq.chain) : [sk];
      return chain.flatMap(publishedOutputs);
    };
    const flow = buildFlow(entries, {
      name: tag,
      origin: new URL(startUrl).origin,
      startUrl,
      vars: { runid },
      session: runid,
      bind: (id, instr) => {
        const sk = store.get(id);
        const bound = sk ? bindSkill(sk, instr, { runid }) : null;
        if (process.env.REBUILD_TRACE) console.error(`  bind ${id}: skill=${sk ? 'found' : 'MISSING'} params=${bound ? JSON.stringify(Object.keys(bound)) : 'NULL'}`);
        return bound;
      },
    });
    if (flow) {
      const text = JSON.stringify(flow);
      run.flow = {
        steps: flow.steps.length,
        refs: histogram(text.match(/\{\{[^}]*\}\}/g) ?? []),
        crossStepRefs: (text.match(/\{\{\d\d-[^}]*\}\}/g) ?? []).length,
        outputs: Object.fromEntries(flow.steps.map((s) => [s.id, s.outputs ?? []])),
        lint: lintFlowRefs(flow, publishedOutputsOf),
      };
    }
  }
  report.runs.push(run);
}

/** A read target reduced the way report.ts's slug() reduces it, for spotting backfilled names. */
function slugLike(target) {
  return target.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
}

function histogram(list) {
  const h = {};
  for (const x of list) h[x] = (h[x] ?? 0) + 1;
  return Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1]));
}

// ---- output -----------------------------------------------------------------

for (const run of report.runs) {
  console.log(`\n=== ${run.runid} ===`);
  for (const ins of run.instructions) {
    console.log(
      `  ${String(ins.n).padStart(2)} ${ins.status.padEnd(7)} reads=${String(ins.reads).padStart(2)}  ` +
        `model-named=[${ins.modelNamed.join(',')}]  would-ask=[${ins.wouldAsk.join(' | ')}]  ` +
        `backfilled=[${ins.promoted.join(',')}]`,
    );
    if (ins.askedForReal) {
      console.log(`      recorded ask: asked=[${ins.askedForReal.asked.join(' | ')}] named=${ins.askedForReal.named}`);
    }
  }
  if (run.flow) {
    console.log(`  flow: ${run.flow.steps} step(s), ${run.flow.crossStepRefs} cross-step reference(s)`);
    console.log(`  refs: ${JSON.stringify(run.flow.refs)}`);
    for (const [id, outs] of Object.entries(run.flow.outputs)) console.log(`    ${id} publishes [${outs.join(',')}]`);
    for (const w of run.flow.lint) console.log(`  lint: ${w}`);
  } else {
    console.log('  flow: not rebuilt (no start url, or no published skill store for this tag)');
  }
}

/** The numbers a recording-path change is allowed to move, and must not move the wrong way. */
const summary = {
  tag,
  runs: report.runs.map((r) => ({
    runid: r.runid,
    instructions: r.instructions.length,
    withModelNames: r.instructions.filter((i) => i.modelNamed.length).length,
    wouldAsk: r.instructions.filter((i) => i.wouldAsk.length).length,
    crossStepRefs: r.flow?.crossStepRefs ?? null,
    stepsPublishing: r.flow ? Object.values(r.flow.outputs).filter((o) => o.length).length : null,
  })),
};
console.log(`\n${JSON.stringify(summary, null, 2)}`);

if (writeBaseline && baselineFile) {
  fs.mkdirSync(path.dirname(path.resolve(baselineFile)), { recursive: true });
  fs.writeFileSync(path.resolve(baselineFile), JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n[rebuild] baseline written to ${baselineFile}`);
} else if (baselineFile) {
  const want = JSON.parse(fs.readFileSync(path.resolve(baselineFile), 'utf8'));
  const got = summary;
  if (JSON.stringify(want) === JSON.stringify(got)) {
    console.log('\n[rebuild] MATCHES baseline — this change does not alter what these recordings compile to');
    process.exit(0);
  }
  console.log('\n[rebuild] DIFFERS from baseline:');
  for (const [i, w] of want.runs.entries()) {
    const g = got.runs[i];
    if (!g) {
      console.log(`  ${w.runid}: missing`);
      continue;
    }
    for (const k of ['instructions', 'withModelNames', 'wouldAsk', 'crossStepRefs', 'stepsPublishing']) {
      if (w[k] !== g[k]) console.log(`  ${w.runid}.${k}: ${w[k]} -> ${g[k]}`);
    }
  }
  process.exit(1);
}
