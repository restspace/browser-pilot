import type { BrowserSession } from '../daemon/browser.js';
import type { SessionState } from '../daemon/state.js';
import type { ChatMessage, Provider } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import { validateReport, type Report } from './report.js';
import { executeTool, TOOL_DEFS } from './tools.js';

/** Tools that change the page URL, staleing every existing snapshot's refs. */
const NAVIGATION_TOOLS = new Set(['goto', 'back', 'tabs']);

export interface LoopOptions {
  maxTurns: number;
  timeoutMs: number;
  screenshotDir: string;
  onProgress?: (message: string) => void;
}

/** One tool call the instruction made, for the resume-safety actions log. */
export interface ActionRecord {
  tool: string;
  args: string;
  ok: boolean;
}

export interface InstructionResult {
  report: Report;
  turns: number;
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
  /** Last few transcript lines, included when the loop had to bail out. */
  transcriptTail?: string[];
  /**
   * Ordered tool calls this instruction made — included on bail-out (turn/time
   * cap) so a caller can see which state-changing actions ran before deciding
   * whether to resume. Omitted on a clean report to keep results lean.
   */
  actions?: ActionRecord[];
}

/**
 * The agentic loop: send instruction + history, execute the model's tool
 * calls in-process, feed results back, until a valid `report` (or turn/time
 * caps hit → blocked with a transcript tail).
 */
export async function runInstruction(
  provider: Provider,
  browser: BrowserSession,
  state: SessionState,
  instruction: string,
  opts: LoopOptions,
): Promise<InstructionResult> {
  const deadline = Date.now() + opts.timeoutMs;
  const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  const transcript: string[] = [];
  const actions: ActionRecord[] = [];
  let reportRetried = false;
  let capWarned = false;

  state.trimHistory();
  state.messages.push({ role: 'user', content: instruction });

  const system: ChatMessage = { role: 'system', content: buildSystemPrompt(state) };

  const finish = (report: Report, turns: number, blockedTail = false): InstructionResult => {
    state.messages.push({
      role: 'assistant',
      content: `[report] ${report.status}: ${report.summary}`,
    });
    state.usage.promptTokens += usage.promptTokens;
    state.usage.completionTokens += usage.completionTokens;
    state.usage.cachedTokens += usage.cachedTokens;
    state.usage.instructions += 1;
    return {
      report,
      turns,
      usage,
      ...(blockedTail ? { transcriptTail: transcript.slice(-12), actions: actions.slice(-40) } : {}),
    };
  };

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    if (Date.now() > deadline) {
      return finish(
        {
          status: 'blocked',
          summary: `Instruction timed out after ${Math.round(opts.timeoutMs / 1000)}s (${turn - 1} turns). Work may be partially complete — check the actions log and verify current state before resuming.`,
        },
        turn - 1,
        true,
      );
    }

    // Near the cap, tell the agent to stop acting and report now — otherwise a
    // completed-but-unreported instruction is misreported as blocked/failed.
    if (!capWarned && turn > opts.maxTurns - 2) {
      capWarned = true;
      state.messages.push({
        role: 'user',
        content: `Only ${opts.maxTurns - turn + 1} turn(s) left before the cap. Call report NOW with your best current assessment of what was done and verified — do not start new actions. Flag anything you could not confirm.`,
      });
    }

    const completion = await provider.complete([system, ...state.messages], TOOL_DEFS);
    usage.promptTokens += completion.usage.promptTokens;
    usage.completionTokens += completion.usage.completionTokens;
    usage.cachedTokens += completion.usage.cachedTokens;
    state.messages.push(completion.assistantMessage);
    if (completion.text) transcript.push(`assistant: ${completion.text.slice(0, 300)}`);

    if (completion.toolCalls.length === 0) {
      // Model replied with prose only — remind it of the contract once per occurrence.
      state.messages.push({
        role: 'user',
        content:
          'Reminder: act via tool calls only, and finish by calling the report tool. Continue with the instruction.',
      });
      continue;
    }

    for (const call of completion.toolCalls) {
      if (Date.now() > deadline) break;

      if (call.name === 'report') {
        const validation = call.args ? validateReport(call.args) : { ok: false as const, error: 'arguments were not valid JSON' };
        if (validation.ok) {
          state.messages.push({ role: 'tool', tool_call_id: call.id, content: 'report accepted' });
          return finish(validation.report, turn);
        }
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `report rejected — ${validation.error}. Call report again with a valid payload (status: success|failure|blocked, summary: string).`,
        });
        transcript.push(`report rejected: ${validation.error}`);
        if (reportRetried) {
          return finish(
            {
              status: 'blocked',
              summary: `Agent could not produce a schema-valid report (last error: ${validation.error}).`,
            },
            turn,
            true,
          );
        }
        reportRetried = true;
        continue;
      }

      if (!call.args) {
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `ERROR: arguments for ${call.name} were not valid JSON. Re-issue the call.`,
        });
        transcript.push(`${call.name}: malformed arguments`);
        continue;
      }

      const summary = summarizeArgs(call.args);
      opts.onProgress?.(`[turn ${turn}/${opts.maxTurns}] ${call.name} ${summary}`);
      const execution = await executeTool(browser, call.name, call.args, opts.screenshotDir);
      actions.push({ tool: call.name, args: summary, ok: !execution.isError });
      state.messages.push({ role: 'tool', tool_call_id: call.id, content: execution.result });

      // Keep the re-sent context lean: a snapshot's @refs go stale on navigation
      // and when a newer snapshot arrives, so stub superseded snapshots now
      // rather than re-sending them (up to ~2k tokens each) every remaining turn.
      if (!execution.isError) {
        if (call.name === 'snapshot') state.elideSnapshots(call.id);
        else if (NAVIGATION_TOOLS.has(call.name) && !(call.name === 'tabs' && call.args.switch_to === undefined)) {
          state.elideSnapshots();
        }
      }
      transcript.push(
        `${call.name} ${summary} → ${execution.isError ? execution.result.slice(0, 200) : 'ok'}`,
      );
    }
  }

  return finish(
    {
      status: 'blocked',
      summary: `Turn cap (${opts.maxTurns}) reached without a final report. The instruction may be partially complete — check the actions log and verify current state before resuming (do not blindly repeat state-changing actions like submit/delete/move).`,
    },
    opts.maxTurns,
    true,
  );
}

function summarizeArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}
