/**
 * Inventory image-search proxy boundary tests.
 * Network-provider success is intentionally not tested here; these tests cover
 * the authenticated route's input boundary without depending on Google or an
 * external image host.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const {
  default: imageSearchRouter,
  extractDuckDuckGoToken,
  parseDuckDuckGoResults,
  parseBraveImageUrls,
} = await import('../server/routes/inventory/image-search.js');

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

test('DuckDuckGo token and results are parsed into the common preview shape', () => {
  assert.equal(extractDuckDuckGoToken('<script>vqd="4-12345678901234567890123456789012-123"</script>'), '4-12345678901234567890123456789012-123');
  const results = parseDuckDuckGoResults({ results: [
    {
      title: 'JPG product',
      image: 'https://images.example.test/product.jpg',
      thumbnail: 'https://images.example.test/product-thumb.jpg',
      url: 'https://example.test/product',
    },
    {
      title: 'PNG product',
      image: 'https://images.example.test/product.png',
      thumbnail: 'https://images.example.test/product-thumb.png',
    },
  ] });
  assert.equal(results.length, 2);
  assert.equal(results[0].provider, 'duckduckgo');
  assert.match(results[0].image_url, /\.png$/);
  assert.match(results[0].thumbnail_preview_url, /image-search\/preview/);
});

test('Brave image proxy parsing removes tiny and duplicate entries', () => {
  const html = String.raw`
    "https:\/\/imgs.search.brave.com/small/rs:fit:32:32/a.png"
    "https:\/\/imgs.search.brave.com/large/rs:fit:640:480/a.jpg"
    "https://imgs.search.brave.com/large/rs:fit:640:480/a.jpg"
    "https://imgs.search.brave.com/other/rs:fit:320:240/b.jpg"
  `;
  assert.deepEqual(parseBraveImageUrls(html), [
    'https://imgs.search.brave.com/large/rs:fit:640:480/a.jpg',
    'https://imgs.search.brave.com/other/rs:fit:320:240/b.jpg',
  ]);
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
