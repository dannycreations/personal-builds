interface Release {
  readonly tag_name: string;
  readonly assets: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
}

interface GithubReleaseResponse {
  readonly tag_name: string;
  readonly assets: ReadonlyArray<{
    readonly name: string;
    readonly browser_download_url: string;
  }>;
}

interface GitlabReleaseLink {
  readonly name: string;
  readonly url: string;
}

interface GitlabReleaseResponse {
  readonly tag_name: string;
  readonly assets?: {
    readonly links?: ReadonlyArray<GitlabReleaseLink>;
  };
}

function parseRepo(repo: string): { provider: 'github' | 'gitlab'; path: string } {
  const match = repo.match(/^(github|gitlab):(.+)$/);
  return match ? { provider: match[1] as 'github' | 'gitlab', path: match[2] } : { provider: 'github', path: repo };
}

async function fetchApiJson<T>(provider: string, url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`${provider} API ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
}

function buildAuthHeaders(token: string | undefined, toHeader: (token: string) => Record<string, string>): Record<string, string> {
  return { Accept: 'application/json', ...(token ? toHeader(token) : {}) };
}

export function isValidSemverCore(tag: string): boolean {
  const core = tag.replace(/^v/, '').split('-')[0];
  return /^[0-9]+(\.[0-9]+)*$/.test(core);
}

export function sortBySemverDesc(a: string, b: string): number {
  const normalize = (s: string) => s.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const aParts = normalize(a);
  const bParts = normalize(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const aNum = aParts[i] ?? 0;
    const bNum = bParts[i] ?? 0;
    if (aNum !== bNum) return bNum - aNum;
  }
  return 0;
}

function pickHighestSemver<T extends { readonly tag_name: string }>(releases: readonly T[], path: string): T {
  if (releases.length === 0) {
    throw new Error(`No releases found for ${path}`);
  }

  const [first] = releases;
  if (!isValidSemverCore(first.tag_name)) {
    return first;
  }
  return [...releases].sort((a, b) => sortBySemverDesc(a.tag_name, b.tag_name))[0];
}

function toGithubRelease(data: GithubReleaseResponse): Release {
  return {
    tag_name: data.tag_name,
    assets: data.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
  };
}

function toGitlabRelease(data: GitlabReleaseResponse): Release {
  return {
    tag_name: data.tag_name,
    assets: (data.assets?.links ?? []).map((link) => ({ name: link.name, url: link.url })),
  };
}

async function fetchGithubRelease(path: string, version: string): Promise<Release> {
  const baseUrl = `https://api.github.com/repos/${path}/releases`;
  const headers = buildAuthHeaders(process.env['GITHUB_TOKEN'], (token) => ({ Authorization: `Bearer ${token}` }));

  if (version === 'dev') {
    const releases = await fetchApiJson<GithubReleaseResponse[]>('GitHub', baseUrl, headers);
    return toGithubRelease(pickHighestSemver(releases, path));
  }

  const url = version === 'latest' ? `${baseUrl}/latest` : `${baseUrl}/tags/${version}`;
  return toGithubRelease(await fetchApiJson<GithubReleaseResponse>('GitHub', url, headers));
}

async function fetchGitlabRelease(path: string, version: string): Promise<Release> {
  const baseUrl = `https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}`;
  const headers = buildAuthHeaders(process.env['GITLAB_TOKEN'], (token) => ({ 'PRIVATE-TOKEN': token }));

  if (version === 'dev' || version === 'latest') {
    const releases = await fetchApiJson<GitlabReleaseResponse[]>('GitLab', `${baseUrl}/releases`, headers);
    if (releases.length === 0) throw new Error(`No releases found for ${path}`);
    return toGitlabRelease(version === 'dev' ? pickHighestSemver(releases, path) : releases[0]);
  }

  return toGitlabRelease(await fetchApiJson<GitlabReleaseResponse>('GitLab', `${baseUrl}/releases/${version}`, headers));
}

export async function fetchGitRelease(repo: string, version: string): Promise<Release> {
  const { provider, path } = parseRepo(repo);
  return provider === 'gitlab' ? fetchGitlabRelease(path, version) : fetchGithubRelease(path, version);
}

export function resolveGitAsset(assets: Release['assets'], pattern: RegExp): string {
  const asset = assets.find((a) => pattern.test(a.name));
  if (!asset) {
    throw new Error(`No asset matched pattern in release. Available: ${assets.map((a) => a.name).join(', ')}`);
  }
  return asset.url;
}
