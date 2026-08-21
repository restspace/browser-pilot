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
 *     --task bench/tasks/atelyr-project-flow.md --runid bpX1 --out bench/results
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const ARMS = {
  'browser-pilot': { bin: 'browser-pilot', docs: 'armdocs/browser-pilot.md' },
  'agent-browser': { bin: 'agent-browser', docs: 'armdocs/agent-browser.md' },
};

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
  const out = { maxTurns: 120, timeoutMs: 900_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (key === 'maxTurns' || key === 'timeoutMs') out[key] = Number(argv[++i]);
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
const SECRETS = ['APP_PASSWORD', 'APP_EMAIL']
  .map((k) => process.env[k])
  .filter((v) => v && v.length > 3);

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
const systemText = `You are an automation agent completing a goal in a real web browser.

You have exactly one tool: \`run_command\`, which runs the \`${arm.bin}\` command-line tool and returns its output. You cannot see the screen; the command output is your only view of the browser.

Work through the goal to completion. Verify what you did rather than assuming a command succeeded. When the whole goal is done (or you are certain you cannot finish it), stop calling tools and reply with a final plain-text report stating, for each part of the goal, whether it succeeded and the concrete values you observed.

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

/**
 * Only the arm's own binary may run. This keeps an arm from wandering into
 * unrelated shell work, which would both break the comparison and make the
 * harness an arbitrary code executor.
 */
function commandIsAllowed(cmd) {
  const trimmed = cmd.trim();
  return trimmed === arm.bin || trimmed.startsWith(arm.bin + ' ');
}

function runCommand(cmd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, { shell: true, windowsHide: true });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, args.timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ out: out.trimEnd(), code, ms: Date.now() - started, killed });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ out: String(err), code: -1, ms: Date.now() - started, killed });
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
async function collectInnerUsage() {
  if (args.arm !== 'browser-pilot') return;
  const r = await runCommand(`${arm.bin} config --session ${runid}`);
  try {
    const cfg = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    if (cfg.usage) {
      inner.promptTokens = cfg.usage.promptTokens ?? 0;
      inner.cachedTokens = cfg.usage.cachedTokens ?? 0;
      inner.completionTokens = cfg.usage.completionTokens ?? 0;
      inner.instructions = cfg.usage.instructions ?? 0;
    }
    if (cfg.usageByModel) inner.byModel = cfg.usageByModel;
    inner.model = cfg.model ?? null;
    inner.fallbackModel = cfg.fallbackModel ?? null;
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
      const reply = await post(
        {
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
        },
        { authorization: `Bearer ${apiKey}` },
      );
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
      };
    },
    toolResults: (results) =>
      results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content })),
    firstMessage: (text) => ({ role: 'user', content: text }),
  },
};

const adapter = providerName === 'anthropic' ? adapters.anthropic : adapters.openai;

const startedAt = Date.now();
const messages = [adapter.firstMessage(task)];
let turns = 0;
let finalText = '';
let stopReason = 'completed';

log({ k: 'meta', arm: args.arm, provider: providerName, model, runid, task: args.task, briefing: args.briefing ?? null, startedAt });

try {
  while (turns < args.maxTurns) {
    turns++;
    const reply = await adapter.send(messages);
    usage.input += reply.usage.input;
    usage.cacheWrite += reply.usage.cacheWrite;
    usage.cacheRead += reply.usage.cacheRead;
    usage.output += reply.usage.output;
    log({ k: 'turn', turn: turns, usage: reply.usage, calls: reply.calls.length });

    messages.push(reply.assistant);

    if (reply.calls.length === 0) {
      finalText = reply.text;
      break;
    }

    const results = [];
    for (const call of reply.calls) {
      if (!commandIsAllowed(call.command)) {
        results.push({
          id: call.id,
          isError: true,
          content: `Refused: this benchmark only permits "${arm.bin}" commands. You sent: ${call.command.slice(0, 200)}`,
        });
        log({ k: 'refused', turn: turns, cmd: call.command });
        continue;
      }
      const r = await runCommand(call.command);
      const bytes = Buffer.byteLength(r.out, 'utf8');
      commands.push({ turn: turns, cmd: call.command, ms: r.ms, bytes, code: r.code, killed: r.killed });
      log({ k: 'cmd', turn: turns, cmd: call.command, ms: r.ms, code: r.code, killed: r.killed, bytes });
      results.push({
        id: call.id,
        isError: r.code !== 0,
        content: r.out || (r.killed ? '(timed out with no output)' : '(no output)'),
      });
    }
    const followUp = adapter.toolResults(results);
    if (Array.isArray(followUp)) messages.push(...followUp);
    else messages.push(followUp);
  }
  if (turns >= args.maxTurns) stopReason = 'turn-cap';
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

const result = {
  arm: args.arm,
  provider: providerName,
  model,
  runid,
  task: args.task,
  briefed: Boolean(briefing),
  stopReason,
  turns,
  wallMs: Date.now() - startedAt,
  orchestrator: usage,
  inner,
  commandCount: commands.length,
  commandMs: commands.reduce((n, c) => n + c.ms, 0),
  commandBytes: commands.reduce((n, c) => n + c.bytes, 0),
  timeouts: commands.filter((c) => c.killed).length,
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
    `-> ${resultPath}`,
  ].join('\n'),
);
