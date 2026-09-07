/**
 * Gehärteter HTTP-Aufruf für Benachrichtigungskanäle.
 *
 * Konfigurierte Gotify-, ntfy-, Webhook- und message-pusher-Ziele sind
 * serverseitige Ausgaben. Sie müssen deshalb dieselbe DNS-Rebinding- und
 * Redirect-Prüfung wie andere externe Integrationen durchlaufen.
 */

import { safeRequest } from '../../utils/http.js';
import { createGuardedLookup, readPrivateNetworkOptIn } from '../../utils/ssrf.js';

export const ENV_ALLOW_PRIVATE_NETWORK = 'NOTIFICATION_ALLOW_PRIVATE_NETWORK';
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Zur Laufzeit gelesen, damit ein kontrolliertes Opt-in auch Tests erfasst. */
export function isPrivateNetworkAllowed() {
  return readPrivateNetworkOptIn(ENV_ALLOW_PRIVATE_NETWORK);
}

async function drainBody(body) {
  const chunks = [];
  let total = 0;
  for await (const value of body) {
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      body.destroy();
      throw new Error('Notification target response exceeds the 1 MB limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * fetch-compatible wrapper backed by safeRequest.
 *
 * `fetchImpl` remains injectable in every provider for deterministic tests;
 * this is only the production default.
 */
export async function guardedFetch(url, {
  method = 'GET',
  headers = {},
  body,
  signal,
  lookup,
} = {}) {
  const outHeaders = { ...headers };
  let outBody = body;
  if (body instanceof URLSearchParams) {
    outBody = body.toString();
    const hasType = Object.keys(outHeaders).some((h) => h.toLowerCase() === 'content-type');
    if (!hasType) outHeaders['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  }

  const options = { method, headers: outHeaders, body: outBody, signal };
  if (lookup) options.lookup = lookup;
  else if (!isPrivateNetworkAllowed()) options.lookup = createGuardedLookup();

  const response = await safeRequest(url, options);
  const buffer = await drainBody(response.body);
  const text = buffer.toString('utf8');
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

export default guardedFetch;
