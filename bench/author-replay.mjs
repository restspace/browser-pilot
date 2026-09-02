#!/usr/bin/env node
/**
 * The "agent-authored script" arm: after an agent completes a task with
 * agent-browser, the SAME model is handed its own command log and told to
 * write a standalone Playwright script for the flow — its best shot at
 * "codegen with judgement". The script is then replayed cold, twice, with
 * resets, scored by the same app-side verifiers as every other arm.
 *
 * Where this sits in the matrix: bench/codegen-replay.mjs is the FLOOR for
 * static replay (literal recording-as-code, no judgement). This arm is the
 * strongest static incumbent we can construct — full agency, memory of the
 * run, freedom to parameterise, wait, and assert. What it still cannot have
 * is what the sleep-walker recorder gets by interrogating the live page at
 * touch time (verified locator ladders, value provenance, observed effect
 * diffs) and what the replay loop adds after (drift tickets, repair,
 * convergence). That gap is the thing being measured.
 *
 * Two subcommands:
 *
 *   author  --transcript <harness jsonl> --task <file> --tag <t> --target <t>
 *           [--result <harness result.json>] [--model z-ai/glm-5.3] [--out bench/results]
 *     Feeds the run's command log (+ final report if given) and the task file
 *     to the model over OpenRouter, demands one self-contained playwright-core
 *     .mjs parameterised by RUNID/APP_URL/APP_EMAIL/APP_PASSWORD, and writes
 *     <tag>-authored.spec.mjs + <tag>-author-meta.json. A script that fails
 *     `node --check` gets ONE repair round with the syntax error appended —
 *     the same courtesy an agent fixing its own typo would take — and the
 *     attempt count is recorded. Semantic failures are never repaired here:
 *     they belong to the replay result.
 *
 *   replay  --spec <path> --runid <r> --target <t> [--reset] [--out bench/results]
 *     Applies the target's env defaults, optionally resets the app, runs the
 *     spec with RUNID set, and writes <runid>-authored.log and
 *     <runid>-authored-result.json. Verification stays external
 *     (bench/verify-<target>.mjs <runid>), same as every arm.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_DEFAULTS } from './app-defaults.mjs';
import { resetTarget } from './app-reset.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const val = argv[i + 1];
    out[a.slice(2)] = val && !val.startsWith('--') ? (i++, val) : true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const mode = args._[0];
const outDir = path.resolve(args.out || 'bench/results');
fs.mkdirSync(outDir, { recursive: true });

function need(names) {
  for (const n of names) {
    if (!args[n]) {
      console.error(`--${n} is required for '${mode}'`);
      process.exit(2);
    }
  }
}

if (mode === 'author') {
  need(['transcript', 'task', 'tag', 'target']);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set');
    process.exit(2);
  }
  const model = args.model || 'z-ai/glm-5.3';
  const task = fs.readFileSync(path.resolve(String(args.task)), 'utf8');
  const lines = fs
    .readFileSync(path.resolve(String(args.transcript)), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((x) => {
      try {
        return JSON.parse(x);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  // The command log IS "the run you just did": every command the agent issued
  // and what it saw back (outputs capped so the prompt stays within budget —
  // the commands themselves, which carry the selectors and values, are never
  // truncated).
  const OUT_CAP = 700;
  const cmds = lines
    .filter((e) => e.k === 'cmd')
    .map((e, i) => {
      const o = String(e.out ?? '').slice(0, OUT_CAP);
      return `#${i + 1} [turn ${e.turn}] $ ${e.cmd}\n${o}${e.outTruncated ? `\n…(output truncated, ${e.outTruncated} bytes total)` : ''}`;
    });
  if (!cmds.length) {
    console.error('transcript has no cmd entries — wrong file?');
    process.exit(2);
  }
  let finalText = '';
  if (args.result) {
    try {
      finalText = String(JSON.parse(fs.readFileSync(path.resolve(String(args.result)), 'utf8')).finalText ?? '');
    } catch {}
  }

  const contract = `Write ONE self-contained Node.js ES module script (.mjs) that automates this whole flow with Playwright, so it can be re-run on a fresh copy of the app without any model.

Hard requirements:
- Use ONLY: import { chromium } from 'playwright-core'; plus Node builtins. No other packages, no installs.
- Launch with: await chromium.launch({ headless: true }).
- Read the run id from process.env.RUNID (required — throw at startup if unset) and substitute it wherever the task says <RUNID>. Read the base URL from process.env.APP_URL and credentials from process.env.APP_EMAIL / process.env.APP_PASSWORD, with the URL falling back to the one you used in the run.
- The app's data differs between runs: ids, generated references and record URLs from your run will NOT exist when the script runs again. Locate records created BY THIS SCRIPT by their RUNID-bearing names, never by remembered ids or URLs containing ids.
- Print one short line per step as it happens, and at the end print one line per numbered objective: the objective number, DONE or FAILED, and the concrete value observed from the page (prices, statuses, references) — read from the page, not assumed.
- Exit with code 0 only if every objective completed; otherwise print which failed and exit 1. Do not swallow errors silently.
- Make it robust to the app's real timing (you saw it: waits that watch for concrete page state, not fixed sleeps or networkidle where the app long-polls).

Output ONLY the complete script in a single \`\`\`js fenced code block. No prose before or after.`;

  const basePrompt = `You are an automation engineer. You just completed the following goal in a real web browser by driving the agent-browser CLI. Below is the goal, then the full log of every command you issued and what it returned${finalText ? ', then your final report' : ''}.

--- THE GOAL (task file; <RUNID> is a per-run parameter) ---
${task}

--- YOUR RUN: every command and its output ---
${cmds.join('\n\n')}
${finalText ? `\n--- YOUR FINAL REPORT ---\n${finalText}\n` : ''}
--- YOUR JOB NOW ---
${contract}`;

  const extract = (text) => {
    const m = String(text).match(/```(?:js|javascript|mjs)?\s*\n([\s\S]*?)```/);
    return m ? m[1] : null;
  };

  // Streamed, because a single 15k-token completion over one silent connection
  // is exactly the shape that dies to a gateway idle timeout (the first smoke
  // attempt did, wordlessly). SSE keeps bytes flowing and shows progress.
  async function callModel(messages) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      // Reasoning cannot be disabled on this endpoint (Z.AI 400s), and left
      // uncapped it ate 15.5k of a 16k budget emitting zero code. Low effort
      // plus a 32k budget gives the thinking room to end and the code room to
      // exist.
      body: JSON.stringify({ model, temperature: 0, max_tokens: 32000, messages, stream: true, usage: { include: true }, reasoning: { effort: 'low' } }),
      signal: AbortSignal.timeout(900_000),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    let text = '';
    let usage = {};
    let buf = '';
    let lastNote = Date.now();
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j;
        try {
          j = JSON.parse(payload);
        } catch {
          continue;
        }
        text += j.choices?.[0]?.delta?.content ?? '';
        if (j.usage) usage = j.usage;
      }
      if (Date.now() - lastNote > 20_000) {
        console.log(`[author] …streaming, ${text.length} chars so far`);
        lastNote = Date.now();
      }
    }
    return { text, usage };
  }

  const specPath = path.join(outDir, `${args.tag}-authored.spec.mjs`);
  const meta = { tag: args.tag, target: args.target, model, promptChars: basePrompt.length, cmdCount: cmds.length, attempts: [], usage: [] };
  const messages = [{ role: 'user', content: basePrompt }];
  let code = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`[author] attempt ${attempt}: calling ${model} (${Math.round(basePrompt.length / 1024)}KB prompt)`);
    const r = await callModel(messages);
    meta.usage.push(r.usage);
    const candidate = extract(r.text);
    if (!candidate) {
      meta.attempts.push({ attempt, outcome: 'no code block' });
      messages.push({ role: 'assistant', content: r.text.slice(0, 4000) });
      messages.push({ role: 'user', content: 'Your reply contained no ```js code block. Output ONLY the complete script in a single ```js fenced block.' });
      continue;
    }
    fs.writeFileSync(specPath, candidate);
    const check = spawnSync(process.execPath, ['--check', specPath], { encoding: 'utf8', timeout: 30_000 });
    if (check.status === 0) {
      meta.attempts.push({ attempt, outcome: 'ok', lines: candidate.split('\n').length });
      code = candidate;
      break;
    }
    const err = `${check.stdout || ''}${check.stderr || ''}`.slice(0, 1500);
    meta.attempts.push({ attempt, outcome: 'syntax error', error: err });
    messages.push({ role: 'assistant', content: '```js\n' + candidate + '\n```' });
    messages.push({ role: 'user', content: `Your script fails to parse:\n${err}\nFix it and output ONLY the corrected complete script in a single \`\`\`js fenced block.` });
  }
  fs.writeFileSync(path.join(outDir, `${args.tag}-author-meta.json`), JSON.stringify(meta, null, 2));
  if (!code) {
    console.error('[author] no parseable script after 2 attempts — that is the arm result; meta written');
    process.exit(1);
  }
  console.log(`[author] wrote ${specPath} (${code.split('\n').length} lines, ${meta.attempts.length} attempt(s))`);
  process.exit(0);
}

if (mode === 'replay') {
  need(['spec', 'runid', 'target']);
  const defaults = APP_DEFAULTS[args.target];
  if (!defaults) {
    console.error(`--target must be one of: ${Object.keys(APP_DEFAULTS).join(', ')}`);
    process.exit(2);
  }
  for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;
  if (args.reset) {
    console.log(`[replay] resetting ${args.target}`);
    await resetTarget(args.target);
  }
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.resolve(String(args.spec))], {
    encoding: 'utf8',
    timeout: 600_000,
    env: { ...process.env, RUNID: String(args.runid) },
  });
  const out = `${run.stdout || ''}${run.stderr || ''}`;
  fs.writeFileSync(path.join(outDir, `${args.runid}-authored.log`), out);
  const result = {
    arm: 'agent-authored-script',
    runid: args.runid,
    target: args.target,
    spec: path.basename(String(args.spec)),
    wallMs: Date.now() - started,
    exitCode: run.status,
    timedOut: run.status === null,
    costUsd: 0, // the replay itself calls no model; authoring cost is in author-meta.json
    logTail: out.slice(-2000),
    // The script's own printed report, so verifiers can cross-check its
    // claimed values exactly as they do for live arms. Tail-sliced: the
    // per-objective lines are the last thing the contract has it print.
    finalText: out.slice(-8000),
  };
  fs.writeFileSync(path.join(outDir, `${args.runid}-authored-result.json`), JSON.stringify(result, null, 2));
  console.log(`[replay] ${args.runid}: exit=${run.status} ${Math.round((Date.now() - started) / 1000)}s — result written`);
  process.exit(run.status === 0 ? 0 : 1);
}

console.error("first argument must be 'author' or 'replay'");
process.exit(2);
