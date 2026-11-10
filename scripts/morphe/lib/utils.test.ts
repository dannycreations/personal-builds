import { describe, expect, it } from 'bun:test';

import { parseJavaVersion } from './utils';

describe('parseJavaVersion', () => {
  it('parses the major version from OpenJDK output', () => {
    expect(parseJavaVersion('openjdk version "21.0.13" 2026-10-20 LTS')).toBe(21);
  });

  it('parses the major version from Oracle JDK output', () => {
    expect(parseJavaVersion('java version "17.0.21" 2026-10-20')).toBe(17);
  });

  it('returns null when no version is present', () => {
    expect(parseJavaVersion('some random output without a version')).toBeNull();
  });
});
