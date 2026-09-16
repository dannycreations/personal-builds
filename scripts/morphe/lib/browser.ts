import { existsSync, mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { launch } from 'cloakbrowser';

import { sleep } from './utils';

type Browser = Awaited<ReturnType<typeof launch>>;

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2000;
const SELECTOR_WAIT_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 600000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CHALLENGE_MARKERS = ['cloudflare', 'attention required', 'verify you are human', 'just a moment'];

let browser: Browser | null = null;

const cookieJars = new Map<string, Map<string, string>>();

async function getBrowser(): Promise<Browser> {
  browser ??= await launch({ headless: true });
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

function hostnameOf(url: string): string {
  return new URL(url).hostname;
}

function getCookieJar(hostname: string): Map<string, string> {
  let jar = cookieJars.get(hostname);
  if (!jar) {
    jar = new Map();
    cookieJars.set(hostname, jar);
  }
  return jar;
}

function buildRequestHeaders(hostname: string): Record<string, string> {
  const jar = cookieJars.get(hostname);
  if (!jar || jar.size === 0) return {};
  return { Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') };
}

function storeCookies(hostname: string, cookies: Record<string, string>): void {
  const jar = getCookieJar(hostname);
  for (const [name, value] of Object.entries(cookies)) jar.set(name, value);
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
    const cookies = Object.fromEntries((await page.context().cookies()).map((cookie) => [cookie.name, cookie.value]));

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
  storeCookies(hostnameOf(url), result.cookies);
  return result.html;
}

export async function fetchPage(url: string, waitSelector?: string): Promise<string> {
  const hostname = hostnameOf(url);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: buildRequestHeaders(hostname) });
    storeCookies(hostname, parseSetCookieHeaders(res.headers.getSetCookie()));

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryDelay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`Rate limited (429) for ${url}, retrying in ${retryDelay}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(retryDelay);
      continue;
    }

    if (!res.ok) {
      return fetchViaBrowserOrThrow(url, waitSelector, `Page failed: ${res.status} for ${url}`);
    }

    const html = await res.text();
    if (isChallengePage(html)) {
      return fetchViaBrowserOrThrow(url, waitSelector, `Cloudflare challenge at ${url}`);
    }
    return html;
  }

  throw new Error(`Page failed after ${MAX_RETRIES} retries for ${url}`);
}

export async function downloadFile(url: string, dest: string): Promise<string> {
  if (existsSync(dest)) return new URL(url).pathname;
  mkdirSync(dirname(dest), { recursive: true });

  let currentUrl = url;
  let hostname = hostnameOf(currentUrl);
  let res = await fetch(currentUrl, { headers: buildRequestHeaders(hostname), redirect: 'manual' });
  storeCookies(hostname, parseSetCookieHeaders(res.headers.getSetCookie()));

  while (REDIRECT_STATUSES.has(res.status)) {
    const location = res.headers.get('location');
    if (!location) break;

    currentUrl = new URL(location, currentUrl).toString();
    hostname = hostnameOf(currentUrl);
    res = await fetch(currentUrl, { headers: buildRequestHeaders(hostname), redirect: 'manual' });
    storeCookies(hostname, parseSetCookieHeaders(res.headers.getSetCookie()));
  }

  if (!res.ok || !res.body) {
    throw new Error(`Download failed ${res.status} for ${url}`);
  }

  const contentLength = Number(res.headers.get('content-length')) || 0;
  const file = await open(dest, 'w');

  let downloaded = 0;
  const startTime = Date.now();
  let lastProgressTime = startTime;
  let lastProgressBytes = 0;

  const reader = res.body.getReader();
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms for ${url}`)), DOWNLOAD_TIMEOUT_MS).unref();
  });

  while (true) {
    const { done, value } = await Promise.race([reader.read(), timeoutPromise]);

    if (done) break;

    downloaded += value.length;
    await file.write(value);

    const now = Date.now();
    if (now - lastProgressTime >= 2000) {
      const elapsedMs = now - lastProgressTime;
      const bytesSinceLast = downloaded - lastProgressBytes;
      const speedBps = bytesSinceLast / (elapsedMs / 1000);
      const mb = downloaded / 1024 / 1024;
      const speedMbps = speedBps / 1024 / 1024;
      const totalMb = contentLength / 1024 / 1024;
      const percent = contentLength ? ((downloaded / contentLength) * 100).toFixed(1) : '???.?';

      console.log(`Downloading ${basename(dest)}: ${mb.toFixed(1)} MB / ${totalMb.toFixed(1)} MB (${percent}%) at ${speedMbps.toFixed(1)} MB/s`);
      lastProgressTime = now;
      lastProgressBytes = downloaded;
    }
  }

  await file.close();
  console.log(`Download complete: ${downloaded} bytes to ${dest}`);
  return currentUrl;
}
