/**
 * Modul: Notification-Channel-Store
 * Zweck: CRUD, Validierung und write-only Secret-Handhabung fuer externe Notification-Provider.
 * Abhaengigkeiten: server/db.js
 */
import * as dbModule from '../db.js';
import {
  WEBHOOK_TEMPLATE_PLACEHOLDERS,
  renderPayloadTemplate,
  unknownTemplatePlaceholders,
} from './notification-providers/webhook.js';

export const NOTIFICATION_PROVIDERS = [
  { id: 'gotify', name: 'Gotify' },
  { id: 'ntfy', name: 'ntfy' },
  { id: 'webhook', name: 'Webhook' },
  { id: 'message_pusher', name: 'message-pusher' },
];

const PROVIDER_IDS = new Set(NOTIFICATION_PROVIDERS.map((p) => p.id));
const NTFY_PRIORITIES = new Set(['min', 'low', 'default', 'high', 'urgent']);
const NTFY_AUTH_TYPES = new Set(['none', 'token', 'basic']);

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toJson(value) {
  return JSON.stringify(value && typeof value === 'object' ? value : {});
}

// `keepPath`: Gotify und ntfy bekommen eine BASIS, an die der Provider seinen
// eigenen Pfad haengt - da ist ein abschliessender Slash Rauschen und wird
// entfernt. Beim Webhook ist der Wert der vollstaendige Endpunkt, auf den
// gepostet wird; ein Empfaenger, der `/hooks/x/` von `/hooks/x` unterscheidet,
// bekaeme sonst still eine andere Adresse als die eingetragene.
function normalizeBaseUrl(value, { keepPath = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('A base URL is required.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('A valid base URL is required.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Notification channel URL scheme must be http or https.');
  }
  if (keepPath) return url.toString();
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function normalizeProvider(provider) {
  const value = String(provider ?? '').trim().toLowerCase();
  if (!PROVIDER_IDS.has(value)) throw new Error('Unknown notification provider.');
  return value;
}

function normalizeScope(scope) {
  const value = String(scope ?? 'household').trim() || 'household';
  if (!['household', 'user'].includes(value)) throw new Error('Invalid notification channel scope.');
  return value;
}

function normalizeGotifyConfig(input = {}) {
  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 5;
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    priority: Math.min(10, Math.max(1, Math.trunc(priority))),
  };
}

function normalizeGotifySecrets(input = {}) {
  return {
    appToken: String(input.appToken ?? '').trim(),
  };
}

function validateGotify({ secrets, requireSecrets }) {
  if (requireSecrets && !secrets.appToken) throw new Error('Gotify app token is required.');
}

function normalizeNtfyConfig(input = {}) {
  const authType = String(input.authType ?? 'none').trim().toLowerCase();
  const priority = String(input.priority ?? 'default').trim().toLowerCase();
  if (!NTFY_AUTH_TYPES.has(authType)) throw new Error('Invalid ntfy auth type.');
  if (!NTFY_PRIORITIES.has(priority)) throw new Error('Invalid ntfy priority.');
  const topic = String(input.topic ?? '').trim();
  if (!topic) throw new Error('ntfy topic is required.');
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    topic,
    priority,
    authType,
  };
}

function normalizeNtfySecrets(input = {}) {
  return {
    token: String(input.token ?? '').trim(),
    username: String(input.username ?? '').trim(),
    password: String(input.password ?? ''),
  };
}

function validateNtfy({ config, secrets, requireSecrets }) {
  if (config.authType === 'token' && requireSecrets && !secrets.token) {
    throw new Error('ntfy token is required for token authentication.');
  }
  if (config.authType === 'basic' && requireSecrets && (!secrets.username || !secrets.password)) {
    throw new Error('ntfy username and password are required for basic authentication.');
  }
}

const MAX_WEBHOOK_TEMPLATE_LENGTH = 4096;

