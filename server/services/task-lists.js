/**
 * Task-list identity shared by task routes and CalDAV VTODO sync.
 *
 * Stage 1 deliberately keeps this service small: it creates or refreshes the
 * provider-backed identity and leaves list CRUD/moving tasks for a later stage.
 */

import * as db from '../db.js';

function tableExists(database = db.get()) {
  return !!database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_lists'"
  ).get();
}

/**
 * Make sure one CalDAV collection has one Yuvomi Task List identity.
 *
 * Older/drifted test or installation databases may not have migration 163 yet;
 * returning null keeps the existing sync path usable until the migration runs.
 */
export function ensureCalDavTaskList({ accountId, listUrl, listName }, createdBy = null) {
  const database = db.get();
  if (!tableExists(database) || accountId == null || !listUrl) return null;

  const name = String(listName || 'Reminders').trim() || 'Reminders';
  const existing = database.prepare(`
    SELECT id
      FROM task_lists
     WHERE provider = 'caldav'
       AND external_account_id = ?
       AND external_list_url = ?
  `).get(accountId, listUrl);

  if (existing) {
    database.prepare(`
      UPDATE task_lists
         SET name = ?,
             created_by = COALESCE(created_by, ?),
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?
    `).run(name, createdBy, existing.id);
    return existing.id;
  }

  database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_url, created_by)
    VALUES (?, 'caldav', ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(name, accountId, listUrl, createdBy);

  return database.prepare(`
    SELECT id
      FROM task_lists
     WHERE provider = 'caldav'
       AND external_account_id = ?
       AND external_list_url = ?
  `).get(accountId, listUrl)?.id ?? null;
}

/** Remove provider-backed list identities when their account is deleted. */
export function removeCalDavTaskLists(accountId) {
  const database = db.get();
  if (!tableExists(database)) return 0;
  return database.prepare(
    "DELETE FROM task_lists WHERE provider = 'caldav' AND external_account_id = ?"
  ).run(accountId).changes;
}

export { tableExists as taskListsTableExists };
