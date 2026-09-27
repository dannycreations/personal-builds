import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { launch } from 'cloakbrowser';

import { sleep } from './utils';

type Browser = Awaited<ReturnType<typeof launch>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2000;
const SELECTOR_WAIT_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 600000;
const PROGRESS_LOG_INTERVAL_MS = 2000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const CHALLENGE_PATTERN = /cloudflare|attention required|verify you are human|just a moment/i;
const CHALLENGE_POLL_INTERVAL_MS = 2000;
const CHALLENGE_MAX_ATTEMPTS = 15;
const TURNSTILE_FRAME_PATTERN = /challenges\.cloudflare\.com/;
const TURNSTILE_CLICK_SELECTORS = ['input[type=checkbox]', '#challenge-stage', 'label', 'body'];
const TURNSTILE_MIN_ELEMENT_WIDTH = 5;
const TURNSTILE_CLICK_TIMEOUT_MS = 5000;

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

function isChallengeResponse(res: Response): boolean {
  return res.status === 403 && res.headers.get('cf-mitigated') === 'challenge';
}

async function clickTurnstileCheckbox(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    if (!TURNSTILE_FRAME_PATTERN.test(frame.url())) continue;

    for (const selector of TURNSTILE_CLICK_SELECTORS) {
      const element = await frame.$(selector).catch(() => null);
      if (!element) continue;

      const box = await element.boundingBox().catch(() => null);
      if (!box || box.width < TURNSTILE_MIN_ELEMENT_WIDTH) continue;

      await element.click({ force: true, timeout: TURNSTILE_CLICK_TIMEOUT_MS }).catch(() => undefined);
      return;
    }
  }
}

async function clearCloudflareChallenge(page: Page): Promise<void> {
  // The interstitial is an interactive Turnstile checkbox that a plain fetch and a passive
  // browser both stall on, so poll the page and click it until Cloudflare issues clearance.
  for (let attempt = 0; attempt < CHALLENGE_MAX_ATTEMPTS; attempt++) {
    await sleep(CHALLENGE_POLL_INTERVAL_MS);

    const title = await page.title().catch(() => '');
    if (!CHALLENGE_PATTERN.test(title)) return;

    await clickTurnstileCheckbox(page);
  }
}

async function trackedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const hostname = hostnameOf(url);
  const headers = { ...buildRequestHeaders(hostname), ...(init.headers as Record<string, string> | undefined) };
  const res = await fetch(url, { ...init, headers });
  storeCookies(hostname, parseSetCookieHeaders(res.headers.getSetCookie()));
  return res;
}

async function fetchWithBrowser(
  url: string,
  waitSelector?: string,
  referer?: string,
): Promise<{ html: string; cookies: Record<string, string> } | null> {
  try {
    const instance = await getBrowser();
    const page = await instance.newPage();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      ...(referer ? { referer } : {}),
    });

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

async function fetchViaBrowserOrThrow(
  url: string,
  waitSelector: string | undefined,
  referer: string | undefined,
  errorMessage: string,
): Promise<string> {
  const result = await fetchWithBrowser(url, waitSelector, referer);
  if (!result) throw new Error(errorMessage);
  storeCookies(hostnameOf(url), result.cookies);
  return result.html;
}

export async function fetchPage(url: string, waitSelector?: string, referer?: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await trackedFetch(url, referer ? { headers: { Referer: referer } } : {});

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryDelay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`Rate limited (429) for ${url}, retrying in ${retryDelay}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(retryDelay);
      continue;
    }

    if (!res.ok) {
      return fetchViaBrowserOrThrow(url, waitSelector, referer, `Page failed: ${res.status} for ${url}`);
    }

    const html = await res.text();
    if (CHALLENGE_PATTERN.test(html)) {
      return fetchViaBrowserOrThrow(url, waitSelector, referer, `Cloudflare challenge at ${url}`);
    }
    return html;
  }

  throw new Error(`Page failed after ${MAX_RETRIES} retries for ${url}`);
}

async function downloadViaBrowser(url: string, dest: string): Promise<string> {
  const instance = await getBrowser();
  const context = await instance.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    const pending = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS });
    // A challenge page answers the navigation, so a rejection here is expected, not fatal.
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await clearCloudflareChallenge(page);

    const download = await pending;
    await download.saveAs(dest);
    return download.url();
  } finally {
    await context.close().catch(() => undefined);
  }
}

function createProgressLogger(dest: string, totalBytes: number): Transform {
  let downloaded = 0;
  let lastLogTime = Date.now();
  let lastLogBytes = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length;

      const now = Date.now();
      if (now - lastLogTime >= PROGRESS_LOG_INTERVAL_MS) {
        const speedMbps = (downloaded - lastLogBytes) / ((now - lastLogTime) / 1000) / 1024 / 1024;
        const percent = totalBytes ? ((downloaded / totalBytes) * 100).toFixed(1) : '???.?';
        const mb = downloaded / 1024 / 1024;
        const totalMb = totalBytes / 1024 / 1024;

        console.log(`Downloading ${basename(dest)}: ${mb.toFixed(1)} MB / ${totalMb.toFixed(1)} MB (${percent}%) at ${speedMbps.toFixed(1)} MB/s`);
        lastLogTime = now;
        lastLogBytes = downloaded;
      }

      callback(null, chunk);
    },
    flush(callback) {
      console.log(`Download complete: ${downloaded} bytes to ${dest}`);
      callback();
    },
  });
}

export async function downloadFile(url: string, dest: string): Promise<string> {
  if (existsSync(dest)) return new URL(url).pathname;
  mkdirSync(dirname(dest), { recursive: true });

  let currentUrl = url;
  let res = await trackedFetch(currentUrl, { redirect: 'manual' });

  while (REDIRECT_STATUSES.has(res.status)) {
    const location = res.headers.get('location');
    if (!location) break;

    currentUrl = new URL(location, currentUrl).toString();
    res = await trackedFetch(currentUrl, { redirect: 'manual' });
  }

  if (isChallengeResponse(res)) {
    console.warn(`Cloudflare challenge on ${url}, downloading through the browser`);
    return downloadViaBrowser(url, dest);
  }

  if (!res.ok || !res.body) {
    throw new Error(`Download failed ${res.status} for ${url}`);
  }

  const contentLength = Number(res.headers.get('content-length')) || 0;
  const timeout = setTimeout(() => {
    throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms for ${url}`);
  }, DOWNLOAD_TIMEOUT_MS).unref();
  const controller = new AbortController();
  clearTimeout(timeout);
  const timer = setTimeout(
    () => controller.abort(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms for ${url}`)),
    DOWNLOAD_TIMEOUT_MS,
  ).unref();

  try {
    await pipeline(Readable.fromWeb(res.body), createProgressLogger(dest, contentLength), createWriteStream(dest), {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  return currentUrl;
}
