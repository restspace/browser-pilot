#!/usr/bin/env node
/**
 * Does this model fill in `evidence.values`? One LLM call per case, no browser,
 * no app, no sweep.
 *
 *   node bench/naming-probe.mjs --variant current --model deepseek/deepseek-v4-flash
 *   node bench/naming-probe.mjs --all --model deepseek/deepseek-v4-flash --provider openrouter
 *
 * WHY THIS SHAPE
 *
 * The behaviour under test is a single decision: at the end of an instruction,
 * having read some values off the page, does the model put them in the report as
 * named values or leave them in the prose? Nothing about that needs a live
 * browser. bench/fixtures/recordings holds twelve real recordings across three
 * apps; each instruction in them is a case whose answer we already know, because
 * the recorded `read` steps say exactly what was on the page.
 *
 * So replay just the final report call: feed the instruction and the tool
 * calls/results the run actually made, offer the real `report` tool, and see
 * what comes back. One call per case, cents per sweep of the whole corpus,
 * about a minute. Compare that to fwod25 — 50 minutes and three cloud runs for
 * an answer that turned out to be unreadable.
 *
 * SHAPE DOMINATES WORDING — measured, with `current` held constant:
 *
 *   summary-nudge     85% of reports carried values   57% of page values named
 *   summary-nonudge   59%                             43%
 *   turns-nudge       48%                             31%
 *   turns-nonudge     11%                              8%
 *
 * Both factors are real and they compound. Real turn structure costs more
 * (-37 points) than losing the explicit ask (-26). And turns-nonudge lands at
 * 11%, against 1-of-9 model-named instructions in fwod24 and 0-of-10 in
 * fwod25 — so THAT shape is the faithful one, and it is the default here for
 * exactly that reason.
 *
 * The first cut of this file defaulted to summary-nudge and reported 89%
 * compliance as evidence the model was willing and something else suppressed
 * it. That number was measuring this file's own nudge. Any variant comparison
 * run in a shape that scores 85% is comparing wordings whose effect the nudge
 * has already swamped.
 *
 * The useful half: adding an ask at REPORT time to a realistic history takes
 * compliance from 11% to 48%. Asking at the right moment is worth about four
 * times asking in the system prompt — which is the case for the retry ask in
 * loop.ts, and it is why fwod25 could not show that mechanism working.
 *
 * WHAT IT IS NOT
 *
 * The message history is RECONSTRUCTED from the recording, not the exact
 * context the model saw (that is not stored). Tool results are replayed
 * verbatim, so the values are the real ones and the instruction is the real
 * one, but token-for-token this is not the original prompt.
 *
 * Local on purpose: the cloud-only rule exists so timing and cost are
 * comparable across identical hardware. This measures neither. It is a model
 * response, and a model responds the same wherever the request came from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = (rel) => pathToFileURL(path.join(root, 'dist', rel)).href;
const { OpenAICompatProvider, resolveProviderConfig } = await import(dist('agent/llm.js'));
const { TOOL_DEFS } = await import(dist('agent/tools.js'));

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

// ---- the variants under test -------------------------------------------------
//
// Each supplies the report tool's `values` description and a system-prompt line.
// Everything else is held constant, so a score difference is the wording.

const VARIANTS = {
  /** Exactly what ships today (tools.ts + prompt.ts rule 11). */
  current: {
    system:
      'put key facts the caller needs (names/ids created, counts, final URL) in evidence.values; ' +
      'keep summary to one short paragraph — the caller only reads the report.',
    values:
      'Every concrete value you read off the page, as name -> value. ' +
      'ALWAYS include any reference the APP assigned to a record you created or opened ' +
      '(an order number, ticket ref, uid, generated id) — later work addresses that record by it, ' +
      'and a value left only in the summary prose cannot be used. Names should be ones a person would ' +
      'write (order_reference, unit_price), not selector fragments.',
  },

  /** Worked example first, abstraction second — the inversion under test. */
  example: {
    system:
      'Every value you read off the page goes in evidence.values as name -> value. Example: after saving an ' +
      'order you read "S00021" and "85.00", so evidence.values is {"order_reference": "S00021", "unit_price": "85.00"}. ' +
      'The summary is prose for a human; evidence.values is the data. A value in the summary but not in ' +
      'evidence.values is lost.',
    values:
      'The values you read, as name -> value. Example: {"order_reference": "S00021", "unit_price": "85.00", ' +
      '"customer_name": "Acme Ltd"}. Every value that appears in your summary belongs here too.',
  },

  /** Mechanical rule, no judgement asked for. */
  mechanical: {
    system:
      'For EVERY read tool call you made, put its result in evidence.values under a name. If you made four ' +
      'read calls, evidence.values has at least four entries. Do not decide which are important — include them all. ' +
      'The summary is prose; evidence.values is the data.',
    values:
      'One entry per value you read, as name -> value. If you called read four times, there are at least four ' +
      'entries here. Name each one as a person would (order_reference, unit_price, customer_name).',
  },

  /** Names the consequence in the caller's terms. */
  consequence: {
    system:
      'put every value you read in evidence.values as name -> value. A later instruction will be given ONLY ' +
      'evidence.values, never your summary — so a value you describe in prose but do not name there is ' +
      'invisible to the rest of the task and the work has to be redone.',
    values:
      'Every value you read off the page, as name -> value. The next instruction receives ONLY this object, ' +
      'never your summary. Anything an order number, ticket ref or id — name it here (order_reference, ' +
      'ticket_ref) or the next step cannot find the record you just worked on.',
  },
};

