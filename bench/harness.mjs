#!/usr/bin/env node
/**
 * Benchmark harness: one agent loop, two tools.
 *
 * The point of this file is that BOTH arms run through it unchanged. The only
 * things that differ between a browser-pilot run and an agent-browser run are
 * (a) which CLI the single `run_command` tool is allowed to invoke and (b) that
 * CLI's own documentation, pasted into the system prompt. Same model, same
 * loop, same prompt scaffolding, same caching strategy, same accounting.
 *
 * Why not drive the arms from a coding agent instead: a general-purpose agent
 * harness carries its own large system prompt and tool set, which inflates
 * per-turn tokens for reasons that have nothing to do with the tool under test,
 * and its transcript is not reliably persisted for accounting. Owning the loop
 * makes every token attributable.
 *
 * The orchestrator is given a GOAL, never a pre-decomposed list of steps.
 * Decomposition is exactly the work that browser-pilot moves off the expensive
 * model and agent-browser leaves on it, so handing both a ready-made plan would
 * erase the difference being measured.
 *
 * Usage:
 *   node bench/harness.mjs --arm browser-pilot --model claude-sonnet-5 \
 *     --target repairdesk --task bench/tasks/repairdesk-ticket-flow.md \
 *     --runid bpX1 --out bench/results --reset
 *
 * --target selects the app under test and decides how --reset rolls it back.
 * It defaults to atelyr, the private app every published run so far used, so
 * that those command lines still reproduce. The repairdesk target ships in
 * this repo and needs nothing provisioned: start it with
 * `node bench/app/server.mjs` and the credentials default themselves.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { loadRates, priceRun } from './pricing.mjs';

const ARMS = {
  'browser-pilot': { bin: 'browser-pilot', docs: 'armdocs/browser-pilot.md' },
  'agent-browser': { bin: 'agent-browser', docs: 'armdocs/agent-browser.md' },
};

/**
 * The application under test. An arm is which tool drives the browser; a target
 * is what the browser is pointed at. Both arms always run against the same
 * target — it is a control, not a variable — but the two supported targets
 * differ in how state is rolled back between runs, and that difference has to
 * live somewhere.
 *
 *   repairdesk  ships in this repo (bench/app). Resetting is an in-process
 *               reload of the seed: one HTTP call, milliseconds, nothing to
 *               stop or restart. Credentials are committed, so a reader needs
 *               no provisioning at all.
 *   atelyr      a private app on a real mongod. Resetting means stopping the
 *               backend and swapping ~300MB of WiredTiger files on disk, which
 *               is what bench/reset.mjs exists for. Requires APP_* to be set
 *               and a baseline to have been captured first.
 *
 * `defaults` are applied only where the environment is silent, so an explicit
 * APP_URL always wins — pointing the neutral target at a different port is a
 * normal thing to want.
 */
const TARGETS = {
  atelyr: {
    task: 'tasks/atelyr-project-flow.md',
    defaults: {},
    reset() {
      console.log('[harness] restoring datastore baseline');
      execFileSync(process.execPath, [path.join(here, 'reset.mjs'), '--restore'], {
        stdio: 'inherit',
      });
    },
    notReadyHint: 'Is the atelyr backend running? Check 127.0.0.1:3100 and the vite dev server.',
  },
  repairdesk: {
    task: 'tasks/repairdesk-ticket-flow.md',
    defaults: {
      APP_URL: 'http://127.0.0.1:4180/',
      APP_EMAIL: 'bench@example.com',
      APP_PASSWORD: 'bench-pass-1234',
    },
    async reset() {
      const url = new URL('/__reset', process.env.APP_URL);
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) throw new Error(`reset failed: ${res.status} ${res.statusText}`);
      console.log(`[harness] reloaded seed via ${url}`);
    },
    notReadyHint: 'Start it with: node bench/app/server.mjs',
    // The app keeps its mutation log in memory, so stopping it destroys the
    // only evidence a run's objectives were met. Pulling the log into the
    // results directory at the end of a run makes a verified run auditable
    // later instead of only while the app that saw it is still up — which
    // matters most for a cloud run, where the box is gone minutes afterwards.
    logUrl: () => new URL('/__log', process.env.APP_URL),
  },
};

/**
 * What produced these numbers. A result file that cannot say which machine,
 * OS or tool version it came from is not much use once runs arrive from more
 * than one box, which is the entire point of running them in the cloud.
 * Deliberately no hostname or username: these files are meant to be published.
 */
function describeMachine(bin) {
  const out = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: os.cpus().length,
    memGB: Math.round(os.totalmem() / 1e9),
  };
  // spawnSync, not execFileSync: browser-pilot prints its banner for --version
  // and exits 2, which execFileSync turns into a throw and records as null.
  // shell:true because on Windows both CLIs are .cmd shims that execFile
  // cannot exec directly. Take whatever was printed, whatever the exit code.
  const v = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    shell: true,
    windowsHide: true,
  });
  const line = `${v.stdout || ''}${v.stderr || ''}`
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  out.tool = line ? line.slice(0, 80) : null;
  try {
    out.commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      cwd: here,
    }).trim();
  } catch {
    out.commit = null;
  }
  return out;
}

const API_VERSION = '2023-06-01';

/**
 * Two wire formats, one loop. The orchestrator model only has to be the SAME
 * across arms — it does not have to be any particular vendor — so the harness
 * speaks both Anthropic Messages and the OpenAI-compatible shape that novita,
 * OpenRouter and friends expose.
 */
const PROVIDERS = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    keyEnv: ['ANTHROPIC_API_KEY'],
    defaultModel: 'claude-sonnet-5',
  },
  novita: {
    url: 'https://api.novita.ai/openai/chat/completions',
    keyEnv: ['NOVITA_API_KEY'],
    defaultModel: 'zai-org/glm-5.3',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: ['OPENROUTER_API_KEY'],
    defaultModel: 'z-ai/glm-5.3',
  },
};

