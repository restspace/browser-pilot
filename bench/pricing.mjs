/**
 * One pricing rule, shared by the harness (live spend ceiling) and score.mjs
 * (post-hoc table), so a run can never be stopped under one formula and
 * reported under another.
 *
 * Orchestrator and inner tokens are priced apart: they bill at different
 * rates, and with escalation a single sleep-walker session can bill against
 * two tiers an order of magnitude apart. Inner cost is therefore computed from
 * the per-model split whenever the daemon reported one; a single-rate estimate
 * is used only as a fallback and is labelled as such.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_RATES = new URL('./rates.json', import.meta.url);

export function loadRates(file) {
  const src = file ? path.resolve(file) : DEFAULT_RATES;
  return JSON.parse(fs.readFileSync(src, 'utf8'));
}

export function rateFor(rates, provider, model) {
  return rates[provider]?.[model] ?? null;
}

/** USD for one usage block at one rate; null when the rate is unknown. */
export function cost(rate, { input = 0, cacheWrite = 0, cacheRead = 0, output = 0 }) {
  if (!rate) return null;
  return (
    (input * rate.input + cacheWrite * rate.cacheWrite + cacheRead * rate.cacheRead + output * rate.output) /
    1e6
  );
}

/**
 * Price a run, finished or in progress.
 *
 * `orchestrator` is the harness's own {input, cacheWrite, cacheRead, output};
 * `inner` is the sleep-walker daemon's {promptTokens, cachedTokens,
 * completionTokens, model, byModel?}. An arm with no inner model (or a run
 * that has not yet made an inner call) prices inner at 0 with basis 'none'.
 *
 * Returns {orchUsd, innerUsd, totalUsd, innerBasis}; each USD field is null
 * when a rate needed for it is missing, and totalUsd is null if either is.
 */
export function priceRun(rates, { provider, model, orchestrator, inner }) {
  const orchUsd = cost(rateFor(rates, provider, model), orchestrator ?? {});

  let innerUsd = 0;
  let innerBasis = 'none';
  const u = inner ?? {};
  // The inner model has its own provider (sleep-walker's SLEEP_WALKER_PROVIDER,
  // reported by `config` and recorded as inner.provider), which is NOT the
  // orchestrator's. They coincided while both ran on novita; once the
  // orchestrator moved to OpenRouter, pricing inner under the orchestrator's
  // provider looked the inner models up in the wrong rate table and returned
  // null — silently disabling the spend ceiling. Price inner against its own
  // provider, falling back to the orchestrator's for older results that predate
  // the field.
  const innerProvider = u.provider || provider;
  if (u.byModel && Object.keys(u.byModel).length) {
    innerBasis = 'per-model';
    for (const [m, t] of Object.entries(u.byModel)) {
      const c = cost(rateFor(rates, innerProvider, m), {
        input: Math.max(0, (t.promptTokens ?? 0) - (t.cachedTokens ?? 0)),
        cacheRead: t.cachedTokens ?? 0,
        output: t.completionTokens ?? 0,
      });
      if (c === null) {
        innerUsd = null;
        innerBasis = `unknown rate for ${m}`;
        break;
      }
      innerUsd += c;
    }
  } else if (u.promptTokens) {
    innerUsd = cost(rateFor(rates, innerProvider, u.model), {
      input: Math.max(0, u.promptTokens - (u.cachedTokens ?? 0)),
      cacheRead: u.cachedTokens ?? 0,
      output: u.completionTokens ?? 0,
    });
    innerBasis = innerUsd === null ? `unknown rate for ${u.model}` : 'single-rate ESTIMATE (no per-model split)';
  }

  const totalUsd = orchUsd === null || innerUsd === null ? null : orchUsd + innerUsd;
  return { orchUsd, innerUsd, totalUsd, innerBasis };
}
