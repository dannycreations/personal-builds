import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { parse } from 'toml';

import { closeBrowser } from './lib/browser';
import { buildApp } from './lib/cli';

import type { AppConfig } from './lib/cli';

const RESERVED_KEYS = new Set(['cli-source', 'cli-version', 'patches-source', 'patches-version']);

interface MorpheConfig {
  readonly 'cli-source': string;
  readonly 'cli-version': string;
  readonly 'patches-source': string;
  readonly 'patches-version': string;
  readonly [appName: string]: unknown;
}

async function main(): Promise<void> {
  try {
    const configPath = process.argv[2];
    if (!configPath) {
      throw new Error('Usage: bun run scripts/morphe/main.ts <config.toml>');
    }

    const config = parse(readFileSync(configPath, 'utf-8')) as MorpheConfig;
    const appNames = Object.keys(config).filter((key) => !RESERVED_KEYS.has(key));

    if (appNames.length === 0) {
      console.log('No apps found in config.');
      return;
    }

    for (const appName of appNames) {
      try {
        await buildApp(
          appName.toLowerCase(),
          config[appName] as AppConfig,
          config['cli-source'],
          config['cli-version'],
          config['patches-source'],
          config['patches-version'],
        );
      } catch (error) {
        console.error(`[${appName}] Build failed: ${error}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await closeBrowser();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
