import { describe, expect, it } from 'bun:test';

import { buildSignArgs } from './sign';

const args = buildSignArgs('tools/apksigner.jar', 'in.apk', 'out.apk');

describe('buildSignArgs', () => {
  it('signs with the bundled keystore entry', () => {
    expect(args[args.indexOf('--ks') + 1]).toEndWith('ks-p12.keystore');
    expect(args).toContain('jhc');
    expect(args.filter((arg) => arg === 'pass:123456789')).toHaveLength(2);
  });

  it('writes the signed apk to the output path and leaves the input untouched', () => {
    expect(args[args.indexOf('--out') + 1]).toBe('out.apk');
    expect(args.at(-1)).toBe('in.apk');
  });
});
