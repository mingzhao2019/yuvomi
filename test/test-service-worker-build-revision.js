/**
 * Service Worker build revision tests.
 * Same-version builds must receive different cache namespaces.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const serviceWorkerModule = await import('../server/utils/service-worker.js');

test('renders a distinct response for each same-version build revision', () => {
  const template = "globalThis.cacheRevision = '__YUVOMI_BUILD_REVISION__';";
  const first = serviceWorkerModule.renderServiceWorkerSource(template, 'acceptance-a');
  const second = serviceWorkerModule.renderServiceWorkerSource(template, 'acceptance-b');

  assert.equal(first, "globalThis.cacheRevision = 'acceptance-a';");
  assert.equal(second, "globalThis.cacheRevision = 'acceptance-b';");
  assert.notEqual(first, second);
});

test('the shipped service worker uses the injected revision in its cache namespace', () => {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const rendered = serviceWorkerModule.renderServiceWorkerSource(source, 'acceptance-a');

  assert.match(rendered, /const APP_BUILD_REVISION\s*=\s*'acceptance-a'/);
  assert.match(rendered, /yuvomi-shell-\$\{CACHE_RELEASE\}/);
  assert.doesNotMatch(rendered, /__YUVOMI_BUILD_REVISION__/);
});

test('falls back to the app version and forbids caching the rendered response', () => {
  const response = serviceWorkerModule.buildServiceWorkerResponse(
    "globalThis.cacheRevision = '__YUVOMI_BUILD_REVISION__';",
    { appVersion: '2.59.0', buildRevision: '' },
  );

  assert.deepEqual(response, {
    body: "globalThis.cacheRevision = '2.59.0';",
    contentType: 'text/javascript; charset=utf-8',
    cacheControl: 'no-store, max-age=0',
    cdnCacheControl: 'no-store',
    cloudflareCdnCacheControl: 'no-store',
  });
});

test('rejects unsafe APP_BUILD_REVISION values with the variable name and allowed format', () => {
  for (const value of [
    "a'; fetch('//evil')//",
    'a\\',
    'a\nb',
    '</script>',
    'a'.repeat(81),
    '',
  ]) {
    assert.throws(
      () => serviceWorkerModule.renderServiceWorkerSource('revision: __YUVOMI_BUILD_REVISION__', value),
      /\[SW\] APP_BUILD_REVISION must match \/\^\[A-Za-z0-9\._-\]\{1,80\}\$\//,
    );
  }
});

test('falls back to the app version when APP_BUILD_REVISION is blank after trimming', () => {
  const response = serviceWorkerModule.buildServiceWorkerResponse(
    "globalThis.cacheRevision = '__YUVOMI_BUILD_REVISION__';",
    { appVersion: '2.59.0', buildRevision: '   ' },
  );

  assert.equal(response.body, "globalThis.cacheRevision = '2.59.0';");
});
