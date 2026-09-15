import 'dotenv/config';

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { isApkBundle } from './apk';
import { resolveApkmirrorApk } from './apkmirror';
import { downloadFile } from './browser';
import { SUPPORTED_VERSION_LINE_PATTERN } from './constants';
import { fetchGitRelease, resolveGitAsset } from './git';

import type { AppTarget } from './apkmirror';

function assertSuccess(command: string, result: ReturnType<typeof spawnSync>): void {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function runCommand(command: string, args: string[], cwd: string): void {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8', stdio: 'inherit' });
  assertSuccess(command, result);
}

function captureCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf-8', stdio: 'pipe' });
  assertSuccess(command, result);
  return result.stdout ?? '';
}

const TEMP_DIR = join(process.cwd(), '.temp');
const UNSPLIT_ARCHS = new Set(['all', 'both']);
const KNOWN_APK_EXTENSIONS = ['apkm', 'xapk', 'apks'] as const;

export interface AppConfig extends AppTarget {
  readonly 'package-name': string;
  readonly 'patcher-args'?: string;
  readonly 'included-patches'?: string;
  readonly 'excluded-patches'?: string;
  readonly 'patches-options'?: Readonly<Record<string, string>>;
}

function listSupportedVersions(cliPath: string, patchesPath: string, packageName: string): readonly string[] {
  const stdout = captureCommand('java', ['-jar', cliPath, 'list-versions', '--patches', patchesPath, '-f', packageName]);

  const versions: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(SUPPORTED_VERSION_LINE_PATTERN);
    if (match) versions.push(match[1]);
  }
  return versions;
}

function isUniversalArch(arch: string | undefined): boolean {
  return !arch || UNSPLIT_ARCHS.has(arch);
}

function parseList(value: string | undefined, separator: RegExp): readonly string[] {
  return value?.split(separator).filter(Boolean) ?? [];
}

async function fetchReleaseAsset(source: string, version: string, assetPattern: RegExp, dest: string, label: string): Promise<void> {
  console.log(`${label} Fetching release...`);
  const release = await fetchGitRelease(source, version);
  const url = resolveGitAsset(release.assets, assetPattern);

  console.log(`${label} Downloading...`);
  await downloadFile(url, dest);
}

function finalizeDownloadedApk(resolvedDownloadUrl: string, tempPath: string, workDir: string, appName: string): string {
  const resolvedPath = new URL(resolvedDownloadUrl).pathname;
  const baseName = resolvedPath.split('/').filter(Boolean).pop() ?? appName;
  const extension = KNOWN_APK_EXTENSIONS.find((ext) => resolvedPath.toLowerCase().endsWith(ext)) ?? 'apk';
  const baseWithoutExt = baseName.replace(/\.[^.]+$/, '');

  let apkPath = join(workDir, `${baseWithoutExt}.${extension}`);
  if (apkPath !== tempPath) renameSync(tempPath, apkPath);

  if (extension === 'apk' && isApkBundle(apkPath)) {
    const bundlePath = apkPath.slice(0, -4) + '.apkm';
    renameSync(apkPath, bundlePath);
    apkPath = bundlePath;
  }

  return apkPath;
}

async function downloadApk(
  appName: string,
  packageName: string,
  appTarget: AppTarget,
  targetVersion: string,
  workDir: string,
): Promise<{ apkPath: string; version: string }> {
  console.log(`[${appName}] Resolving APK from APKMirror...`);
  const { url, version } = await resolveApkmirrorApk(packageName, appTarget, targetVersion);

  console.log(`[${appName}] Downloading APK...`);
  const tempPath = join(workDir, `${appName}-apk.tmp`);
  const resolvedDownloadUrl = await downloadFile(url, tempPath);

  return { apkPath: finalizeDownloadedApk(resolvedDownloadUrl, tempPath, workDir, appName), version };
}

interface PatchInfo {
  readonly name: string;
  readonly enabled: boolean;
}

function listPatches(cliPath: string, patchesPath: string, packageName: string): readonly PatchInfo[] {
  const stdout = captureCommand('java', ['-jar', cliPath, 'list-patches', '--patches', patchesPath, '-f', packageName]);

  const patches: PatchInfo[] = [];
  for (const block of stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.trim());
    const nameLine = lines.find((line) => line.startsWith('Name:'));
    const enabledLine = lines.find((line) => line.startsWith('Enabled:'));

    const name = nameLine?.slice('Name:'.length).trim();
    const enabled = enabledLine?.slice('Enabled:'.length).trim() === 'true';

    if (name) patches.push({ name, enabled });
  }
  return patches;
}

