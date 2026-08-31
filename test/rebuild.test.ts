import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The recording-path regression gate.
 *
 * `bench/sweep.mjs --from` can A/B a REPLAY change, because it reuses an
 * earlier recording. Nothing could A/B a RECORDING change: run 1 is
 * model-driven, so each sweep compiles a different procedure. fwod25 is what
 * that cost — 50 minutes, three cloud runs, and an unreadable answer, because
 * the recording bore no resemblance to the one it was being compared against.
 *
 * bench/fixtures/recordings holds real published `script.jsonl` files. Everything
 * after the model speaks is a pure function of them, so it can be replayed here
 * in a second, for free, and pinned. If a change to report.ts, learn.ts or
 * flow.ts alters what these recordings compile to, this test says so and names
 * the number that moved — before an hour of cloud time says it worse.
 *
 * A DIFF IS NOT A FAILURE. It is the measurement. When a change is meant to
 * move these numbers, read the diff, satisfy yourself it moved the right way,
 * then re-pin:
 *
 *   node bench/rebuild-flow.mjs --tag fwod24 --dir bench/fixtures/recordings \
 *     --baseline bench/fixtures/fwod24.json --write-baseline
 */
const root = path.resolve(__dirname, '..');
const TAGS = ['fwod24', 'fwod25'];

describe('recorded-flow rebuild', () => {
  for (const tag of TAGS) {
    it(`${tag} still compiles to its pinned flow`, () => {
      // Throws on a non-zero exit, and rebuild-flow.mjs exits 1 on a diff with
      // the changed fields on stdout — which is what we want in the failure.
      const out = execFileSync(
        process.execPath,
        [
          'bench/rebuild-flow.mjs',
          '--tag',
          tag,
          '--dir',
          'bench/fixtures/recordings',
          '--baseline',
          `bench/fixtures/${tag}.json`,
        ],
        { cwd: root, encoding: 'utf8' },
      );
      expect(out).toContain('MATCHES baseline');
    });
  }

  it('fwod24 pins the defect it was recorded for: the order reference named after its selector', () => {
    const out = execFileSync(
      process.execPath,
      ['bench/rebuild-flow.mjs', '--tag', 'fwod24', '--dir', 'bench/fixtures/recordings'],
      { cwd: root, encoding: 'utf8' },
    );
    // 02-create publishes the quotation reference as `h1`, and eleven later
    // references point at it. When the naming ask starts landing, this line is
    // what changes — and it should change to a name a person would write.
    expect(out).toContain('{{02-create.h1}}":11');
    expect(out).toMatch(/02-create publishes \[h1,/);
  });
});
