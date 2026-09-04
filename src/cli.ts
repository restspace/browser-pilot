import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { clip } from './shared/text.js';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnthropicProvider, OpenAICompatProvider, globalConfigPath, resolveProviderConfig, writeGlobalConfig, type Provider } from './agent/llm.js';
import type { Report } from './agent/report.js';
import { encodeFrame, LineDecoder, type Frame, type Request, type ResultFrame } from './shared/protocol.js';
import { aliasLegacyEnv, sessionsDir, socketPath, validateSessionName } from './shared/paths.js';
import { candidateExpr } from './daemon/recorder.js';
import { fillParams } from './skills/compile.js';
import { SkillStore, successRate, type Skill } from './skills/store.js';
import { listFlows, loadFlow } from './skills/flow.js';
import { patchSegment, promoteFallback, triage, type DriftTicket, type ProposeLocator, type TriageAction } from './skills/repair.js';
import { compileFlow } from './spec/index.js';
import { emitFlowFile } from './spec/emit.js';
import { flowToSpec, type SpecFlow } from './spec/ir.js';
import { LiftError, liftFlowFile } from './spec/lift.js';
import { diffSpecChanges, reloadStaged, stageRepair } from './spec/repair.js';
import os from 'node:os';

const USAGE = `sitelooper — agent-in-the-loop Playwright CLI

Usage:
  sitelooper do "<instruction>" [--json] [--max-turns N] [--timeout S] [--turn-timeout S] [--provider P] [--model M]
                                   [--fallback-model M | --no-escalate]
  sitelooper open <url>
  sitelooper brief <file.md> [--append]
  sitelooper note "<text>"
  sitelooper reset                       # clear the LLM conversation only (browser/cookies/briefing/notes kept)
  sitelooper peek [--selector <sel>] [--interactive]
  sitelooper script [out.spec.ts] [--title T] [--clear]   # emit a Playwright spec from the recorded actions
  sitelooper compile <flow-name-or-path> [--out <dir>] [--force] [--json]
                                          # compile a converged flow to a standalone Playwright
                                          # spec (Tier 2, no sitelooper runtime) — no daemon needed
  sitelooper skills list [--origin <origin>]             # stored procedures (learning mode; no daemon needed)
  sitelooper skills show <id>
  sitelooper skills rm <id>
  sitelooper skills clear --origin <origin> | --all
  sitelooper skills repair --drift <run-drift.json> [--dry-run] [--model M]   # post-session repair: drain a run's drift tickets
  sitelooper repair <name.flow.ts> [--var k=v ...] [--out <file>] [--converge <n>]
                                   [--dry-run] [--model M] [--json]
                                          # self-updating spec: replay a compiled flow file against
                                          # the live app in an ISOLATED temp store, let the recovery
                                          # ladder adapt it, fold the adaptation back into the owned
                                          # .flow.ts and re-emit it. Never touches the .spec.ts.
                                          # --converge n re-runs the repaired flow n more times
                                          # (default 1) and refuses to write unless every step is a
                                          # clean tier-A replay with no drift; each of those runs is
                                          # a REAL run against the app, so a flow that creates
                                          # records needs the app reset between them (or
                                          # --converge 0 and your own gate).
  sitelooper var <name>=<value>          # EXPERIMENTAL: declare a run variable (becomes {{name}} in a flow)
  sitelooper flow list | show <name>     # EXPERIMENTAL: saved flows (recorded sessions you can replay with run)
  sitelooper run <flow> [--var k=v ...]  # EXPERIMENTAL: replay a saved flow, repairing drifted steps
  sitelooper screenshot [path]
  sitelooper session list
  sitelooper stop [--all] [--save-flow <name>]
  sitelooper doctor                      # diagnose an install: node, browser, provider, key (no daemon needed)
  sitelooper config                      # show resolved provider/model/paths
  sitelooper config set <key> <value>    # persist a default (provider, model, fallbackModel, baseUrl, apiKey)

Sizing an instruction:
  One \`do\` = one logical, verifiable step: a goal plus the check that it worked
  ("create a project named X, fill any required fields, submit, and report the row
  that appears"). Several UI actions inside one instruction is normal — that is the
  point of the tool.
  Too big:   several unrelated goals or assertions in one string. The agent stalls on
             planning and burns --max-turns. If a result comes back "blocked", split
             it and retry the halves.
  Too small: one click, one fill, one read. You pay for a whole agent loop to do what
             \`peek\` gives you for free.
  Do not drive the page by repeated \`peek\`/\`config\` polling. \`peek\` is for orienting
  ONCE when a \`do\` reports something you did not expect. If you are about to issue the
  same read a second time, issue a \`do\` instead.

Escalation:
  When the routine model reports an instruction "blocked", it is retried once on a
  stronger fallback model, on the same live browser and history (told to verify state
  before repeating anything). Verified "failure" results are NOT retried. Disable with
  --no-escalate, or set the fallback model to "none".

Learning (progressive automation):
  Start a session with --learn (or SITELOOPER_SKILLS=1) and every instruction that
  reports success is compiled into a stored procedure: its actions, durable locators
  with fallbacks, the values it typed turned into parameters, and what each step
  changed. On later instructions the procedures that start on the current page are
  offered to the internal agent, which replays one deterministically (run_skill) and
  only reasons when a step no longer works — the repair is stored as a variant. A
  validated procedure whose template matches an instruction word for word is replayed
  with no model call at all. Procedures live under ~/.sitelooper/skills/<origin>.json
  (override with SITELOOPER_SKILLS_DIR); inspect with "sitelooper skills".

Global flags:
  --session <name>   session name (default "default"; one daemon+browser per session)
  --verbose          stream the internal agent's actions + token accounting while it works
  --progress         stream the agent's actions to stderr (composes with --json)
  --headed           launch the browser with a visible window (first call only)
  --record           record the session to webm, one file per tab; paths are printed
                     on stop, which is when Playwright writes them (first call only)
  --script           record every action as a replayable Playwright step (first call
                     only); write the spec out later with "sitelooper script"
  --learn            learning mode: compile successful instructions into stored
                     procedures and replay them on later instructions (first call only)
  --json             machine-readable output

Providers (presets; each field overridable by flag > env > config file):
  zhipu (default)    glm-5.2 @ api.z.ai            key: GLM_API_KEY / ZHIPU_API_KEY
  novita             deepseek/deepseek-v4-flash @ novita.ai   key: NOVITA_API_KEY
                     escalates to zai-org/glm-5.3 when blocked
  openrouter         z-ai/glm-5.2 @ openrouter.ai  key: OPENROUTER_API_KEY
  openai             gpt-5-mini @ api.openai.com   key: OPENAI_API_KEY
  anthropic          claude-sonnet-5 @ api.anthropic.com (native Messages API, not
                     OpenAI-compatible — its own adapter)   key: ANTHROPIC_API_KEY

Environment:
  SITELOOPER_PROVIDER        provider preset name
  SITELOOPER_MODEL           model id override
  SITELOOPER_FALLBACK_MODEL  escalation model for blocked instructions ("none" disables)
  SITELOOPER_BASE_URL        any OpenAI-compatible base URL
  SITELOOPER_API_KEY         API key (works with any provider)
  Secrets: write {{env:NAME}} in an instruction/briefing instead of a plaintext credential.
  It resolves from the DAEMON's environment at the moment a tool runs — the model, transcript,
  skills, and flows only ever carry the marker. Export NAME before the session's first call.
  SITELOOPER_CHANNEL         browser channel (default chrome, falls back to msedge)
  SITELOOPER_HEADED=1        headed browser
  SITELOOPER_RECORD=1        record session video to <session dir>/video
  SITELOOPER_SCRIPT=1        record actions as a Playwright script (see the script command)
  SITELOOPER_SKILLS=1        learning mode (see --learn); SITELOOPER_SKILLS_DIR relocates the store

Exit codes: 0 instruction succeeded · 1 failed/blocked · 2 infra error`;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgv(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const valueFlags = new Set([
    'session',
    'max-turns',
    'timeout',
    'turn-timeout',
    'provider',
    'model',
    'fallback-model',
    'base-url',
    'selector',
    'title',
    'origin',
    'save-flow',
    'recovery-model',
    'drift',
    'var',
    'out',
    'converge',
  ]);
  /**
   * Every flag that takes no value. Unknown options are rejected rather than
   * assumed boolean: an unrecognised `--url http://…` used to set a phantom
   * boolean and drop the URL into the positionals, where `do` appended it to
   * the instruction. The run still worked, so nothing looked wrong — but the
   * compiled skill's template carried the URL and a slot for it, and no later
   * instruction could bind that template. A typo silently changing what the
   * agent was asked to do is not a defensible default for a tool whose
   * results are meant to be reproducible.
   */
  const booleanFlags = new Set([
    'all',
    'append',
    'clear',
    'dry-run',
    'force',
    'full-page',
    'headed',
    'help',
    'interactive',
    'json',
    'learn',
    'no-escalate',
    'progress',
    'record',
    'script',
    'verbose',
    'version',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valueFlags.has(name)) {
        flags.set(name, argv[++i] ?? '');
      } else if (booleanFlags.has(name)) {
        flags.set(name, true);
      } else {
        const known = [...valueFlags, ...booleanFlags].sort();
        throw new Error(`unknown option "--${name}". Known options: ${known.map((f) => `--${f}`).join(' ')}`);
      }
    } else {
      positional.push(arg);
    }
  }
  const command = positional.shift() ?? '';
  return { command, positional, flags };
}

