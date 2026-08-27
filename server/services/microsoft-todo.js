/**
 * Microsoft To Do (Microsoft Graph) task-list synchronization.
 *
 * The service deliberately reuses outlook_accounts, its refresh-token flow, and
 * the shared Graph HTTP helper. A To Do list is materialized as a task_lists row;
 * the delta cursor is stored per list because Graph exposes one delta feed per
 * list. Yuvomi remains the source of truth for task edits made through the app,
 * while remote list/task identities are stable and never exposed with tokens.
 */
import { createLogger } from '../logger.js';
import * as dbModule from '../db.js';
import {
  ensureAccessToken,
  getStatus as getOutlookStatus,
  graphJson,
  graphPath,
} from './outlook-calendar.js';
import {
  householdTimeZone,
  isValidTimeZone,
  localToUTC,
  utcToWall,
} from '../utils/timezone.js';

const log = createLogger('MicrosoftToDo');

export const MICROSOFT_TODO_PROVIDER = 'microsoft_todo';
export const MICROSOFT_TODO_SOURCE = 'microsoft_todo';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const OUTBOUND_IN_FLIGHT = 2;
// Delta is intentionally cheap for normal polling, but it is not sufficient to
// repair a local mirror when Graph omits or coalesces a deletion event. Keep a
// persistent full-sync checkpoint per list so the safety net survives restarts.
const FULL_RESYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Microsoft Graph returns Windows time-zone names for some tenants, while the
// shared timezone helpers intentionally accept IANA names. Keep the mapping
// local so importing a task never silently falls back to UTC and shifts its
// due date. The aliases below follow Microsoft's Windows time-zone IDs.
const WINDOWS_TIME_ZONES = new Map(Object.entries({
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Pacific/Pago_Pago',
  'Aleutian Standard Time': 'America/Adak',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Marquesas Standard Time': 'Pacific/Marquesas',
  'Alaskan Standard Time': 'America/Anchorage',
  'UTC-09': 'Etc/GMT+9',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'UTC-08': 'Etc/GMT+8',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Chihuahua',
  'Mountain Standard Time': 'America/Denver',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Easter Island Standard Time': 'Pacific/Easter',
  'Central Standard Time': 'America/Chicago',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Haiti Standard Time': 'America/Port-au-Prince',
  'Cuba Standard Time': 'America/Havana',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Eastern Standard Time': 'America/New_York',
  'Turks And Caicos Standard Time': 'America/Grand_Turk',
  'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax',
  'Venezuela Standard Time': 'America/Caracas',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Tocantins Standard Time': 'America/Araguaina',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Greenland Standard Time': 'America/Godthab',
  'Montevideo Standard Time': 'America/Montevideo',
  'Magallanes Standard Time': 'America/Punta_Arenas',
  'Saint Pierre Standard Time': 'America/Miquelon',
  'Bahia Standard Time': 'America/Bahia',
  'UTC-02': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  'UTC': 'UTC',
  'Morocco Standard Time': 'Africa/Casablanca',
  'Sao Tome Standard Time': 'Africa/Sao_Tome',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Namibia Standard Time': 'Africa/Windhoek',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'South Sudan Standard Time': 'Africa/Juba',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Egypt Standard Time': 'Africa/Cairo',
  'FLE Standard Time': 'Europe/Kyiv',
  'GTB Standard Time': 'Europe/Bucharest',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Jordan Standard Time': 'Asia/Amman',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk',
  'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Russia Time Zone 3': 'Europe/Samara',
  'Mauritius Standard Time': 'Indian/Mauritius',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Omsk Standard Time': 'Asia/Omsk',
  'Myanmar Standard Time': 'Asia/Rangoon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Altai Standard Time': 'Asia/Barnaul',
  'W. Mongolia Standard Time': 'Asia/Hovd',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'Tomsk Standard Time': 'Asia/Tomsk',
  'China Standard Time': 'Asia/Shanghai',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'North Korea Standard Time': 'Asia/Pyongyang',
  'Aus Central W. Standard Time': 'Australia/Eucla',
  'Transbaikal Standard Time': 'Asia/Chita',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Lord Howe Standard Time': 'Australia/Lord_Howe',
  'Bougainville Standard Time': 'Pacific/Bougainville',
  'Russia Time Zone 10': 'Asia/Srednekolymsk',
  'Magadan Standard Time': 'Asia/Magadan',
  'Norfolk Standard Time': 'Pacific/Norfolk',
  'Sakhalin Standard Time': 'Asia/Sakhalin',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC+12': 'Etc/GMT-12',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Kamchatka Standard Time': 'Asia/Anadyr',
  'Chatham Islands Standard Time': 'Pacific/Chatham',
  'UTC+13': 'Etc/GMT-13',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia',
  'Line Islands Standard Time': 'Pacific/Kiritimati',
}).map(([name, zone]) => [name.toLowerCase(), zone]));

