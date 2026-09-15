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

export interface MorpheBuildOptions {
  readonly cliSource: string;
  readonly cliVersion: string;
  readonly patchesSource: string;
  readonly patchesVersion: string;
}

interface PatchInfo {
  readonly name: string;
  readonly enabled: boolean;
}

interface ReleaseAssetRequest {
  readonly source: string;
  readonly version: string;
  readonly assetPattern: RegExp;
  readonly dest: string;
  readonly label: string;
}

interface BuildContext {
  readonly appName: string;
  readonly appConfig: AppConfig;
  readonly packageName: string;
  readonly cliPath: string;
  readonly patchesPath: string;
  readonly workDir: string;
}

function assertSuccess(command: string, result: ReturnType<typeof spawnSync>): void {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function runCommand(command: string, args: string[], cwd: string): void {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8', stdio: 'inherit' });
  assertSuccess(command, result);
}

function captureCliOutput(ctx: BuildContext, subcommand: string): string {
  const args = ['-jar', ctx.cliPath, subcommand, '--patches', ctx.patchesPath, '-f', ctx.packageName];
  const result = spawnSync('java', args, { encoding: 'utf-8', stdio: 'pipe' });
  assertSuccess('java', result);
  return result.stdout ?? '';
}

function isUniversalArch(arch: string | undefined): boolean {
  return !arch || UNSPLIT_ARCHS.has(arch);
}

function parseList(value: string | undefined, separator: RegExp): readonly string[] {
  return value?.split(separator).filter(Boolean) ?? [];
}

async function fetchReleaseAsset({ source, version, assetPattern, dest, label }: ReleaseAssetRequest): Promise<void> {
  console.log(`${label} Fetching release...`);
  const release = await fetchGitRelease(source, version);
  const url = resolveGitAsset(release.assets, assetPattern);

  console.log(`${label} Downloading...`);
  await downloadFile(url, dest);
}

function listSupportedVersions(ctx: BuildContext): readonly string[] {
  const stdout = captureCliOutput(ctx, 'list-versions');

  const versions: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(SUPPORTED_VERSION_LINE_PATTERN);
    if (match) versions.push(match[1]);
  }
  return versions;
}

function listPatches(ctx: BuildContext): readonly PatchInfo[] {
  const stdout = captureCliOutput(ctx, 'list-patches');

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

function finalizeDownloadedApk(ctx: BuildContext, resolvedDownloadUrl: string, tempPath: string): string {
  const resolvedPath = new URL(resolvedDownloadUrl).pathname;
  const baseName = resolvedPath.split('/').filter(Boolean).pop() ?? ctx.appName;
  const extension = KNOWN_APK_EXTENSIONS.find((ext) => resolvedPath.toLowerCase().endsWith(ext)) ?? 'apk';
  const baseWithoutExt = baseName.replace(/\.[^.]+$/, '');

  let apkPath = join(ctx.workDir, `${baseWithoutExt}.${extension}`);
  if (apkPath !== tempPath) renameSync(tempPath, apkPath);

  if (extension === 'apk' && isApkBundle(apkPath)) {
    const bundlePath = apkPath.slice(0, -4) + '.apkm';
    renameSync(apkPath, bundlePath);
    apkPath = bundlePath;
  }

  return apkPath;
}

async function downloadApk(ctx: BuildContext, targetVersion: string): Promise<{ apkPath: string; version: string }> {
  const { appName, packageName, appConfig, workDir } = ctx;

  console.log(`[${appName}] Resolving APK from APKMirror...`);
  const { url, version } = await resolveApkmirrorApk(packageName, appConfig, targetVersion);

  console.log(`[${appName}] Downloading APK...`);
  const tempPath = join(workDir, `${appName}-apk.tmp`);
  const resolvedDownloadUrl = await downloadFile(url, tempPath);

  return { apkPath: finalizeDownloadedApk(ctx, resolvedDownloadUrl, tempPath), version };
}

function resolveEnabledPatchNames(ctx: BuildContext, included: readonly string[], excluded: readonly string[]): readonly string[] {
  let enabled = included;

  if (enabled.length === 0) {
    enabled = listPatches(ctx)
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

function buildPatchArgs(ctx: BuildContext, apkPath: string, outputPath: string): string[] {
  const { appConfig, cliPath, patchesPath, workDir } = ctx;
  const args = ['-jar', cliPath, 'patch', '--patches', patchesPath, '--out', outputPath];

  if (!isUniversalArch(appConfig.arch)) {
    args.push(`--striplibs=${appConfig.arch}`);
  }

  const included = parseList(appConfig['included-patches'], /[, ]+/);
  const excluded = parseList(appConfig['excluded-patches'], /[, ]+/);
  const enabled = resolveEnabledPatchNames(ctx, included, excluded);

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

export async function buildApp(appName: string, appConfig: AppConfig, options: MorpheBuildOptions): Promise<void> {
  const workDir = join(TEMP_DIR, appName);
  if (existsSync(workDir)) rmSync(workDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  console.log(`\n[${appName}] Starting build...`);

  const cliPath = join(TEMP_DIR, 'morphe.jar');
  await fetchReleaseAsset({
    source: options.cliSource,
    version: options.cliVersion,
    assetPattern: /^morphe-desktop-.*-all\.jar$/i,
    dest: cliPath,
    label: `[${appName}] CLI:`,
  });

  const patchesPath = join(workDir, 'patches.mpp');
  await fetchReleaseAsset({
    source: options.patchesSource,
    version: options.patchesVersion,
    assetPattern: /^patches-.*\.mpp$/i,
    dest: patchesPath,
    label: `[${appName}] Patches:`,
  });

  const ctx: BuildContext = {
    appName,
    appConfig,
    packageName: appConfig['package-name'],
    cliPath,
    patchesPath,
    workDir,
  };

  console.log(`[${appName}] Listing supported versions...`);
  const targetVersion = appConfig.version ?? listSupportedVersions(ctx)[0];
  if (!targetVersion) {
    throw new Error(`No supported versions found for ${appName}`);
  }
  console.log(`[${appName}] Target version: ${targetVersion}`);

  const { apkPath, version } = await downloadApk(ctx, targetVersion);

  const outputPath = join(workDir, `${appName}-patched.apk`);
  const patchArgs = buildPatchArgs(ctx, apkPath, outputPath);

  console.log(`[${appName}] Patching...`);
  runCommand('java', patchArgs, workDir);

  const archTag = isUniversalArch(appConfig.arch) ? 'universal' : appConfig.arch;
  const outputDir = join(process.cwd(), 'dist');
  mkdirSync(outputDir, { recursive: true });
  const finalPath = join(outputDir, `${appName}-v${version}-${archTag}.apk`);
  cpSync(outputPath, finalPath);
  console.log(`[${appName}] Build complete: ${finalPath}`);
}
