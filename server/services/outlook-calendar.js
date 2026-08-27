/**
 * Modul: Outlook Calendar Sync (Microsoft Graph)
 * Zweck: Bidirektionaler Sync zwischen Yuvomi und Outlook.com für persönliche
 *        Microsoft-Konten (M365 Family / outlook.com). Multi-Account wie
 *        caldav_accounts.
 * Abhängigkeiten: server/db.js, server/services/recurrence.js (kein SDK, plain fetch)
 *
 * Graph calendarView/delta liefert je Kalender einen stabilen, bereichsgebundenen
 * Cursor. Lokale und entfernte Änderungen werden über den letzten gemeinsamen
 * Hash erkannt. Ändern beide Seiten denselben Termin, bleibt er unverändert und
 * landet in outlook_calendar_conflicts, bis jemand ausdrücklich eine Seite wählt.
 */

import { createLogger } from '../logger.js';
const log = createLogger('Outlook');

import crypto from 'node:crypto';
import * as db from '../db.js';
import { parseRRule } from './recurrence.js';
import { visibilityWhere } from './visibility.js';
import {
  householdTimeZone,
  isValidTimeZone,
  localToUTC,
  shiftDateKey,
  todayKey,
} from '../utils/timezone.js';

// /consumers statt /common: die Entra-App ist für "Personal Microsoft accounts
// only" registriert; so kann sich kein Organisations-Konto versehentlich anmelden.
const AUTH_BASE  = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
// User.Read wird für GET /me (Anzeigename + E-Mail der Konto-Zeile) benötigt.
// Tasks.ReadWrite is deliberately added to this existing consent flow so
// Microsoft To Do does not get a second account table or callback.
const SCOPES = 'offline_access Calendars.ReadWrite Tasks.ReadWrite User.Read';
const DEFAULT_SYNC_MONTHS = 6;
const SYNC_RANGE_MONTHS = 24;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MICROSOFT_TIME_ZONES = new Map(Object.entries({
  'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kyiv',
  'GTB Standard Time': 'Europe/Bucharest',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'India Standard Time': 'Asia/Kolkata',
  'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'New Zealand Standard Time': 'Pacific/Auckland',
}).map(([name, zone]) => [name.toLowerCase(), zone]));

// Die Zone, in der Yuvomi seine zonenlosen Wanduhrzeiten meint. Bis v2.27.0 stand
// hier fest 'Europe/Berlin' - als "Parität mit dem Google-Outbound" begründet,
// obwohl der schon damals die Zone des Zielkalenders nahm und nur als RÜCKFALL
// auf `TZ` ging. Ein Haushalt in Toronto schickte seine Termine damit sechs
// Stunden verschoben zu Outlook, und installation.md musste die Abweichung als
// Einschränkung dokumentieren. Jetzt ist es dieselbe Haushaltszone wie überall
// sonst (#829).
const outlookTimeZone = () => householdTimeZone(db.get());

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Date-key arithmetic deliberately ignores DST; a date is not 24 hours. */
function addMonthsToDateKey(dateKey, months) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const targetMonth = month - 1 + Number(months || 0);
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInMonth);
  return `${String(targetYear).padStart(4, '0')}-${pad2(normalizedMonth + 1)}-${pad2(targetDay)}`;
}

function isValidDateKey(value) {
  if (!DATE_ONLY_RE.test(String(value || ''))) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

function defaultSyncStartDate(now = new Date()) {
  return addMonthsToDateKey(todayKey(db.get(), now), -DEFAULT_SYNC_MONTHS);
}

function defaultSyncEndDate(now = new Date()) {
  return addMonthsToDateKey(todayKey(db.get(), now), SYNC_RANGE_MONTHS);
}

function effectiveSyncStartDate(selection, now = new Date()) {
  return selection.sync_start_date || selection.sync_range_start || defaultSyncStartDate(now);
}

function graphTimeZone(value, fallback = outlookTimeZone()) {
  const raw = String(value || '').trim();
  const mapped = MICROSOFT_TIME_ZONES.get(raw.toLowerCase()) || raw;
  return isValidTimeZone(mapped) ? mapped : fallback;
}

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isoNow() {
  return new Date().toISOString();
}

/** Refresh-Token ist ungültig/abgelaufen — Konto braucht manuellen Reconnect. */
class ReauthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

// Outlook Calendar and Microsoft To Do deliberately share one OAuth account.
// Refresh tokens may rotate, so concurrent scheduler/request refreshes must
// collapse into one request instead of racing with the same old refresh token.
const tokenRefreshes = new Map();

function envConfig() {
  return {
    clientId:     process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    redirectUri:  process.env.MS_REDIRECT_URI,
  };
}

function isConfigured() {
  const { clientId, clientSecret, redirectUri } = envConfig();
  return !!(clientId && clientSecret && redirectUri);
}

function requireConfig() {
  if (!isConfigured()) {
    throw new Error('[Outlook] MS_CLIENT_ID, MS_CLIENT_SECRET, and MS_REDIRECT_URI must be set.');
  }
  return envConfig();
}

/**
 * Für Route-Handler: wirft bei fehlender Konfiguration denselben lauten Fehler
 * wie der Google-Provider (loadAuthorizedClient) — bewusst KEIN stilles
 * Leerergebnis, damit eine fehlende Konfiguration (z. B. frische Installation)
 * im Server-Log sofort auffällt. Der Intervall-Sync bleibt davon unberührt
 * (sync() kehrt ohne Konten weiterhin leise zurück).
 */
function assertConfigured() {
  requireConfig();
}

// --------------------------------------------------------
// Konten
// --------------------------------------------------------

function getAccountById(accountId, database = db.get()) {
  return database.prepare('SELECT * FROM outlook_accounts WHERE id = ?').get(accountId);
}

function getAllAccounts() {
  return db.get().prepare('SELECT * FROM outlook_accounts').all();
}

function listAccounts() {
  // Tokens bewusst NICHT zurückgeben (Muster caldav-sync.listAccounts).
  return db.get().prepare(`
    SELECT id, name, email, needs_reauth, todo_needs_reauth, created_at,
           last_sync, last_error, auto_sync_calendar_id, owner_user_id
    FROM outlook_accounts
    ORDER BY created_at DESC
  `).all().map((acc) => ({
    id: acc.id,
    name: acc.name,
    email: acc.email,
    needsReauth: acc.needs_reauth === 1,
    todoNeedsReauth: acc.todo_needs_reauth === 1,
    createdAt: acc.created_at,
    lastSync: acc.last_sync,
    lastError: acc.last_error,
    autoSyncCalendarId: acc.auto_sync_calendar_id,
    ownerUserId: acc.owner_user_id,
  }));
}

/**
 * Partial-Update eines Kontos. Nur übergebene Felder werden geändert;
 * autoSyncCalendarId/ownerUserId akzeptieren null zum Deaktivieren.
 * Der Auto-Sync-Zielkalender muss beschreibbar sein und wird beim Setzen
 * automatisch als Push-Ziel aktiviert (enabled=1).
 */
function updateAccount(accountId, { name, autoSyncCalendarId, ownerUserId } = {}) {
  const account = getAccountById(accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  const updates = [];
  const values = [];

  if (name !== undefined) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) throw new Error('name is required.');
    updates.push('name = ?');
    values.push(trimmed);
  }

  if (autoSyncCalendarId !== undefined) {
    if (autoSyncCalendarId === null || autoSyncCalendarId === '') {
      updates.push('auto_sync_calendar_id = NULL');
    } else {
      if (typeof autoSyncCalendarId !== 'string') {
        throw new Error('autoSyncCalendarId must be a string or null.');
      }
      const cal = db.get().prepare(`
        SELECT can_edit FROM outlook_calendar_selection
        WHERE account_id = ? AND calendar_id = ?
      `).get(accountId, autoSyncCalendarId);
      if (!cal) throw new Error('Calendar not found for this account.');
      if (cal.can_edit !== 1) throw new Error('Calendar is read-only.');
      // Der Auto-Sync-Kalender ist implizit auch als Ziel aktiv.
      db.get().prepare(`
        UPDATE outlook_calendar_selection SET enabled = 1
        WHERE account_id = ? AND calendar_id = ?
      `).run(accountId, autoSyncCalendarId);
      updates.push('auto_sync_calendar_id = ?');
      values.push(autoSyncCalendarId);
    }
  }

  if (ownerUserId !== undefined) {
    if (ownerUserId === null || ownerUserId === '') {
      updates.push('owner_user_id = NULL');
    } else {
      const userId = Number(ownerUserId);
      if (!Number.isInteger(userId) || !db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
        throw new Error('Unknown owner user id.');
      }
      updates.push('owner_user_id = ?');
      values.push(userId);
    }
  }

  if (updates.length === 0) throw new Error('No fields to update.');
  values.push(accountId);
  db.get().prepare(`UPDATE outlook_accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return { success: true };
}

function deleteAccount(accountId) {
  const account = getAccountById(accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  // Bereits gepushte Events bleiben in Outlook stehen (kein Token-Zugriff mehr
  // garantiert); Events mit diesem Ziel werden wieder rein lokal. Eingehende
  // Spiegel dürfen nach dem Trennen nicht als tote Outlook-Events im Kalender
  // hängen bleiben. Hat ein Event noch einen Link zu einem anderen Konto, bleibt
  // dieser Link führend und das Event wird nicht abgekoppelt.
  db.get().prepare(`
    UPDATE calendar_events
    SET target_outlook_account_id = NULL, target_outlook_calendar_id = NULL
    WHERE target_outlook_account_id = ?
  `).run(accountId);
  db.get().prepare(`
    UPDATE calendar_events
       SET external_source = 'local', external_calendar_id = NULL,
           external_object_url = NULL, outbound_dirty = 0, outbound_attempts = 0
     WHERE external_source = 'outlook'
       AND id IN (SELECT event_id FROM outlook_event_links WHERE account_id = ?)
       AND NOT EXISTS (
         SELECT 1 FROM outlook_event_links other
          WHERE other.event_id = calendar_events.id AND other.account_id <> ?
       )
  `).run(accountId, accountId);
  // To Do mirrors are household data. Detach them before removing the OAuth
  // account, just like CalDAV mirrors, so a disconnected account cannot leave
  // tasks pointing at a provider identity that can no longer be synchronized.
  db.get().prepare(`
    UPDATE tasks
       SET external_source = 'local', external_uid = NULL,
           external_account_id = NULL, external_object_url = NULL,
           outbound_dirty = 0, outbound_attempts = 0
     WHERE external_source = 'microsoft_todo' AND external_account_id = ?
  `).run(accountId);
  // To Do list identities belong to this OAuth account. Removing them also
  // clears the task-list navigation for a deliberately disconnected account;
  // the FK turns mirrored tasks into unassigned local tasks.
  db.get().prepare(`
    DELETE FROM task_lists WHERE provider = 'microsoft_todo' AND external_account_id = ?
  `).run(accountId);
  // CASCADE räumt outlook_calendar_selection + outlook_event_links auf.
  db.get().prepare('DELETE FROM outlook_accounts WHERE id = ?').run(accountId);

  log.info(`Deleted Outlook account ${accountId} ("${account.name}").`);
  return { success: true };
}

// --------------------------------------------------------
// OAuth (Authorization Code + Refresh, persönliche Konten)
// --------------------------------------------------------

/**
 * Auth-URL für den Redirect des Admins, mit CSRF-state in der Session.
 * prompt=select_account: mehrere Familienkonten am selben (Admin-)Browser.
 * @param {object} session - Express-Session (state wird dort gespeichert)
 * @returns {string}
 */
function getAuthUrl(session) {
  const { clientId, redirectUri } = requireConfig();
  const state = crypto.randomBytes(32).toString('hex');
  if (session) session.outlookOAuthState = state;
  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
    redirect_uri:  redirectUri,
    response_mode: 'query',
    scope:         SCOPES,
    state,
    prompt:        'select_account',
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

async function tokenRequest(bodyParams, fetchImpl = fetch, { scope = SCOPES } = {}) {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  const params = {
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    ...bodyParams,
  };
  if (scope) params.scope = scope;
  const body = new URLSearchParams(params);
  const res = await fetchImpl(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data.error || `HTTP ${res.status}`;
    // invalid_grant: Refresh-Token abgelaufen/widerrufen (MSA rotieren und
    // verfallen nach ~90 Tagen Inaktivität) → Konto braucht Reconnect.
    if (code === 'invalid_grant') {
      throw new ReauthRequiredError(data.error_description || 'invalid_grant');
    }
    throw new Error(`[Outlook] Token request failed: ${code} ${data.error_description || ''}`.trim());
  }
  return data;
}

function expiryFromNow(expiresIn) {
  const seconds = Number(expiresIn) || 3600;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Gültiges Access-Token für ein Konto liefern; refresht bei Ablauf (< 5 min
 * Restlaufzeit). Persistiert IMMER das ggf. rotierte Refresh-Token.
 * Bei invalid_grant: needs_reauth=1 setzen und ReauthRequiredError werfen.
 * @returns {Promise<string>} Access-Token
 */
async function ensureAccessToken(account, fetchImpl = fetch, database = db.get()) {
  const accountId = account?.id;
  const readCurrent = () => (accountId == null
    ? account
    : database.prepare('SELECT * FROM outlook_accounts WHERE id = ?').get(accountId) || account);
  const isValid = (current) => {
    const expiry = current?.token_expiry ? Date.parse(current.token_expiry) : 0;
    return !!(current?.access_token && expiry - Date.now() > 5 * 60_000);
  };

  const current = readCurrent();
  if (isValid(current)) return current.access_token;
  if (accountId != null && tokenRefreshes.has(accountId)) return tokenRefreshes.get(accountId);

  const pending = (async () => {
    // Re-read after acquiring the logical slot: another caller may have
    // refreshed the account immediately before this promise was registered.
    const latest = readCurrent();
    if (isValid(latest)) return latest.access_token;

    let data;
    try {
      data = await tokenRequest(
        { grant_type: 'refresh_token', refresh_token: latest.refresh_token },
        fetchImpl,
        // Do not ask legacy Calendar-only grants for the newly added Tasks
        // scope. Their calendar refresh remains valid; Graph will mark only To
        // Do as requiring consent until the user reconnects through OAuth.
        { scope: null },
      );
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        database.prepare(`
          UPDATE outlook_accounts SET needs_reauth = 1, last_error = ? WHERE id = ?
        `).run(`Reconnect required: ${err.message}`, latest.id);
      }
      throw err;
    }
    database.prepare(`
      UPDATE outlook_accounts
      SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
          token_expiry = ?, needs_reauth = 0
      WHERE id = ?
    `).run(data.access_token, data.refresh_token || null, expiryFromNow(data.expires_in), latest.id);
    return data.access_token;
  })();

  if (accountId == null) return pending;
  tokenRefreshes.set(accountId, pending);
  try {
    return await pending;
  } finally {
    if (tokenRefreshes.get(accountId) === pending) tokenRefreshes.delete(accountId);
  }
}

/**
 * OAuth-Callback: Code gegen Tokens tauschen, Konto upserten (Reconnect
 * desselben Microsoft-Kontos ersetzt Tokens statt zu duplizieren) und die
 * Kalenderliste initial laden.
 * @param {string} code
 * @returns {Promise<{accountId: number}>}
 */
async function handleCallback(code, fetchImpl = fetch) {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code }, fetchImpl);
  if (!tokens.refresh_token) {
    throw new Error('[Outlook] No refresh token received - check that offline_access scope is granted.');
  }

  const me = await graphJson('/me?$select=id,displayName,mail,userPrincipalName', tokens.access_token, {}, fetchImpl);
  const email = me.mail || me.userPrincipalName || null;
  const name  = me.displayName || email || 'Outlook';

  const existing = me.id
    ? db.get().prepare('SELECT id FROM outlook_accounts WHERE ms_user_id = ?').get(me.id)
    : null;

  let accountId;
  if (existing) {
    db.get().prepare(`
      UPDATE outlook_accounts
      SET email = ?, access_token = ?, refresh_token = ?, token_expiry = ?,
          needs_reauth = 0, todo_needs_reauth = 0, last_error = NULL
      WHERE id = ?
    `).run(email, tokens.access_token, tokens.refresh_token, expiryFromNow(tokens.expires_in), existing.id);
    accountId = existing.id;
    log.info(`Reconnected Outlook account ${accountId} (${email || 'unknown'}).`);
  } else {
    const result = db.get().prepare(`
      INSERT INTO outlook_accounts (name, ms_user_id, email, access_token, refresh_token, token_expiry)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, me.id || null, email, tokens.access_token, tokens.refresh_token, expiryFromNow(tokens.expires_in));
    accountId = result.lastInsertRowid;
    log.info(`Connected Outlook account ${accountId} (${email || 'unknown'}).`);
  }

  await refreshCalendarSelection(accountId, tokens.access_token, fetchImpl);
  return { accountId };
}

