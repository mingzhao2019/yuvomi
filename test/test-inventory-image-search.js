/**
 * Inventory image-search proxy boundary tests.
 * Network-provider success is intentionally not tested here; these tests cover
 * the authenticated route's input boundary without depending on Google or an
 * external image host.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { default: imageSearchRouter } = await import('../server/routes/inventory/image-search.js');

const app = express();
app.use((req, _res, next) => {
  req.authUserId = 1;
  req.session = { userId: 1 };
  next();
});
app.use('/', imageSearchRouter);
const server = app.listen(0);
const baseUrl = await new Promise((resolve) => {
  server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

test.after(() => server.close());

test('GET / image search requires a query', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 400);
});

test('GET /preview rejects non-public and non-HTTP URLs before network access', async () => {
  for (const url of [
    'javascript:alert(1)',
    'http://127.0.0.1/image.png',
    'http://192.168.1.10/image.png',
    'http://[::1]/image.png',
    'http://[::ffff:192.168.1.10]/image.png',
  ]) {
    const response = await fetch(`${baseUrl}/preview?url=${encodeURIComponent(url)}`);
    assert.equal(response.status, 400, url);
  }
});

test('GET /preview rejects credentials and unsupported ports', async () => {
  for (const url of ['https://user:pass@example.com/image.png', 'https://example.com:8443/image.png']) {
    const response = await fetch(`${baseUrl}/preview?url=${encodeURIComponent(url)}`);
    assert.equal(response.status, 400, url);
  }
});
