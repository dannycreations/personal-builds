import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const MIN_JAVA_VERSION = 21;

const JAVA_VERSION_PATTERN = /version\s+"(\d+)(?:\.\d+)*"/;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseJavaVersion(output: string): number | null {
  const match = output.match(JAVA_VERSION_PATTERN);
  return match ? Number(match[1]) : null;
}

export function resolveJavaCommand(): string {
  const candidates = [
    process.env['MORPHE_JAVA'],
    process.env['JAVA_HOME'] ? join(process.env['JAVA_HOME'], 'bin', 'java') : undefined,
    'java',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(candidate, ['-version'], { encoding: 'utf-8', stdio: 'pipe' });
    } catch {
      continue;
    }

    const version = parseJavaVersion(String(result.stderr ?? result.stdout ?? ''));
    if (version !== null && version >= MIN_JAVA_VERSION) {
      return candidate;
    }
  }

  throw new Error(
    `No suitable Java runtime found. Morphe requires Java ${MIN_JAVA_VERSION} or newer. ` +
      'Install Java 21+ and set MORPHE_JAVA to the java executable, or ensure JAVA_HOME or PATH points to it.',
  );
}

export function assertSuccess(command: string, result: ReturnType<typeof spawnSync>): void {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${String(result.stderr).trimEnd()}` : '';
    throw new Error(`${command} exited with ${result.status}${stderr}`);
  }
}

export function runCommand(command: string, args: string[], cwd: string): void {
  console.log(`$ ${command} ${args.join(' ')}`);
  assertSuccess(command, spawnSync(command, args, { cwd, encoding: 'utf-8', stdio: 'inherit' }));
}