// --------------------------------------------------------
// Graph-HTTP-Helfer
// --------------------------------------------------------

async function graphRequest(path, accessToken, {
  method = 'GET',
  body,
  headers: extraHeaders = {},
} = {}, fetchImpl = fetch) {
  const doFetch = () => fetchImpl(`${GRAPH_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let res = await doFetch();
  // Graph-Throttling: einmal Retry-After honorieren, danach gibt der Aufrufer
  // auf (der Intervall-Sync versucht es in 15 min ohnehin erneut).
  if (res.status === 429) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || 5, 60);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    res = await doFetch();
  }
  return res;
}

async function graphJson(path, accessToken, options = {}, fetchImpl = fetch) {
  const res = await graphRequest(path, accessToken, options, fetchImpl);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message || `HTTP ${res.status}`;
    const err = new Error(`[Outlook] Graph request ${options.method || 'GET'} ${path} failed: ${message}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Convert a Graph nextLink/deltaLink into the relative path accepted by the
 * shared Graph helper. Never persist or return the access token from a link.
 */
function graphPath(value) {
  if (!value) return null;
  const raw = String(value);
  const apiPath = new URL(GRAPH_BASE).pathname.replace(/\/$/, '');
  const stripApiPrefix = (pathname, search = '') => {
    if (pathname === apiPath) return search || '/';
    if (pathname.startsWith(`${apiPath}/`)) {
      return `${pathname.slice(apiPath.length)}${search}`;
    }
    return `${pathname}${search}`;
  };
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(GRAPH_BASE).origin) return null;
    return stripApiPrefix(url.pathname, url.search);
  } catch {
    const relative = raw.startsWith('/') ? raw : `/${raw}`;
    const split = relative.indexOf('?');
    return stripApiPrefix(
      split === -1 ? relative : relative.slice(0, split),
      split === -1 ? '' : relative.slice(split),
    );
  }
}

// --------------------------------------------------------
// Kalenderauswahl
// --------------------------------------------------------

