"""Monolithic-arm runner: one browser-use Agent, one task, one JSON result.

Reads {task, runid, model, maxSteps, headless} as JSON on stdin and prints
exactly one JSON object as the LAST line of stdout:

    {finalText, steps, usage: {prompt, cached, completion}, model,
     success, error?}

Everything above that line is browser-use's own logging and is captured into
the transcript only. The harness (bench/harness.mjs, arm kind "monolithic")
parses the last JSON line, so nothing here may print after it.

Fairness notes, disclosed in bench/README.md:
- The LLM is ChatOpenRouter with the SAME model the other arms' orchestrator
  uses, so model quality is held constant across arms.
- use_vision=False: that model takes no images, and every other arm is
  text-only. This disables a browser-use feature its authors recommend; the
  comparison is "browser-use on the benchmark's model", not peak browser-use.
- Token usage comes from browser-use's own TokenCost service, the same way
  browser-pilot's inner usage comes from its own daemon: each tool self-reports
  and the harness prices the report.
"""

import asyncio
import json
import os
import sys

# Keep the run self-contained: no telemetry, no cloud sync.
os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
os.environ.setdefault("BROWSER_USE_CLOUD_SYNC", "false")


async def main() -> None:
    cfg = json.load(sys.stdin)
    result = {
        "finalText": "",
        "steps": 0,
        "usage": {"prompt": 0, "cached": 0, "completion": 0},
        "model": cfg["model"],
        "success": None,
    }
    agent = None
    try:
        from browser_use import Agent, BrowserProfile, ChatOpenRouter

        llm = ChatOpenRouter(model=cfg["model"], api_key=os.environ["OPENROUTER_API_KEY"])
        agent = Agent(
            task=cfg["task"],
            llm=llm,
            use_vision=False,
            browser_profile=BrowserProfile(headless=bool(cfg.get("headless", True))),
        )
        history = await agent.run(max_steps=int(cfg.get("maxSteps", 120)))
        result["finalText"] = history.final_result() or ""
        result["steps"] = history.number_of_steps()
        result["success"] = history.is_successful()
        errors = [e for e in history.errors() if e]
        if errors and not result["finalText"]:
            result["error"] = "; ".join(str(e)[:200] for e in errors[:3])
    except Exception as err:  # noqa: BLE001 — the harness needs the reason, not a traceback code
        result["error"] = f"{type(err).__name__}: {err}"
    finally:
        if agent is not None:
            try:
                summary = await agent.token_cost_service.get_usage_summary()
                result["usage"] = {
                    "prompt": summary.total_prompt_tokens,
                    "cached": summary.total_prompt_cached_tokens,
                    "completion": summary.total_completion_tokens,
                }
            except Exception:
                pass

    sys.stdout.flush()
    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