// Probewerte mit genau den Zeichen, an denen eine naive Ersetzung zerbricht:
// Anfuehrungszeichen, Backslash, Zeilenumbruch. Waeren sie harmlos, ginge die
// Gegenprobe unten durch und der Fehler kaeme erst bei der ersten Zustellung.
const WEBHOOK_TEMPLATE_SAMPLE = Object.freeze({
  title: 'Yuvomi "Test"',
  body: 'Zeile 1\nZeile 2 \\ Ende',
  url: '/tasks',
  tag: 'reminder-1',
});

function normalizeWebhookConfig(input = {}) {
  const payloadTemplate = String(input.payloadTemplate ?? '').trim();
  if (payloadTemplate) {
    if (payloadTemplate.length > MAX_WEBHOOK_TEMPLATE_LENGTH) {
      throw new Error(`Webhook payload template must be at most ${MAX_WEBHOOK_TEMPLATE_LENGTH} characters.`);
    }
    const unknown = unknownTemplatePlaceholders(payloadTemplate);
    if (unknown.length) {
      throw new Error(
        `Unknown webhook placeholder(s): ${unknown.map((k) => `{{${k}}}`).join(', ')}. `
        + `Available: ${WEBHOOK_TEMPLATE_PLACEHOLDERS.map((k) => `{{${k}}}`).join(', ')}.`,
      );
    }
    // Gegenprobe beim Speichern statt beim Senden: eine Vorlage, die erst in der
    // Nacht am fehlenden Komma scheitert, kostet die Benachrichtigung UND die
    // Diagnose. Der Fehler gehoert an das Formular, in dem sie entstanden ist.
    try {
      JSON.parse(renderPayloadTemplate(payloadTemplate, WEBHOOK_TEMPLATE_SAMPLE));
    } catch {
      throw new Error('Webhook payload template must produce valid JSON.');
    }
  }
  return { baseUrl: normalizeBaseUrl(input.baseUrl, { keepPath: true }), payloadTemplate };
}

function normalizeWebhookSecrets(input = {}) {
  return { token: String(input.token ?? '').trim() };
}

function normalizeMessagePusherConfig(input = {}) {
  const method = String(input.method ?? 'POST').trim().toUpperCase();
  const postFormat = String(input.postFormat ?? 'json').trim().toLowerCase();
  const messageField = String(input.messageField ?? 'content').trim().toLowerCase();
  const username = String(input.username ?? '').trim();
  if (!username) throw new Error('message-pusher username is required.');
  if (!['GET', 'POST'].includes(method)) throw new Error('Invalid message-pusher request method.');
  if (!['json', 'form'].includes(postFormat)) throw new Error('Invalid message-pusher POST format.');
  if (!['content', 'description'].includes(messageField)) throw new Error('Invalid message-pusher message field.');
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl, { keepPath: true }),
    username,
    method,
    postFormat,
    messageField,
    channel: String(input.channel ?? '').trim(),
    tokenInQuery: input.tokenInQuery === true,
  };
}

function normalizeMessagePusherSecrets(input = {}) {
  return { token: String(input.token ?? '').trim() };
}

export function normalizeChannelInput(input = {}, existing = null) {
  const provider = existing?.provider || normalizeProvider(input.provider);
  normalizeProvider(provider);
  const mergedConfig = { ...(existing?.config || {}), ...(input.config || {}) };
  const existingSecrets = existing?.secrets || {};
  let mergedSecrets = { ...existingSecrets, ...(input.secrets || {}) };
  for (const key of input.clearSecrets || []) {
    if (Object.hasOwn(mergedSecrets, key)) mergedSecrets[key] = '';
  }

  let config;
  let secrets;
  if (provider === 'gotify') {
    config = normalizeGotifyConfig(mergedConfig);
    secrets = normalizeGotifySecrets(mergedSecrets);
    validateGotify({ secrets, requireSecrets: !existing });
  } else if (provider === 'ntfy') {
    config = normalizeNtfyConfig(mergedConfig);
    secrets = normalizeNtfySecrets(mergedSecrets);
    validateNtfy({ config, secrets, requireSecrets: !existing || input.secrets !== undefined });
  } else if (provider === 'message_pusher') {
    config = normalizeMessagePusherConfig(mergedConfig);
    secrets = normalizeMessagePusherSecrets(mergedSecrets);
  } else {
    config = normalizeWebhookConfig(mergedConfig);
    secrets = normalizeWebhookSecrets(mergedSecrets);
  }

  return {
    provider,
    name: String(input.name ?? existing?.name ?? '').trim(),
    enabled: input.enabled === undefined ? Boolean(existing?.enabled) : Boolean(input.enabled),
    scope: normalizeScope(input.scope ?? existing?.scope ?? 'household'),
    userId: input.userId ?? input.user_id ?? existing?.userId ?? existing?.user_id ?? null,
    config,
    secrets,
  };
}