function activeDatabase(database) {
  return database || dbModule.get();
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function shouldRunFullResync(lastFullSync, now = Date.now()) {
  if (!lastFullSync) return true;
  const timestamp = Date.parse(lastFullSync);
  return !Number.isFinite(timestamp) || now - timestamp >= FULL_RESYNC_INTERVAL_MS;
}

function safeError(error) {
  return String(error?.message || error || 'Microsoft To Do synchronization failed.')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function accountOwner(database, account) {
  if (account.owner_user_id && database.prepare('SELECT 1 FROM users WHERE id = ?').get(account.owner_user_id)) {
    return account.owner_user_id;
  }
  return database.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get()?.id ?? null;
}

function listRow(database, accountId, listId) {
  return database.prepare(`
    SELECT tl.*, oa.name AS account_name
      FROM task_lists tl
      LEFT JOIN outlook_accounts oa ON oa.id = tl.external_account_id
     WHERE tl.provider = ? AND tl.external_account_id = ? AND tl.external_list_id = ?
  `).get(MICROSOFT_TODO_PROVIDER, accountId, listId);
}

function listRows(database, accountId) {
  return database.prepare(`
    SELECT tl.*, oa.name AS account_name
      FROM task_lists tl
      LEFT JOIN outlook_accounts oa ON oa.id = tl.external_account_id
     WHERE tl.provider = ? AND tl.external_account_id = ?
     ORDER BY tl.name COLLATE NOCASE, tl.id
  `).all(MICROSOFT_TODO_PROVIDER, accountId);
}

function publicList(row) {
  return {
    id: row.id,
    listId: row.external_list_id,
    listName: row.name,
    accountId: row.external_account_id,
    accountName: row.account_name || null,
    enabled: row.enabled !== 0,
    lastSync: row.last_sync || null,
    lastFullSync: row.last_full_sync || null,
    lastError: row.last_error || null,
  };
}

async function collectPages(path, accessToken, fetchImpl) {
  const values = [];
  let next = path;
  let deltaLink = null;
  while (next) {
    const data = await graphJson(next, accessToken, {}, fetchImpl);
    if (Array.isArray(data.value)) values.push(...data.value);
    next = graphPath(data['@odata.nextLink']);
    if (!next) deltaLink = graphPath(data['@odata.deltaLink']);
  }
  return { values, deltaLink };
}

async function fetchRemoteLists(accessToken, fetchImpl = fetch) {
  return collectPages(
    // The To Do list collection rejects `$select` for displayName with an
    // opaque "Invalid request" response, although the general Graph docs
    // describe OData query parameters as optional here. Keep `$top` for the
    // service's paging behaviour and read id/displayName from the full object.
    '/me/todo/lists?$top=100',
    accessToken,
    fetchImpl,
  );
}

function initialDeltaPath(listId) {
  // Personal Microsoft accounts currently return "Invalid request" for this
  // delta endpoint when optional OData parameters are present, even though
  // the Graph documentation lists $select and $top as supported. Let Graph
  // choose the page size and consume every returned property instead.
  return `${taskCollectionPath(listId)}/delta`;
}

function taskCollectionPath(listId) {
  return `/me/todo/lists/${encodeURIComponent(listId)}/tasks`;
}

async function fetchTaskDelta(listId, cursor, accessToken, fetchImpl = fetch, allowFullResync = true) {
  let path = cursor || initialDeltaPath(listId);
  const tasks = [];
  let deltaLink = null;
  try {
    while (path) {
      const data = await graphJson(path, accessToken, {
        // Microsoft Graph documents this header as required for todoTask
        // delta requests, including GET requests without a body.
        headers: { 'Content-Type': 'application/json' },
      }, fetchImpl);
      if (Array.isArray(data.value)) tasks.push(...data.value);
      path = graphPath(data['@odata.nextLink']);
      if (!path) deltaLink = graphPath(data['@odata.deltaLink']);
    }
  } catch (error) {
    // A saved delta cursor can expire. Do not replace it until the complete full
    // feed has been fetched and applied.
    if (allowFullResync && cursor && [400, 410].includes(error.status)) {
      const full = await fetchTaskDelta(listId, null, accessToken, fetchImpl, false);
      return { ...full, fullResync: true };
    }
    // Some personal Microsoft accounts reject the delta route itself with a
    // generic 400. Fall back to the ordinary task collection so the first
    // import still works; a full snapshot is authoritative and is reconciled
    // by applyRemoteTasks(). With no delta cursor, the next run retries delta.
    if (!cursor && error.status === 400) {
      const snapshot = await collectPages(taskCollectionPath(listId), accessToken, fetchImpl);
      return { tasks: snapshot.values, deltaLink: null, fullResync: true };
    }
    throw error;
  }
  return { tasks, deltaLink, fullResync: !cursor };
}

function importanceToPriority(importance) {
  if (importance === 'high') return 'high';
  if (importance === 'low') return 'low';
  return 'medium';
}

function statusToLocal(status) {
  if (status === 'completed') return 'done';
  if (status === 'inProgress') return 'in_progress';
  return 'open';
}

function graphBodyText(body) {
  if (!body || typeof body.content !== 'string') return null;
  if (String(body.contentType || '').toLowerCase() !== 'html') return body.content || null;
  return htmlToPlainText(body.content) || null;
}

function htmlToPlainText(value) {
  return String(value ?? '')
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
    .replace(/&#(\d+);/g, (_match, code) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10FFFF
        ? String.fromCodePoint(point)
        : '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function plainTextToHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '<br>');
}

function graphTimeZone(value) {
  const raw = String(value || 'UTC').trim();
  const zone = WINDOWS_TIME_ZONES.get(raw.toLowerCase()) || raw;
  return isValidTimeZone(zone) ? zone : 'UTC';
}

function dueDateParts(dueDateTime, targetTimeZone = householdTimeZone(null)) {
  const value = typeof dueDateTime?.dateTime === 'string' ? dueDateTime.dateTime : '';
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2})?)?/.exec(value);
  if (!match) return { due_date: null, due_time: null };
  if (!match[2]) return { due_date: match[1], due_time: null };

  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  let utc;
  if (explicitZone) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return { due_date: match[1], due_time: match[2] === '00:00' ? null : match[2] };
    }
    utc = parsed.toISOString();
  } else {
    utc = localToUTC(`${match[1]}T${match[2]}:00`, graphTimeZone(dueDateTime?.timeZone));
  }
  const wall = utcToWall(utc, targetTimeZone);
  if (!wall) return { due_date: match[1], due_time: match[2] === '00:00' ? null : match[2] };

  // Microsoft Graph has no date-only flag for To Do dueDateTime. Yuvomi uses
  // midnight in the household zone for a date-only task, and strips that
  // implementation detail again on import.
  return { due_date: wall.date, due_time: wall.time.slice(0, 5) === '00:00' ? null : wall.time.slice(0, 5) };
}

