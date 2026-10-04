import { spawnSync } from 'node:child_process';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertSuccess(command: string, result: ReturnType<typeof spawnSync>): void {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

export function runCommand(command: string, args: string[], cwd: string): void {
  console.log(`$ ${command} ${args.join(' ')}`);
  assertSuccess(command, spawnSync(command, args, { cwd, encoding: 'utf-8', stdio: 'inherit' }));
}