// ---- cases from the recorded corpus ------------------------------------------

const dir = path.join(root, 'bench/fixtures/recordings');

/** One instruction: what was asked, what the run did, what was on the page. */
function cases(limit) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    const app = f.startsWith('fwod') ? 'odoo' : f.startsWith('fwgr') ? 'grafana' : 'repairdesk';
    const L = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean)
      .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    let cur = null;
    for (const e of L) {
      if (e.k === 'instruction') cur = { app, run: f.replace('-script.jsonl', ''), instruction: e.text ?? '', steps: [], expect: [] };
      else if (!cur) continue;
      else if (e.k === 'report') {
        // Only cases where the run actually read something: with nothing on the
        // page there is nothing to name, and the case cannot discriminate.
        if (e.status === 'success' && cur.expect.length) out.push(cur);
        cur = null;
      } else if (e.k === 'step') {
        cur.steps.push(e);
        if (/^read/.test(e.tool) && e.args?.target !== '(read-back)' && typeof e.result === 'string') {
          let p; try { p = JSON.parse(e.result); } catch { p = e.result; }
          for (const v of Array.isArray(p) ? p : [p]) {
            const s = typeof v === 'string' ? v.trim() : '';
            if (s.length >= 3 && s.length <= 60 && !cur.expect.includes(s)) cur.expect.push(s);
          }
        }
      }
    }
  }
  return limit ? out.slice(0, limit) : out;
}

/**
 * The message history the model had when it called report — in one of four
 * shapes, because the SHAPE turned out to matter more than any wording.
 *
 * The first probe collapsed a whole instruction into one user message ending
 * "You have finished acting. Now call the report tool." That scored the current
 * prompt at 89% of reports carrying values, against 5-of-9 (fwod24) and 0-of-10
 * (fwod25) in real runs with the same model and the same wording. Two suspects
 * in that collapse, so vary them independently:
 *
 *   summary-nudge   the original probe: read results listed compactly, then a
 *                   direct instruction to report. Every value is recent, salient
 *                   and adjacent to the ask.
 *   summary-nonudge same list, no instruction to report — does the pointed ask
 *                   alone carry it?
 *   turns-nudge     the real thing: genuine assistant tool_calls and tool
 *                   results, one pair per step, so read results sit where they
 *                   really sit — scattered through a long history — plus the ask.
 *   turns-nonudge   real turns, no ask. This is what a live run looks like.
 *
 * If turns-nonudge collapses toward the live rate, the problem is where the
 * instruction sits relative to the values, not how it is phrased — and the fix
 * is to ask at REPORT time, which is what the retry ask already does.
 */
function messages(c, variant, shape) {
  const nudge = shape.endsWith('-nudge');
  const asTurns = shape.startsWith('turns');
  const msgs = [
    { role: 'system', content: `You are driving a web browser to carry out one instruction. ${variant.system}` },
    { role: 'user', content: c.instruction },
  ];
  const steps = c.steps.slice(0, 40);
  if (asTurns) {
    // One assistant tool_call + one tool result per step, as the live loop
    // accumulates them. Snapshots are the bulk of a real context and they are
    // recorded, so they go in at full recorded length rather than trimmed.
    steps.forEach((s, i) => {
      const id = `c${i + 1}`;
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: s.tool, arguments: JSON.stringify(s.args ?? {}) } }],
      });
      msgs.push({ role: 'tool', tool_call_id: id, content: String(s.result ?? '') });
    });
    if (nudge) msgs.push({ role: 'user', content: 'You have finished acting. Now call the report tool with the outcome.' });
  } else {
    const lines = steps.map((s, i) => {
      const args = JSON.stringify(s.args ?? {});
      const res = String(s.result ?? '').slice(0, 200);
      return `${i + 1}. ${s.tool}(${args.slice(0, 160)}) -> ${res}`;
    });
    msgs.push({
      role: 'user',
      content: nudge
        ? `You have finished acting. Here is what you did, in order:\n\n${lines.join('\n')}\n\nNow call the report tool with the outcome.`
        : `Here is what you did, in order:\n\n${lines.join('\n')}`,
    });
  }
  return msgs;
}