// --- daemon connection ---

function connect(sock: string, timeoutMs = 1000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sock);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    conn.once('connect', () => {
      clearTimeout(timer);
      resolve(conn);
    });
    conn.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Connect and prove the daemon is alive with a ping round-trip (a pipe can
 * still accept connections while its daemon is shutting down). */
async function connectValidated(sock: string): Promise<net.Socket> {
  const conn = await connect(sock);
  try {
    await request(conn, 'ping', {}, undefined, 5_000);
    return conn;
  } catch (err) {
    conn.destroy();
    throw err;
  }
}

async function connectOrSpawn(
  session: string,
  opts: { headed: boolean; record: boolean; script: boolean; learn: boolean },
): Promise<net.Socket> {
  const sock = socketPath(session);
  try {
    return await connectValidated(sock);
  } catch {
    // not running — spawn the daemon detached and wait for the pipe
  }
  const serverPath = fileURLToPath(new URL('./daemon/server.js', import.meta.url));
  const args = [serverPath, '--session', session];
  if (opts.headed) args.push('--headed');
  if (opts.record) args.push('--record');
  if (opts.script) args.push('--script');
  if (opts.learn) args.push('--learn');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectValidated(sock);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`daemon did not come up for session "${session}": ${(lastErr as Error)?.message}`);
}

/**
 * `timeoutMs` guards the control commands (ping/stop): a daemon that is wedged
 * — rather than merely busy — must not hang the CLI indefinitely. `do` passes
 * no timeout; the daemon enforces its own instruction deadline.
 */
function request(
  conn: net.Socket,
  command: Request['command'],
  args: Record<string, unknown>,
  onProgress?: (m: string) => void,
  timeoutMs?: number,
): Promise<ResultFrame> {
  return new Promise((resolve, reject) => {
    const req: Request = { id: Date.now() % 1_000_000, command, args };
    const decoder = new LineDecoder<Frame>();
    const timer = timeoutMs
      ? setTimeout(() => {
          cleanup();
          reject(new Error(`${command} timed out after ${timeoutMs}ms — daemon not responding`));
        }, timeoutMs)
      : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      conn.removeListener('data', onData);
      conn.removeListener('error', onError);
      conn.removeListener('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        cleanup();
        return reject(err);
      }
      for (const frame of frames) {
        if (frame.type === 'progress') onProgress?.(frame.message);
        else {
          cleanup();
          resolve(frame);
        }
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('connection closed before result'));
    };
    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('close', onClose);
    conn.write(encodeFrame(req));
  });
}

// --- output helpers ---

function fail(message: string, code: 1 | 2 = 2): never {
  console.error(`sitelooper: ${message}`);
  process.exit(code);
}

function printResult(res: ResultFrame, json: boolean): unknown {
  if (!res.ok) fail(res.error ?? 'unknown error', res.errorKind === 'infra' ? 2 : 1);
  if (json) console.log(JSON.stringify(res.data, null, 2));
  return res.data;
}

// --- main ---