async function refreshCalendarSelection(accountId, accessToken, fetchImpl = fetch) {
  const calendars = [];
  let path = '/me/calendars?$select=id,name,hexColor,canEdit,isDefaultCalendar&$top=50';
  while (path) {
    const data = await graphJson(path, accessToken, {}, fetchImpl);
    calendars.push(...(data.value || []));
    // @odata.nextLink ist eine absolute URL — auf den Graph-Pfad reduzieren.
    path = graphPath(data['@odata.nextLink']);
  }

  const conn = db.get();
  conn.transaction(() => {
    // Alle lokalen Synchronisationszustände bekannter Kalender überleben den
    // Refresh. Ein Kalender-Refresh darf weder den Datumsbereich noch den
    // Delta-Cursor zurücksetzen.
    const stateMap = new Map(
      conn.prepare(`
        SELECT calendar_id, enabled, sync_start_date, sync_range_start,
               sync_range_end, sync_cursor, last_inbound_sync, sync_error
          FROM outlook_calendar_selection WHERE account_id = ?
      `).all(accountId).map((r) => [r.calendar_id, r])
    );
    conn.prepare('DELETE FROM outlook_calendar_selection WHERE account_id = ?').run(accountId);
    const ins = conn.prepare(`
      INSERT INTO outlook_calendar_selection
        (account_id, calendar_id, calendar_name, calendar_color, can_edit, enabled,
         sync_start_date, sync_range_start, sync_range_end, sync_cursor,
         last_inbound_sync, sync_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const cal of calendars) {
      const old = stateMap.get(cal.id);
      ins.run(
        accountId,
        cal.id,
        cal.name || 'Calendar',
        /^#[0-9a-fA-F]{6}$/.test(cal.hexColor || '') ? cal.hexColor : null,
        cal.canEdit === false ? 0 : 1,
        // Neue Kalender starten deaktiviert: der Connect-Flow soll erst zur Anlage
        // eines dedizierten Zielkalenders führen, statt alles anzubieten.
        old?.enabled ?? 0,
        old?.sync_start_date ?? null,
        old?.sync_range_start ?? null,
        old?.sync_range_end ?? null,
        old?.sync_cursor ?? null,
        old?.last_inbound_sync ?? null,
        old?.sync_error ?? null,
      );
    }
  })();

  log.info(`Refreshed ${calendars.length} calendars for Outlook account ${accountId}.`);
  return listCalendarSelection(accountId);
}

function listCalendarSelection(accountId) {
  return db.get().prepare(`
    SELECT calendar_id, calendar_name, calendar_color, can_edit, enabled,
           sync_start_date, sync_range_start, sync_range_end, last_inbound_sync,
           sync_error
    FROM outlook_calendar_selection
    WHERE account_id = ?
    ORDER BY calendar_name
  `).all(accountId).map((cal) => ({
    calendarId: cal.calendar_id,
    calendarName: cal.calendar_name,
    calendarColor: cal.calendar_color,
    canEdit: cal.can_edit === 1,
    enabled: cal.enabled === 1,
    syncStartDate: cal.sync_start_date || cal.sync_range_start || defaultSyncStartDate(),
    customSyncStartDate: cal.sync_start_date || null,
    syncRangeStart: cal.sync_range_start || null,
    syncRangeEnd: cal.sync_range_end || null,
    lastInboundSync: cal.last_inbound_sync || null,
    syncError: cal.sync_error || null,
  }));
}

async function listCalendars(accountId, { refresh = false } = {}, fetchImpl = fetch) {
  const account = getAccountById(accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);
  if (!refresh) return listCalendarSelection(accountId);
  const accessToken = await ensureAccessToken(account, fetchImpl);
  return refreshCalendarSelection(accountId, accessToken, fetchImpl);
}

function setCalendarEnabled(accountId, calendarId, enabled) {
  const result = db.get().prepare(`
    UPDATE outlook_calendar_selection SET enabled = ?
    WHERE account_id = ? AND calendar_id = ?
  `).run(enabled ? 1 : 0, accountId, calendarId);
  if (result.changes === 0) {
    throw new Error(`Calendar not found for account ${accountId}.`);
  }
  return { success: true };
}

/**
 * Setzt den Beginn des Importfensters als absolutes Datum. `null` bedeutet
 * wieder „heute minus sechs Monate“. Bereits importierte Events bleiben dabei
 * unverändert; nur der Graph-Cursor dieses Kalenders wird neu aufgebaut.
 */
function setCalendarSyncStartDate(accountId, calendarId, syncStartDate) {
  const value = syncStartDate === null || syncStartDate === '' ? null : syncStartDate;
  if (value !== null && (!isValidDateKey(value) || value.length !== 10)) {
    throw new Error('syncStartDate muss ein gültiges Datum im Format YYYY-MM-DD sein.');
  }
  const result = db.get().prepare(`
    UPDATE outlook_calendar_selection
       SET sync_start_date = ?, sync_range_start = NULL, sync_range_end = NULL,
           sync_cursor = NULL, sync_error = NULL
     WHERE account_id = ? AND calendar_id = ?
  `).run(value, accountId, calendarId);
  if (result.changes === 0) throw new Error(`Calendar not found for account ${accountId}.`);
  return listCalendarSelection(accountId).find((cal) => cal.calendarId === calendarId);
}

// --------------------------------------------------------
// Mapping: lokales Event → Graph-Payload
// --------------------------------------------------------

// JS-Wochentagsnummern (parseRRule/DAY_MAP: 0=SU..6=SA) → Graph-daysOfWeek.
const GRAPH_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Yuvomi-RRULE-Subset → Graph-recurrence ({pattern, range}).
 * MONTHLY mit BYDAY degradiert bewusst zum absoluten Monatstag (PoC-Grenze).
 * @param {string} rrule - RRULE-Body (mit oder ohne "RRULE:"-Prefix)
 * @param {string} startDate - 'YYYY-MM-DD' (DTSTART-Datum)
 * @param {string} [tz] - Haushaltszone für `recurrenceTimeZone`
 * @returns {{pattern: object, range: object}|null}
 */
function rruleToGraphRecurrence(rrule, startDate, tz = outlookTimeZone()) {
  const parsed = parseRRule(rrule);
  if (!parsed || !startDate) return null;

  const start = new Date(startDate + 'T00:00:00Z');
  if (isNaN(start.getTime())) return null;

  let pattern;
  if (parsed.freq === 'DAILY') {
    pattern = { type: 'daily', interval: parsed.interval };
  } else if (parsed.freq === 'WEEKLY') {
    const days = parsed.byday.length
      ? parsed.byday.map((d) => GRAPH_DAYS[d])
      : [GRAPH_DAYS[start.getUTCDay()]];
    pattern = { type: 'weekly', interval: parsed.interval, daysOfWeek: days, firstDayOfWeek: 'monday' };
  } else if (parsed.freq === 'MONTHLY') {
    pattern = { type: 'absoluteMonthly', interval: parsed.interval, dayOfMonth: start.getUTCDate() };
  } else if (parsed.freq === 'YEARLY') {
    pattern = {
      type: 'absoluteYearly',
      interval: parsed.interval,
      dayOfMonth: start.getUTCDate(),
      month: start.getUTCMonth() + 1,
    };
  } else {
    return null;
  }

  let range;
  if (parsed.until) {
    range = { type: 'endDate', startDate, endDate: parsed.until.toISOString().slice(0, 10) };
  } else if (parsed.count) {
    range = { type: 'numbered', startDate, numberOfOccurrences: parsed.count };
  } else {
    range = { type: 'noEnd', startDate };
  }
  range.recurrenceTimeZone = tz;

  return { pattern, range };
}

// Yuvomi speichert inklusive Ganztags-Enden; Graph verlangt exklusiv
// (Mitternacht-zu-Mitternacht) — +1 Tag (Muster google-calendar.js).
function allDayEndToExclusive(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * DB-Datetime → Graph {dateTime, timeZone}. Lokal angelegte Events sind naive
 * "YYYY-MM-DDTHH:MM" (validate.js) → Sekunden ergänzen, TZ Europe/Berlin.
 * Importierte Events können Z/Offset tragen → nach UTC normalisieren.
 */
function toGraphDateTime(dt, tz = outlookTimeZone()) {
  if (!dt) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt)) {
    return { dateTime: `${dt}:00`, timeZone: tz };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dt)) {
    return { dateTime: dt, timeZone: tz };
  }
  const parsed = new Date(dt);
  if (isNaN(parsed.getTime())) return { dateTime: dt, timeZone: tz };
  return { dateTime: parsed.toISOString().slice(0, 19), timeZone: 'UTC' };
}

/**
 * Lokales calendar_events-Row → Microsoft-Graph-Event-Payload.
 * Zugewiesene Personen erscheinen als Titel-Suffix "Titel (A, B)" — gleiche
 * Konvention wie der ICS-Export-Feed (#482). Da die Namen Teil des Payloads
 * sind, löst eine Zuweisungs-Änderung über den Content-Hash ein PATCH aus.
 * Kein Teilnehmer-/Reminder-/Farb-Mapping (PoC-Umfang).
 */
function localEventToGraph(event, assigneeNames = [], tz = outlookTimeZone()) {
  const allDay = !!event.all_day;
  const subject = assigneeNames.length
    ? `${event.title} (${assigneeNames.join(', ')})`
    : event.title;
  const payload = {
    subject,
    body: { contentType: 'text', content: event.description || '' },
  };
  if (event.location) payload.location = { displayName: event.location };

  if (allDay) {
    const startDate = event.start_datetime.slice(0, 10);
    const endDate   = (event.end_datetime || event.start_datetime).slice(0, 10);
    payload.isAllDay = true;
    payload.start = { dateTime: `${startDate}T00:00:00`, timeZone: tz };
    payload.end   = { dateTime: `${allDayEndToExclusive(endDate)}T00:00:00`, timeZone: tz };
  } else {
    payload.start = toGraphDateTime(event.start_datetime, tz);
    payload.end   = toGraphDateTime(event.end_datetime || event.start_datetime, tz);
  }

  if (event.recurrence_rule) {
    const recurrence = rruleToGraphRecurrence(event.recurrence_rule, event.start_datetime.slice(0, 10), tz);
    if (recurrence) payload.recurrence = recurrence;
  }

  return payload;
}

// Der Payload wird deterministisch aufgebaut — der Hash erkennt inhaltliche
// Änderungen und macht unveränderte Events zu No-Ops (0 Graph-Requests).
function contentHash(payload, calendarId) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(payload) + '|' + calendarId)
    .digest('hex');
}

const GRAPH_DAY_TO_RRULE = {
  sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE',
  thursday: 'TH', friday: 'FR', saturday: 'SA',
};

function graphDateTimeValue(value, { allDay = false, fallbackTimeZone = outlookTimeZone() } = {}) {
  if (!value) return { value: null, timeZone: null };
  const raw = String(value.dateTime || value.date || '').trim();
  if (!raw) return { value: null, timeZone: null };
  if (allDay || value.date) return { value: raw.slice(0, 10), timeZone: null };

  const explicit = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (explicit) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime())
      ? { value: raw.slice(0, 19), timeZone: 'UTC' }
      : { value: parsed.toISOString().replace('.000Z', 'Z'), timeZone: 'UTC' };
  }
  return {
    value: raw.slice(0, 16),
    timeZone: graphTimeZone(value.timeZone, fallbackTimeZone),
  };
}

function graphRecurrenceToRRule(recurrence, startDate) {
  const pattern = recurrence?.pattern;
  const range = recurrence?.range;
  if (!pattern || !range || !startDate) return null;

  let rule;
  const interval = Number(pattern.interval) > 1 ? `;INTERVAL=${Number(pattern.interval)}` : '';
  if (pattern.type === 'daily') {
    rule = `FREQ=DAILY${interval}`;
  } else if (pattern.type === 'weekly') {
    const days = (pattern.daysOfWeek || [])
      .map((day) => GRAPH_DAY_TO_RRULE[String(day).toLowerCase()])
      .filter(Boolean);
    rule = `FREQ=WEEKLY${interval}${days.length ? `;BYDAY=${days.join(',')}` : ''}`;
  } else if (pattern.type === 'absoluteMonthly' && Number(pattern.dayOfMonth) >= 1) {
    // The local recurrence engine intentionally supports a small RRULE subset;
    // it anchors monthly series to DTSTART, so only the matching day is safe.
    const day = Number(startDate.slice(8, 10));
    if (day !== Number(pattern.dayOfMonth)) return null;
    rule = `FREQ=MONTHLY${interval}`;
  } else if (
    pattern.type === 'absoluteYearly'
    && Number(pattern.dayOfMonth) >= 1
    && Number(pattern.month) >= 1
    && Number(pattern.month) <= 12
  ) {
    const month = Number(startDate.slice(5, 7));
    const day = Number(startDate.slice(8, 10));
    if (month !== Number(pattern.month) || day !== Number(pattern.dayOfMonth)) return null;
    rule = `FREQ=YEARLY${interval}`;
  } else {
    // Relative monthly/yearly patterns and unsupported Graph patterns cannot be
    // represented without silently changing their meaning. Import the event as
    // a one-off instead of inventing a wrong local series.
    return null;
  }

  if (range.type === 'endDate' && isValidDateKey(range.endDate)) {
    rule += `;UNTIL=${range.endDate.replaceAll('-', '')}`;
  } else if (range.type === 'numbered' && Number(range.numberOfOccurrences) > 0) {
    rule += `;COUNT=${Number(range.numberOfOccurrences)}`;
  }
  return rule;
}

function remoteEventSnapshot(remote, fallbackTimeZone = outlookTimeZone(), { exception = false } = {}) {
  const allDay = remote?.isAllDay === true
    || Boolean(remote?.start?.date && !remote?.start?.dateTime);
  const start = graphDateTimeValue(remote?.start, { allDay, fallbackTimeZone });
  const end = graphDateTimeValue(remote?.end, { allDay, fallbackTimeZone });
  if (!start.value) return null;

  const endValue = allDay && end.value ? shiftDateKey(end.value, -1) : (end.value || start.value);
  return {
    title: String(remote.subject || 'Outlook event').trim() || 'Outlook event',
    description: graphBodyText(remote.body),
    location: remote.location?.displayName ? String(remote.location.displayName) : null,
    start_datetime: start.value,
    end_datetime: endValue,
    all_day: allDay ? 1 : 0,
    recurrence_rule: exception ? null : graphRecurrenceToRRule(remote.recurrence, start.value.slice(0, 10)),
    tzid: allDay ? null : start.timeZone,
    external_object_url: remote.webLink || `${GRAPH_BASE}/me/events/${encodeURIComponent(remote.id)}`,
  };
}

function snapshotToGraphPayload(snapshot, calendarId = '') {
  if (!snapshot) return null;
  return localEventToGraph(
    snapshot,
    [],
    snapshot.tzid || outlookTimeZone(),
  );
}

function localEventSnapshot(event) {
  if (!event) return null;
  return {
    title: event.title || '',
    description: event.description || null,
    location: event.location || null,
    start_datetime: event.start_datetime,
    end_datetime: event.end_datetime || event.start_datetime,
    all_day: event.all_day ? 1 : 0,
    recurrence_rule: event.recurrence_rule || null,
    tzid: event.tzid || null,
  };
}

function graphBodyText(body) {
  if (!body || typeof body.content !== 'string') return null;
  if (String(body.contentType || '').toLowerCase() !== 'html') return body.content || null;
  return String(body.content)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null;
}

function localEventHash(event, calendarId) {
  const names = safeJson(event?.assignee_names_json, []) || [];
  const payload = localEventToGraph(
    event,
    Array.isArray(names) ? names : [],
    event?.tzid || outlookTimeZone(),
  );
  return contentHash(payload, calendarId);
}

function remoteEventHash(remote, calendarId, fallbackTimeZone = outlookTimeZone(), options = {}) {
  const snapshot = remoteEventSnapshot(remote, fallbackTimeZone, options);
  return snapshot ? contentHash(snapshotToGraphPayload(snapshot, calendarId), calendarId) : null;
}

function graphCalendarViewDeltaPath(calendarId, startDate, endDate, timeZone = outlookTimeZone()) {
  // Use UTC instants for the query boundary, but derive them from the household
  // wall clock so an absolute local date is not shifted across midnight by DST.
  const start = localToUTC(`${startDate}T00:00:00`, timeZone);
  const endExclusive = shiftDateKey(endDate, 1);
  const end = localToUTC(`${endExclusive}T00:00:00`, timeZone);
  const params = new URLSearchParams({
    startDateTime: start,
    endDateTime: end,
  });
  return `/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${params}`;
}

async function fetchCalendarViewDelta(
  calendarId,
  { cursor = null, startDate, endDate, timeZone = outlookTimeZone() } = {},
  accessToken,
  fetchImpl = fetch,
  allowFullResync = true,
) {
  const changes = [];
  let path = cursor || graphCalendarViewDeltaPath(calendarId, startDate, endDate, timeZone);
  let deltaLink = null;
  try {
    while (path) {
      const data = await graphJson(path, accessToken, {
        headers: { 'Content-Type': 'application/json' },
      }, fetchImpl);
      if (Array.isArray(data.value)) changes.push(...data.value);
      path = graphPath(data['@odata.nextLink']);
      if (!path) deltaLink = graphPath(data['@odata.deltaLink']);
    }
  } catch (error) {
    // Graph expires delta tokens. Keep the old cursor until the complete fresh
    // range has been fetched successfully, then replace it atomically.
    if (allowFullResync && cursor && [400, 410].includes(error.status)) {
      return fetchCalendarViewDelta(
        calendarId,
        { cursor: null, startDate, endDate, timeZone },
        accessToken,
        fetchImpl,
        false,
      );
    }
    throw error;
  }
  return { changes, deltaLink, fullResync: !cursor };
}

// --------------------------------------------------------
// Sync (bidirectional)
// --------------------------------------------------------

// Zugewiesene Personen alphabetisch als JSON-Array je Event (Muster
// ics-export.js #482) — wird zum Titel-Suffix "Titel (A, B)".
const ASSIGNEE_NAMES_SQL = `(
  SELECT json_group_array(name) FROM (
    SELECT u.display_name AS name
    FROM event_assignments ea JOIN users u ON u.id = ea.user_id
    WHERE ea.event_id = e.id
    ORDER BY u.display_name
  )
) AS assignee_names_json`;

/**
 * Kandidaten eines Kontos: eventId → { event, calendarId }.
 * a) Auto-Sync (falls Zielkalender + Owner gesetzt): alle lokalen, für den
 *    Owner sichtbaren Events → Auto-Kalender. Extern synchronisierte Events
 *    (google/caldav/ics/apple) sind bewusst ausgeschlossen — die hängen
 *    typischerweise schon nativ in Outlook und würden Duplikate erzeugen.
 * b) Explizites Ziel-pro-Termin — gewinnt bei Kollision mit a).
 */
function collectCandidates(conn, account) {
  const candidates = new Map();

  if (account.auto_sync_calendar_id && account.owner_user_id) {
    const rows = conn.prepare(`
      SELECT e.*, ${ASSIGNEE_NAMES_SQL}
      FROM calendar_events e
      WHERE e.external_source = 'local'
        AND ${visibilityWhere('e', 'event_assignments', 'event_id')}
    `).all(account.owner_user_id, account.owner_user_id);
    for (const event of rows) {
      candidates.set(event.id, { event, calendarId: account.auto_sync_calendar_id });
    }
  }

  const explicit = conn.prepare(`
    SELECT e.*, ${ASSIGNEE_NAMES_SQL}
    FROM calendar_events e
    WHERE e.external_source = 'local' AND e.target_outlook_account_id = ?
  `).all(account.id);
  for (const event of explicit) {
    candidates.set(event.id, { event, calendarId: event.target_outlook_calendar_id });
  }

  return candidates;
}

/**
 * Local edits to an event imported from Outlook do not appear in the normal
 * local/explicit candidate query because their source is `outlook`. Keep the
 * link-level outbound intent as a second candidate source so those edits can
 * travel back to the same Graph object. The normal candidate wins for local
 * events because it contains the current explicit/auto-sync target.
 */
function collectDirtyLinkedCandidates(conn, account, candidates) {
  const rows = conn.prepare(`
    SELECT e.*, l.outlook_calendar_id AS linked_calendar_id, ${ASSIGNEE_NAMES_SQL}
      FROM calendar_events e
      JOIN outlook_event_links l ON l.event_id = e.id
     WHERE l.account_id = ?
       AND l.pending_delete = 0
       AND (l.outbound_dirty = 1 OR l.remote_missing = 1)
  `).all(account.id);
  for (const event of rows) {
    if (candidates.has(event.id)) continue;
    // A local event that disappeared from the normal candidate query has
    // usually lost its explicit target, its visibility, or its auto-sync
    // eligibility. Let processOrphans remove its old remote copy instead of
    // resurrecting it from this dirty-link fallback. Imported Outlook events
    // have no local candidate by design and are the only rows this fallback
    // must add.
    if (event.external_source !== 'outlook') continue;
    candidates.set(event.id, {
      event,
      calendarId: event.linked_calendar_id,
    });
  }
  return candidates;
}

/**
 * id → changeKey aller Events eines Kalenders (Serien zählen als ein Master) —
 * die Basis der Drift-Erkennung, eine (paginierte) Anfrage je Kalender und Lauf.
 * @returns {Promise<Map<string, string|null>|null>} null, wenn das Listing
 *          scheitert; der Push läuft dann ohne Drift-Erkennung weiter.
 */
async function fetchRemoteEventStates(calendarId, accessToken, fetchImpl = fetch) {
  try {
    const states = new Map();
    let path = `/me/calendars/${encodeURIComponent(calendarId)}/events?$select=id,changeKey&$top=500`;
    while (path) {
      const data = await graphJson(path, accessToken, {}, fetchImpl);
      for (const ev of data.value || []) states.set(ev.id, ev.changeKey ?? null);
      path = graphPath(data['@odata.nextLink']);
    }
    return states;
  } catch (err) {
    log.warn(`Drift check failed for calendar ${calendarId}:`, err.message);
    return null;
  }
}

function eventForSync(database, eventId) {
  return database.prepare(`
    SELECT e.*, ${ASSIGNEE_NAMES_SQL}
      FROM calendar_events e
     WHERE e.id = ?
  `).get(eventId);
}

function accountOwnerId(database, account) {
  if (account.owner_user_id && database.prepare('SELECT 1 FROM users WHERE id = ?').get(account.owner_user_id)) {
    return account.owner_user_id;
  }
  return database.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get()?.id ?? null;
}

function upsertLink(database, {
  eventId,
  accountId,
  calendarId,
  remoteEventId,
  contentHash: localHash = null,
  remoteContentHash = null,
  changeKey = null,
  linkType = 'push',
  dirty = 0,
  attempts = 0,
  pendingDelete = 0,
  remoteMissing = 0,
  localSnapshot = null,
  seriesMasterId = null,
  lastPushedAt = null,
  lastInboundAt = null,
}) {
  database.prepare(`
    INSERT INTO outlook_event_links
      (event_id, account_id, outlook_calendar_id, outlook_event_id,
       content_hash, outlook_change_key, last_pushed_at, last_error,
       link_type, remote_content_hash, outbound_dirty, outbound_attempts,
       pending_delete, remote_missing, local_snapshot, series_master_id, last_inbound_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, account_id) DO UPDATE SET
      outlook_calendar_id = excluded.outlook_calendar_id,
      outlook_event_id = excluded.outlook_event_id,
      content_hash = excluded.content_hash,
      outlook_change_key = excluded.outlook_change_key,
      last_pushed_at = COALESCE(excluded.last_pushed_at, outlook_event_links.last_pushed_at),
      last_error = NULL,
      link_type = excluded.link_type,
      remote_content_hash = excluded.remote_content_hash,
      outbound_dirty = excluded.outbound_dirty,
      outbound_attempts = excluded.outbound_attempts,
      pending_delete = excluded.pending_delete,
      remote_missing = excluded.remote_missing,
      local_snapshot = excluded.local_snapshot,
      series_master_id = excluded.series_master_id,
      last_inbound_at = COALESCE(excluded.last_inbound_at, outlook_event_links.last_inbound_at)
  `).run(
    eventId,
    accountId,
    calendarId,
    remoteEventId,
    localHash,
    changeKey,
    lastPushedAt,
    linkType,
    remoteContentHash,
    dirty ? 1 : 0,
    attempts,
    pendingDelete ? 1 : 0,
    remoteMissing ? 1 : 0,
    localSnapshot ? JSON.stringify(localSnapshot) : null,
    seriesMasterId,
    lastInboundAt,
  );
}

function pendingConflict(database, accountId, remoteEventId) {
  return database.prepare(`
    SELECT * FROM outlook_calendar_conflicts
     WHERE account_id = ? AND outlook_event_id = ? AND status = 'pending'
     LIMIT 1
  `).get(accountId, remoteEventId);
}

function recordConflict(database, {
  account,
  link,
  event,
  calendarId,
  remoteSnapshot,
  remoteChangeKey,
  localSnapshot = null,
}) {
  const local = localSnapshot || localEventSnapshot(event) || safeJson(link?.local_snapshot, null) || {};
  const existing = pendingConflict(database, account.id, link.outlook_event_id);
  const base = {
    contentHash: link.content_hash || null,
    remoteContentHash: link.remote_content_hash || null,
    changeKey: link.outlook_change_key || null,
  };
  if (existing) {
    database.prepare(`
      UPDATE outlook_calendar_conflicts
         SET event_id = ?, local_snapshot = ?, remote_snapshot = ?,
             remote_change_key = ?
       WHERE id = ?
    `).run(
      event?.id ?? link.event_id ?? null,
      JSON.stringify(local),
      remoteSnapshot == null ? null : JSON.stringify(remoteSnapshot),
      remoteChangeKey || null,
      existing.id,
    );
  } else {
    database.prepare(`
      INSERT INTO outlook_calendar_conflicts
        (event_id, account_id, outlook_calendar_id, outlook_event_id,
         base_snapshot, local_snapshot, remote_snapshot, remote_change_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event?.id ?? link.event_id ?? null,
      account.id,
      calendarId || link.outlook_calendar_id,
      link.outlook_event_id,
      JSON.stringify(base),
      JSON.stringify(local),
      remoteSnapshot == null ? null : JSON.stringify(remoteSnapshot),
      remoteChangeKey || null,
    );
  }
  database.prepare(`
    UPDATE outlook_event_links
       SET last_error = ?, outbound_dirty = CASE WHEN ? THEN 1 ELSE outbound_dirty END
     WHERE event_id = ? AND account_id = ?
  `).run(
    'Conflict pending: choose local or Outlook version.',
    event ? 1 : 0,
    link.event_id,
    account.id,
  );
}

function stripAssigneeSuffix(snapshot, event) {
  if (!snapshot || !event) return snapshot;
  const names = safeJson(event.assignee_names_json, []) || [];
  const suffix = Array.isArray(names) && names.length ? ` (${names.join(', ')})` : '';
  if (!suffix || !snapshot.title?.endsWith(suffix)) return snapshot;
  return { ...snapshot, title: snapshot.title.slice(0, -suffix.length) };
}

function applyRemoteSnapshot(database, event, snapshot) {
  const values = stripAssigneeSuffix(snapshot, event);
  database.prepare(`
    UPDATE calendar_events
       SET title = ?, description = ?, location = ?, start_datetime = ?,
           end_datetime = ?, all_day = ?, recurrence_rule = ?, tzid = ?,
           external_object_url = ?, user_modified = 0, outbound_dirty = 0,
           outbound_attempts = 0,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
  `).run(
    values.title,
    values.description,
    values.location,
    values.start_datetime,
    values.end_datetime,
    values.all_day ? 1 : 0,
    values.recurrence_rule,
    values.tzid,
    values.external_object_url,
    event.id,
  );
}

function removeLinkConflict(database, link) {
  database.prepare(`
    DELETE FROM outlook_calendar_conflicts
     WHERE account_id = ? AND outlook_event_id = ? AND status = 'pending'
  `).run(link.account_id, link.outlook_event_id);
  database.prepare(
    'DELETE FROM outlook_event_links WHERE event_id = ? AND account_id = ?'
  ).run(link.event_id, link.account_id);
}

function exceptionDate(remote, snapshot) {
  const value = remote?.originalStart?.dateTime
    || remote?.originalStart?.date
    || remote?.originalStartTime?.dateTime
    || remote?.originalStartTime?.date
    || snapshot?.start_datetime;
  return String(value || '').slice(0, 10);
}

function addSeriesException(database, accountId, remote, snapshot) {
  if (!remote?.seriesMasterId || !snapshot) return;
  const master = database.prepare(`
    SELECT event_id FROM outlook_event_links
     WHERE account_id = ? AND outlook_event_id = ?
  `).get(accountId, remote.seriesMasterId);
  const date = exceptionDate(remote, snapshot);
  if (master?.event_id && isValidDateKey(date)) {
    database.prepare(`
      INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date)
      VALUES (?, ?)
    `).run(master.event_id, date);
  }
}

function applyRemoteDelete(database, account, calendarId, remoteId) {
  const link = database.prepare(`
    SELECT * FROM outlook_event_links
     WHERE account_id = ? AND outlook_event_id = ?
     LIMIT 1
  `).get(account.id, remoteId);
  if (!link) return { deleted: 0, conflicts: 0 };

  const event = eventForSync(database, link.event_id);
  if (link.pending_delete) {
    removeLinkConflict(database, link);
    return { deleted: 0, conflicts: 0 };
  }
  if (!event) {
    removeLinkConflict(database, link);
    return { deleted: 0, conflicts: 0 };
  }

  const localHash = localEventHash(event, calendarId || link.outlook_calendar_id);
  const localChanged = link.outbound_dirty === 1 || localHash !== link.content_hash;
  if (localChanged) {
    recordConflict(database, {
      account,
      link,
      event,
      calendarId,
      remoteSnapshot: null,
      remoteChangeKey: null,
    });
    return { deleted: 0, conflicts: 1 };
  }

  const otherLinks = database.prepare(`
    SELECT COUNT(*) AS count FROM outlook_event_links
     WHERE event_id = ? AND account_id <> ?
  `).get(link.event_id, account.id).count;
  if (otherLinks > 0) {
    // A local event may be mirrored to several accounts. Removing one remote
    // copy must not destroy the other account's local mirror.
    if (event.external_source === 'outlook') {
      database.prepare(`
        UPDATE calendar_events
           SET external_source = 'local', external_calendar_id = NULL,
               external_object_url = NULL, outbound_dirty = 0,
               outbound_attempts = 0
         WHERE id = ?
      `).run(event.id);
    }
    removeLinkConflict(database, link);
    return { deleted: 0, conflicts: 0 };
  }

  database.prepare('DELETE FROM calendar_events WHERE id = ?').run(event.id);
  removeLinkConflict(database, link);
  return { deleted: 1, conflicts: 0 };
}

function applyRemoteEvent(database, account, selection, remote, timeZone) {
  const remoteId = remote?.id;
  if (!remoteId) return { created: 0, updated: 0, conflicts: 0 };
  const exception = remote.type === 'exception' || remote.__oneOff === true;
  const snapshot = remoteEventSnapshot(remote, timeZone, { exception });
  if (!snapshot) return { created: 0, updated: 0, conflicts: 0 };
  const remoteHash = remoteEventHash(remote, selection.calendar_id, timeZone, { exception });
  const link = database.prepare(`
    SELECT * FROM outlook_event_links
     WHERE account_id = ? AND outlook_event_id = ?
     LIMIT 1
  `).get(account.id, remoteId);

  if (!link) {
    const ownerId = accountOwnerId(database, account);
    if (!ownerId) return { created: 0, updated: 0, conflicts: 0 };
    const result = database.prepare(`
      INSERT INTO calendar_events
        (title, description, start_datetime, end_datetime, all_day, location,
         color, created_by, external_calendar_id, external_source,
         recurrence_rule, user_modified, visibility, tzid, external_object_url,
         outbound_dirty, outbound_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'outlook', ?, 0, 'all', ?, ?, 0, 0)
    `).run(
      snapshot.title,
      snapshot.description,
      snapshot.start_datetime,
      snapshot.end_datetime,
      snapshot.all_day ? 1 : 0,
      snapshot.location,
      selection.calendar_color || '#4285F4',
      ownerId,
      remoteId,
      snapshot.recurrence_rule,
      snapshot.tzid,
      snapshot.external_object_url,
    );
    upsertLink(database, {
      eventId: result.lastInsertRowid,
      accountId: account.id,
      calendarId: selection.calendar_id,
      remoteEventId: remoteId,
      contentHash: remoteHash,
      remoteContentHash: remoteHash,
      changeKey: remote.changeKey || null,
      linkType: 'inbound',
      localSnapshot: snapshot,
      seriesMasterId: remote.seriesMasterId || null,
      lastInboundAt: isoNow(),
    });
    addSeriesException(database, account.id, remote, snapshot);
    return { created: 1, updated: 0, conflicts: 0 };
  }

  let event = eventForSync(database, link.event_id);
  if (!event) {
    if (link.pending_delete) {
      // A locally deleted event has a tombstone. An inbound update must not
      // resurrect it before the outbound DELETE gets its chance to run.
      return { created: 0, updated: 0, conflicts: 0 };
    }
    // A legacy client may have removed the local row without creating the new
    // tombstone. The current CRUD path does create it, but importing the remote
    // version is the safest recovery for old data.
    database.prepare(
      'DELETE FROM outlook_event_links WHERE event_id = ? AND account_id = ?'
    ).run(link.event_id, account.id);
    return applyRemoteEvent(database, account, selection, remote, timeZone);
  }
  if (link.pending_delete) return { created: 0, updated: 0, conflicts: 0 };

  const localHash = localEventHash(event, selection.calendar_id);
  const localChanged = link.outbound_dirty === 1 || localHash !== link.content_hash;
  const keyChanged = link.outlook_change_key && remote.changeKey
    ? link.outlook_change_key !== remote.changeKey
    : false;
  const hashChanged = link.remote_content_hash
    ? link.remote_content_hash !== remoteHash
    : link.content_hash !== remoteHash;
  const remoteChanged = keyChanged || hashChanged;

  if (remoteChanged && localChanged) {
    recordConflict(database, {
      account,
      link,
      event,
      calendarId: selection.calendar_id,
      remoteSnapshot: snapshot,
      remoteChangeKey: remote.changeKey || null,
    });
    return { created: 0, updated: 0, conflicts: 1 };
  }

  if (remoteChanged) {
    applyRemoteSnapshot(database, event, snapshot);
    event = eventForSync(database, event.id);
  }
  const nextLocalHash = remoteChanged ? localEventHash(event, selection.calendar_id) : localHash;
  database.prepare(`
    UPDATE outlook_event_links
       SET content_hash = ?, remote_content_hash = ?, outlook_change_key = ?,
           outbound_dirty = CASE WHEN ? THEN outbound_dirty ELSE 0 END,
           outbound_attempts = CASE WHEN ? THEN outbound_attempts ELSE 0 END,
           remote_missing = 0, last_error = NULL, last_inbound_at = ?, series_master_id = ?
     WHERE event_id = ? AND account_id = ?
  `).run(
    localChanged && !remoteChanged ? localHash : nextLocalHash,
    remoteHash,
    remote.changeKey || link.outlook_change_key || null,
    localChanged ? 1 : 0,
    localChanged ? 1 : 0,
    isoNow(),
    remote.seriesMasterId || link.series_master_id || null,
    link.event_id,
    account.id,
  );
  if (exception) addSeriesException(database, account.id, remote, snapshot);
  return { created: 0, updated: remoteChanged ? 1 : 0, conflicts: 0 };
}

async function expandSeriesChanges(database, account, changes, accessToken, fetchImpl) {
  const masterIds = new Set(
    changes.filter((item) => item?.id && item.type === 'seriesMaster').map((item) => item.id)
  );
  const fetchedMasters = new Map();
  const output = [];
  for (const item of changes) {
    if (!item?.id || item['@removed']) {
      output.push(item);
      continue;
    }
    if (item.type === 'occurrence' && item.seriesMasterId) {
      if (masterIds.has(item.seriesMasterId)) continue;
      const existingMaster = database.prepare(`
        SELECT 1 FROM outlook_event_links
         WHERE account_id = ? AND outlook_event_id = ?
      `).get(account.id, item.seriesMasterId);
      if (existingMaster) continue;
      if (!fetchedMasters.has(item.seriesMasterId)) {
        try {
          fetchedMasters.set(item.seriesMasterId, await graphJson(
            `/me/events/${encodeURIComponent(item.seriesMasterId)}`,
            accessToken,
            {},
            fetchImpl,
          ));
        } catch (error) {
          log.warn(`Could not load Outlook series master ${item.seriesMasterId}:`, error.message);
          fetchedMasters.set(item.seriesMasterId, null);
        }
      }
      const master = fetchedMasters.get(item.seriesMasterId);
      output.push(master || { ...item, __oneOff: true });
      continue;
    }
    output.push(item);
  }
  return output;
}

function applyRemoteChanges(database, account, selection, changes, timeZone) {
  return database.transaction(() => {
    const result = { created: 0, updated: 0, deleted: 0, conflicts: 0 };
    for (const change of changes) {
      if (!change?.id) continue;
      if (change['@removed'] || change.isCancelled) {
        const outcome = applyRemoteDelete(database, account, selection.calendar_id, change.id);
        result.deleted += outcome.deleted;
        result.conflicts += outcome.conflicts;
        continue;
      }
      const outcome = applyRemoteEvent(database, account, selection, change, timeZone);
      result.created += outcome.created;
      result.updated += outcome.updated;
      result.conflicts += outcome.conflicts;
    }
    return result;
  })();
}

async function fetchRemoteEvent(remoteEventId, accessToken, fetchImpl = fetch) {
  try {
    return await graphJson(`/me/events/${encodeURIComponent(remoteEventId)}`, accessToken, {}, fetchImpl);
  } catch (error) {
    if (error.status === 404 || error.status === 410) return null;
    throw error;
  }
}

async function deleteRemoteLink(database, account, link, accessToken, fetchImpl, event = null) {
  try {
    const headers = link.outlook_change_key ? { 'If-Match': link.outlook_change_key } : {};
    const response = await graphRequest(
      `/me/events/${encodeURIComponent(link.outlook_event_id)}`,
      accessToken,
      { method: 'DELETE', headers },
      fetchImpl,
    );
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    removeLinkConflict(database, link);
    return { deleted: 1, conflict: false };
  } catch (error) {
    if (error.status === 409 || error.status === 412) {
      let remote = null;
      try { remote = await fetchRemoteEvent(link.outlook_event_id, accessToken, fetchImpl); } catch { /* retain the conflict */ }
      recordConflict(database, {
        account,
        link,
        event,
        calendarId: link.outlook_calendar_id,
        remoteSnapshot: remote ? remoteEventSnapshot(remote) : null,
        remoteChangeKey: remote?.changeKey || null,
        localSnapshot: event ? null : safeJson(link.local_snapshot, null),
      });
      return { deleted: 0, conflict: true };
    }
    throw error;
  }
}

async function processPendingDeletes(database, account, accessToken, fetchImpl) {
  const rows = database.prepare(`
    SELECT * FROM outlook_event_links
     WHERE account_id = ? AND pending_delete = 1
     ORDER BY event_id
  `).all(account.id);
  let deleted = 0;
  let conflicts = 0;
  for (const link of rows) {
    if (eventForSync(database, link.event_id)) continue;
    try {
      const outcome = await deleteRemoteLink(database, account, link, accessToken, fetchImpl);
      deleted += outcome.deleted;
      conflicts += outcome.conflict ? 1 : 0;
    } catch (error) {
      database.prepare(`
        UPDATE outlook_event_links
           SET last_error = ?, outbound_attempts = outbound_attempts + 1
         WHERE event_id = ? AND account_id = ?
      `).run(String(error.message || error).slice(0, 500), link.event_id, account.id);
      log.warn(`Failed to delete pending Outlook event ${link.outlook_event_id}:`, error.message);
    }
  }
  return { deleted, conflicts };
}

async function pushCandidates(database, account, candidates, enabledCalendars, accessToken, fetchImpl) {
  let pushed = 0;
  let updated = 0;
  let deleted = 0;
  let conflicts = 0;
  const linkFor = (eventId) => database.prepare(
    'SELECT * FROM outlook_event_links WHERE event_id = ? AND account_id = ?'
  ).get(eventId, account.id);

  for (const { event, calendarId } of candidates.values()) {
    if (!calendarId || !enabledCalendars.has(calendarId) || !enabledCalendars.get(calendarId)) continue;
    let link = linkFor(event.id);
    if (link && pendingConflict(database, account.id, link.outlook_event_id)) continue;
    const names = safeJson(event.assignee_names_json, []) || [];
    const payload = localEventToGraph(
      event,
      Array.isArray(names) ? names : [],
      event.tzid || outlookTimeZone(),
    );
    const hash = contentHash(payload, calendarId);

    try {
      if (!link) {
        const created = await graphJson(
          `/me/calendars/${encodeURIComponent(calendarId)}/events`,
          accessToken,
          { method: 'POST', body: payload },
          fetchImpl,
        );
        upsertLink(database, {
          eventId: event.id,
          accountId: account.id,
          calendarId,
          remoteEventId: created.id,
          contentHash: hash,
          remoteContentHash: hash,
          changeKey: created.changeKey || null,
          linkType: 'push',
          localSnapshot: localEventSnapshot(event),
          lastPushedAt: isoNow(),
        });
        pushed++;
        continue;
      }

      if (link.outlook_calendar_id !== calendarId) {
        const outcome = await deleteRemoteLink(database, account, link, accessToken, fetchImpl, event);
        if (outcome.conflict) {
          conflicts++;
          continue;
        }
        deleted += outcome.deleted;
        link = null;
        const created = await graphJson(
          `/me/calendars/${encodeURIComponent(calendarId)}/events`,
          accessToken,
          { method: 'POST', body: payload },
          fetchImpl,
        );
        upsertLink(database, {
          eventId: event.id,
          accountId: account.id,
          calendarId,
          remoteEventId: created.id,
          contentHash: hash,
          remoteContentHash: hash,
          changeKey: created.changeKey || null,
          linkType: 'push',
          localSnapshot: localEventSnapshot(event),
          lastPushedAt: isoNow(),
        });
        updated++;
        continue;
      }

      if (link.remote_missing) {
        const created = await graphJson(
          `/me/calendars/${encodeURIComponent(calendarId)}/events`,
          accessToken,
          { method: 'POST', body: payload },
          fetchImpl,
        );
        upsertLink(database, {
          eventId: event.id,
          accountId: account.id,
          calendarId,
          remoteEventId: created.id,
          contentHash: hash,
          remoteContentHash: hash,
          changeKey: created.changeKey || null,
          linkType: link.link_type || 'push',
          localSnapshot: localEventSnapshot(event),
          lastPushedAt: isoNow(),
        });
        updated++;
        continue;
      }

      if (!link.outbound_dirty && link.content_hash === hash) continue;
      const headers = link.outlook_change_key ? { 'If-Match': link.outlook_change_key } : {};
      const patched = await graphJson(
        `/me/events/${encodeURIComponent(link.outlook_event_id)}`,
        accessToken,
        { method: 'PATCH', body: payload, headers },
        fetchImpl,
      );
      upsertLink(database, {
        eventId: event.id,
        accountId: account.id,
        calendarId,
        remoteEventId: link.outlook_event_id,
        contentHash: hash,
        remoteContentHash: hash,
        changeKey: patched.changeKey || link.outlook_change_key || null,
        linkType: link.link_type || 'push',
        localSnapshot: localEventSnapshot(event),
        lastPushedAt: isoNow(),
      });
      updated++;
    } catch (error) {
      if (error.status === 404 || error.status === 409 || error.status === 412) {
        if (!link) {
          log.warn(`Failed to create Outlook event ${event.id}:`, error.message);
          continue;
        }
        const remote = error.status === 404
          ? null
          : await fetchRemoteEvent(link.outlook_event_id, accessToken, fetchImpl);
        recordConflict(database, {
          account,
          link,
          event,
          calendarId,
          remoteSnapshot: remote ? remoteEventSnapshot(remote) : null,
          remoteChangeKey: remote?.changeKey || null,
        });
        conflicts++;
      } else {
        if (link) {
          database.prepare(`
            UPDATE outlook_event_links
               SET last_error = ?, outbound_attempts = outbound_attempts + 1
             WHERE event_id = ? AND account_id = ?
          `).run(String(error.message || error).slice(0, 500), event.id, account.id);
        }
        log.warn(`Failed to push Outlook event ${event.id}:`, error.message);
      }
    }
  }
  return { pushed, updated, deleted, conflicts };
}

async function processOrphans(database, account, candidates, accessToken, fetchImpl) {
  const rows = database.prepare(`
    SELECT * FROM outlook_event_links
     WHERE account_id = ? AND link_type = 'push' AND pending_delete = 0
     ORDER BY event_id
  `).all(account.id);
  let deleted = 0;
  let conflicts = 0;
  for (const link of rows) {
    if (candidates.has(link.event_id) || pendingConflict(database, account.id, link.outlook_event_id)) continue;
    const event = eventForSync(database, link.event_id);
    try {
      const outcome = await deleteRemoteLink(database, account, link, accessToken, fetchImpl, event);
      deleted += outcome.deleted;
      conflicts += outcome.conflict ? 1 : 0;
    } catch (error) {
      database.prepare(`
        UPDATE outlook_event_links
           SET last_error = ?, outbound_attempts = outbound_attempts + 1
         WHERE event_id = ? AND account_id = ?
      `).run(String(error.message || error).slice(0, 500), link.event_id, account.id);
      log.warn(`Failed to remove orphaned Outlook event ${link.outlook_event_id}:`, error.message);
    }
  }
  return { deleted, conflicts };
}

/**
 * Runs one account through inbound Graph delta feeds and local outbound work.
 * `inbound: false` is used by the immediate post-edit/delete flush; it only
 * pushes the already recorded local intent and never performs a network-wide
 * import for every keystroke.
 */
async function sync({ fetchImpl = fetch, inbound = true } = {}) {
  const accounts = getAllAccounts();
  const empty = {
    success: true,
    syncedAccounts: 0,
    pushed: 0,
    imported: 0,
    updated: 0,
    deleted: 0,
    conflicts: 0,
  };
  if (accounts.length === 0) {
    log.debug('No Outlook accounts configured.');
    return empty;
  }
  if (!isConfigured()) {
    log.warn('Accounts exist but MS_CLIENT_ID/MS_CLIENT_SECRET/MS_REDIRECT_URI are not set - skipping.');
    return { ...empty, success: false };
  }

  const database = db.get();
  const total = { ...empty };
  for (const account of accounts) {
    if (account.needs_reauth) {
      log.debug(`Account ${account.id} needs reconnect, skipping.`);
      continue;
    }

    let accountFailed = false;
    try {
      const accessToken = await ensureAccessToken(account, fetchImpl);

      if (inbound) {
        const selections = database.prepare(`
          SELECT * FROM outlook_calendar_selection
           WHERE account_id = ? AND enabled = 1
           ORDER BY calendar_name
        `).all(account.id);
        for (const selection of selections) {
          const startDate = effectiveSyncStartDate(selection);
          const endDate = selection.sync_range_end || defaultSyncEndDate();
          try {
            const delta = await fetchCalendarViewDelta(
              selection.calendar_id,
              {
                cursor: selection.sync_cursor,
                startDate,
                endDate,
                timeZone: outlookTimeZone(),
              },
              accessToken,
              fetchImpl,
            );
            const changes = await expandSeriesChanges(
              database,
              account,
              delta.changes,
              accessToken,
              fetchImpl,
            );
            const result = applyRemoteChanges(
              database,
              account,
              selection,
              changes,
              outlookTimeZone(),
            );
            database.prepare(`
              UPDATE outlook_calendar_selection
                 SET sync_range_start = ?, sync_range_end = ?, sync_cursor = ?,
                     last_inbound_sync = ?, sync_error = NULL
               WHERE account_id = ? AND calendar_id = ?
            `).run(
              startDate,
              endDate,
              delta.deltaLink,
              isoNow(),
              account.id,
              selection.calendar_id,
            );
            total.imported += result.created;
            total.updated += result.updated;
            total.deleted += result.deleted;
            total.conflicts += result.conflicts;
          } catch (error) {
            accountFailed = true;
            database.prepare(`
              UPDATE outlook_calendar_selection SET sync_error = ?
               WHERE account_id = ? AND calendar_id = ?
            `).run(String(error.message || error).slice(0, 500), account.id, selection.calendar_id);
            log.warn(`Inbound Outlook sync failed for calendar ${selection.calendar_id}:`, error.message);
          }
        }
      }

      const pending = await processPendingDeletes(database, account, accessToken, fetchImpl);
      total.deleted += pending.deleted;
      total.conflicts += pending.conflicts;

      const candidates = collectDirtyLinkedCandidates(
        database,
        account,
        collectCandidates(database, account),
      );
      const enabledCalendars = new Map(
        database.prepare(`
          SELECT calendar_id, can_edit FROM outlook_calendar_selection
           WHERE account_id = ? AND enabled = 1
        `).all(account.id).map((row) => [row.calendar_id, row.can_edit === 1])
      );
      const orphans = await processOrphans(database, account, candidates, accessToken, fetchImpl);
      total.deleted += orphans.deleted;
      total.conflicts += orphans.conflicts;
      const pushed = await pushCandidates(
        database,
        account,
        candidates,
        enabledCalendars,
        accessToken,
        fetchImpl,
      );
      total.pushed += pushed.pushed;
      total.updated += pushed.updated;
      total.deleted += pushed.deleted;
      total.conflicts += pushed.conflicts;

      database.prepare(`
        UPDATE outlook_accounts SET last_sync = ?, last_error = CASE WHEN ? THEN last_error ELSE NULL END
         WHERE id = ?
      `).run(isoNow(), accountFailed ? 1 : 0, account.id);
      total.syncedAccounts++;
    } catch (error) {
      accountFailed = true;
      log.error(`Sync failed for account ${account.id}:`, error.message);
      if (!(error instanceof ReauthRequiredError)) {
        database.prepare('UPDATE outlook_accounts SET last_error = ? WHERE id = ?')
          .run(String(error.message || error).slice(0, 500), account.id);
      }
    }
  }

  const changed = total.pushed + total.imported + total.updated + total.deleted + total.conflicts;
  log[changed > 0 ? 'info' : 'debug'](
    `Outlook bidirectional sync complete: ${total.syncedAccounts}/${accounts.length} accounts, `
    + `${total.pushed} created, ${total.imported} imported, ${total.updated} updated, `
    + `${total.deleted} deleted, ${total.conflicts} conflict(s).`
  );
  return total;
}

/** Immediate best-effort outbound pass used after local event mutations. */
async function flushOutbound(options = {}) {
  return sync({ ...options, inbound: false });
}

function markEventOutbound(before, after) {
  if (!after?.id) return false;
  const database = db.get();
  const links = database.prepare(
    'SELECT * FROM outlook_event_links WHERE event_id = ?'
  ).all(after.id);
  if (!links.length) return false;
  const mirroredChanged = [
    'title', 'description', 'location', 'all_day',
    'start_datetime', 'end_datetime', 'recurrence_rule',
  ].some((field) => before?.[field] !== after[field]);
  const targetChanged = before?.target_outlook_account_id !== after.target_outlook_account_id
    || before?.target_outlook_calendar_id !== after.target_outlook_calendar_id;
  if (!mirroredChanged && !targetChanged) return false;
  database.prepare(`
    UPDATE outlook_event_links
       SET outbound_dirty = 1, outbound_attempts = 0, local_snapshot = ?, last_error = NULL
     WHERE event_id = ?
  `).run(JSON.stringify(localEventSnapshot(after)), after.id);
  return true;
}

/**
 * Saves the local snapshot before a calendar row is deleted. The link remains
 * as a tombstone until Graph confirms the DELETE, so a network failure cannot
 * silently leave the remote event behind.
 */
function queueEventDeletion(event) {
  if (!event?.id) return false;
  const database = db.get();
  const links = database.prepare(
    'SELECT * FROM outlook_event_links WHERE event_id = ?'
  ).all(event.id);
  if (!links.length) return false;
  database.prepare(`
    UPDATE outlook_event_links
       SET pending_delete = 1, outbound_dirty = 0, outbound_attempts = 0,
           local_snapshot = ?, last_error = NULL
     WHERE event_id = ?
  `).run(JSON.stringify(localEventSnapshot(event)), event.id);
  return true;
}

function parseConflictRow(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    accountId: row.account_id,
    accountName: row.account_name || null,
    calendarId: row.outlook_calendar_id,
    outlookEventId: row.outlook_event_id,
    status: row.status,
    resolution: row.resolution || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null,
    base: safeJson(row.base_snapshot, null),
    local: safeJson(row.local_snapshot, {}),
    remote: safeJson(row.remote_snapshot, null),
  };
}

function listConflicts({ accountId = null, status = 'pending' } = {}) {
  const params = [];
  let sql = `
    SELECT c.*, oa.name AS account_name
      FROM outlook_calendar_conflicts c
      JOIN outlook_accounts oa ON oa.id = c.account_id
     WHERE c.status = ?
  `;
  params.push(status);
  if (accountId != null) {
    sql += ' AND c.account_id = ?';
    params.push(accountId);
  }
  sql += ' ORDER BY c.created_at DESC, c.id DESC';
  return db.get().prepare(sql).all(...params).map(parseConflictRow);
}

function resolveConflict(conflictId, resolution) {
  if (!['local', 'remote'].includes(resolution)) {
    throw new Error('resolution must be local or remote.');
  }
  const database = db.get();
  const conflict = database.prepare(`
    SELECT c.*, oa.name AS account_name
      FROM outlook_calendar_conflicts c
      JOIN outlook_accounts oa ON oa.id = c.account_id
     WHERE c.id = ? AND c.status = 'pending'
  `).get(conflictId);
  if (!conflict) throw new Error('Pending Outlook conflict not found.');
  const link = database.prepare(`
    SELECT * FROM outlook_event_links
     WHERE account_id = ? AND outlook_event_id = ?
     LIMIT 1
  `).get(conflict.account_id, conflict.outlook_event_id);
  if (!link) throw new Error('Outlook conflict link not found.');

  const local = safeJson(conflict.local_snapshot, null);
  const remote = safeJson(conflict.remote_snapshot, null);
  let event = conflict.event_id ? eventForSync(database, conflict.event_id) : null;

  database.transaction(() => {
    if (resolution === 'remote') {
      if (remote && event) {
        applyRemoteSnapshot(database, event, remote);
        event = eventForSync(database, event.id);
        const hash = localEventHash(event, link.outlook_calendar_id);
        database.prepare(`
          UPDATE outlook_event_links
             SET content_hash = ?, remote_content_hash = ?,
                 outlook_change_key = ?, outbound_dirty = 0,
                 outbound_attempts = 0, pending_delete = 0,
                 local_snapshot = ?, last_error = NULL
           WHERE event_id = ? AND account_id = ?
        `).run(
          hash,
          contentHash(snapshotToGraphPayload(remote), link.outlook_calendar_id),
          conflict.remote_change_key || null,
          JSON.stringify(localEventSnapshot(event)),
          event.id,
          conflict.account_id,
        );
      } else if (remote && !event) {
        const owner = accountOwnerId(database, database.prepare(
          'SELECT * FROM outlook_accounts WHERE id = ?'
        ).get(conflict.account_id));
        if (!owner) throw new Error('No local user available for Outlook conflict recovery.');
        const result = database.prepare(`
          INSERT INTO calendar_events
            (title, description, start_datetime, end_datetime, all_day, location,
             color, created_by, external_calendar_id, external_source,
             recurrence_rule, user_modified, visibility, tzid, external_object_url)
          VALUES (?, ?, ?, ?, ?, ?, '#4285F4', ?, ?, 'outlook', ?, 0, 'all', ?, ?)
        `).run(
          remote.title,
          remote.description,
          remote.start_datetime,
          remote.end_datetime,
          remote.all_day ? 1 : 0,
          remote.location,
          owner,
          conflict.outlook_event_id,
          remote.recurrence_rule,
          remote.tzid,
          remote.external_object_url,
        );
        event = eventForSync(database, result.lastInsertRowid);
        const hash = localEventHash(event, conflict.outlook_calendar_id);
        database.prepare(`
          UPDATE outlook_event_links
             SET event_id = ?, content_hash = ?, remote_content_hash = ?,
                 outbound_dirty = 0, pending_delete = 0,
                 local_snapshot = ?, last_error = NULL
           WHERE account_id = ? AND outlook_event_id = ?
        `).run(
          event.id,
          hash,
          contentHash(snapshotToGraphPayload(remote), conflict.outlook_calendar_id),
          JSON.stringify(localEventSnapshot(event)),
          conflict.account_id,
          conflict.outlook_event_id,
        );
      } else {
        if (event) {
          const otherLinks = database.prepare(`
            SELECT COUNT(*) AS count FROM outlook_event_links
             WHERE event_id = ? AND account_id <> ?
          `).get(event.id, conflict.account_id).count;
          if (otherLinks > 0) {
            if (event.external_source === 'outlook') {
              database.prepare(`
                UPDATE calendar_events
                   SET external_source = 'local', external_calendar_id = NULL,
                       external_object_url = NULL, outbound_dirty = 0,
                       outbound_attempts = 0
                 WHERE id = ?
              `).run(event.id);
            }
          } else database.prepare('DELETE FROM calendar_events WHERE id = ?').run(event.id);
        }
        database.prepare(`
          DELETE FROM outlook_event_links
           WHERE account_id = ? AND outlook_event_id = ?
        `).run(conflict.account_id, conflict.outlook_event_id);
      }
    } else {
      // “Local” means the Yuvomi version wins. If the remote object was deleted,
      // the normal outbound pass will recreate it; if local deletion won, the
      // tombstone remains and deletes the current remote version.
      database.prepare(`
        UPDATE outlook_event_links
           SET outbound_dirty = CASE WHEN ? THEN 1 ELSE 0 END,
               pending_delete = CASE WHEN ? THEN 1 ELSE pending_delete END,
               remote_missing = CASE WHEN ? THEN 1 ELSE 0 END,
               outbound_attempts = 0, local_snapshot = ?,
               outlook_change_key = COALESCE(?, outlook_change_key),
               remote_content_hash = COALESCE(?, remote_content_hash),
               last_error = NULL
         WHERE account_id = ? AND outlook_event_id = ?
      `).run(
        event ? 1 : 0,
        event ? 0 : 1,
        event && !remote ? 1 : 0,
        local ? JSON.stringify(local) : null,
        conflict.remote_change_key || null,
        remote ? contentHash(snapshotToGraphPayload(remote), conflict.outlook_calendar_id) : null,
        conflict.account_id,
        conflict.outlook_event_id,
      );
    }
    database.prepare(`
      UPDATE outlook_calendar_conflicts
         SET status = 'resolved', resolution = ?, resolved_at = ?
       WHERE id = ?
    `).run(resolution, isoNow(), conflict.id);
  })();
  return parseConflictRow({ ...conflict, status: 'resolved', resolution, resolved_at: isoNow() });
}

function getStatus() {
  const accounts = listAccounts().map((acc) => ({
    ...acc,
    enabledCalendars: db.get().prepare(
      'SELECT COUNT(*) AS count FROM outlook_calendar_selection WHERE account_id = ? AND enabled = 1'
    ).get(acc.id).count,
    pendingConflicts: db.get().prepare(`
      SELECT COUNT(*) AS count FROM outlook_calendar_conflicts
       WHERE account_id = ? AND status = 'pending'
    `).get(acc.id).count,
  }));
  return {
    configured: isConfigured(),
    accounts,
    totalAccounts: accounts.length,
    pendingConflicts: accounts.reduce((sum, account) => sum + account.pendingConflicts, 0),
  };
}

export {
  getAuthUrl,
  handleCallback,
  sync,
  getStatus,
  listAccounts,
  updateAccount,
  deleteAccount,
  listCalendars,
  listCalendarSelection,
  setCalendarEnabled,
  setCalendarSyncStartDate,
  listConflicts,
  resolveConflict,
  markEventOutbound,
  queueEventDeletion,
  flushOutbound,
  assertConfigured,
  getAccountById,
  ensureAccessToken,
  graphJson,
  graphPath,
};

export const __test = {
  rruleToGraphRecurrence,
  allDayEndToExclusive,
  toGraphDateTime,
  localEventToGraph,
  contentHash,
  collectCandidates,
  fetchRemoteEventStates,
  fetchCalendarViewDelta,
  graphCalendarViewDeltaPath,
  defaultSyncStartDate,
  defaultSyncEndDate,
  remoteEventSnapshot,
  graphRecurrenceToRRule,
  applyRemoteChanges,
  ensureAccessToken,
  graphJson,
  graphPath,
  refreshCalendarSelection,
  ReauthRequiredError,
};
