import { describe, expect, it } from 'vitest';
import { maskSecrets } from './secrets.js';

describe('maskSecrets', () => {
  it.each([
    ['a classic GitHub token', `ghp_${'a'.repeat(36)}`],
    ['a fine-grained GitHub token', `github_pat_${'B1_'.repeat(20)}`],
    ['an Anthropic key', `sk-ant-api03-${'x'.repeat(40)}`],
    ['a machine token', `omt_${'Ab-_'.repeat(10)}xyz`],
    ['a run token', `ort_${'Cd-_'.repeat(10)}xyz`],
  ])('hides %s', (_name, secret) => {
    expect(maskSecrets(`cat says ${secret} here`)).toBe('cat says [hidden] here');
  });

  it('leaves other text alone', () => {
    expect(maskSecrets('omt_short ort_short ghp_short plain text')).toBe(
      'omt_short ort_short ghp_short plain text',
    );
  });
});
