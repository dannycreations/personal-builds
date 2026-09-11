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

async function fetchGithubRelease(path: string, version: string): Promise<Release> {
  const baseUrl = `https://api.github.com/repos/${path}/releases`;
  const url = version === 'dev' ? `${baseUrl}/latest` : `${baseUrl}/tags/${version}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const data = await fetchApiJson<GithubReleaseResponse>('GitHub', url, headers);
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
  const url = version === 'dev' ? `${baseUrl}/releases` : `${baseUrl}/releases/${version}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = process.env['GITLAB_TOKEN'];
  if (token) headers['PRIVATE-TOKEN'] = token;

  if (version === 'dev') {
    const releases = await fetchApiJson<GitlabReleaseResponse[]>('GitLab', url, headers);
    const [latest] = releases;
    if (!latest) throw new Error(`No releases found for ${path}`);
    return toRelease(latest);
  }

  return toRelease(await fetchApiJson<GitlabReleaseResponse>('GitLab', url, headers));
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
