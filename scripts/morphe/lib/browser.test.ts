import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

import { downloadFile, fetchPage } from './browser';

describe('fetchPage', () => {
  it('sends the provided referer header', async () => {
    let receivedReferer: string | undefined;

    const server = createServer((req, res) => {
      receivedReferer = req.headers.referer;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as import('node:net').AddressInfo).port;
      const url = `http://127.0.0.1:${port}/page`;
      const referer = `http://127.0.0.1:${port}/source`;

      await fetchPage(url, undefined, referer);

      expect(receivedReferer).toBe(referer);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not send a referer header when none is provided', async () => {
    let receivedReferer: string | undefined;

    const server = createServer((req, res) => {
      receivedReferer = req.headers.referer;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as import('node:net').AddressInfo).port;
      const url = `http://127.0.0.1:${port}/page`;

      await fetchPage(url);

      expect(receivedReferer).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('downloadFile', () => {
  it('writes the response body to disk and returns the final url', async () => {
    const payload = Buffer.from('apk-bytes');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive' });
      res.end(payload);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dir = mkdtempSync(join(tmpdir(), 'morphe-'));
    try {
      const port = (server.address() as import('node:net').AddressInfo).port;
      const url = `http://127.0.0.1:${port}/file.apk`;
      const dest = join(dir, 'file.apk');

      const resolved = await downloadFile(url, dest);

      expect(resolved).toBe(url);
      expect(readFileSync(dest)).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
