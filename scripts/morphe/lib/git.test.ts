import { describe, expect, it } from 'bun:test';

import { isValidSemverCore, pickHighestSemver, sortBySemverDesc } from './git';

describe('isValidSemverCore', () => {
  it('accepts plain numeric cores with or without a v prefix', () => {
    expect(isValidSemverCore('1')).toBe(true);
    expect(isValidSemverCore('v1')).toBe(true);
    expect(isValidSemverCore('1.2')).toBe(true);
    expect(isValidSemverCore('v1.2.3')).toBe(true);
  });

  it('rejects tags whose core contains letters, but accepts prerelease suffixes', () => {
    expect(isValidSemverCore('1a')).toBe(false);
    expect(isValidSemverCore('v1.2-beta')).toBe(true);
    expect(isValidSemverCore('v1.2.3-rc.1')).toBe(true);
  });
});

describe('sortBySemverDesc', () => {
  it('sorts by numeric semver descending, ignoring v prefix and prerelease suffixes', () => {
    const tags = ['v1.2.3', '1.0.0', 'v1.2.3-dev', '2.0.0'];
    expect([...tags].sort(sortBySemverDesc)).toEqual(['2.0.0', 'v1.2.3', 'v1.2.3-dev', '1.0.0']);
  });

  it('handles unequal segment lengths by padding missing segments as 0', () => {
    const tags = ['1.9', '1.10'];
    expect([...tags].sort(sortBySemverDesc)).toEqual(['1.10', '1.9']);
  });
});

describe('pickHighestSemver', () => {
  it('returns the tag with the highest semver core', () => {
    expect(pickHighestSemver(['v0.5.0', 'v1.0.0', 'v0.9.0'])).toBe('v1.0.0');
  });

  it('falls back to returning the first tag when tags are non-semver strings', () => {
    expect(pickHighestSemver(['alpha', 'beta'])).toBe('alpha');
  });

  it('throws on an empty array', () => {
    expect(() => pickHighestSemver([])).toThrow('No tags provided');
  });
});