function remoteTaskValues(remote, timeZone = householdTimeZone(null)) {
  const due = dueDateParts(remote.dueDateTime, timeZone);
  return {
    title: String(remote.title || 'Microsoft To Do task').trim() || 'Microsoft To Do task',
    description: graphBodyText(remote.body),
    priority: importanceToPriority(remote.importance),
    status: statusToLocal(remote.status),
    due_date: due.due_date,
    due_time: due.due_time,
  };
}

function graphTaskUrl(listId, taskId) {
  return `${GRAPH_BASE}/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;
}

function applyRemoteTasks(database, account, list, changes, timeZone = householdTimeZone(database)) {
  const ownerId = accountOwner(database, account);
  const existing = database.prepare(`
    SELECT * FROM tasks
     WHERE external_source = ? AND external_account_id = ? AND task_list_id = ?
  `).all(MICROSOFT_TODO_SOURCE, account.id, list.id);
  const byUid = new Map(existing.filter((row) => row.external_uid).map((row) => [row.external_uid, row]));
  const seen = new Set();
  let created = 0;
  let updated = 0;
  let deleted = 0;

  const insert = database.prepare(`
    INSERT INTO tasks
      (title, description, category, priority, status, due_date, due_time,
       created_by, visibility, external_uid, external_source, external_account_id,
       external_object_url, outbound_dirty, outbound_attempts, task_list_id)
    VALUES (?, ?, 'misc', ?, ?, ?, ?, ?, 'all', ?, ?, ?, ?, 0, 0, ?)
  `);
  const update = database.prepare(`
    UPDATE tasks
       SET title = ?, description = ?, priority = ?, status = ?, due_date = ?, due_time = ?,
           external_object_url = ?, task_list_id = ?, outbound_dirty = 0,
           outbound_attempts = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
  `);
  const remove = database.prepare(
    'DELETE FROM tasks WHERE external_source = ? AND external_account_id = ? AND external_uid = ? AND task_list_id = ?'
  );

  for (const remote of changes.tasks) {
    const uid = String(remote?.id || '');
    if (!uid) continue;
    seen.add(uid);
    const old = byUid.get(uid);
    if (remote['@removed']) {
      // Let the outbound PATCH recover a locally edited task when Graph reports
      // that its previous remote object disappeared. Deleting the dirty row
      // here would lose the user's edit before the 404->POST recovery runs.
      if (old?.outbound_dirty) continue;
      if (remove.run(MICROSOFT_TODO_SOURCE, account.id, uid, list.id).changes) deleted += 1;
      continue;
    }

    const values = remoteTaskValues(remote, timeZone);
    if (old) {
      // A local edit has an outbound marker. Keep it until the PATCH succeeds;
      // otherwise a quick inbound run could silently erase the user's change.
      if (old.outbound_dirty) continue;
      update.run(
        values.title,
        values.description,
        values.priority,
        values.status,
        values.due_date,
        values.due_time,
        graphTaskUrl(list.external_list_id, uid),
        list.id,
        old.id,
      );
      updated += 1;
    } else {
      insert.run(
        values.title,
        values.description,
        values.priority,
        values.status,
        values.due_date,
        values.due_time,
        ownerId,
        uid,
        MICROSOFT_TODO_SOURCE,
        account.id,
        graphTaskUrl(list.external_list_id, uid),
        list.id,
      );
      created += 1;
    }
  }

  // A full feed is authoritative for this list. Prune remote tasks absent from
  // it, but leave dirty rows for the next outbound attempt.
  if (changes.fullResync) {
    const stale = existing.filter((row) => row.external_uid && !seen.has(row.external_uid) && !row.outbound_dirty);
    const deleteStale = database.prepare('DELETE FROM tasks WHERE id = ?');
    for (const row of stale) {
      if (deleteStale.run(row.id).changes) deleted += 1;
    }
  }

  return { created, updated, deleted };
}

function setTodoReauth(database, accountId, required) {
  database.prepare('UPDATE outlook_accounts SET todo_needs_reauth = ? WHERE id = ?')
    .run(required ? 1 : 0, accountId);
}

function markListError(database, listId, error) {
  database.prepare('UPDATE task_lists SET last_error = ? WHERE id = ?')
    .run(safeError(error), listId);
}

function upsertRemoteLists(database, accountId, remoteLists, ownerId) {
  const known = new Map(listRows(database, accountId).map((row) => [row.external_list_id, row]));
  const remoteIds = new Set();
  const insert = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const update = database.prepare(`
    UPDATE task_lists
       SET name = ?, last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
  `);
  for (const remote of remoteLists) {
    const listId = String(remote?.id || '');
    if (!listId) continue;
    remoteIds.add(listId);
    const name = String(remote.displayName || 'Microsoft To Do').trim() || 'Microsoft To Do';
    const old = known.get(listId);
    if (old) update.run(name, old.id);
    else insert.run(name, MICROSOFT_TODO_PROVIDER, accountId, listId, ownerId);
  }

  // The list collection is authoritative once all pagination has completed.
  // Retain the tasks as local work when a remote list disappears instead of
  // leaving a permanently failing sidebar entry and an unusable Graph target.
  const detach = database.prepare(`
    UPDATE tasks
       SET external_source = 'local', external_uid = NULL,
           external_account_id = NULL, external_object_url = NULL,
           outbound_dirty = 0, outbound_attempts = 0
     WHERE external_source = ? AND task_list_id = ?
  `);
  const remove = database.prepare('DELETE FROM task_lists WHERE id = ?');
  for (const row of known.values()) {
    if (row.external_list_id && !remoteIds.has(String(row.external_list_id))) {
      detach.run(MICROSOFT_TODO_SOURCE, row.id);
      remove.run(row.id);
    }
  }
  return listRows(database, accountId);
}

async function refreshTaskLists(account, { database, fetchImpl = fetch, accessToken } = {}) {
  const activeDb = activeDatabase(database);
  const token = accessToken || await ensureAccessToken(account, fetchImpl, activeDb);
  const { values } = await fetchRemoteLists(token, fetchImpl);
  const ownerId = accountOwner(activeDb, account);
  const rows = activeDb.transaction(() => upsertRemoteLists(activeDb, account.id, values, ownerId))();
  return { rows, remoteIds: new Set(values.map((list) => String(list.id))) };
}

function isReauthError(error) {
  return error?.status === 401 || error?.status === 403 || error?.name === 'ReauthRequiredError';
}

/**
 * List materialized To Do lists. `refresh=true` discovers new Graph lists while
 * retaining the local enabled state of known lists.
 */
export async function listTaskLists(accountId, { refresh = false, database, fetchImpl = fetch } = {}) {
  const activeDb = activeDatabase(database);
  const account = activeDb.prepare('SELECT * FROM outlook_accounts WHERE id = ?').get(accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);
  if (refresh) {
    try {
      await refreshTaskLists(account, { database: activeDb, fetchImpl });
      setTodoReauth(activeDb, account.id, false);
    } catch (error) {
      if (isReauthError(error)) setTodoReauth(activeDb, account.id, true);
      throw error;
    }
  }
  return listRows(activeDb, accountId).map(publicList);
}

export function setTaskListEnabled(accountId, listId, enabled, { database } = {}) {
  const activeDb = activeDatabase(database);
  const result = activeDb.prepare(`
    UPDATE task_lists SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE provider = ? AND external_account_id = ? AND external_list_id = ?
  `).run(enabled ? 1 : 0, MICROSOFT_TODO_PROVIDER, accountId, listId);
  if (!result.changes) throw new Error(`Microsoft To Do list not found for account ${accountId}.`);
  return { success: true };
}

function graphTaskPayload(task, timeZone = householdTimeZone(null)) {
  const payload = {
    title: String(task.title || 'Microsoft To Do task'),
    status: task.status === 'done' ? 'completed' : task.status === 'in_progress' ? 'inProgress' : 'notStarted',
    importance: ['high', 'urgent'].includes(task.priority) ? 'high' : task.priority === 'low' ? 'low' : 'normal',
  };
  const description = String(task.description || '');
  payload.body = { content: plainTextToHtml(description), contentType: 'html' };
  if (!task.due_date) {
    payload.dueDateTime = null;
  } else {
    const local = `${task.due_date}T${task.due_time || '00:00'}:00`;
    const utc = localToUTC(local, timeZone);
    const parsed = new Date(utc);
    payload.dueDateTime = Number.isNaN(parsed.getTime())
      ? { dateTime: local, timeZone }
      : { dateTime: parsed.toISOString().slice(0, 19), timeZone: 'UTC' };
  }
  return payload;
}

function pendingDeletionRows(database) {
  return database.prepare(`
    SELECT d.*
      FROM microsoft_todo_pending_deletions d
     ORDER BY d.id
  `).all();
}

function queueRemoteDeletion(database, accountId, listId, taskUid) {
  if (accountId == null || !listId || !taskUid) return false;
  database.prepare(`
    INSERT INTO microsoft_todo_pending_deletions (account_id, list_id, task_uid)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id, list_id, task_uid) DO NOTHING
  `).run(accountId, listId, taskUid);
  return true;
}

function markDeletionFailure(database, row, error) {
  database.prepare(`
    UPDATE microsoft_todo_pending_deletions
       SET attempts = attempts + 1, last_error = ? WHERE id = ?
  `).run(safeError(error), row.id);
}

async function flushPendingDeletions(account, accessToken, { database, fetchImpl }) {
  const rows = pendingDeletionRows(database).filter((row) => row.account_id === account.id);
  let deleted = 0;
  for (const row of rows) {
    try {
      await graphJson(
        `/me/todo/lists/${encodeURIComponent(row.list_id)}/tasks/${encodeURIComponent(row.task_uid)}`,
        accessToken,
        { method: 'DELETE' },
        fetchImpl,
      );
      database.prepare('DELETE FROM microsoft_todo_pending_deletions WHERE id = ?').run(row.id);
      deleted += 1;
    } catch (error) {
      if (error.status === 404) {
        database.prepare('DELETE FROM microsoft_todo_pending_deletions WHERE id = ?').run(row.id);
        deleted += 1;
      } else {
        markDeletionFailure(database, row, error);
      }
    }
  }
  return deleted;
}

async function flushOutboundTasks(account, accessToken, { database, fetchImpl }) {
  const timeZone = householdTimeZone(database);

  // A process can disappear after claiming a row. Recover such claims at the
  // beginning of the next run; a user edit made during a live request is 1 and
  // therefore remains pending.
  database.prepare(`
    UPDATE tasks
       SET outbound_dirty = CASE WHEN external_source = ? THEN 1 ELSE 0 END
     WHERE outbound_dirty = ?
       AND task_list_id IN (
         SELECT id FROM task_lists
          WHERE provider = ? AND external_account_id = ?
       )
  `).run(MICROSOFT_TODO_SOURCE, OUTBOUND_IN_FLIGHT, MICROSOFT_TODO_PROVIDER, account.id);

  const candidates = database.prepare(`
    SELECT t.*, tl.external_list_id, tl.external_account_id
      FROM tasks t
      JOIN task_lists tl ON tl.id = t.task_list_id
     WHERE tl.provider = ? AND tl.external_account_id = ? AND tl.enabled = 1
       AND t.parent_task_id IS NULL
       AND (
         t.external_source = 'local'
         OR (t.external_source = ? AND t.outbound_dirty = 1)
       )
     ORDER BY t.id
  `).all(MICROSOFT_TODO_PROVIDER, account.id, MICROSOFT_TODO_SOURCE);

  let created = 0;
  let updated = 0;
  let failed = 0;
  for (const task of candidates) {
    const dirtyBefore = task.outbound_dirty === 1 ? 1 : 0;
    const claim = task.external_source === 'local'
      ? database.prepare(`
          UPDATE tasks SET outbound_dirty = ?
           WHERE id = ? AND external_source = 'local' AND outbound_dirty != ?
        `).run(OUTBOUND_IN_FLIGHT, task.id, OUTBOUND_IN_FLIGHT)
      : database.prepare(`
          UPDATE tasks SET outbound_dirty = ?
           WHERE id = ? AND external_source = ? AND outbound_dirty = 1
        `).run(OUTBOUND_IN_FLIGHT, task.id, MICROSOFT_TODO_SOURCE);
    if (!claim.changes) continue;

    try {
      const path = `/me/todo/lists/${encodeURIComponent(task.external_list_id)}/tasks`;
      if (task.external_source === 'local') {
        const remote = await graphJson(path, accessToken, {
          method: 'POST',
          body: graphTaskPayload(task, timeZone),
        }, fetchImpl);
        if (!remote?.id) throw new Error('Microsoft To Do did not return a task id.');
        const current = database.prepare('SELECT task_list_id FROM tasks WHERE id = ?').get(task.id);
        if (!current || Number(current.task_list_id) !== Number(task.task_list_id)) {
          queueRemoteDeletion(database, account.id, task.external_list_id, String(remote.id));
        } else {
          database.prepare(`
            UPDATE tasks
               SET external_uid = ?, external_source = ?, external_account_id = ?,
                   external_object_url = ?,
                   outbound_dirty = CASE WHEN outbound_dirty = 1 THEN 1 ELSE 0 END,
                   outbound_attempts = 0,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
             WHERE id = ? AND task_list_id = ?
          `).run(
            String(remote.id),
            MICROSOFT_TODO_SOURCE,
            account.id,
            graphTaskUrl(task.external_list_id, remote.id),
            task.id,
            task.task_list_id,
          );
        }
        created += 1;
      } else {
        try {
          await graphJson(
            `${path}/${encodeURIComponent(task.external_uid)}`,
            accessToken,
            { method: 'PATCH', body: graphTaskPayload(task, timeZone) },
            fetchImpl,
          );
        } catch (error) {
          // A remote deletion is not a local list move. Recreate the task so a
          // Yuvomi edit remains durable, matching the Outlook calendar sync rule.
          if (error.status !== 404) throw error;
          const current = database.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
          if (!current || Number(current.task_list_id) !== Number(task.task_list_id)) {
            queueRemoteDeletion(database, account.id, task.external_list_id, task.external_uid);
            updated += 1;
            continue;
          }
          const remote = await graphJson(path, accessToken, {
            method: 'POST',
            body: graphTaskPayload(current, timeZone),
          }, fetchImpl);
          if (!remote?.id) throw new Error('Microsoft To Do did not return a task id.');
          database.prepare(`
            UPDATE tasks
             SET external_uid = ?, external_object_url = ?, outbound_dirty =
                   CASE WHEN outbound_dirty = 1 THEN 1 ELSE 0 END,
                   outbound_attempts = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE id = ? AND task_list_id = ?
          `).run(
            String(remote.id),
            graphTaskUrl(task.external_list_id, remote.id),
            task.id,
            task.task_list_id,
          );
        }
        const current = database.prepare('SELECT task_list_id FROM tasks WHERE id = ?').get(task.id);
        if (!current || Number(current.task_list_id) !== Number(task.task_list_id)) {
          queueRemoteDeletion(database, account.id, task.external_list_id, task.external_uid);
        } else {
          database.prepare(`
            UPDATE tasks
               SET outbound_dirty = CASE WHEN outbound_dirty = 1 THEN 1 ELSE 0 END,
                   outbound_attempts = 0
             WHERE id = ? AND task_list_id = ?
          `).run(task.id, task.task_list_id);
        }
        updated += 1;
      }
    } catch (error) {
      database.prepare(`
        UPDATE tasks
           SET outbound_dirty = CASE WHEN outbound_dirty = ? THEN ? ELSE outbound_dirty END,
               outbound_attempts = outbound_attempts + 1
         WHERE id = ?
      `).run(OUTBOUND_IN_FLIGHT, dirtyBefore, task.id);
      failed += 1;
      log.error(`Outbound task sync failed for account ${account.id}, task ${task.id}:`, safeError(error));
    }
  }
  return { created, updated, failed };
}

/** Mark a mirrored Microsoft task for the next outbound PATCH. */
export function markTaskOutbound(before, after, database) {
  const changed = ['title', 'description', 'priority', 'status', 'due_date', 'due_time']
    .some((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
  if (!changed) return false;
  const activeDb = activeDatabase(database);
  const taskId = after.id ?? before.id;
  const taskListId = after.task_list_id ?? before.task_list_id;
  const isNewMicrosoftTarget = before?.external_source === 'local' && taskListId != null
    && activeDb.prepare(
      'SELECT 1 FROM task_lists WHERE id = ? AND provider = ?'
    ).get(taskListId, MICROSOFT_TODO_PROVIDER);
  if (before?.external_source !== MICROSOFT_TODO_SOURCE && !isNewMicrosoftTarget) return false;
  return activeDb.prepare(`
    UPDATE tasks
       SET outbound_dirty = 1, outbound_attempts = 0
     WHERE id = ?
       AND (
         external_source = ?
         OR (external_source = 'local' AND task_list_id = ?)
       )
  `).run(taskId, MICROSOFT_TODO_SOURCE, taskListId).changes > 0;
}

/** Preserve a remote identity after the local row is deleted. */
export function queueTaskDeletion(task, database) {
  if (task?.external_source !== MICROSOFT_TODO_SOURCE || !task.external_uid || !task.task_list_id) return false;
  const activeDb = activeDatabase(database);
  const list = activeDb.prepare(`
    SELECT external_account_id, external_list_id
      FROM task_lists WHERE id = ? AND provider = ?
  `).get(task.task_list_id, MICROSOFT_TODO_PROVIDER);
  return queueRemoteDeletion(
    activeDb,
    list?.external_account_id,
    list?.external_list_id,
    task.external_uid,
  );
}

/**
 * Synchronize all connected Outlook accounts. Each list's cursor is persisted
 * only after its complete delta pages and all task changes succeed.
 */
let syncInFlight = null;
let syncInFlightForceFull = false;

async function syncInternal({ database, fetchImpl = fetch, forceFull = false } = {}) {
  const activeDb = activeDatabase(database);
  const timeZone = householdTimeZone(activeDb);
  const accounts = activeDb.prepare('SELECT * FROM outlook_accounts ORDER BY id').all();
  const result = {
    success: true,
    syncedAccounts: 0,
    lists: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    fullResyncLists: 0,
    failed: 0,
  };

  if (accounts.length && !getOutlookStatus().configured) {
    log.warn('Microsoft accounts exist but MS_* configuration is incomplete; skipping To Do sync.');
    return { ...result, success: false };
  }

  for (const account of accounts) {
    if (account.todo_needs_reauth) {
      log.debug(`Microsoft account ${account.id} needs To Do reconnect, skipping.`);
      continue;
    }
    let accountFailed = false;
    try {
      const accessToken = await ensureAccessToken(account, fetchImpl, activeDb);
      result.deleted += await flushPendingDeletions(account, accessToken, {
        database: activeDb,
        fetchImpl,
      });
      const discovered = await refreshTaskLists(account, {
        database: activeDb,
        fetchImpl,
        accessToken,
      });
      setTodoReauth(activeDb, account.id, false);

      for (const list of discovered.rows) {
        if (!list.enabled || !discovered.remoteIds.has(String(list.external_list_id))) continue;
        try {
          const runFullResync = forceFull || shouldRunFullResync(list.last_full_sync);
          const changes = await fetchTaskDelta(
            list.external_list_id,
            runFullResync ? null : list.sync_cursor,
            accessToken,
            fetchImpl,
          );
          const completedFullResync = runFullResync || changes.fullResync;
          const syncedAt = nowIso();
          const counts = activeDb.transaction(() => {
            const applied = applyRemoteTasks(activeDb, account, list, changes, timeZone);
            activeDb.prepare(`
              UPDATE task_lists
                 SET sync_cursor = ?, last_sync = ?, last_full_sync = ?, last_error = NULL,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
               WHERE id = ?
            `).run(
              changes.deltaLink,
              syncedAt,
              completedFullResync ? syncedAt : list.last_full_sync,
              list.id,
            );
            return applied;
          })();
          result.created += counts.created;
          result.updated += counts.updated;
          result.deleted += counts.deleted;
          if (completedFullResync) result.fullResyncLists += 1;
          result.lists += 1;
        } catch (error) {
          accountFailed = true;
          result.success = false;
          result.failed += 1;
          markListError(activeDb, list.id, error);
          if (isReauthError(error)) setTodoReauth(activeDb, account.id, true);
          log.error(`To Do list sync failed for account ${account.id}, list ${list.id}:`, safeError(error));
        }
      }

      if (!accountFailed) {
        const outbound = await flushOutboundTasks(account, accessToken, {
          database: activeDb,
          fetchImpl,
        });
        result.created += outbound.created;
        result.updated += outbound.updated;
        result.failed += outbound.failed;
        if (outbound.failed) accountFailed = true;
      }
      if (!accountFailed) result.syncedAccounts += 1;
    } catch (error) {
      result.success = false;
      result.failed += 1;
      if (isReauthError(error)) setTodoReauth(activeDb, account.id, true);
      log.error(`Microsoft To Do sync failed for account ${account.id}:`, safeError(error));
    }
  }

  return result;
}

/** Serialize scheduler, manual, and OAuth-triggered syncs for shared accounts. */
export function sync(options = {}) {
  const forceFull = Boolean(options.forceFull);
  if (syncInFlight) {
    if (!forceFull || syncInFlightForceFull) return syncInFlight;

    // Do not let a manual full check disappear behind an already-running
    // scheduler Delta poll. Queue it after the current run, even if that run
    // fails, so the manual action still gets its authoritative reconciliation.
    const previous = syncInFlight;
    const queued = previous.then(
      () => syncInternal(options),
      () => syncInternal(options),
    );
    let wrapped;
    wrapped = queued.finally(() => {
      if (syncInFlight === wrapped) {
        syncInFlight = null;
        syncInFlightForceFull = false;
      }
    });
    syncInFlightForceFull = true;
    syncInFlight = wrapped;
    return syncInFlight;
  }

  const running = syncInternal(options);
  let wrapped;
  wrapped = running.finally(() => {
    if (syncInFlight === wrapped) {
      syncInFlight = null;
      syncInFlightForceFull = false;
    }
  });
  syncInFlightForceFull = forceFull;
  syncInFlight = wrapped;
  return syncInFlight;
}

export function getStatus({ database } = {}) {
  const activeDb = activeDatabase(database);
  const accounts = activeDb.prepare(`
    SELECT id, todo_needs_reauth,
      (SELECT COUNT(*) FROM task_lists tl
        WHERE tl.provider = ? AND tl.external_account_id = oa.id) AS task_lists,
      (SELECT COUNT(*) FROM task_lists tl
        WHERE tl.provider = ? AND tl.external_account_id = oa.id AND tl.enabled = 1) AS enabled_task_lists
      FROM outlook_accounts oa ORDER BY id
  `).all(MICROSOFT_TODO_PROVIDER, MICROSOFT_TODO_PROVIDER).map((row) => ({
    accountId: row.id,
    needsReauth: row.todo_needs_reauth === 1,
    taskLists: row.task_lists,
    enabledTaskLists: row.enabled_task_lists,
  }));
  return { accounts };
}

export const __test = {
  collectPages,
  fetchRemoteLists,
  fetchTaskDelta,
  shouldRunFullResync,
  FULL_RESYNC_INTERVAL_MS,
  dueDateParts,
  remoteTaskValues,
  graphTaskPayload,
  publicList,
  graphTaskUrl,
};
