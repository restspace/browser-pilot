browser-pilot — agent-in-the-loop Playwright CLI

Usage:
  browser-pilot do "<instruction>" [--json] [--max-turns N] [--timeout S] [--turn-timeout S] [--provider P] [--model M]
                                   [--fallback-model M | --no-escalate]
  browser-pilot open <url>
  browser-pilot brief <file.md> [--append]
  browser-pilot note "<text>"
  browser-pilot reset                       # clear the LLM conversation only (browser/cookies/briefing/notes kept)
  browser-pilot peek [--selector <sel>] [--interactive]
  browser-pilot script [out.spec.ts] [--title T] [--clear]   # emit a Playwright spec from the recorded actions
  browser-pilot screenshot [path]
  browser-pilot session list
  browser-pilot stop [--all]
  browser-pilot config                      # show resolved provider/model/paths
  browser-pilot config set <key> <value>    # persist a default (provider, model, fallbackModel, baseUrl, apiKey)

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
                     only); write the spec out later with "browser-pilot script"
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
  BROWSER_PILOT_PROVIDER        provider preset name
  BROWSER_PILOT_MODEL           model id override
  BROWSER_PILOT_FALLBACK_MODEL  escalation model for blocked instructions ("none" disables)
  BROWSER_PILOT_BASE_URL        any OpenAI-compatible base URL
  BROWSER_PILOT_API_KEY         API key (works with any provider)
  BROWSER_PILOT_CHANNEL         browser channel (default chrome, falls back to msedge)
  BROWSER_PILOT_HEADED=1        headed browser
  BROWSER_PILOT_RECORD=1        record session video to <session dir>/video
  BROWSER_PILOT_SCRIPT=1        record actions as a Playwright script (see the script command)

Exit codes: 0 instruction succeeded · 1 failed/blocked · 2 infra error