function parseArgs(argv) {
  // The per-command timeout must sit ABOVE the slowest legitimate command in
  // either arm, or it silently truncates work and looks like a tool failure.
  // browser-pilot's own default instruction budget is 300s, and an escalated
  // instruction may take 300 + 1.5x300 before it returns; agent-browser's
  // commands are seconds, with a 25s worst case. 900s clears both. This is a
  // backstop against a wedged process, not a budget.
  // captureBytes: how much of each command's output to keep in the transcript.
  // Byte counts alone proved not to be enough: three runs stalled at or before
  // login and the recorded transcripts could not say what the agent was
  // actually being shown, only how big it was. 4000 is plenty to see a page
  // snapshot or a `do` report while keeping transcripts publishable in size.
  // 0 disables capture.
  // maxUsd: spend ceiling in USD across orchestrator + inner tokens, priced
  // after every turn with bench/pricing.mjs (the same formula score.mjs uses).
  // A run that crosses it stops with stopReason 'spend-cap'. It exists because
  // the turn cap is not symmetric between arms: one wasted agent-browser turn
  // is a CLI call, one wasted browser-pilot turn is a whole sub-agent run plus
  // an escalation — c0822bp spent $7.21 on 119 identical blocked instructions.
  // 2.00 is ~7x the dearest complete run on record and well under that. 0
  // disables the ceiling.
  const out = { maxTurns: 120, timeoutMs: 900_000, captureBytes: 4000, maxUsd: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (key === 'maxTurns' || key === 'timeoutMs' || key === 'captureBytes' || key === 'maxUsd')
      out[key] = Number(argv[++i]);
    else out[key] = val && !val.startsWith('--') ? (i++, val) : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const arm = ARMS[args.arm];
if (!arm) {
  console.error(`--arm must be one of: ${Object.keys(ARMS).join(', ')}`);
  process.exit(2);
}

// Defaults to atelyr so every run recorded before targets existed still
// reproduces from its own command line.
const targetName = typeof args.target === 'string' ? args.target : 'atelyr';
const target = TARGETS[targetName];
if (!target) {
  console.error(`--target must be one of: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(2);
}
// Applied before the task file is read, since substitution resolves {{APP_URL}}
// and friends out of the environment, and before SECRETS is built so anything
// defaulted in here is still redacted from the transcript.
for (const [k, v] of Object.entries(target.defaults)) {
  if (!process.env[k]) {
    process.env[k] = v;
    console.log(`[harness] ${targetName}: defaulting ${k}`);
  }
}
const providerName =
  args.provider ||
  (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.NOVITA_API_KEY ? 'novita' : 'anthropic');
const provider = PROVIDERS[providerName];
if (!provider) {
  console.error(`--provider must be one of: ${Object.keys(PROVIDERS).join(', ')}`);
  process.exit(2);
}
const model = args.model || provider.defaultModel;
const runid = args.runid || `run-${Date.now()}`;
const outDir = path.resolve(args.out || 'bench/results');
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const apiKey = provider.keyEnv.map((k) => process.env[k]).find(Boolean);
if (!apiKey) {
  console.error(`no API key for provider "${providerName}": set ${provider.keyEnv.join(' or ')}`);
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
const transcriptPath = path.join(outDir, `${runid}-${args.arm}-transcript.jsonl`);
const transcript = fs.createWriteStream(transcriptPath, { flags: 'w' });

/**
 * Values that must never reach a transcript. The task file substitutes real
 * credentials in, and the orchestrator then puts them verbatim into commands
 * ("... sign in with password X ..."), so an unredacted transcript cannot be
 * published — which defeats the point of keeping raw runs for scrutiny.
 */
/**
 * Each secret plus the encodings it plausibly appears in. Raw substring
 * matching alone is not enough now that command OUTPUT is captured: a password
 * can come back URL-encoded in a request line, or backslash-escaped inside a
 * JSON blob the tool prints, and either form would sail past a plain
 * `split(secret)` straight into a transcript meant for publication.
 */
const SECRETS = [...new Set(
  ['APP_PASSWORD', 'APP_EMAIL']
    .map((k) => process.env[k])
    .filter((v) => v && v.length > 3)
    .flatMap((v) => [v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)]),
)]
  // Longest first, so a broader encoding is masked before a substring of it.
  .sort((a, b) => b.length - a.length);

function redact(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const s of SECRETS) out = out.split(s).join('«redacted»');
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

const log = (obj) => transcript.write(JSON.stringify(redact(obj)) + '\n');

/**
 * Placeholder substitution keeps credentials and hostnames out of the
 * committed task/briefing files, so this directory stays publishable.
 * Values come from the environment at run time.
 */
function substitute(text) {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name) => {
    const v = process.env[name];
    if (v === undefined) {
      console.error(`task/briefing references {{${name}}} but that env var is not set`);
      process.exit(2);
    }
    return v;
  });
}

const readIfSet = (p) =>
  p && typeof p === 'string' ? substitute(fs.readFileSync(path.resolve(p), 'utf8')) : '';
// Checked before the file is read, because pairing a target with the other
// target's task file usually fails first at placeholder substitution, and
// "APP_URL is not set" is a baffling way to be told you picked the wrong task.
// Not fatal: sensitivity arms legitimately run task variants under other names.
if (args.task && !String(args.task).replace(/\\/g, '/').endsWith(target.task)) {
  console.warn(
    `[harness] note: --target ${targetName} normally runs bench/${target.task}, not ${args.task}`,
  );
}
const task = readIfSet(args.task);
if (!task) {
  console.error('--task <file> is required');
  process.exit(2);
}
const briefing = readIfSet(args.briefing);
const toolDocs = fs.readFileSync(path.join(here, arm.docs), 'utf8');

/**
 * Identical for both arms apart from the tool docs and the optional briefing.
 * Deliberately says nothing about HOW to decompose the goal.
 */
// Opt-in, browser-pilot only: teach the orchestrator to delegate whole outcomes
// and let each command run autonomously to its own report, instead of driving
// the browser one UI action per call. Diagnosed 2026-08-22: the orchestrator was
// micro-stepping browser-pilot (open form / fill / submit as separate `do`s) and
// thrashing, so each fragment paid for a full inner agent run plus escalation.
// Gated to browser-pilot because agent-browser has no inner agent and must issue
// atomic commands — it stays the untouched control. Recorded in the result as
// `coarse` and disclosed in HANDOFF; contains no app specifics or task plan.
const coarse = Boolean(args.coarse) && args.arm === 'browser-pilot';

// Learning mode (progressive automation): browser-pilot compiles successful
// instructions into stored skills and replays them on later ones. The store is
// shared across the runs of a learning sweep and isolated from the user's own
// (`--learn <dir>`), so run N+1 can benefit from run N and nothing else can.
// Only the inner tool changes; the orchestrator prompt is untouched, so a
// sweep measures what the tool learned, not what the orchestrator was told.
const learnDir = args.learn && args.arm === 'browser-pilot' ? path.resolve(String(args.learn)) : null;
if (learnDir) {
  fs.mkdirSync(learnDir, { recursive: true });
  process.env.BROWSER_PILOT_SKILLS = '1';
  process.env.BROWSER_PILOT_SKILLS_DIR = learnDir;
}
const coarseBlock = coarse
  ? `\n\nIMPORTANT — how to use this tool well. Each \`run_command\` does NOT perform a single action and return — it hands one instruction to an internal agent that then works autonomously, taking as many browser steps as it needs (snapshot, fill, click, wait, retry, verify), and returns ONLY when it has achieved the outcome you asked for or is genuinely stuck. So your job is to delegate an outcome and let that command run to its own report — not to drive the browser click-by-click. Give it one whole sub-goal per call — for example "create a record with these field values and report what the app computed", or "bring the item to «target state», discovering and satisfying any preconditions the app enforces, and report what was required" — and trust it to handle the intermediate steps itself. Do NOT split one sub-goal across several calls (one to open a form, another to fill it, another to submit); that interrupts an agent that would have finished the whole thing in a single call. Equally, do NOT spend a call just exploring or cataloguing the UI ("describe the app's structure", "open the dialog and list every field, option and button", "report the full contents") — that sends the agent on an open-ended survey that burns its whole budget without moving the goal forward. Ask for the outcome and let the agent read only what it needs to achieve it; if you need a specific fact back, request that one fact as part of an action, not an exhaustive inventory. Read each report, then issue the next outcome; keep every instruction about the outcome you want, not the steps to get there.`
  : '';

const systemText = `You are an automation agent completing a goal in a real web browser.

You have exactly one tool: \`run_command\`, which runs the \`${arm.bin}\` command-line tool and returns its output. You cannot see the screen; the command output is your only view of the browser.

Work through the goal to completion. Verify what you did rather than assuming a command succeeded. When the whole goal is done (or you are certain you cannot finish it), stop calling tools and reply with a final plain-text report stating, for each part of the goal, whether it succeeded and the concrete values you observed.${coarseBlock}

Runid for this run: ${runid}. Where the goal says to name something with the runid, use exactly this value.

Pass \`--session ${runid}\` on every command. Both tools take this flag; it isolates this run's
browser and state from any other, so a run never inherits leftovers from a previous one.

--- ${arm.bin} DOCUMENTATION ---
${toolDocs}${
  briefing
    ? `\n\n--- APP BRIEFING (conventions and selector knowledge for the app under test) ---\n${briefing}`
    : ''
}`;

const TOOL_NAME = 'run_command';
const TOOL_DESC = `Run a single ${arm.bin} command and return its stdout/stderr. Provide the full command line, starting with "${arm.bin}".`;
const TOOL_SCHEMA = {
  type: 'object',
  required: ['command'],
  properties: {
    command: { type: 'string', description: `Full command line, e.g. "${arm.bin} ..."` },
  },
};

/** Accounting. Orchestrator tokens and the inner model's tokens are kept apart: they bill at different rates. */
const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const inner = { promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
const commands = [];
// OpenRouter tells us which backend actually served each call and (with usage
// accounting on) the real USD cost. Both are recorded so a run is attributable
// to a specific backend, the same way the machine block attributes it to a box.
const servedBackends = new Set();
let orReportedCostUsd = 0;
// Optional OpenRouter provider routing: pin with --orOnly a,b (never falls
// back) or exclude with --orIgnore a,b. Default is unrestricted — the default
// orchestrator model z-ai/glm-5.3 has a single backend (Z.ai), so there is
// nothing to route; the served backend is logged and the context-truncated
// detector validates whatever route is taken.
const orRouting = (() => {
  if (providerName !== 'openrouter') return null;
  const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);
  const only = csv(args.orOnly);
  const ignore = csv(args.orIgnore);
  const p = {};
  if (only?.length) { p.only = only; p.allow_fallbacks = false; }
  if (ignore?.length) p.ignore = ignore;
  return Object.keys(p).length ? p : null;
})();

/**
 * Only the arm's own binary may run. This keeps an arm from wandering into
 * unrelated shell work, which would both break the comparison and make the
 * harness an arbitrary code executor.
 */
/** Start appending the advisory once a turn's output repeats this many times. */
const LOOP_NUDGE = 4;

/**
 * Degenerate-loop detection, advisory only.
 *
 * History: this guard has caused two defects and cost each arm a run. v1
 * compared command text and suppressed the command, which pinned its own tally
 * and burned a12's whole turn cap. Every version that *terminates* a run is an
 * intervention that can bias an outcome, and it biases unevenly: agent-browser
 * legitimately re-reads far more than browser-pilot, and the task file itself
 * says list views refresh asynchronously, so repeating a read while waiting is
 * correct behaviour. A false abort corrupts a result; a missed loop wastes
 * about $0.60 and fifteen minutes of a run that was going to be discarded.
 * Those costs are not close, so this version cannot abort and cannot suppress.
 *
 * It compares OUTPUT, not command text, because identical output means no
 * information was gained regardless of how the command was worded — which is
 * what defeated the previous version, when a13 escaped it by changing one
 * string inside an otherwise identical query. The turn cap is now the only
 * thing that ends a run.
 */
let lastOutputKey = null;
let sameOutputRuns = 0;

function repeatedOutput(text) {
  const key = text.trim();
  if (key === lastOutputKey) sameOutputRuns++;
  else {
    lastOutputKey = key;
    sameOutputRuns = 1;
  }
  return sameOutputRuns;
}

/**
 * Flags that consume the following token as their value. Needed so that the
 * `a13` in `agent-browser --session a13 eval ...` is not mistaken for the
 * subcommand. Union of both CLIs' value-taking flags; a flag listed here but
 * absent from one tool is harmless.
 */
const VALUE_FLAGS = new Set([
  '--session', '--selector', '--model', '--provider', '--fallback-model',
  '--timeout', '--turn-timeout', '--max-turns', '--title', '--out',
]);

/**
 * Which subcommand each invocation used, counted across every occurrence of the
 * binary in the command line (chained commands contain several).
 *
 * This is the delegation signal. browser-pilot's context advantage only appears
 * when the orchestrator delegates coarsely — h12 spent 15 of 17 invocations on
 * `do` and used 25.5KB, while h11 fell back to fine-grained `peek` polling and
 * used 69.6KB, essentially agent-browser's figure. Reading that off the
 * transcript by hand is how it was missed; counting it makes "did this run
 * actually delegate?" a number rather than an impression. Arm-neutral: it just
 * counts subcommand tokens, whatever the tool.
 */
function subcommandCounts(cmds, bin) {
  const counts = {};
  for (const c of cmds) {
    const tokens = String(c.cmd).split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].replace(/^["']/, '') !== bin) continue;
      let j = i + 1;
      while (j < tokens.length) {
        const t = tokens[j];
        if (t.startsWith('-')) {
          j += VALUE_FLAGS.has(t) ? 2 : 1;
          continue;
        }
        break;
      }
      if (j < tokens.length) {
        const sub = tokens[j].replace(/^["']|["']$/g, '');
        counts[sub] = (counts[sub] || 0) + 1;
      }
    }
  }
  return counts;
}

/**
 * Split a command line on top-level shell operators, respecting quotes.
 *
 * agent-browser chains routinely (`agent-browser X && agent-browser Y`) and
 * browser-pilot never does, so treating a chain as one "command" made
 * commands-per-run incomparable across arms — a03 recorded 70 commands but made
 * 160 real invocations. Splitting restores comparable counting, lets every
 * segment be checked against the allow-list instead of only the first, and
 * stops a chain being used to slip past the repeat detector.
 *
 * Quote-aware because agent-browser's `eval` payloads are JavaScript, which
 * uses `&&` and `;` inside string arguments. Splitting those would shred the
 * command. Observed across 475 recorded commands: `&&` 59, `;` 1, and no
 * pipes, redirects, backticks or command substitution.
 */
function splitSegments(cmd) {
  const parts = [];
  const ops = [];
  let cur = '';
  let quote = null;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (cmd.startsWith('&&', i) || cmd.startsWith('||', i)) {
      ops.push(cmd.slice(i, i + 2));
      parts.push(cur);
      cur = '';
      i += 2;
      continue;
    }
    if (ch === ';') {
      ops.push(';');
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  parts.push(cur);
  // An unbalanced quote means the parse is untrustworthy — treat the whole
  // string as one segment and let the allow-list decide, rather than acting on
  // a split that may have landed inside a string.
  if (quote) return { segments: [cmd.trim()].filter(Boolean), ops: [] };
  return { segments: parts.map((s) => s.trim()).filter(Boolean), ops };
}

/** Shell syntax that would take a segment outside the sandbox, at top level only. */
const SHELL_ESCAPES = ['|', '>', '<', '`', '$('];

function hasTopLevelShellEscape(seg) {
  let quote = null;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (SHELL_ESCAPES.some((e) => seg.startsWith(e, i))) return true;
  }
  return false;
}

/**
 * Only the arm's own binary may run, and only as a plain invocation. Checked
 * per segment, so a chain cannot smuggle in unrelated work after a valid first
 * command — which is what made the "not an arbitrary code executor" claim false
 * while the check was prefix-only.
 */
function commandIsAllowed(cmd) {
  const trimmed = cmd.trim();
  if (hasTopLevelShellEscape(trimmed)) return false;
  return trimmed === arm.bin || trimmed.startsWith(arm.bin + ' ');
}

/** How long to wait for a killed process tree to close its pipes before giving up. */
const DRAIN_MS = 10_000;

// How long to keep reading a command's output after the process has exited but
// its pipes are still held open by something it spawned. Long enough for a
// trailing write to arrive, short enough that it is noise against commands that
// take seconds. See the 'exit' handler in runCommand for why this is needed.
const EXIT_GRACE_MS = 500;

/**
 * Kill the whole process tree, not just the shell.
 *
 * spawn(cmd, {shell:true}) makes cmd.exe the child and the actual CLI a
 * grandchild. child.kill() therefore terminates only the shell, leaving the
 * CLI running and still holding the inherited stdio pipes — and since we
 * resolve on 'close', which waits for those pipes, the harness would block on
 * the orphan indefinitely instead of moving on after the timeout.
 */
function killTree(pid) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

function runCommand(cmd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, { shell: true, windowsHide: true });
    let out = '';
    let killed = false;
    let settled = false;
    let drain = null;
    let grace = null;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      if (grace) clearTimeout(grace);
      resolve({ out: out.trimEnd(), code, ms: Date.now() - started, killed });
    };

    const timer = setTimeout(() => {
      killed = true;
      killTree(child.pid);
      // Backstop: if the tree still holds the pipes, stop waiting on 'close'.
      drain = setTimeout(() => finish(null), DRAIN_MS);
    }, args.timeoutMs);

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));

    /**
     * Resolve on 'exit', not only on 'close'.
     *
     * 'close' waits for the stdio pipes to close, and agent-browser leaves a
     * DETACHED DAEMON holding them after the CLI itself has exited. So on a
     * cold start 'close' never fired, and the harness sat on a command that had
     * already finished and already printed its output until the 900s timeout
     * killed it. Run r02 lost 910 of its 1238 wall-clock seconds to this, and
     * it was recorded for weeks as an "agent-browser cold-start hang" — the
     * tool was not slow, the harness was waiting on the wrong event.
     *
     * The grace period exists because 'exit' can precede the last chunk of
     * output: it gives the pipes a moment to deliver anything still buffered.
     * 'close' still wins when it arrives, which is the normal case for a
     * process that does not daemonise, so well-behaved commands are unaffected.
     */
    child.on('exit', (code) => {
      if (settled || grace) return;
      grace = setTimeout(() => finish(code), EXIT_GRACE_MS);
    });
    child.on('close', (code) => finish(code));
    child.on('error', (err) => {
      out += String(err);
      finish(-1);
    });
  });
}

