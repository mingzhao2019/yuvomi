/**
 * Inventory image search and preview proxy.
 *
 * The browser module must not expose a Google API key and the application CSP
 * intentionally blocks arbitrary cross-origin images. Search therefore stays
 * same-origin: Google Programmable Search is used when configured, while the
 * public Openverse API is a keyless fallback. Selected images are fetched
 * through the SSRF-guarded preview endpoint and converted to Inventory's local
 * photo_data by the browser cropper.
 */

import express from 'express';
import { isIP } from 'node:net';
import { createLogger } from '../../logger.js';
import { safeRequest } from '../../utils/http.js';
import {
  createGuardedLookup,
  isBlockedAddress,
  isBlockedHostname,
  normalizeHostname,
} from '../../utils/ssrf.js';

const log = createLogger('InventoryImageSearch');
const router = express.Router();

const MAX_QUERY_LENGTH = 120;
const MAX_PREVIEW_URL_LENGTH = 2048;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 8000;
const PREVIEW_TIMEOUT_MS = 10000;
const GOOGLE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const OPENVERSE_ENDPOINT = 'https://api.openverse.org/v1/images/';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function googleConfig() {
  const key = String(process.env.ASSET_COST_GOOGLE_API_KEY || '').trim();
  const cx = String(process.env.ASSET_COST_GOOGLE_CSE_ID || '').trim();
  return key && cx ? { key, cx } : null;
}

function safeHttpUrl(raw, maxLength = MAX_PREVIEW_URL_LENGTH) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxLength) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (url.port && !['80', '443'].includes(url.port)) return null;
    return url;
  } catch {
    return null;
  }
}

function safePublicHttpUrl(raw, maxLength = MAX_PREVIEW_URL_LENGTH) {
  const url = safeHttpUrl(raw, maxLength);
  if (!url) return null;
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) return null;
  if (isIP(hostname) && isBlockedAddress(hostname)) return null;
  return url;
}

async function readBodyLimited(body, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) {
      body.destroy();
      const err = new Error('Response body is too large.');
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function mimeFromBytes(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif';
  return null;
}

async function requestJson(url, headers = {}) {
  const response = await safeRequest(url, {
    headers: { Accept: 'application/json', ...headers },
    lookup: createGuardedLookup(),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    redirect: 'follow',
    maxRedirects: 3,
  });
  const body = await readBodyLimited(response.body, 1024 * 1024);
  let data = null;
  try { data = JSON.parse(body.toString('utf8')); } catch { /* handled below */ }
  if (!response.ok || !data) {
    const err = new Error(`Image search provider returned HTTP ${response.status}.`);
    err.status = response.status;
    throw err;
  }
  return data;
}

function normalizeResult({ title, imageUrl, thumbnailUrl, sourceUrl, provider, license = null, creator = null }) {
  const image = safeHttpUrl(imageUrl);
  const thumbnail = safeHttpUrl(thumbnailUrl || imageUrl);
  const source = safeHttpUrl(sourceUrl || imageUrl);
  if (!image || !thumbnail) return null;
  return {
    title: String(title || '').trim().slice(0, 300),
    image_url: image.href,
    thumbnail_url: thumbnail.href,
    source_url: source?.href || image.href,
    provider,
    license: license ? String(license).slice(0, 80) : null,
    creator: creator ? String(creator).slice(0, 200) : null,
    preview_url: `/api/v1/inventory/image-search/preview?url=${encodeURIComponent(image.href)}`,
  };
}

async function searchGoogle(query) {
  const config = googleConfig();
  if (!config) return [];
  const url = new URL(GOOGLE_ENDPOINT);
  url.searchParams.set('key', config.key);
  url.searchParams.set('cx', config.cx);
  url.searchParams.set('q', query);
  url.searchParams.set('searchType', 'image');
  url.searchParams.set('safe', 'active');
  url.searchParams.set('imgType', 'photo');
  url.searchParams.set('num', '10');
  const data = await requestJson(url.href);
  return (data.items || []).map((item) => normalizeResult({
    title: item.title,
    imageUrl: item.link,
    thumbnailUrl: item.image?.thumbnailLink,
    sourceUrl: item.image?.contextLink,
    provider: 'google',
  })).filter(Boolean);
}

async function searchOpenverse(query) {
  const url = new URL(OPENVERSE_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('page_size', '10');
  // Keep the fallback broad: an exact product model is often absent from
  // openly licensed subsets. The response still carries license/creator
  // metadata so the picker can show provenance when the provider returns it.
  const data = await requestJson(url.href);
  return (data.results || []).map((item) => normalizeResult({
    title: item.title,
    imageUrl: item.url || item.thumbnail,
    thumbnailUrl: item.thumbnail || item.url,
    sourceUrl: item.foreign_landing_url || item.url,
    provider: 'openverse',
    license: item.license,
    creator: item.creator,
  })).filter(Boolean);
}

router.get('/', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, MAX_QUERY_LENGTH) : '';
  if (!query) return res.status(400).json({ error: 'Search query is required.', code: 400 });

  if (googleConfig()) {
    try {
      const results = await searchGoogle(query);
      if (results.length) return res.json({ data: { provider: 'google', results } });
    } catch (err) {
      // Do not expose provider details or the key. The fallback keeps the
      // module useful when Google quota/configuration is unavailable.
      log.warn(`Google image search failed (${err.status || 'network'}); using fallback.`);
    }
  }

  try {
    const results = await searchOpenverse(query);
    return res.json({ data: { provider: 'openverse', results } });
  } catch (err) {
    log.warn(`Open image search failed (${err.status || 'network'}).`);
    return res.status(502).json({ error: 'Image search is temporarily unavailable.', code: 502 });
  }
});

router.get('/preview', async (req, res) => {
  const target = safePublicHttpUrl(req.query.url);
  if (!target) return res.status(400).json({ error: 'A public HTTP(S) image URL is required.', code: 400 });

  try {
    const response = await safeRequest(target.href, {
      headers: { Accept: 'image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.1' },
      lookup: createGuardedLookup(),
      signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      redirect: 'follow',
      maxRedirects: 3,
    });
    if (!response.ok) {
      response.body.resume();
      return res.status(502).json({ error: 'The selected image could not be downloaded.', code: 502 });
    }
    const body = await readBodyLimited(response.body, MAX_IMAGE_BYTES);
    // Do not trust a remote Content-Type header: a hostile host can label HTML
    // as an image. The local cropper only accepts these three raster formats,
    // so require a matching magic signature before returning the bytes.
    const mime = mimeFromBytes(body);
    if (!mime || !IMAGE_TYPES.has(mime)) {
      return res.status(415).json({ error: 'The selected result is not a supported raster image.', code: 415 });
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', body.length);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(body);
  } catch (err) {
    const status = err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 502;
    if (status >= 500) log.warn(`Image preview failed (${err.message || 'network'}).`);
    return res.status(status).json({
      error: status === 413 ? 'The selected image is too large.' : 'The selected image could not be downloaded.',
      code: status,
    });
  }
});

export default router;
