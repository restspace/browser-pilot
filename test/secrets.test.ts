import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSecretLedger, hasSecretMarker, resolveSecrets, resolveSecretsDeep, scrubSecrets, scrubSecretsDeep } from '../src/shared/secrets.js';

beforeEach(() => {
  clearSecretLedger();
  process.env.BP_TEST_SECRET = 'hunter2-secret';
  process.env.BP_TEST_SHORT = 'ab';
});
afterEach(() => {
  delete process.env.BP_TEST_SECRET;
  delete process.env.BP_TEST_SHORT;
  clearSecretLedger();
});

describe('resolveSecrets', () => {
  it('substitutes {{env:NAME}} from the environment', () => {
    expect(resolveSecrets('password {{env:BP_TEST_SECRET}} ok')).toBe('password hunter2-secret ok');
  });
  it('throws a directive error on an unset variable', () => {
    expect(() => resolveSecrets('{{env:BP_TEST_UNSET_VAR}}')).toThrow(/BP_TEST_UNSET_VAR is not set/);
  });
  it('resolves deep through tool args without mutating', () => {
    const args = { target: '@e1', value: '{{env:BP_TEST_SECRET}}', nested: { list: ['{{env:BP_TEST_SECRET}}'] } };
    const live = resolveSecretsDeep(args);
    expect(live.value).toBe('hunter2-secret');
    expect((live.nested.list as string[])[0]).toBe('hunter2-secret');
    expect(args.value).toBe('{{env:BP_TEST_SECRET}}');
  });
  it('hasSecretMarker is precise', () => {
    expect(hasSecretMarker('x {{env:FOO}} y')).toBe(true);
    expect(hasSecretMarker('x {{v1}} {{d2}} {{step.url.p1}} y')).toBe(false);
  });
});

describe('scrubSecrets', () => {
  it('replaces every resolved value with its marker', () => {
    resolveSecrets('{{env:BP_TEST_SECRET}}');
    expect(scrubSecrets('the page shows hunter2-secret twice: hunter2-secret')).toBe(
      'the page shows {{env:BP_TEST_SECRET}} twice: {{env:BP_TEST_SECRET}}',
    );
  });
  it('scrubs deep structures (diffs)', () => {
    resolveSecrets('{{env:BP_TEST_SECRET}}');
    const diff = scrubSecretsDeep({ url: 'http://h/', added: ['- banner "Saved hunter2-secret!"'], alerts: [] });
    expect(diff.added[0]).toBe('- banner "Saved {{env:BP_TEST_SECRET}}!"');
  });
  it('never scrubs values it did not resolve, and skips too-short values', () => {
    expect(scrubSecrets('hunter2-secret untouched')).toBe('hunter2-secret untouched');
    resolveSecrets('{{env:BP_TEST_SHORT}}');
    expect(scrubSecrets('lab report')).toBe('lab report');
  });
});
