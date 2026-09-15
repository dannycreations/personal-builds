import { describe, expect, it } from 'bun:test';

import { SUPPORTED_VERSION_LINE_PATTERN } from './constants';

describe('SUPPORTED_VERSION_LINE_PATTERN', () => {
  it('matches the simple format without versionCodes', () => {
    expect('1.2.3 (42 patches)'.match(SUPPORTED_VERSION_LINE_PATTERN)?.[1]).toBe('1.2.3');
  });

  it('matches the format with versionCodes brackets', () => {
    expect('12.10.0 [versionCodes: ARM64_V8A=70319] (14 patches)'.match(SUPPORTED_VERSION_LINE_PATTERN)?.[1]).toBe('12.10.0');
  });

  it('rejects lines that are not version entries', () => {
    expect('INFO: Package name: org.telegram.messenger.web'.match(SUPPORTED_VERSION_LINE_PATTERN)).toBeNull();
    expect('Most common compatible versions:'.match(SUPPORTED_VERSION_LINE_PATTERN)).toBeNull();
  });
});