/**
 * Ask browser-pilot's daemon what its inner model(s) actually spent.
 *
 * Scraping stdout does not work: the orchestrator is free to call `do` without
 * `--json`, in which case no usage is printed at all — and forcing `--json`
 * would change what the orchestrator reads, altering the very thing being
 * measured. The session keeps authoritative cumulative totals, split per model
 * because escalation can bill a second, pricier tier within one session.
 *
 * Must run before the session is stopped.
 */
/**
 * Sample browser-pilot's own token usage.
 *
 * Called after every command, not just at the end, because the end is too late
 * in two real cases: the run crashes (h11), or the agent stops its own session
 * as part of cleaning up (h13 issued `browser-pilot stop` on its last turn).
 * Either way the daemon holding the counters is gone, and a later `config`
 * silently spawns a FRESH daemon that truthfully reports zero — which is how
 * h13 finished complete but uncosted.
 *
 * Usage within a session only grows, so a reading lower than what we already
 * have means we are looking at a new daemon, not at progress. Keep the high
 * water mark and ignore the reset. `config` is cheap (~200ms) and is not
 * recorded as one of the run's commands, so it does not pollute the metrics.
 */
async function collectInnerUsage() {
  if (args.arm !== 'browser-pilot') return;
  const r = await runCommand(`${arm.bin} config --session ${runid}`);
  try {
    const cfg = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    if (cfg.usage) {
      const prompt = cfg.usage.promptTokens ?? 0;
      if (prompt >= inner.promptTokens) {
        inner.promptTokens = prompt;
        inner.cachedTokens = cfg.usage.cachedTokens ?? 0;
        inner.completionTokens = cfg.usage.completionTokens ?? 0;
        inner.instructions = cfg.usage.instructions ?? 0;
        if (cfg.usageByModel) inner.byModel = cfg.usageByModel;
      } else {
        log({ k: 'inner-usage-stale', seen: prompt, kept: inner.promptTokens });
      }
    }
    if (cfg.skills) inner.skills = cfg.skills;
    inner.model = cfg.model ?? inner.model ?? null;
    inner.fallbackModel = cfg.fallbackModel ?? inner.fallbackModel ?? null;
    // The inner model's own provider, so it is priced against the right rate
    // table even when the orchestrator runs on a different provider.
    inner.provider = cfg.provider ?? inner.provider ?? null;
  } catch (err) {
    log({ k: 'inner-usage-failed', message: String(err), raw: r.out.slice(0, 400) });
  }
}

