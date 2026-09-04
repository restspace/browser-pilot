sitelooper — agent-in-the-loop Playwright CLI

Usage:
  sitelooper do "<instruction>" [--json] [--max-turns N] [--timeout S] [--turn-timeout S] [--provider P] [--model M]
                                   [--fallback-model M | --no-escalate]
  sitelooper open <url>
  sitelooper brief <file.md> [--append]
  sitelooper note "<text>"
  sitelooper reset                       # clear the LLM conversation only (browser/cookies/briefing/notes kept)
  sitelooper peek [--selector <sel>] [--interactive]
  sitelooper script [out.spec.ts] [--title T] [--clear]   # emit a Playwright spec from the recorded actions
  sitelooper screenshot [path]
  sitelooper session list
  sitelooper stop [--all]
  sitelooper config                      # show resolved provider/model/paths
  sitelooper config set <key> <value>    # persist a default (provider, model, fallbackModel, baseUrl, apiKey)

Sizing an instruction:
  One `do` = one logical, verifiable step: a goal plus the check that it worked
  ("create a project named X, fill any required fields, submit, and report the row
  that appears"). Several UI actions inside one instruction is normal — that is the
  point of the tool.
  Too big:   several unrelated goals or assertions in one string. The agent stalls on
             planning and burns --max-turns. If a result comes back "blocked", split
             it and retry the halves.
  Too small: one click, one fill, one read. You pay for a whole agent loop to do what
             `peek` gives you for free.
  Do not drive the page by repeated `peek`/`config` polling. `peek` is for orienting
  ONCE when a `do` reports something you did not expect. If you are about to issue the
  same read a second time, issue a `do` instead.
  Name records by what is ON SCREEN — a name, a reference like S00021 — NEVER by an
  internal database id from a url ("res.partner id 44"). Instructions are recorded
  and replayed against fresh data: a name generalises, a database id is a pointer
  into THIS run's database and poisons every replay (fwod27 halted both replays on
  exactly this).

Escalation:
  When the routine model reports an instruction "blocked", it is retried once on a
  stronger fallback model, on the same live browser and history (told to verify state
  before repeating anything). Verified "failure" results are NOT retried. Disable with
  --no-escalate, or set the fallback model to "none".

Global flags:
  --session <name>   session name (default "default"; one daemon+browser per session)
  --verbose          stream the internal agent's actions + token accounting while it works
  --progress         stream the agent's actions to stderr (composes with --json)
  --headed           launch the browser with a visible window (first call only)
  --record           record the session to webm, one file per tab; paths are printed
                     on stop, which is when Playwright writes them (first call only)
  --script           record every action as a replayable Playwright step (first call
                     only); write the spec out later with "sitelooper script"
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
  SITELOOPER_EXTRA_BODY      JSON merged into MAIN-model requests only (e.g. an OpenRouter
                                provider pin); the fallback tier does not inherit it
  SITELOOPER_FALLBACK_EXTRA_BODY  same, for the fallback/recovery tier
  SITELOOPER_BASE_URL        any OpenAI-compatible base URL
  SITELOOPER_API_KEY         API key (works with any provider)
  SITELOOPER_CHANNEL         browser channel (default chrome, falls back to msedge)
  SITELOOPER_HEADED=1        headed browser
  SITELOOPER_RECORD=1        record session video to <session dir>/video
  SITELOOPER_SCRIPT=1        record actions as a Playwright script (see the script command)

Exit codes: 0 instruction succeeded · 1 failed/blocked · 2 infra error