async function main(): Promise<void> {
  aliasLegacyEnv(); // honor legacy BROWSER_PILOT_* env vars — see paths.ts
  const { command, positional, flags } = parseArgv(process.argv.slice(2));
  if (!command || flags.has('help') || command === 'help') {
    console.log(USAGE);
    process.exit(command ? 0 : 2);
  }

  const session = validateSessionName(String(flags.get('session') ?? 'default'));
  const json = flags.has('json');
  const verbose = flags.has('verbose');
  // --progress streams the agent's actions to stderr without the full --verbose
  // token accounting, so it composes with --json (JSON stays clean on stdout).
  const onProgress = verbose || flags.has('progress') ? (m: string) => console.error(`  · ${m}`) : undefined;

  // Commands that don't need (or must not start) a daemon:
  if (command === 'config' && positional[0] === 'set') {
    const [, key, value] = positional;
    if (!key || value === undefined) fail('usage: config set <provider|model|fallbackModel|baseUrl|apiKey> <value>', 2);
    const merged = writeGlobalConfig({ [key]: value });
    const shown = { ...merged, ...(merged.apiKey ? { apiKey: '***' } : {}) };
    console.log(`${globalConfigPath()}: ${JSON.stringify(shown)}`);
    console.log('applies to the next instruction — running daemons re-read this file per call');
    return;
  }
  if (command === 'doctor') {
    const { runDoctor } = await import('./doctor.js');
    process.exit(await runDoctor(json));
  }
  if (command === 'skills' && positional[0] === 'repair') {
    await repairCommand(positional, flags, json);
    return;
  }
  if (command === 'skills') {
    skillsCommand(positional, flags, json);
    return;
  }
  if (command === 'flow' && positional[0] !== undefined && positional[0] !== 'run') {
    flowCommand(positional, json);
    return;
  }
  if (command === 'compile') {
    await compileCommand(positional, flags, json);
    return;
  }
  if (command === 'repair') {
    await repairFlowCommand(positional, flags, json, onProgress);
    return;
  }
  if (command === 'session') {
    if (positional[0] !== 'list') fail(`unknown subcommand "session ${positional[0] ?? ''}" (try: session list)`);
    await listSessions(json);
    return;
  }
  if (command === 'stop') {
    const names = flags.has('all') ? allSessionNames() : [session];
    for (const name of names) {
      let conn: net.Socket;
      try {
        conn = await connect(socketPath(name));
      } catch {
        if (!flags.has('all')) console.log(`not running: ${name}`);
        continue;
      }
      try {
        // Generous: the daemon aborts any in-flight instruction and lets it
        // unwind before closing the browser. Reachable-but-unresponsive is a
        // real failure worth reporting, not a silent "not running".
        //
        // A --save-flow stop is doing real work, not just unwinding: flow
        // export includes the post-session relabel (an LLM call, time-boxed
        // daemon-side), read-back pinning and the flow lint. fwod26 hit the
        // old shared 20s budget mid-export — the client gave up, the sweep
        // read "flow was never saved" and SKIPPED both replays, while the
        // detached daemon finished writing a perfectly good flow seconds
        // later. Reachable-and-working must be allowed to finish.
        // 150s: the relabel pass inside stop may ride out a full OpenRouter
    // rate-limit wait (its own 100s timebox) and the export still needs room.
    const stopTimeout = flags.get('save-flow') ? 150_000 : 20_000;
        const res = await request(conn, 'stop', { saveFlow: flags.get('save-flow') || undefined }, undefined, stopTimeout);
        const data = res.data as { preempted?: boolean; videos?: string[]; flow?: { path?: string; name?: string; steps?: number; vars?: string[]; warnings?: string[]; error?: string } } | undefined;
        console.log(`stopped: ${name}${data?.preempted ? ' (interrupted a running instruction)' : ''}`);
        for (const video of data?.videos ?? []) console.log(`  video: ${video}`);
        if (data?.flow?.error) console.error(`  flow not saved: ${data.flow.error}`);
        else if (data?.flow?.path) {
          console.log(`  flow "${data.flow.name}" saved: ${data.flow.steps} step(s)${data.flow.vars?.length ? `, vars ${data.flow.vars.join(', ')}` : ''} → ${data.flow.path}`);
          for (const w of data.flow.warnings ?? []) console.error(`  warning: ${w}`);
        }
      } catch (err) {
        console.error(`sitelooper: could not stop ${name}: ${(err as Error).message}`);
      } finally {
        conn.destroy();
      }
    }
    return;
  }

  const conn = await connectOrSpawn(session, {
    headed: flags.has('headed'),
    record: flags.has('record'),
    script: flags.has('script'),
    learn: flags.has('learn'),
  }).catch((err) => fail(err.message));

  try {
    switch (command) {
      case 'do': {
        const instruction = positional.join(' ').trim();
        if (!instruction) fail('do requires an instruction', 2);
        const res = await request(
          conn,
          'do',
          {
            instruction,
            maxTurns: flags.has('max-turns') ? Number(flags.get('max-turns')) : undefined,
            timeoutS: flags.has('timeout') ? Number(flags.get('timeout')) : undefined,
            turnTimeoutS: flags.has('turn-timeout') ? Number(flags.get('turn-timeout')) : undefined,
            provider: flags.get('provider') || undefined,
            model: flags.get('model') || undefined,
            baseUrl: flags.get('base-url') || undefined,
            fallbackModel: flags.get('fallback-model') || undefined,
            escalate: flags.has('no-escalate') ? false : undefined,
          },
          onProgress,
        );
        if (!res.ok) fail(res.error ?? 'unknown error', res.errorKind === 'infra' ? 2 : 1);
        const data = res.data as {
          report: Report;
          turns: number;
          usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
          transcriptTail?: string[];
          actions?: { tool: string; args: string; ok: boolean }[];
          finalState?: { url: string; title?: string };
          screenshots: string[];
          model: string;
          fallbackModel?: string;
          escalation?: {
            from: string;
            to: string;
            reason: string;
            firstAttempt: {
              status: string;
              turns: number;
              usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
            };
            rescued: boolean;
          };
          skill?: {
            listed: string[];
            invoked?: string;
            stepsReplayed: number;
            stepsTotal: number;
            repaired: boolean;
            refused: boolean;
            tier?: string;
            deterministicActions: number;
            totalActions: number;
          };
          learned?: { compiled?: string; merged?: string; variantOf?: string; superseded?: string; outcome?: { skill: string; status: string; ok: boolean } };
        };
        if (json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const mark = data.report.status === 'success' ? 'OK' : data.report.status.toUpperCase();
          console.log(`[${mark}] ${data.report.summary}`);
          if (data.escalation) {
            const e = data.escalation;
            console.log(
              `  escalated: ${e.from} blocked after ${e.firstAttempt.turns} turns → retried on ${e.to} (${e.rescued ? 'rescued' : 'still not resolved'})`,
            );
            console.log(`    blocked because: ${e.reason}`);
          }
          if (data.skill?.invoked) {
            const k = data.skill;
            console.log(
              `  skill: ${k.tier === 'A' ? 'replayed without the model' : 'replayed'} ${k.invoked} ${k.stepsReplayed}/${k.stepsTotal} steps${k.repaired ? ' — agent repaired the rest' : ''}${k.refused ? ' (refused)' : ''}`,
            );
          }
          if (data.learned) {
            const l = data.learned;
            const bits = [
              l.compiled ? `stored ${l.compiled}${l.variantOf ? ` (variant of ${l.variantOf})` : ''}` : '',
              l.merged ? `merged into ${l.merged}` : '',
              l.outcome ? `${l.outcome.skill} → ${l.outcome.status}` : '',
              l.superseded ? `${l.superseded} superseded` : '',
            ].filter(Boolean);
            if (bits.length) console.log(`  learned: ${bits.join('; ')}`);
          }
          if (data.report.details) console.log(data.report.details);
          if (data.report.evidence?.values) {
            for (const [k, v] of Object.entries(data.report.evidence.values)) console.log(`  ${k}: ${v}`);
          }
          if (data.report.evidence?.capturedDialogs?.length) {
            console.log(`  dialogs: ${data.report.evidence.capturedDialogs.join(' | ')}`);
          }
          if (data.screenshots.length) {
            console.log(`  screenshots: ${data.screenshots.length}`);
            for (const s of data.screenshots) console.log(`    ${s}`);
          }
          if (data.actions?.length) {
            // On bail-out: the state-changing actions that ran, so you can verify
            // before resuming rather than blindly repeating them.
            console.log('--- actions taken (verify before resuming) ---');
            for (const a of data.actions) console.log(`  ${a.ok ? '✓' : '✗'} ${a.tool} ${a.args}`);
          }
          if (data.transcriptTail?.length && !data.actions?.length) {
            // Nothing ran — the agent's own reasoning is the only evidence there is.
            console.log('--- transcript tail (no tool calls ran) ---');
            for (const line of data.transcriptTail) console.log(`  ${line}`);
          }
          if (data.finalState) {
            console.log(`--- browser left at: ${data.finalState.url}${data.finalState.title ? ` — "${data.finalState.title}"` : ''}`);
          }
        }
        if (verbose) {
          const u = data.usage;
          const fresh = u.promptTokens - u.cachedTokens;
          const hit = u.promptTokens ? Math.round((u.cachedTokens / u.promptTokens) * 100) : 0;
          const models = data.escalation ? `${data.escalation.from} → ${data.escalation.to}` : data.model;
          console.error(
            `  · ${data.turns} turns, ${u.promptTokens} prompt (${u.cachedTokens} cached / ${fresh} fresh, ${hit}% hit) + ${u.completionTokens} completion tokens (${models})`,
          );
        }
        process.exit(data.report.status === 'success' ? 0 : 1);
        break;
      }

      case 'var': {
        const spec = positional.join(' ');
        const eq = spec.indexOf('=');
        if (eq < 1) fail('usage: var <name>=<value>', 2);
        const data = printResult(await request(conn, 'var', { name: spec.slice(0, eq).trim(), value: spec.slice(eq + 1) }), json) as { vars: Record<string, string> };
        if (!json) console.log(`vars: ${Object.entries(data.vars).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        break;
      }

      case 'run': {
        const flowName = positional[0];
        if (!flowName) fail('run requires a flow name (see: flow list)', 2);
        const vars: Record<string, string> = {};
        // --var k=v may repeat; parseArgv keeps only the last, so re-scan argv.
        for (let i = 0; i < process.argv.length - 1; i++) {
          if (process.argv[i] === '--var') {
            const kv = process.argv[i + 1];
            const eq = kv.indexOf('=');
            if (eq > 0) vars[kv.slice(0, eq)] = kv.slice(eq + 1);
          }
        }
        const res = await request(
          conn,
          'run',
          {
            name: flowName,
            vars,
            maxTurns: flags.has('max-turns') ? Number(flags.get('max-turns')) : undefined,
            timeoutS: flags.has('timeout') ? Number(flags.get('timeout')) : undefined,
            escalate: flags.has('no-escalate') ? false : undefined,
            recoveryModel: flags.get('recovery-model') || undefined,
          },
          onProgress,
        );
        if (!res.ok) fail(res.error ?? 'unknown error', res.errorKind === 'infra' ? 2 : 1);
        const data = res.data as {
          flow: string; status: string; passed: number; total: number; repinned: number; wallMs: number;
          steps: { id: string; status: string; summary?: string; tier?: string | null; replayed?: string | null; repaired?: boolean; turns?: number; repinned?: string }[];
        };
        if (json) console.log(JSON.stringify(data, null, 2));
        else {
          for (const st of data.steps) {
            const mark = st.status === 'success' ? 'OK' : st.status.toUpperCase();
            const how = st.tier === 'A' ? 'replay' : st.replayed ? (st.repaired ? `replay+repair ${st.replayed}` : `replay ${st.replayed}`) : 'agent';
            console.log(`[${mark}] ${st.id}  (${how}${st.turns ? `, ${st.turns} turns` : ''})${st.repinned ? ` re-pinned ${st.repinned}` : ''}`);
            if (st.status !== 'success' && st.summary) console.log(`       ${st.summary}`);
          }
          console.log(`${data.flow}: ${data.passed}/${data.total} steps, ${(data.wallMs / 1000).toFixed(1)}s${data.repinned ? `, ${data.repinned} step(s) re-pinned` : ''} — ${data.status}`);
        }
        process.exit(data.status === 'success' ? 0 : 1);
        break;
      }

      case 'open': {
        if (!positional[0]) fail('open requires a URL', 2);
        const data = printResult(await request(conn, 'open', { url: positional[0] }, onProgress), json) as {
          url: string;
          title: string;
        };
        if (!json) console.log(`${data.title} — ${data.url}`);
        break;
      }

      case 'brief': {
        const file = positional[0];
        if (!file || !fs.existsSync(file)) fail(`brief requires an existing file (got: ${file ?? 'nothing'})`, 2);
        const text = fs.readFileSync(path.resolve(file), 'utf8');
        const data = printResult(await request(conn, 'brief', { text, append: flags.has('append') }), json) as {
          briefingChars: number;
        };
        if (!json) console.log(`briefing loaded (${data.briefingChars} chars)`);
        break;
      }

      case 'note': {
        const text = positional.join(' ').trim();
        if (!text) fail('note requires text', 2);
        const data = printResult(await request(conn, 'note', { text }), json) as { notes: number };
        if (!json) console.log(`noted (${data.notes} notes in session)`);
        break;
      }

      case 'reset': {
        const data = printResult(await request(conn, 'reset', {}), json) as { clearedMessages: number };
        if (!json) console.log(`conversation reset (${data.clearedMessages} message(s) cleared; browser, briefing, and notes kept)`);
        break;
      }

      case 'peek': {
        const data = printResult(
          await request(conn, 'peek', {
            selector: flags.get('selector') || undefined,
            interactiveOnly: flags.has('interactive'),
          }),
          json,
        ) as { url: string; title: string; snapshot: string };
        if (!json) {
          console.log(`${data.title} — ${data.url}`);
          console.log(data.snapshot);
        }
        break;
      }

      case 'script': {
        const data = printResult(
          await request(conn, 'script', {
            path: positional[0],
            title: flags.get('title') || undefined,
            clear: flags.has('clear'),
          }),
          json,
        ) as { path?: string; steps: number; instructions?: number; recording?: boolean; cleared?: boolean };
        if (!json) {
          if (data.path) {
            console.log(`${data.path} (${data.steps} action(s), ${data.instructions ?? 0} instruction(s))`);
            if (data.cleared) console.log('recording cleared');
            if (!data.recording) {
              console.log('note: this session is not recording — generated from previously recorded actions');
            }
          } else {
            console.log(`recording cleared (${data.steps} action(s) discarded)`);
          }
        }
        break;
      }

      case 'screenshot': {
        const data = printResult(
          await request(conn, 'screenshot', { path: positional[0], fullPage: flags.has('full-page') }),
          json,
        ) as { path: string };
        if (!json) console.log(data.path);
        break;
      }

      case 'config': {
        const data = printResult(await request(conn, 'config', {}), true);
        void data;
        break;
      }

      default:
        fail(`unknown command "${command}"\n\n${USAGE}`, 2);
    }
  } finally {
    conn.destroy();
  }
  process.exit(0);
}

// --- skills (reads the store directly; no daemon involved) ---

function skillsCommand(positional: string[], flags: Map<string, string | boolean>, json: boolean): void {
  const store = new SkillStore();
  const sub = positional[0] ?? 'list';
  const origin = flags.get('origin') ? String(flags.get('origin')) : undefined;
  switch (sub) {
    case 'list': {
      const skills = (origin ? store.list(origin) : store.all()).sort((a, b) => a.origin.localeCompare(b.origin) || b.stats.uses - a.stats.uses);
      if (json) {
        console.log(JSON.stringify(skills.map(skillSummary), null, 2));
        return;
      }
      if (!skills.length) {
        console.log(`no stored procedures${origin ? ` for ${origin}` : ''} (store: ${store.dir})`);
        return;
      }
      let last = '';
      for (const s of skills) {
        if (s.origin !== last) {
          console.log(`${s.origin}`);
          last = s.origin;
        }
        const pct = Math.round(successRate(s) * 100);
        console.log(
          `  ${s.id}  ${s.status.padEnd(11)} ${String(s.steps.length).padStart(2)} steps  ${s.stats.successes}/${s.stats.uses} (${pct}%)${s.variantOf ? `  variant of ${s.variantOf}` : ''}`,
        );
        console.log(`           ${clipText(s.template, 110)}`);
      }
      console.log(`store: ${store.dir}`);
      return;
    }
    case 'show': {
      const id = positional[1];
      if (!id) fail('usage: skills show <id>', 2);
      const s = store.get(id);
      if (!s) fail(`no skill ${id}`, 1);
      if (json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      console.log(`${s.id}  ${s.status}  ${s.origin}`);
      console.log(`template: ${s.template}`);
      console.log(`starts on: ${s.preconditions.urlPattern}`);
      const params = Object.entries(s.params);
      console.log(params.length ? `params: ${params.map(([k, p]) => `${k} = e.g. ${JSON.stringify(p.example)} (steps ${p.usedIn.join(',')})`).join('; ')}` : 'params: none');
      console.log(
        `stats: ${s.stats.successes}/${s.stats.uses} ok, ${s.stats.partial} partial, ${s.stats.fallthroughs} locator fallthrough(s)${
          Object.keys(s.stats.failedAtStep).length ? `, failed at step ${Object.entries(s.stats.failedAtStep).map(([k, v]) => `${k}×${v}`).join(', ')}` : ''
        }; created ${s.provenance.created} in session ${s.provenance.session}${s.provenance.model ? ` by ${s.provenance.model}` : ''}`,
      );
      if (s.variantOf) console.log(`variant of: ${s.variantOf}`);
      console.log('steps:');
      s.steps.forEach((st, i) => {
        const target = st.locators.target?.[0] ? candidateExpr(st.locators.target[0]) : st.args.target ? String(st.args.target) : '';
        const fallbacks = (st.locators.target?.length ?? 0) > 1 ? ` (+${st.locators.target!.length - 1} fallback)` : '';
        const args = Object.entries(st.args)
          .filter(([k]) => k !== 'target' && k !== 'source')
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(' ');
        const literal = Object.entries(st.args)
          .filter(([k, v]) => ['value', 'text', 'option'].includes(k) && typeof v === 'string' && !/\{\{v\d+\}\}/.test(v))
          .map(([, v]) => JSON.stringify(v));
        console.log(
          `  ${String(i + 1).padStart(2)}. ${st.tool.padEnd(14)} ${target}${fallbacks}${args ? '  ' + args : ''}${st.label ? `  → ${st.label}` : ''}${
            literal.length ? `  [literal value ${literal.join(', ')} — not a parameter]` : ''
          }${st.via ? `  (via ${st.via.skill} #${st.via.step})` : ''}`,
        );
        if (st.expect?.urlPattern) console.log(`      expect url ${st.expect.urlPattern}`);
      });
      if (s.reportTemplate?.summary) console.log(`report: ${clipText(fillParams(s.reportTemplate.summary, {}), 200)}`);
      return;
    }
    case 'rm': {
      const id = positional[1];
      if (!id) fail('usage: skills rm <id>', 2);
      if (!store.remove(id)) fail(`no skill ${id}`, 1);
      console.log(`removed ${id}`);
      return;
    }
    case 'clear': {
      if (flags.has('all')) {
        let n = 0;
        for (const o of store.origins()) n += store.clear(o);
        console.log(`cleared ${n} skill(s) across all origins`);
        return;
      }
      if (!origin) fail('usage: skills clear --origin <origin> | --all', 2);
      console.log(`cleared ${store.clear(origin)} skill(s) for ${origin}`);
      return;
    }
    default:
      fail(`unknown subcommand "skills ${sub}" (try: list, show <id>, rm <id>, clear)`, 2);
  }
}

function skillSummary(s: Skill) {
  return {
    id: s.id,
    origin: s.origin,
    status: s.status,
    template: s.template,
    steps: s.steps.length,
    params: Object.fromEntries(Object.entries(s.params).map(([k, p]) => [k, p.example])),
    uses: s.stats.uses,
    successes: s.stats.successes,
    partial: s.stats.partial,
    urlPattern: s.preconditions.urlPattern,
    ...(s.variantOf ? { variantOf: s.variantOf } : {}),
    created: s.provenance.created,
  };
}

function clipText(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' '), max);
}

function flowCommand(positional: string[], json: boolean): void {
  const op = positional[0] ?? 'list';
  if (op === 'list') {
    const flows = listFlows();
    if (json) console.log(JSON.stringify(flows.map((f) => ({ name: f.name, steps: f.steps.length, vars: f.vars, origin: f.origin })), null, 2));
    else if (!flows.length) console.log('no saved flows');
    else for (const f of flows) console.log(`${f.name}  ${f.steps.length} step(s)  ${f.vars.length ? `vars ${f.vars.join(', ')}` : 'no vars'}  ${f.origin}`);
    return;
  }
  if (op === 'show') {
    const flow = loadFlow(positional[1] ?? '');
    if (!flow) fail(`no flow "${positional[1] ?? ''}"`, 1);
    if (json) {
      console.log(JSON.stringify(flow, null, 2));
      return;
    }
    console.log(`${flow.name}  ${flow.origin}  (recorded ${flow.provenance.created} in session ${flow.provenance.session})`);
    console.log(`starts at: ${flow.startUrl}`);
    console.log(flow.vars.length ? `vars: ${flow.vars.join(', ')}` : 'vars: none');
    for (const st of flow.steps) {
      console.log(`  ${st.id}${st.skill ? ` [${st.skill}]` : ' [no skill]'}${st.outputs.length ? ` → ${st.outputs.join(', ')}` : ''}`);
      console.log(`     ${st.instruction.length > 120 ? st.instruction.slice(0, 120) + '…' : st.instruction}`);
    }
    return;
  }
  fail(`unknown "flow ${op}" (try: list, show <name>)`, 2);
}

// --- compile (reads the flow + skill store directly; no daemon involved) ---

async function compileCommand(positional: string[], flags: Map<string, string | boolean>, json: boolean): Promise<void> {
  const flowNameOrPath = positional[0];
  if (!flowNameOrPath) fail('usage: compile <flow-name-or-path> [--out <dir>] [--force] [--json]', 2);
  const outDir = flags.get('out') ? String(flags.get('out')) : '.';
  let result: ReturnType<typeof compileFlow>;
  try {
    result = compileFlow(flowNameOrPath, { outDir, force: flags.has('force') });
  } catch (err) {
    fail(`compile failed: ${(err as Error).message}`, 2);
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`flow: ${result.flowFile}`);
    console.log(result.specFile ? `spec: ${result.specFile}` : 'spec: unchanged (already exists — pass --force to overwrite)');
    for (const w of result.warnings) console.error(`  warning: ${w}`);
  }
  if (!result.compilable) {
    const missing = result.spec.steps.filter((s) => s.segments.length === 0).length;
    fail(`not compilable: ${missing} step(s) have no converged procedure`, 2);
  }
}

function allSessionNames(): string[] {
  try {
    return fs
      .readdirSync(sessionsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

async function listSessions(json: boolean): Promise<void> {
  const names = allSessionNames();
  const rows: { session: string; running: boolean; pid?: number }[] = [];
  for (const name of names) {
    try {
      const conn = await connect(socketPath(name), 500);
      const res = await request(conn, 'ping', {}, undefined, 5_000);
      conn.destroy();
      const data = res.data as { pid: number };
      rows.push({ session: name, running: true, pid: data.pid });
    } catch {
      rows.push({ session: name, running: false });
    }
  }
  if (json) console.log(JSON.stringify(rows, null, 2));
  else if (!rows.length) console.log('no sessions');
  else for (const r of rows) console.log(`${r.session}  ${r.running ? `running (pid ${r.pid})` : 'stopped'}`);
}

main().catch((err) => fail(err?.message ?? String(err)));

// --- post-session repair (SLOW MODE) ---

/**
 * Drain one run's drift tickets, after the timed run is over:
 *  - localized drift that already self-healed (a fallback resolved) → promote
 *    that fallback to primary in the stored skill. Cheap, deterministic.
 *  - localized drift with a dead chain → ask the repair model to re-derive
 *    the moved control's locator on the live page, verify it resolves, and
 *    store the patched chain as a provisional VARIANT that must earn adoption
 *    through the normal lifecycle.
 *  - low similarity → broad redesign: flag for a fresh record run, never
 *    patch selectors.
 */
async function repairCommand(positional: string[], flags: Map<string, string | boolean>, json: boolean): Promise<void> {
  const file = String(flags.get('drift') ?? positional[1] ?? '');
  if (!file) fail('usage: skills repair --drift <run-drift.json> [--dry-run] [--model M]', 2);
  let tickets: DriftTicket[];
  try {
    tickets = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fail(`could not read drift tickets from ${file}: ${(err as Error).message}`, 1);
  }
  const dryRun = flags.has('dry-run');
  const store = new SkillStore();
  const summary = await drainDrift(store, tickets, { dryRun, model: flags.get('model') ? String(flags.get('model')) : undefined });

  if (json) {
    console.log(JSON.stringify({ tickets: tickets.length, ...summary }, null, 2));
    return;
  }
  console.log(`${tickets.length} drift ticket(s) → ${summary.promoted.length} fallback(s) promoted, ${summary.patched.length} segment(s) patched, ${summary.reRecord.length} flagged for re-record, ${summary.skipped.length} skipped`);
  for (const p of summary.promoted) console.log(`  promoted   ${p.skill} step ${p.step}: ${p.to}${p.dryRun ? ' (dry run)' : ''}`);
  for (const p of summary.patched) console.log(`  patched    ${p.skill} step ${p.step} → variant ${p.variant} (${p.locator})`);
  for (const p of summary.reRecord) console.log(`  re-record  ${p.skill} (${p.flow}/${p.step}): ${p.why}`);
  for (const p of summary.skipped) console.log(`  skipped    ${p.skill}${p.step ? ` step ${p.step}` : ''}: ${p.why}`);
}


/** What one drain pass did, as rows a reporter (text or JSON) can print. */
export interface DrainSummary {
  promoted: Array<Record<string, unknown>>;
  patched: Array<Record<string, unknown>>;
  reRecord: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
}

/**
 * Drain a run's drift tickets onto `store`: triage, then the cheap codemod
 * (promote-fallback), then the model-and-live-page one (patch-segment).
 * Re-record is REPORTED, never attempted — a broad redesign is a fresh
 * recording, and guessing at it is how a spec quietly stops testing what it
 * says it tests (PLAN-self-updating-spec.md, "what the agent is allowed to
 * change").
 *
 * Takes the store as an argument rather than opening `~/.sitelooper` itself,
 * because `sitelooper repair <flow.ts>` hands it a THROWAWAY store staged
 * from the compiled spec — the whole point of the spec-first loop is that
 * nothing outside the user's repo mutates.
 */
async function drainDrift(store: SkillStore, tickets: DriftTicket[], opts: { dryRun: boolean; model?: string }): Promise<DrainSummary> {
  const actions = triage(tickets);
  const summary: DrainSummary = { promoted: [], patched: [], reRecord: [], skipped: [] };

  for (const a of actions) {
    if (a.kind === 'promote-fallback') {
      const ok = opts.dryRun ? true : promoteFallback(store, a.ticket);
      (ok ? summary.promoted : summary.skipped).push({
        skill: a.ticket.skill, step: a.ticket.atStep, from: a.ticket.missedLocator, to: a.ticket.fallbackUsed,
        ...(opts.dryRun ? { dryRun: true } : {}), ...(ok ? {} : { why: 'ticket no longer maps onto the stored skill' }),
      });
    } else if (a.kind === 're-record') {
      summary.reRecord.push({ flow: a.ticket.flow, step: a.ticket.step, skill: a.ticket.skill, why: a.why });
    } else if (a.kind === 'skip') {
      summary.skipped.push({ skill: a.ticket.skill, step: a.ticket.step, why: a.why });
    }
  }

  const patches = actions.filter((a): a is Extract<TriageAction, { kind: 'patch-segment' }> => a.kind === 'patch-segment');
  if (patches.length && !opts.dryRun) {
    const config = resolveProviderConfig({ model: opts.model });
    const model = opts.model ?? (config.fallbackModel && config.fallbackModel !== 'none' ? config.fallbackModel : config.model);
    const provider: Provider = config.provider === 'anthropic' ? new AnthropicProvider({ ...config, model }) : new OpenAICompatProvider({ ...config, model });
    const { BrowserSession } = await import('./daemon/browser.js');
    const session = new BrowserSession({ session: 'repair', persist: false });
    try {
      for (const a of patches) {
        const url = repairPageUrl(store, a.ticket);
        if (!url) {
          summary.reRecord.push({ flow: a.ticket.flow, step: a.ticket.step, skill: a.ticket.skill, why: 'the drifted page cannot be revisited (its url needs run-specific ids)' });
          continue;
        }
        const page = await session.getPage();
        await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {});
        // A proposer that cannot run at all (no key, no balance, a provider
        // outage) is a REPORTABLE outcome, not a crash: the promotions this
        // pass already made are real work, and losing them to an unhandled
        // 403 would make the whole repair look like a tool bug.
        let res: Awaited<ReturnType<typeof patchSegment>>;
        try {
          res = await patchSegment(store, a.ticket, page, llmProposer(provider));
        } catch (err) {
          summary.skipped.push({ skill: a.ticket.skill, step: a.ticket.atStep, why: `the repair model could not be reached (${(err as Error).message.slice(0, 200)})` });
          continue;
        }
        if (res.outcome === 'patched') summary.patched.push({ skill: a.ticket.skill, step: a.ticket.atStep, variant: res.variant, locator: res.detail, model });
        else summary.skipped.push({ skill: a.ticket.skill, step: a.ticket.atStep, why: `${res.outcome}${res.detail ? `: ${res.detail}` : ''}` });
      }
    } finally {
      await session.close();
    }
  } else if (patches.length) {
    for (const a of patches) summary.skipped.push({ skill: a.ticket.skill, step: a.ticket.atStep, why: 'patch-segment (dry run: needs the repair model + live page)' });
  }
  return summary;
}

/** A concrete url the drifted page can be revisited at, or null when it cannot. */
function repairPageUrl(store: SkillStore, ticket: DriftTicket): string | null {
  const skill = store.get(ticket.skill);
  if (!skill) return null;
  const candidates = [ticket.pageUrlPattern, skill.preconditions.urlPattern];
  for (const c of candidates) {
    if (!c) continue;
    const filled = fillParams(c, Object.fromEntries(Object.entries(skill.params).map(([k, p]) => [k, p.example])));
    if (!filled.includes(':id') && !filled.includes('{{')) return filled;
  }
  return null;
}

/** ProposeLocator backed by the repair model: strict-JSON locator proposals from the live-page snapshot. */
function llmProposer(provider: Provider): ProposeLocator {
  return async ({ skill, ticket, chain, snapshot }) => {
    const prompt = [
      "A stored browser procedure has drifted: one step's locator no longer resolves on the live page.",
      `Procedure template: ${skill.template}`,
      `Step ${ticket.atStep ?? '?'} (${ticket.key ?? 'target'}); its known locators, best first, ALL of which failed to resolve:`,
      ...chain.map((c) => `  - ${candidateExpr(c)}`),
      '',
      'Interactive elements currently on the page, one per line:',
      snapshot || '(none found)',
      '',
      'Pick the ONE element that serves the same purpose the dead locators described (the control probably moved or was renamed).',
      'Reply with ONLY a JSON object, no prose, in one of these shapes:',
      '{"kind":"role","role":"button","name":"..."} {"kind":"label","label":"..."} {"kind":"placeholder","placeholder":"..."}',
      '{"kind":"testid","attr":"data-testid","value":"..."} {"kind":"id","selector":"#..."} {"kind":"text","text":"..."} {"kind":"css","selector":"..."}',
      'If no element on the page serves that purpose, reply with exactly: null',
    ].join('\n');
    const completion = await provider.complete([{ role: 'user', content: prompt }], []);
    const text = (completion.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    if (!text || text === 'null') return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') return parsed;
    } catch {
      /* not JSON */
    }
    return null;
  };
}

// --- repair on a compiled spec (PLAN-self-updating-spec.md, phase 4) ---

/**
 * `--var k=v` may repeat, and `parseArgv` keeps only the last one, so the
 * repeats are re-scanned out of argv. Same rule `run` uses; shared so a flow
 * replayed by `repair` binds exactly what `run` would.
 */
function varFlags(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === '--var') {
      const kv = process.argv[i + 1];
      const eq = kv.indexOf('=');
      if (eq > 0) vars[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  return vars;
}

interface FlowRunResult {
  flow: string;
  status: string;
  passed: number;
  total: number;
  steps: Array<{ id: string; status: string; summary?: string; tier?: string | null; repinned?: string }>;
  driftTickets?: DriftTicket[];
  wallMs: number;
}

/** Best-effort shutdown of a throwaway repair session (its browser is the only thing holding that profile open). */
async function stopSessionQuietly(name: string): Promise<void> {
  try {
    const conn = await connect(socketPath(name));
    try {
      await request(conn, 'stop', {}, undefined, 30_000);
    } finally {
      conn.destroy();
    }
  } catch {
    /* already gone */
  }
}

/**
 * Replay a staged flow through the daemon exactly as `sitelooper run` does —
 * same spawn, same `run` command, same recovery ladder — with the skill store
 * pointed at the staged temp dir so the run's re-pins, learned variants and
 * candidate evidence land there and nowhere near `~/.sitelooper`.
 *
 * A FRESH session per run, deliberately: the flow's first step signs in, and a
 * session still signed in from the previous run would send that step to model
 * recovery and make the convergence gate measure the wrong thing. The session
 * is stopped on the way out so a converge loop does not leave one browser per
 * iteration running.
 */
async function runStagedFlow(
  staged: { flowFile: string; skillsDir: string },
  vars: Record<string, string>,
  session: string,
  opts: { headed: boolean; onProgress?: (m: string) => void },
): Promise<FlowRunResult> {
  const prev = { skills: process.env.SITELOOPER_SKILLS, dir: process.env.SITELOOPER_SKILLS_DIR };
  process.env.SITELOOPER_SKILLS = '1';
  process.env.SITELOOPER_SKILLS_DIR = staged.skillsDir;
  try {
    const conn = await connectOrSpawn(session, { headed: opts.headed, record: false, script: false, learn: true });
    try {
      const res = await request(conn, 'run', { name: staged.flowFile, vars }, opts.onProgress);
      if (!res.ok) fail(res.error ?? 'the flow run failed', res.errorKind === 'infra' ? 2 : 1);
      return res.data as FlowRunResult;
    } finally {
      conn.destroy();
    }
  } finally {
    if (prev.skills === undefined) delete process.env.SITELOOPER_SKILLS;
    else process.env.SITELOOPER_SKILLS = prev.skills;
    if (prev.dir === undefined) delete process.env.SITELOOPER_SKILLS_DIR;
    else process.env.SITELOOPER_SKILLS_DIR = prev.dir;
    await stopSessionQuietly(session);
    // A repair run's session is scratch: its browser profile exists for one
    // replay and a converge loop would otherwise leave one directory per
    // iteration behind. Best effort — a profile Chrome has not finished
    // releasing is left for the OS to clean up rather than failing the run.
    try {
      fs.rmSync(path.join(sessionsDir(), session), { recursive: true, force: true });
    } catch {
      /* still held open — harmless */
    }
  }
}

/**
 * Steps that are not "clean tier A", in the convergence gate's own vocabulary:
 * a step that did not succeed, a step that needed the model (any tier but A),
 * or a step that succeeded but still filed a drift ticket. A run that halted
 * reports its unreached steps too — silence about them would read as success.
 */
function notConverged(run: FlowRunResult): string[] {
  const bad = new Map<string, string>();
  for (const st of run.steps) {
    if (st.status !== 'success') bad.set(st.id, st.status);
    else if (st.tier !== 'A') bad.set(st.id, `tier ${st.tier ?? 'none'}`);
  }
  for (const t of run.driftTickets ?? []) {
    if (!bad.has(t.step)) bad.set(t.step, `drift (${t.missedLocator ?? t.reason ?? t.fellBack ?? 'recovered'})`);
  }
  if (run.steps.length < run.total) bad.set('(unreached)', `${run.total - run.steps.length} step(s) the run never got to`);
  return [...bad].map(([id, why]) => `${id} (${why})`);
}

/**
 * `sitelooper repair <name.flow.ts>` — the self-updating half of the compiled
 * runner (PLAN-self-updating-spec.md, "The loop").
 *
 * Lift the owned file back to its IR, stage it into a THROWAWAY store and flow
 * file, replay it against the live app through the daemon (whose recovery
 * ladder is the agent adapting the flow — that is the point), drain the run's
 * drift tickets onto the staged store, re-derive the IR from what the run and
 * the drain left there, and print the difference as English a reviewer can
 * read. Only then, and only if the convergence gate passes, is the `.flow.ts`
 * re-emitted. The `.spec.ts` is never touched: it is the user's file.
 */
async function repairFlowCommand(
  positional: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
  onProgress?: (m: string) => void,
): Promise<void> {
  const file = positional[0];
  if (!file) fail('usage: repair <name.flow.ts> [--var k=v ...] [--out <file>] [--converge <n>] [--dry-run] [--model M] [--json]', 2);
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return fail(`could not read ${file}: ${(err as Error).message}`, 2);
  }
  let before: SpecFlow;
  try {
    before = liftFlowFile(source).spec;
  } catch (err) {
    if (err instanceof LiftError) {
      return fail(`this file was edited by hand or is not a sitelooper flow file; refusing to repair — ${err.message}`, 2);
    }
    throw err;
  }

  const vars = varFlags();
  const missingVars = before.vars.filter((v) => !(v in vars));
  if (missingVars.length) fail(`flow "${before.name}" needs --var for: ${missingVars.join(', ')}`, 2);
  const converge = flags.has('converge') ? Number(flags.get('converge')) : 1;
  if (!Number.isInteger(converge) || converge < 0) fail('--converge takes a non-negative integer', 2);
  const dryRun = flags.has('dry-run');
  const outFile = flags.get('out') ? String(flags.get('out')) : file;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitelooper-repair-'));
  const staged = stageRepair(before, dir);
  const stamp = Date.now().toString(36);
  const say = (m: string) => {
    if (!json) console.log(m);
  };
  say(`repairing ${file} (${before.steps.length} step(s)) in ${dir}`);

  const run = await runStagedFlow(staged, vars, `repair-${stamp}-0`, { headed: flags.has('headed'), onProgress });
  const tickets = run.driftTickets ?? [];
  say(`run 1: ${run.passed}/${run.total} step(s) ${run.status}, ${tickets.length} drift ticket(s)`);
  for (const st of run.steps) {
    say(`  [${st.status === 'success' ? 'OK' : st.status.toUpperCase()}] ${st.id} (tier ${st.tier ?? 'none'})${st.status === 'success' ? '' : ` — ${st.summary ?? ''}`}`);
  }

  // The drain runs even under --dry-run: the summary IS the repair, and it
  // cannot be described without performing it. --dry-run governs the one
  // irreversible thing — writing the user's `.flow.ts`.
  const drained = await drainDrift(staged.store, tickets, {
    dryRun: false,
    model: flags.get('model') ? String(flags.get('model')) : undefined,
  });

  const after = reloadStaged(staged).spec;
  const diff = diffSpecChanges(before, after);
  const changed = diff.lines.filter((l) => !l.endsWith(': no change'));

  const report = {
    file,
    flow: before.name,
    workspace: dir,
    run: { status: run.status, passed: run.passed, total: run.total, drift: tickets.length },
    ...drained,
    changes: diff.lines,
    droppedExpectations: diff.droppedExpectations,
  };

  if (!json) {
    console.log(
      `${tickets.length} drift ticket(s) → ${drained.promoted.length} promoted, ${drained.patched.length} patched, ${drained.reRecord.length} need re-record, ${drained.skipped.length} skipped`,
    );
    for (const p of drained.reRecord) console.log(`  needs re-record  ${p.skill} (${p.flow}/${p.step}): ${p.why}`);
    for (const p of drained.skipped) console.log(`  skipped          ${p.skill}${p.step ? ` step ${p.step}` : ''}: ${p.why}`);
    console.log('--- changes ---');
    for (const line of diff.lines) console.log(`  ${line}`);
  }

  // Never weaken an expectation: an assertion that no longer holds is a test
  // failure for a human, not drift (PLAN-self-updating-spec.md).
  if (diff.droppedExpectations.length) {
    if (json) console.log(JSON.stringify({ ...report, wrote: null, refused: 'expectation dropped' }, null, 2));
    for (const d of diff.droppedExpectations) console.error(`  expectation dropped: ${d}`);
    fail('refusing to write: the repair would drop an expectation — that is a test failure for a human, not drift', 1);
  }

  if (!changed.length && drained.reRecord.length) {
    if (json) console.log(JSON.stringify({ ...report, wrote: null, refused: 'needs re-record' }, null, 2));
    else console.log('nothing could be repaired without re-recording — re-record the segment(s) listed above and compile again');
    process.exit(1);
  }

  for (let i = 1; i <= converge; i++) {
    const check = await runStagedFlow(staged, vars, `repair-${stamp}-${i}`, { headed: flags.has('headed'), onProgress });
    const bad = notConverged(check);
    say(`converge ${i}/${converge}: ${check.passed}/${check.total} step(s) ${check.status}, ${(check.driftTickets ?? []).length} drift ticket(s)`);
    if (bad.length) {
      if (json) console.log(JSON.stringify({ ...report, wrote: null, converged: false, notConverged: bad }, null, 2));
      console.error(`not converged: ${bad.join(', ')}`);
      process.exit(3);
    }
  }

  if (dryRun) {
    if (json) console.log(JSON.stringify({ ...report, wrote: null, dryRun: true }, null, 2));
    else console.log(`dry run: ${changed.length} change(s), nothing written (would have written ${outFile})`);
    return;
  }

  // Re-emit from the repaired IR — the owned file is generated in full, every
  // time, so a promoted candidate shows up in the diff as a reordered chain in
  // both the FLOW constant and the generated step body.
  const emitted = emitFlowFile(reloadStaged(staged).spec, { tier: 'plain' });
  fs.writeFileSync(outFile, emitted.source);
  if (json) console.log(JSON.stringify({ ...report, wrote: outFile, converged: true }, null, 2));
  else {
    for (const w of emitted.warnings) console.error(`  warning: ${w}`);
    console.log(`wrote ${outFile} (${changed.length} change(s); the .spec.ts was not touched)`);
  }
}