function reportTool(variant) {
  const base = TOOL_DEFS.find((t) => t.name === 'report');
  const t = JSON.parse(JSON.stringify(base));
  t.parameters.properties.evidence.properties.values.description = variant.values;
  return t;
}

// ---- run ---------------------------------------------------------------------

const model = arg('--model', 'deepseek/deepseek-v4-flash');
const provider = arg('--provider', 'openrouter');
const limit = Number(arg('--limit', '0')) || 0;
const names = argv.includes('--all') ? Object.keys(VARIANTS) : [arg('--variant', 'current')];
const SHAPES = ['summary-nudge', 'summary-nonudge', 'turns-nudge', 'turns-nonudge'];
// Default to the shape that matches live behaviour, not the flattering one.
const shapes = argv.includes('--shapes') ? SHAPES : [arg('--shape', 'turns-nonudge')];
const all = cases(limit);

console.log(`${all.length} case(s) from ${new Set(all.map((c) => c.run)).size} recording(s), model ${model}\n`);

const results = [];
for (const shape of shapes) {
 for (const name of names) {
  const variant = VARIANTS[name];
  if (!variant) { console.error(`unknown variant "${name}" (have: ${Object.keys(VARIANTS).join(', ')})`); process.exit(2); }
  const cfg = resolveProviderConfig({ provider, model });
  const llm = new OpenAICompatProvider(cfg);
  const tool = reportTool(variant);
  let filled = 0, covered = 0, wanted = 0, failed = 0;
  const perApp = {};
  for (const c of all) {
    perApp[c.app] ??= { n: 0, filled: 0, covered: 0, wanted: 0 };
    const A = perApp[c.app];
    A.n++;
    A.wanted += c.expect.length;
    wanted += c.expect.length;
    let values = {};
    try {
      const done = await llm.complete(messages(c, variant, shape), [tool], { temperature: 0 });
      const call = (done.toolCalls ?? []).find((x) => x.name === 'report');
      values = call?.args?.evidence?.values ?? {};
      if (typeof values !== 'object' || values === null) values = {};
    } catch (err) {
      failed++;
      if (failed <= 2) console.error(`
[probe] call failed: ${err.message.slice(0, 400)}`);
      process.stdout.write('!');
      continue;
    }
    const got = Object.values(values).map((v) => String(v).trim());
    const hit = c.expect.filter((e) => got.some((g) => g === e || g.includes(e) || e.includes(g))).length;
    if (Object.keys(values).length) { filled++; A.filled++; }
    covered += hit; A.covered += hit;
    process.stdout.write(hit === c.expect.length ? '#' : Object.keys(values).length ? '+' : '.');
  }
  console.log(`\n\n=== ${name} ===`);
  console.log(`  reports with any values : ${filled}/${all.length}  (${((filled / all.length) * 100).toFixed(0)}%)`);
  console.log(`  page values named       : ${covered}/${wanted}  (${((covered / wanted) * 100).toFixed(0)}%)`);
  if (failed) console.log(`  call failures           : ${failed}`);
  for (const [app, A] of Object.entries(perApp)) {
    console.log(`    ${app.padEnd(11)} values-filled ${A.filled}/${A.n}   named ${A.covered}/${A.wanted}`);
  }
  results.push({ name: `${name} / ${shape}`, filled, cases: all.length, covered, wanted });
 }
}

if (results.length > 1) {
  console.log('\n=== ranking (by page values named) ===');
  for (const r of [...results].sort((a, b) => b.covered / b.wanted - a.covered / a.wanted)) {
    console.log(`  ${r.name.padEnd(12)} ${((r.covered / r.wanted) * 100).toFixed(0)}% named   ${((r.filled / r.cases) * 100).toFixed(0)}% of reports had any values`);
  }
}
