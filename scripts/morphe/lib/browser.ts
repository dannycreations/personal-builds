import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch } from 'cloakbrowser';

type Browser = Awaited<ReturnType<typeof launch>>;

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2000;
const SELECTOR_WAIT_TIMEOUT_MS = 10000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CHALLENGE_MARKERS = ['cloudflare', 'attention required', 'verify you are human', 'just a moment'];

let browser: Browser | null = null;
const cookieJar = new Map<string, string>();

async function getBrowser(): Promise<Browser> {
  browser ??= await launch({ headless: true });
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

function buildRequestHeaders(): Record<string, string> {
  if (cookieJar.size === 0) return {};
  const cookieHeader = [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
  return { Cookie: cookieHeader };
}

function storeCookies(cookies: Record<string, string>): void {
  for (const [name, value] of Object.entries(cookies)) cookieJar.set(name, value);
}

function parseSetCookieHeaders(headers: readonly string[]): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const header of headers) {
    const [pair] = header.split(';', 1);
    const separator = pair.indexOf('=');
    if (separator === -1) continue;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name && value) cookies[name] = value;
  }

  return cookies;
}

function isChallengePage(html: string): boolean {
  const lower = html.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

async function fetchWithBrowser(url: string, waitSelector?: string): Promise<{ html: string; cookies: Record<string, string> } | null> {
  try {
    const instance = await getBrowser();
    const page = await instance.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (!response || response.status() !== 200) {
      await page.close();
      return null;
    }

    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: SELECTOR_WAIT_TIMEOUT_MS }).catch(() => {});
    }

    const html = await page.content();
    const cookies: Record<string, string> = {};
    for (const cookie of await page.context().cookies()) {
      if (cookie.domain.includes('apkmirror')) cookies[cookie.name] = cookie.value;
    }

    await page.close();
    return { html, cookies };
  } catch (error) {
    console.warn(`Browser fetch failed for ${url}: ${(error as Error).message}`);
    return null;
  }
}

async function fetchViaBrowserOrThrow(url: string, waitSelector: string | undefined, errorMessage: string): Promise<string> {
  const result = await fetchWithBrowser(url, waitSelector);
  if (!result) throw new Error(errorMessage);
  storeCookies(result.cookies);
  return result.html;
}

export async function fetchPage(url: string, waitSelector?: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: buildRequestHeaders() });
    storeCookies(parseSetCookieHeaders(res.headers.getSetCookie()));

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryDelay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`Rate limited (429) for ${url}, retrying in ${retryDelay}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      continue;
    }

    if (!res.ok) {
      return fetchViaBrowserOrThrow(url, waitSelector, `APKMirror page failed: ${res.status} for ${url}`);
    }

    const html = await res.text();
    if (isChallengePage(html)) {
      return fetchViaBrowserOrThrow(url, waitSelector, `APKMirror Cloudflare challenge at ${url}`);
    }
    return html;
  }

  throw new Error(`APKMirror page failed after ${MAX_RETRIES} retries for ${url}`);
}

export async function downloadFile(url: string, dest: string): Promise<string> {
  if (existsSync(dest)) return new URL(url).pathname;
  mkdirSync(dirname(dest), { recursive: true });

  const headers = buildRequestHeaders();
  let currentUrl = url;
  let res = await fetch(currentUrl, { headers, redirect: 'manual' });
  storeCookies(parseSetCookieHeaders(res.headers.getSetCookie()));

  while (REDIRECT_STATUSES.has(res.status)) {
    const location = res.headers.get('location');
    if (!location) break;
    currentUrl = new URL(location, currentUrl).toString();
    res = await fetch(currentUrl, { headers, redirect: 'manual' });
    storeCookies(parseSetCookieHeaders(res.headers.getSetCookie()));
  }

  if (!res.ok || !res.body) {
    throw new Error(`Download failed ${res.status} for ${url}`);
  }

  await Bun.write(dest, res);
  return currentUrl;
}