function dbRowToChannel(row, { includeSecrets = false } = {}) {
  if (!row) return null;
  const config = parseJson(row.config_json);
  const secrets = parseJson(row.secret_json);
  const channel = {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: Boolean(row.enabled),
    scope: row.scope,
    userId: row.user_id,
    config,
    secretSet: Object.values(secrets).some((value) => String(value ?? '') !== ''),
    lastTestAt: row.last_test_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeSecrets) channel.secrets = secrets;
  return channel;
}

export function publicChannel(channel) {
  if (!channel) return null;
  const { secrets, ...safe } = channel;
  void secrets;
  return safe;
}

export function createNotificationChannelStore({ db } = {}) {
  const getDb = () => (db || dbModule.get());

  function getInternalChannel(id) {
    const row = getDb().prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
    return dbRowToChannel(row, { includeSecrets: true });
  }

  function listChannels() {
    return getDb().prepare('SELECT * FROM notification_channels ORDER BY provider, name, id')
      .all()
      .map((row) => publicChannel(dbRowToChannel(row)));
  }

  function getChannel(id, options = {}) {
    const row = getDb().prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
    const channel = dbRowToChannel(row, options);
    return options.includeSecrets ? channel : publicChannel(channel);
  }

  function createChannel(input) {
    const normalized = normalizeChannelInput(input);
    if (!normalized.name) throw new Error('Notification channel name is required.');
    const now = new Date().toISOString();
    const result = getDb().prepare(`
      INSERT INTO notification_channels
        (provider, name, enabled, scope, user_id, config_json, secret_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.provider,
      normalized.name,
      normalized.enabled ? 1 : 0,
      normalized.scope,
      normalized.userId,
      toJson(normalized.config),
      toJson(normalized.secrets),
      now,
      now
    );
    return getChannel(result.lastInsertRowid);
  }

  function updateChannel(id, input) {
    const existing = getInternalChannel(id);
    if (!existing) return null;
    const normalized = normalizeChannelInput(input, existing);
    if (!normalized.name) throw new Error('Notification channel name is required.');
    const now = new Date().toISOString();
    getDb().prepare(`
      UPDATE notification_channels
      SET name = ?, enabled = ?, scope = ?, user_id = ?, config_json = ?, secret_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      normalized.name,
      normalized.enabled ? 1 : 0,
      normalized.scope,
      normalized.userId,
      toJson(normalized.config),
      toJson(normalized.secrets),
      now,
      id
    );
    return getChannel(id);
  }

  function deleteChannel(id) {
    const result = getDb().prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
    return result.changes > 0;
  }

  function markChannelTestResult(id, { ok, error = null, at = new Date().toISOString() } = {}) {
    getDb().prepare(`
      UPDATE notification_channels
      SET last_test_at = ?,
          last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(at, ok ? 1 : 0, at, ok ? null : String(error || 'Test failed.'), at, id);
    return getChannel(id);
  }

  function listEnabledChannelsForUser(userId) {
    return getDb().prepare(`
      SELECT * FROM notification_channels
      WHERE enabled = 1
        AND (scope = 'household' OR user_id = ?)
      ORDER BY provider, name, id
    `).all(userId).map((row) => dbRowToChannel(row, { includeSecrets: true }));
  }

  return {
    listChannels,
    getChannel,
    createChannel,
    updateChannel,
    deleteChannel,
    markChannelTestResult,
    listEnabledChannelsForUser,
  };
}
