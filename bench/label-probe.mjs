#!/usr/bin/env node
/**
 * Will this model use `read`'s label argument? One LLM call per case, no browser.
 *
 *   node bench/label-probe.mjs --model deepseek/deepseek-v4-flash
 *   node bench/label-probe.mjs --arms --limit 20
 *
 * WHY THIS EXISTS
 *
 * Report-time naming is an attention problem: the value was read fifteen turns
 * before the ask, and the naming probe measured placement at 4x while four
 * wordings sat inside noise. `read`'s `label` argument moves the naming to the
 * moment the model's attention is on the value. This probe prices the one
 * assumption that idea rests on — that a model too inattentive to name a value
 * at report time WILL name it in the read call itself.
 *
 * SHAPE: take each recorded instruction, cut the turn history immediately
 * before a singular `read` the run really made, hand the model the real
 * toolset (whose read now documents `label`), and ask nothing — just let it
 * act. Score what comes back: did it read, and did the read carry a label?
 * Temperature 0 against the same context the recorded model acted in, so the
 * next act is usually the same read.
 *
 * Two arms, because the label instruction can live in two places:
 *   tooldesc  only the read tool's own description mentions label (what a
 *             model attends to at call time)
 *   system    plus one system-prompt sentence
 *
 * WHAT IT IS NOT: proof the label survives to a better flow — that half is
 * deterministic and already gated by test/rebuild.test.ts. And as ever the
 * history is reconstructed, not the original tokens.
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

const dir = path.join(root, 'bench/fixtures/recordings');

/**
 * One case per singular read: the instruction, every step BEFORE that read,
 * and the read the run really made next (target + value), which is the case's
 * ground truth.
 */
function cases(limit) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    const app = f.startsWith('fwod') ? 'odoo' : f.startsWith('fwgr') ? 'grafana' : 'repairdesk';
    const L = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean)
      .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    let cur = null;
    for (const e of L) {
      if (e.k === 'instruction') cur = { app, run: f.replace('-script.jsonl', ''), instruction: e.text ?? '', steps: [] };
      else if (!cur) continue;
      else if (e.k === 'report') cur = null;
      else if (e.k === 'step') {
        if (e.tool === 'read' && e.args?.target !== '(read-back)' && typeof e.result === 'string') {
          let p; try { p = JSON.parse(e.result); } catch { p = e.result; }
          const v = typeof p === 'string' ? p.trim() : '';
          if (v.length >= 3 && v.length <= 60) {
            out.push({ app, run: cur.run, instruction: cur.instruction, steps: cur.steps.slice(0, 40), target: String(e.args?.target ?? ''), value: v });
          }
        }
        cur.steps.push(e);
      }
    }
  }
  return limit ? out.slice(0, limit) : out;
}

/** The real turn structure up to the cut, exactly as naming-probe builds it. */
function messages(c, arm) {
  const labelLine =
    arm === 'system'
      ? ' When a read fetches a value the task or a later step will need — a reference the app assigned, a price, a name — pass `label` in that read call; a labelled value is published under that name, an unlabelled one is lost.'
      : '';
  const msgs = [
    {
      role: 'system',
      content:
        'You are driving a web browser to carry out one instruction. ' +
        'put key facts the caller needs (names/ids created, counts, final URL) in evidence.values; ' +
        'keep summary to one short paragraph — the caller only reads the report.' +
        labelLine,
    },
    { role: 'user', content: c.instruction },
  ];
  c.steps.forEach((s, i) => {
    const id = `c${i + 1}`;
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: s.tool, arguments: JSON.stringify(s.args ?? {}) } }],
    });
    msgs.push({ role: 'tool', tool_call_id: id, content: String(s.result ?? '') });
  });
  return msgs;
}

const model = arg('--model', 'deepseek/deepseek-v4-flash');
const provider = arg('--provider', 'openrouter');
const limit = Number(arg('--limit', '0')) || 0;
const arms = argv.includes('--arms') ? ['tooldesc', 'system'] : [arg('--arm', 'tooldesc')];
const all = cases(limit);

console.log(`${all.length} case(s) from ${new Set(all.map((c) => c.run)).size} recording(s), model ${model}\n`);

for (const arm of arms) {
  const cfg = resolveProviderConfig({ provider, model });
  const llm = new OpenAICompatProvider(cfg);
  let reads = 0, labelled = 0, other = 0, failed = 0;
  const labels = [];
  const perApp = {};
  for (const c of all) {
    perApp[c.app] ??= { reads: 0, labelled: 0 };
    try {
      const done = await llm.complete(messages(c, arm), TOOL_DEFS, { temperature: 0 });
      const call = (done.toolCalls ?? [])[0];
      if (call?.name === 'read') {
        reads++;
        perApp[c.app].reads++;
        const label = typeof call.args?.label === 'string' && call.args.label.trim();
        if (label) {
          labelled++;
          perApp[c.app].labelled++;
          labels.push(`${c.run}: ${JSON.stringify(c.value)} -> ${call.args.label}`);
          process.stdout.write('#');
        } else process.stdout.write('.');
      } else {
        other++;
        process.stdout.write('+');
      }
    } catch (err) {
      failed++;
      if (failed <= 2) console.error(`\n[probe] call failed: ${err.message.slice(0, 400)}`);
      process.stdout.write('!');
    }
  }
  console.log(`\n\n=== ${arm} ===`);
  console.log(`  next call was read      : ${reads}/${all.length - failed}   (other tool: ${other}, failed: ${failed})`);
  console.log(`  of those, labelled      : ${labelled}/${reads}${reads ? `  (${Math.round((100 * labelled) / reads)}%)` : ''}`);
  for (const [app, a] of Object.entries(perApp)) console.log(`    ${app.padEnd(11)} labelled ${a.labelled}/${a.reads}`);
  for (const l of labels) console.log(`    ${l}`);
}
