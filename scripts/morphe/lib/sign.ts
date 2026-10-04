import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { downloadFile } from './browser';
import { runCommand } from './utils';

const KEYSTORE_PATH = join(import.meta.dir, '..', 'ks-p12.keystore');
const KEYSTORE_PASSWORD = '123456789';
const KEYSTORE_ALIAS = 'jhc';

const APKSIGNER_URL = 'https://raw.githubusercontent.com/j-hc/revanced-magisk-module/main/bin/apksigner.jar';

export function buildSignArgs(apksignerPath: string, apkPath: string, outputPath: string): string[] {
  return [
    '-jar',
    apksignerPath,
    'sign',
    '--ks',
    KEYSTORE_PATH,
    '--ks-pass',
    `pass:${KEYSTORE_PASSWORD}`,
    '--key-pass',
    `pass:${KEYSTORE_PASSWORD}`,
    '--ks-key-alias',
    KEYSTORE_ALIAS,
    '--out',
    outputPath,
    '--v4-signing-enabled',
    'false',
    apkPath,
  ];
}

export async function signApk(apkPath: string, outputPath: string, cacheDir: string): Promise<void> {
  if (!existsSync(KEYSTORE_PATH)) {
    throw new Error(`Keystore not found: ${KEYSTORE_PATH}`);
  }

  const apksignerPath = join(cacheDir, 'apksigner.jar');
  await downloadFile(APKSIGNER_URL, apksignerPath);

  runCommand('java', buildSignArgs(apksignerPath, apkPath, outputPath), cacheDir);
}
