import { describe, expect, it } from 'bun:test';

import { buildPatchArgs } from './cli';

import type { BuildContext } from './cli';

function createContext(): BuildContext {
  return {
    appName: 'reddit',
    appConfig: {
      'package-name': 'com.reddit.frontpage',
      'included-patches': 'Enable-debug-logging',
      arch: 'arm64-v8a',
    },
    packageName: 'com.reddit.frontpage',
    cliPath: 'tmp/morphe.jar',
    patchesPath: 'tmp/reddit/patches.mpp',
    workDir: 'tmp/reddit',
    tempDir: 'tmp/reddit/temp',
  };
}

describe('buildPatchArgs', () => {
  it('patches the input apk into the requested output path', () => {
    const args = buildPatchArgs(createContext(), 'tmp/reddit/com.reddit.frontpage.apk', 'tmp/reddit/reddit-patched.apk');

    expect(args[args.indexOf('--out') + 1]).toBe('tmp/reddit/reddit-patched.apk');
    expect(args.at(-1)).toBe('tmp/reddit/com.reddit.frontpage.apk');
    expect(args).toContain('--unsigned');
  });

  it('keeps the patcher scratch directory out of the output path', () => {
    // The Morphe CLI stages the patched apk as <temporary files path>/<output file name> and then copies
    // it over the output path, so the output must never live inside the temporary files path.
    const outputPath = 'tmp/reddit/reddit-patched.apk';
    const args = buildPatchArgs(createContext(), 'tmp/reddit/com.reddit.frontpage.apk', outputPath);

    const tempDir = args[args.indexOf('-t') + 1];
    expect(tempDir).not.toBe(outputPath);
    expect(outputPath.startsWith(`${tempDir}/`)).toBe(false);
  });

  it('enables the included patches and strips the configured architectures', () => {
    const args = buildPatchArgs(createContext(), 'tmp/reddit/com.reddit.frontpage.apk', 'tmp/reddit/reddit-patched.apk');

    expect(args).toContain('--striplibs=arm64-v8a');
    const enableIndex = args.indexOf('-e');
    expect(args.slice(enableIndex, enableIndex + 2)).toEqual(['-e', 'Enable-debug-logging']);
  });
});