/**
 * One request, one TCP connection, explicitly NOT pooled.
 *
 * The browser-pilot arm leaves multi-minute gaps between model calls, because a
 * single `do` is a whole sub-agent run — observed gaps of 439s and 687s here.
 * A pooled keep-alive socket is long dead by the time the next call reuses it,
 * and global fetch hands the dead socket back: two long runs died that way,
 * one of them after six backed-off retries. agent-browser's arm never sees it,
 * its commands taking seconds — so pooling penalises one arm for the shape of
 * its work rather than its merits. `keepAlive: false` removes the variable.
 */
function httpPost(url, body, headers) {
  const payload = JSON.stringify(body);
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        agent: new https.Agent({ keepAlive: false }),
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          connection: 'close',
          ...headers,
        },
        timeout: 300_000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Retries transport failures as well as 429/5xx. A benchmark run is long and
 * expensive — a single dropped connection three-quarters of the way through
 * otherwise discards the whole run, which is exactly what happened on the first
 * costed attempt. Only 4xx (a request the server understood and rejected) is
 * treated as terminal.
 */
async function post(body, headers) {
  // Patient by design. A browser-pilot run takes 40+ minutes of wall clock and
  // real money, and the model API is the one component whose failure discards
  // ALL of it — the local browser work survives fine. Six attempts capped at
  // 30s tolerated about a minute of outage, which lost a run to a DNS blip.
  // This tolerates roughly a quarter of an hour, which is the right trade when
  // the alternative is throwing away completed work.
  const ATTEMPTS = 20;
  let lastErr = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) {
      const wait = Math.min(60_000, 2000 * 2 ** (attempt - 1));
      log({ k: 'retry', attempt, wait, reason: lastErr });
      await new Promise((r) => setTimeout(r, wait));
    }
    let res;
    try {
      res = await httpPost(provider.url, body, headers);
    } catch (err) {
      lastErr = `transport: ${err?.message ?? err}`;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `HTTP ${res.status}`;
      continue;
    }
    if (res.status >= 400) {
      // Record the SHAPE of the rejected request — roles and field names only,
      // never content. A bare "invalid request error" is undiagnosable without
      // knowing which message shape provoked it, and message content carries
      // the app credentials.
      log({
        k: 'rejected-request',
        status: res.status,
        body: res.text.slice(0, 300),
        shape: (body.messages ?? []).map((m) => ({
          role: m.role,
          keys: Object.keys(m),
          toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.length : undefined,
        })),
      });
      throw new Error(`API ${res.status}: ${res.text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(res.text);
    } catch (err) {
      lastErr = `bad JSON: ${err?.message ?? err}`;
    }
  }
  throw new Error(`model call failed after ${ATTEMPTS} attempts (last: ${lastErr})`);
}

/**
 * Both adapters return the same normalised shape so the loop below is
 * provider-agnostic: { assistant (native message to append), calls, text, usage }.
 * `usage` is normalised to {input, cacheWrite, cacheRead, output} — for the
 * OpenAI shape, cached prompt tokens are reported as a SUBSET of prompt_tokens,
 * so they are subtracted out to avoid double-counting them as fresh input.
 */
const adapters = {
  anthropic: {
    async send(messages) {
      const reply = await post(
        {
          model,
          max_tokens: 4096,
          system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
          tools: [
            {
              name: TOOL_NAME,
              description: TOOL_DESC,
              input_schema: TOOL_SCHEMA,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages,
        },
        { 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      );
      const u = reply.usage ?? {};
      return {
        assistant: { role: 'assistant', content: reply.content },
        calls: reply.content
          .filter((c) => c.type === 'tool_use')
          .map((c) => ({ id: c.id, command: String(c.input?.command ?? '') })),
        text: reply.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
        usage: {
          input: u.input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
        },
      };
    },
    toolResults: (results) => ({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        is_error: r.isError,
        content: r.content,
      })),
    }),
    firstMessage: (text) => ({ role: 'user', content: text }),
  },

  openai: {
    async send(messages) {
      const body = {
        model,
        temperature: 0,
        messages: [{ role: 'system', content: systemText }, ...messages],
        tools: [
          {
            type: 'function',
            function: { name: TOOL_NAME, description: TOOL_DESC, parameters: TOOL_SCHEMA },
          },
        ],
        tool_choice: 'auto',
      };
      if (providerName === 'openrouter') {
        // Ask OpenRouter to return usage accounting (real USD cost) and honour
        // any provider pin/exclude. These fields are OpenRouter-specific, so
        // they are gated to it — novita would reject the unknown keys.
        body.usage = { include: true };
        if (orRouting) body.provider = orRouting;
      }
      const reply = await post(body, { authorization: `Bearer ${apiKey}` });
      const msg = reply.choices?.[0]?.message;
      if (!msg) throw new Error(`no choices: ${JSON.stringify(reply).slice(0, 300)}`);
      const raw = (msg.tool_calls ?? []).filter((c) => c?.function?.name === TOOL_NAME);
      const u = reply.usage ?? {};
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      // Rebuild the assistant message from just the fields the wire format
      // defines, rather than echoing the provider's own object back. Reasoning
      // models return extra keys (reasoning_content and friends) that the same
      // endpoint then rejects on the next request with a bare 400 — which
      // killed a run at turn 2 with no indication of which field was at fault.
      const assistant = {
        role: 'assistant',
        content: msg.content ?? null,
        ...(raw.length
          ? {
              tool_calls: raw.map((c, i) => ({
                id: c.id || `call_${i}`,
                type: 'function',
                function: { name: c.function.name, arguments: c.function.arguments ?? '{}' },
              })),
            }
          : {}),
      };
      return {
        assistant,
        calls: raw.map((c, i) => {
          let command = '';
          try {
            command = String(JSON.parse(c.function.arguments || '{}').command ?? '');
          } catch {
            command = '';
          }
          return { id: c.id || `call_${i}`, command };
        }),
        text: msg.content ?? '',
        usage: {
          input: Math.max(0, (u.prompt_tokens ?? 0) - cached),
          cacheWrite: 0,
          cacheRead: cached,
          output: u.completion_tokens ?? 0,
        },
        served: reply.provider ?? null,
        costUsd: typeof u.cost === 'number' ? u.cost : null,
      };
    },
    toolResults: (results) =>
      results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content })),
    firstMessage: (text) => ({ role: 'user', content: text }),
  },
};

const adapter = providerName === 'anthropic' ? adapters.anthropic : adapters.openai;

/**
 * Roll the app back to its baseline before the run.
 *
 * Without this, state accumulates across runs (neither app's UI offers a bulk
 * delete), so list sizes drift and later runs face a different task than
 * earlier ones. How it happens is the target's business: repairdesk reloads
 * its seed in-process, atelyr stops the backend and swaps files on disk. The
 * atelyr path restarts processes, so it must happen before the first command
 * and never while the other arm is running.
 */
if (args.reset) {
  try {
    await target.reset();
  } catch (err) {
    // Reset runs before the reachability check below, because the atelyr path
    // is what brings the backend back up — so a dead app surfaces here first,
    // and this is where it has to be explained.
    console.error(`[harness] could not reset ${targetName}: ${err.message}`);
    console.error(`[harness] ${target.notReadyHint}`);
    process.exit(2);
  }
}

/**
 * Fail before spending a single model token if the app is not actually there.
 *
 * A previous sweep burned three runs discovering at turn 40 that the agent had
 * been staring at a connection error the whole time — the transcripts recorded
 * only that each observation was small, not that the app was down. One request
 * up front turns that into a one-line message.
 */
if (process.env.APP_URL) {
  try {
    const res = await fetch(process.env.APP_URL, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    // Any HTTP answer means something is listening and routing; a login
    // redirect or a 404 on the root is still a live app.
    console.log(`[harness] ${targetName} responded ${res.status} at ${process.env.APP_URL}`);
  } catch (err) {
    console.error(`[harness] ${targetName} is not reachable at ${process.env.APP_URL}`);
    console.error(`[harness] ${target.notReadyHint}`);
    console.error(`[harness] ${err.message}`);
    process.exit(2);
  }
}

const startedAt = Date.now();
const messages = [adapter.firstMessage(task)];
let turns = 0;
let finalText = '';
let stopReason = 'completed';
let leftLoopEarly = false;
let spendUnpriced = false;
let contextTruncations = 0;
const rates = loadRates(typeof args.rates === 'string' ? args.rates : undefined);

log({ k: 'meta', arm: args.arm, target: targetName, provider: providerName, model, runid, task: args.task, briefing: args.briefing ?? null, reset: Boolean(args.reset), captureBytes: args.captureBytes, startedAt });

try {
  while (turns < args.maxTurns) {
    turns++;
    // What the harness is about to SEND, measured before the call. If this grows
    // while the provider's reported `usage.input` stays flat, the history is
    // being dropped between here and the model (provider/network), not by the
    // harness. Counts only — no message content — so it stays publishable.
    // Diagnoses the cloud browser-pilot freeze where usage.input sat at 17 for
    // 118 turns (c0822bp/c0822bp2). See bench/HANDOFF.md.
    const sentChars = messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
    log({ k: 'sent', turn: turns, messages: messages.length, chars: sentChars });
    const reply = await adapter.send(messages);
    usage.input += reply.usage.input;
    usage.cacheWrite += reply.usage.cacheWrite;
    usage.cacheRead += reply.usage.cacheRead;
    usage.output += reply.usage.output;
    if (reply.served) servedBackends.add(reply.served);
    if (typeof reply.costUsd === 'number') orReportedCostUsd += reply.costUsd;
    log({ k: 'turn', turn: turns, usage: reply.usage, calls: reply.calls.length, ...(reply.served ? { served: reply.served } : {}) });

    // Catch the intermittent cloud freeze in the act. The provider's whole
    // received prompt is input + cacheRead; a healthy turn reports ~1 token per
    // 3-4 chars sent. When the provider reports far less than the harness sent,
    // the conversation was dropped between here and the model (the c0822bp /
    // c0822bp2 freeze, where received sat at ~2129 tokens while sent kept
    // growing). >=8 chars/received-token means over half the prompt vanished:
    // far past any tokenizer/caching variance, so it flags a real truncation
    // rather than noise. Log-only — never abort, so detection cannot itself
    // change a run's outcome or bias the comparison.
    const received = reply.usage.input + reply.usage.cacheRead;
    if (turns > 1 && received > 0 && sentChars / received >= 8) {
      contextTruncations++;
      log({ k: 'context-truncated', turn: turns, sentChars, received, ratio: +(sentChars / received).toFixed(1) });
      console.error(`[harness] turn ${turns}: sent ${sentChars} chars but provider received ~${received} tokens (${(sentChars / received).toFixed(1)}x) — conversation history is being dropped upstream`);
    }

    messages.push(reply.assistant);

    if (reply.calls.length === 0) {
      finalText = reply.text;
      leftLoopEarly = true;
      break;
    }

    const results = [];
    for (const call of reply.calls) {
      const { segments, ops } = splitSegments(call.command);
      const bad = segments.find((seg) => !commandIsAllowed(seg));
      if (!segments.length || bad) {
        results.push({
          id: call.id,
          isError: true,
          content: `Refused: this benchmark only permits plain "${arm.bin}" commands. Offending part: ${String(bad ?? call.command).slice(0, 200)}`,
        });
        log({ k: 'refused', turn: turns, cmd: call.command, segment: bad ?? null });
        continue;
      }

      // Run each segment as its own invocation, honouring the operator that
      // joined it. Recording them separately is what makes commands-per-run
      // mean the same thing in both arms.
      const outs = [];
      let lastCode = 0;
      let anyKilled = false;
      for (let s = 0; s < segments.length; s++) {
        if (s > 0) {
          const op = ops[s - 1];
          if (op === '&&' && lastCode !== 0) {
            log({ k: 'skipped', turn: turns, cmd: segments[s], after: op });
            continue;
          }
          if (op === '||' && lastCode === 0) {
            log({ k: 'skipped', turn: turns, cmd: segments[s], after: op });
            continue;
          }
        }
        const r = await runCommand(segments[s]);
        const bytes = Buffer.byteLength(r.out, 'utf8');
        commands.push({ turn: turns, cmd: segments[s], ms: r.ms, bytes, code: r.code, killed: r.killed });
        // `out` is what the orchestrator actually saw. It goes through the same
        // redaction as everything else, so transcripts stay publishable.
        const entry = { k: 'cmd', turn: turns, cmd: segments[s], ms: r.ms, code: r.code, killed: r.killed, bytes };
        if (args.captureBytes > 0) {
          entry.out = r.out.slice(0, args.captureBytes);
          if (r.out.length > args.captureBytes) entry.outTruncated = r.out.length;
        }
        log(entry);
        if (r.out) outs.push(r.out);
        lastCode = r.code;
        anyKilled = anyKilled || r.killed;
      }

      let content = outs.join('\n') || (anyKilled ? '(timed out with no output)' : '(no output)');

      // Advisory only: the real output is always returned, the command is
      // always run, and the run is never abandoned. See repeatedOutput.
      const repeat = repeatedOutput(content);
      if (repeat >= LOOP_NUDGE) {
        log({ k: 'loop-advice', turn: turns, repeat });
        content += `\n\n[harness] This is the ${repeat}th turn in a row with byte-identical output, so these commands are not revealing anything new. Consider acting on what you have already observed instead of observing again.`;
      }

      results.push({
        id: call.id,
        // Explicit: a killed command exits with code null, which is only
        // "not zero" by accident. Say what is actually being tested.
        isError: anyKilled || lastCode !== 0,
        content,
      });

      // Sample now, while the daemon still exists. See collectInnerUsage.
      await collectInnerUsage();
    }
    const followUp = adapter.toolResults(results);
    if (Array.isArray(followUp)) messages.push(...followUp);
    else messages.push(followUp);

    // Spend ceiling. Priced here, after this turn's inner usage was sampled,
    // so the figure includes the sub-agent work the turn just paid for.
    const spend = priceRun(rates, { provider: providerName, model, orchestrator: usage, inner });
    if (spend.totalUsd === null) {
      if (!spendUnpriced) {
        spendUnpriced = true;
        const why = spend.orchUsd === null ? `no rate for ${providerName}/${model} in rates.json` : spend.innerBasis;
        log({ k: 'spend-unpriced', why });
        console.error(`[harness] cannot price this run (${why}); --maxUsd is NOT enforced`);
      }
    } else {
      log({ k: 'spend', turn: turns, usd: +spend.totalUsd.toFixed(4) });
      if (args.maxUsd > 0 && spend.totalUsd >= args.maxUsd) {
        stopReason = 'spend-cap';
        leftLoopEarly = true;
        log({ k: 'spend-cap', turn: turns, usd: +spend.totalUsd.toFixed(4), maxUsd: args.maxUsd });
        console.error(`[harness] spend ceiling hit: $${spend.totalUsd.toFixed(4)} >= --maxUsd ${args.maxUsd} at turn ${turns}`);
        break;
      }
    }
  }
  // Only a run that exhausted the budget is turn-capped. Testing `turns >=
  // maxTurns` alone mislabels a run that finished exactly on the last turn — it
  // would overwrite the real reason with 'turn-cap'.
  if (!leftLoopEarly) stopReason = 'turn-cap';
} catch (err) {
  stopReason = `error: ${err.message}`;
  log({ k: 'error', message: err.message });
}

await collectInnerUsage();

/**
 * Release the run's browser. Each arm keeps its session alive between commands
 * by design, so a sweep of runs would otherwise leave a daemon and a browser
 * per run. Runs after usage collection, and failures here are logged rather
 * than thrown — losing a completed run's results to a cleanup error would be
 * worse than leaking a process.
 */
try {
  const stop =
    args.arm === 'browser-pilot'
      ? `${arm.bin} stop --session ${runid}`
      : `${arm.bin} --session ${runid} close`;
  const r = await runCommand(stop);
  log({ k: 'cleanup', cmd: stop, code: r.code });
} catch (err) {
  log({ k: 'cleanup-failed', message: String(err) });
}

/**
 * Snapshot the target's mutation log while the app is still up. Runs before
 * the result is written so a crash here cannot cost us the result file.
 */
let mutationLogPath = null;
if (target.logUrl) {
  try {
    const res = await fetch(target.logUrl(), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const entries = await res.json();
    mutationLogPath = path.join(outDir, `${runid}-${args.arm}-mutationlog.json`);
    fs.writeFileSync(mutationLogPath, JSON.stringify(redact(entries), null, 2));
    log({ k: 'mutation-log', path: mutationLogPath, entries: entries.length });
  } catch (err) {
    mutationLogPath = null;
    log({ k: 'mutation-log-failed', message: String(err) });
  }
}

const result = {
  arm: args.arm,
  target: targetName,
  machine: describeMachine(arm.bin),
  mutationLogPath,
  provider: providerName,
  model,
  runid,
  task: args.task,
  briefed: Boolean(briefing),
  reset: Boolean(args.reset),
  stopReason,
  turns,
  wallMs: Date.now() - startedAt,
  orchestrator: usage,
  inner,
  commandCount: commands.length,
  subcommands: subcommandCounts(commands, arm.bin),
  invocationCount: Object.values(subcommandCounts(commands, arm.bin)).reduce((n, v) => n + v, 0),
  commandMs: commands.reduce((n, c) => n + c.ms, 0),
  commandBytes: commands.reduce((n, c) => n + c.bytes, 0),
  timeouts: commands.filter((c) => c.killed).length,
  contextTruncations,
  coarse,
  // Learning sweep accounting: deterministic fraction A_n of the inner tool's
  // browser actions that ran by replay rather than by the model.
  learn: learnDir
    ? {
        dir: learnDir,
        ...(inner.skills ?? {}),
        deterministicFraction:
          inner.skills && inner.skills.totalActions ? +(inner.skills.deterministicActions / inner.skills.totalActions).toFixed(3) : null,
      }
    : null,
  orBackends: [...servedBackends],
  orReportedCostUsd: providerName === 'openrouter' ? +orReportedCostUsd.toFixed(4) : null,
  maxUsd: args.maxUsd,
  spendUsd: (() => {
    const t = priceRun(rates, { provider: providerName, model, orchestrator: usage, inner }).totalUsd;
    return t === null ? null : +t.toFixed(4);
  })(),
  finalText,
  transcriptPath,
};
log({ k: 'result', ...result });
transcript.end();

const resultPath = path.join(outDir, `${runid}-${args.arm}-result.json`);
fs.writeFileSync(resultPath, JSON.stringify(redact(result), null, 2));

console.log(
  [
    `arm=${args.arm} model=${model} runid=${runid} stop=${stopReason}`,
    `turns=${turns} wall=${(result.wallMs / 1000).toFixed(1)}s`,
    `commands=${result.commandCount} cmdTime=${(result.commandMs / 1000).toFixed(1)}s cmdBytes=${result.commandBytes} timeouts=${result.timeouts}`,
    `orchestrator in=${usage.input} cw=${usage.cacheWrite} cr=${usage.cacheRead} out=${usage.output}`,
    `inner prompt=${inner.promptTokens} cached=${inner.cachedTokens} completion=${inner.completionTokens}`,
    `spend=${result.spendUsd === null ? 'unpriced' : `$${result.spendUsd}`} maxUsd=${args.maxUsd || 'off'}`,
    ...(result.learn
      ? [
          `learn: A_n=${result.learn.deterministicFraction ?? 'n/a'} replayed=${result.learn.invoked ?? 0}/${result.learn.instructions ?? 0} full=${result.learn.fullReplays ?? 0} repaired=${result.learn.repaired ?? 0} compiled=${result.learn.compiled ?? 0} variants=${result.learn.variants ?? 0}`,
        ]
      : []),
    `-> ${resultPath}`,
  ].join('\n'),
);
