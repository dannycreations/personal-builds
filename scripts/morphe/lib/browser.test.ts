import { createServer } from 'node:http';
import { describe, expect, it } from 'bun:test';

import { fetchPage } from './browser';

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
