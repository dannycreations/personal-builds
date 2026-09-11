import { load } from 'cheerio';

import { fetchPage } from './browser';
import { VERSION_PATTERN } from './constants';

import type { CheerioAPI } from 'cheerio';

const BASE_URL = 'https://www.apkmirror.com';
const EXCLUDED_TITLE_KEYWORDS = ['wear os', 'daydream', 'automotive', 'android tv', 'beta', 'alpha'];
const DISQUS_ANCHOR = '#disqus_thread';
const RELEASE_PAGE_FETCH_DELAY_MS = 1000;

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

function matchesCriteria(rowText: string, target: AppTarget): boolean {
  const text = rowText.toLowerCase();

  const type = (target.type ?? '').toLowerCase();
  if (type && !text.includes(type)) return false;

  const arch = (target.arch ?? 'universal').toLowerCase();
  if (arch === 'universal' || arch === 'noarch') {
    const universalMarkers = ['universal', 'noarch', 'arm64-v8a', 'armeabi-v7a'];
    if (!universalMarkers.some((marker) => text.includes(marker))) return false;
  } else if (!text.includes(arch) && !text.includes('universal')) {
    return false;
  }

  const dpi = (target.dpi ?? 'nodpi').toLowerCase();
  const isAnyDpi = ['nodpi', '120-640dpi', 'all', ''].includes(dpi);
  if (!isAnyDpi && !text.includes(dpi)) return false;

  return true;
}

function extractDownloadPageUrl($: CheerioAPI, row: ReturnType<CheerioAPI>[number]): string | null {
  const $row = $(row);

  const directHref = $row
    .find('a[href]')
    .toArray()
    .map((a) => $(a).attr('href') ?? '')
    .find((href) => !href.endsWith(DISQUS_ANCHOR) && (href.includes('-android-apk-download') || href.replace(/\/$/, '').endsWith('-download')));
  if (directHref) return toAbsoluteUrl(directHref);

  const accentHref = $row.find('a.accent_color').attr('href');
  if (accentHref && !accentHref.endsWith(DISQUS_ANCHOR)) return toAbsoluteUrl(accentHref);

  return null;
}

async function searchApkmirror(packageName: string, version?: string): Promise<ApkMirrorSearchResult | null> {
  const searchTerm = version ? `${packageName} ${version}` : packageName;
  const searchUrl = `${BASE_URL}/?post_type=app_release&searchtype=apk&sortby=date&sort=desc&s=${encodeURIComponent(searchTerm)}`;

  console.log(`Searching APKMirror: ${searchUrl}`);
  const html = await fetchPage(searchUrl, '.appRow');
  const $ = load(html);

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
  console.log(`Fetching release page: ${releaseUrl}`);
  await new Promise((resolve) => setTimeout(resolve, RELEASE_PAGE_FETCH_DELAY_MS));

  const html = await fetchPage(releaseUrl);
  const $ = load(html);

  for (const row of $('.table-row').toArray()) {
    const rowText = $(row).text();
    const lowerRowText = rowText.toLowerCase();
    const isHeaderRow = lowerRowText.includes('variant') && lowerRowText.includes('arch');
    const hasVersionNumber = /\d+(\.\d+)+/.test(rowText);

    if (isHeaderRow || !hasVersionNumber || !matchesCriteria(rowText, appTarget)) continue;

    const downloadPageUrl = extractDownloadPageUrl($, row);
    if (downloadPageUrl) return downloadPageUrl;
  }

  throw new Error(`No matching variant found for ${releaseUrl} with criteria: ${JSON.stringify(appTarget)}`);
}

async function followDownloadButton(variantPageUrl: string): Promise<string> {
  console.log(`Fetching download page: ${variantPageUrl}`);
  const html = await fetchPage(variantPageUrl);
  const href = load(html)('a.downloadButton').attr('href');
  if (!href) throw new Error(`Download button not found on ${variantPageUrl}`);
  return toAbsoluteUrl(href);
}

async function resolveFinalDownloadUrl(confirmationPageUrl: string): Promise<string> {
  console.log(`Fetching final download page: ${confirmationPageUrl}`);
  const html = await fetchPage(confirmationPageUrl);
  const href = load(html)('a#download-link').attr('href');
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
