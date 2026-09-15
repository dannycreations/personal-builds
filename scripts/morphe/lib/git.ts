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

export function pickHighestSemver(tags: readonly string[]): string {
  if (tags.length === 0) throw new Error('No tags provided');
  const [first] = tags;
  if (!isValidSemverCore(first)) return first;
  return [...tags].sort(sortBySemverDesc)[0];
}

async function fetchGithubRelease(path: string, version: string): Promise<Release> {
  const baseUrl = `https://api.github.com/repos/${path}/releases`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) headers['Authorization'] = `Bearer ${token}`;

  if (version === 'dev') {
    const releases = await fetchApiJson<GithubReleaseResponse[]>('GitHub', baseUrl, headers);
    if (releases.length === 0) throw new Error(`No releases found for ${path}`);
    const tagNames = releases.map((r) => r.tag_name);
    const highestTag = pickHighestSemver(tagNames);
    const release = releases.find((r) => r.tag_name === highestTag);
    if (!release) throw new Error(`Release ${highestTag} not found for ${path}`);
    return {
      tag_name: release.tag_name,
      assets: release.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
    };
  }

  if (version === 'latest') {
    const data = await fetchApiJson<GithubReleaseResponse>('GitHub', `${baseUrl}/latest`, headers);
    return {
      tag_name: data.tag_name,
      assets: data.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
    };
  }

  const data = await fetchApiJson<GithubReleaseResponse>('GitHub', `${baseUrl}/tags/${version}`, headers);
  return {
    tag_name: data.tag_name,
    assets: data.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
  };
}

function toRelease(data: GitlabReleaseResponse): Release {
  return {
    tag_name: data.tag_name,
    assets: (data.assets?.links ?? []).map((link) => ({ name: link.name, url: link.url })),
  };
}

async function fetchGitlabRelease(path: string, version: string): Promise<Release> {
  const baseUrl = `https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = process.env['GITLAB_TOKEN'];
  if (token) headers['PRIVATE-TOKEN'] = token;

  if (version === 'dev') {
    const releases = await fetchApiJson<GitlabReleaseResponse[]>('GitLab', `${baseUrl}/releases`, headers);
    if (releases.length === 0) throw new Error(`No releases found for ${path}`);
    const tagNames = releases.map((r) => r.tag_name);
    const highestTag = pickHighestSemver(tagNames);
    const release = releases.find((r) => r.tag_name === highestTag);
    if (!release) throw new Error(`Release ${highestTag} not found for ${path}`);
    return toRelease(release);
  }

  if (version === 'latest') {
    const releases = await fetchApiJson<GitlabReleaseResponse[]>('GitLab', `${baseUrl}/releases`, headers);
    if (releases.length === 0) throw new Error(`No releases found for ${path}`);
    return toRelease(releases[0]);
  }

  const data = await fetchApiJson<GitlabReleaseResponse>('GitLab', `${baseUrl}/releases/${version}`, headers);
  return toRelease(data);
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