function resolveEnabledPatchNames(
  cliPath: string,
  patchesPath: string,
  packageName: string,
  included: readonly string[],
  excluded: readonly string[],
): readonly string[] {
  let enabled = included;

  if (enabled.length === 0) {
    enabled = listPatches(cliPath, patchesPath, packageName)
      .filter((patch) => patch.enabled)
      .map((patch) => patch.name);
    if (enabled.length === 0) {
      throw new Error('No patches found. Specify "included-patches" or "excluded-patches" in the app config.');
    }
  }

  enabled = enabled.filter((name) => !excluded.includes(name));
  if (enabled.length === 0) {
    throw new Error('No patches enabled. Check your "included-patches" and "excluded-patches" configuration.');
  }

  return enabled;
}

function buildPatchArgs(
  appConfig: AppConfig,
  cliPath: string,
  patchesPath: string,
  packageName: string,
  apkPath: string,
  outputPath: string,
  workDir: string,
): string[] {
  const args = ['-jar', cliPath, 'patch', '--patches', patchesPath, '--out', outputPath];

  if (!isUniversalArch(appConfig.arch)) {
    args.push(`--striplibs=${appConfig.arch}`);
  }

  const included = parseList(appConfig['included-patches'], /[, ]+/);
  const excluded = parseList(appConfig['excluded-patches'], /[, ]+/);
  const enabled = resolveEnabledPatchNames(cliPath, patchesPath, packageName, included, excluded);

  const patchOptions = appConfig['patches-options'] ?? {};
  const patchesWithOptions = new Set(Object.keys(patchOptions));

  for (const name of enabled) {
    if (!patchesWithOptions.has(name)) args.push('-e', name);
  }
  for (const name of excluded) args.push('-d', name);

  for (const [patchName, patchOption] of Object.entries(patchOptions)) {
    if (!excluded.includes(patchName)) args.push('-e', patchName, '-O', patchOption);
  }

  args.push(...parseList(appConfig['patcher-args'], /\s+/), '-t', workDir, '--unsigned', apkPath);

  return args;
}

export async function buildApp(
  appName: string,
  appConfig: AppConfig,
  cliSource: string,
  cliVersion: string,
  patchesSource: string,
  patchesVersion: string,
): Promise<void> {
  const workDir = join(TEMP_DIR, appName);
  if (existsSync(workDir)) rmSync(workDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  console.log(`\n[${appName}] Starting build...`);

  const cliPath = join(TEMP_DIR, 'morphe.jar');
  await fetchReleaseAsset(cliSource, cliVersion, /^morphe-desktop-.*-all\.jar$/i, cliPath, `[${appName}] CLI:`);

  const patchesPath = join(workDir, 'patches.mpp');
  await fetchReleaseAsset(patchesSource, patchesVersion, /^patches-.*\.mpp$/i, patchesPath, `[${appName}] Patches:`);

  console.log(`[${appName}] Listing supported versions...`);
  const supportedVersions = listSupportedVersions(cliPath, patchesPath, appConfig['package-name']);
  const targetVersion = appConfig.version ?? supportedVersions[0];
  if (!targetVersion) {
    throw new Error(`No supported versions found for ${appName}`);
  }
  console.log(`[${appName}] Target version: ${targetVersion}`);

  const { apkPath, version } = await downloadApk(appName, appConfig['package-name'], appConfig, targetVersion, workDir);

  const outputPath = join(workDir, `${appName}-patched.apk`);
  const patchArgs = buildPatchArgs(appConfig, cliPath, patchesPath, appConfig['package-name'], apkPath, outputPath, workDir);

  console.log(`[${appName}] Patching...`);
  runCommand('java', patchArgs, workDir);

  const archTag = isUniversalArch(appConfig.arch) ? 'universal' : appConfig.arch;
  const outputDir = join(process.cwd(), 'dist');
  mkdirSync(outputDir, { recursive: true });
  const finalPath = join(outputDir, `${appName}-v${version}-${archTag}.apk`);
  cpSync(outputPath, finalPath);
  console.log(`[${appName}] Build complete: ${finalPath}`);
}
