import { load } from 'cheerio';

import { fetchPage } from './browser';
import { VERSION_PATTERN } from './constants';
import { sleep } from './utils';

import type { CheerioAPI } from 'cheerio';

const BASE_URL = 'https://www.apkmirror.com';
const RELEASE_PAGE_FETCH_DELAY_MS = 1000;

const EXCLUDED_TITLE_KEYWORDS = ['wear os', 'daydream', 'automotive', 'android tv', 'beta', 'alpha'];
const UNIVERSAL_ARCH_ALIASES = new Set(['universal', 'noarch']);
const UNIVERSAL_ARCH_MARKERS = ['universal', 'noarch', 'arm64-v8a', 'armeabi-v7a'];
const ANY_DPI_VALUES = new Set(['nodpi', '120-640dpi', 'all', '']);

export interface AppTarget {
  readonly version?: string;
  readonly arch?: string;
  readonly type?: string;
  readonly dpi?: string;
}

interface ApkMirrorSearchResult {
  readonly href: string;
  readonly title: string;
  readonly version: string;
}

function toAbsoluteUrl(href: string): string {
  return href.startsWith('http') ? href : `${BASE_URL}${href}`;
}

function isDisqusLink(href: string): boolean {
  return href.endsWith('#disqus_thread');
}

async function fetchAndLoad(label: string, url: string, waitSelector?: string): Promise<CheerioAPI> {
  console.log(`${label}: ${url}`);
  const html = await fetchPage(url, waitSelector);
  return load(html);
}

function matchesCriteria(rowText: string, target: AppTarget): boolean {
  const text = rowText.toLowerCase();

  const type = (target.type ?? '').toLowerCase();
  if (type && !text.includes(type)) return false;

  const arch = (target.arch ?? 'universal').toLowerCase();
  if (UNIVERSAL_ARCH_ALIASES.has(arch)) {
    if (!UNIVERSAL_ARCH_MARKERS.some((marker) => text.includes(marker))) return false;
  } else if (!text.includes(arch) && !text.includes('universal')) {
    return false;
  }

  const dpi = (target.dpi ?? 'nodpi').toLowerCase();
  if (!ANY_DPI_VALUES.has(dpi) && !text.includes(dpi)) return false;

  return true;
}

function isDownloadHref(href: string): boolean {
  if (!href || isDisqusLink(href)) return false;
  return href.includes('-android-apk-download') || href.replace(/\/$/, '').endsWith('-download');
}

async function searchApkmirror(packageName: string, version?: string): Promise<ApkMirrorSearchResult | null> {
  const searchTerm = version ? `${packageName} ${version}` : packageName;
  const searchUrl = `${BASE_URL}/?post_type=app_release&searchtype=apk&sortby=date&sort=desc&s=${encodeURIComponent(searchTerm)}`;

  const $ = await fetchAndLoad('Searching APKMirror', searchUrl, '.appRow');

  const results: ApkMirrorSearchResult[] = [];
  $('.appRow').each((_, el) => {
    const $row = $(el);
    const titleEl = $row.find('h5.appRowTitle');
    const title = titleEl.attr('title')?.trim() || titleEl.text().trim();
    const link = titleEl.find('a').attr('href') || '';
    if (!title || !link) return;

    const versionMatch = title.match(VERSION_PATTERN);
    if (!versionMatch) return;

    const lowerTitle = title.toLowerCase();
    if (EXCLUDED_TITLE_KEYWORDS.some((keyword) => lowerTitle.includes(keyword))) return;

    results.push({ href: toAbsoluteUrl(link), title, version: versionMatch[1] });
  });

  if (results.length === 0) return null;

  if (version) {
    const exactMatch = results.find((r) => r.version === version);
    if (exactMatch) {
      console.log(`Found exact version match: ${exactMatch.title}`);
      return exactMatch;
    }
    console.warn(`Exact version ${version} not found, using most recent result`);
  }

  console.log(`Using most recent result: ${results[0].title}`);
  return results[0];
}

async function findVariantDownloadPage(releaseUrl: string, appTarget: AppTarget): Promise<string> {
  await sleep(RELEASE_PAGE_FETCH_DELAY_MS);
  const $ = await fetchAndLoad('Fetching release page', releaseUrl);

  for (const row of $('.table-row').toArray()) {
    const $row = $(row);
    const rowText = $row.text();
    const lowerRowText = rowText.toLowerCase();
    const isHeaderRow = lowerRowText.includes('variant') && lowerRowText.includes('arch');
    const hasVersionNumber = /\d+(\.\d+)+/.test(rowText);

    if (isHeaderRow || !hasVersionNumber || !matchesCriteria(rowText, appTarget)) continue;

    const directHref = $row
      .find('a[href]')
      .toArray()
      .map((a) => a.attribs['href'] ?? '')
      .find(isDownloadHref);
    if (directHref) return toAbsoluteUrl(directHref);

    const accentHref = $row.find('a.accent_color').attr('href');
    if (accentHref && !isDisqusLink(accentHref)) return toAbsoluteUrl(accentHref);
  }

  throw new Error(`No matching variant found for ${releaseUrl} with criteria: ${JSON.stringify(appTarget)}`);
}

async function followDownloadButton(variantPageUrl: string): Promise<string> {
  const $ = await fetchAndLoad('Fetching download page', variantPageUrl);
  const href = $('a.downloadButton').attr('href');
  if (!href) throw new Error(`Download button not found on ${variantPageUrl}`);
  return toAbsoluteUrl(href);
}

async function resolveFinalDownloadUrl(confirmationPageUrl: string): Promise<string> {
  const $ = await fetchAndLoad('Fetching final download page', confirmationPageUrl);
  const href = $('a#download-link').attr('href');
  if (!href) throw new Error(`Download link not found on ${confirmationPageUrl}`);

  const finalUrl = toAbsoluteUrl(href);
  console.log(`Resolved download URL: ${finalUrl}`);
  return finalUrl;
}

export async function resolveApkmirrorApk(packageName: string, appTarget: AppTarget, version?: string): Promise<{ url: string; version: string }> {
  const searchResult = await searchApkmirror(packageName, version);
  if (!searchResult) {
    throw new Error(`No APKMirror results found for ${packageName}${version ? ` ${version}` : ''}`);
  }

  const variantPageUrl = await findVariantDownloadPage(searchResult.href, appTarget);
  const confirmationPageUrl = await followDownloadButton(variantPageUrl);
  const url = await resolveFinalDownloadUrl(confirmationPageUrl);

  return { url, version: searchResult.version };
}
