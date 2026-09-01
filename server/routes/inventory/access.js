/**
 * Inventory asset ownership and visibility.
 *
 * Family assets are administered by household admins. Personal assets belong
 * to their creator. Sharing controls reading only; shared recipients never
 * gain edit/delete rights.
 */
import * as db from '../../db.js';
import { normalizeVisibility, visibilityWhere } from '../../services/visibility.js';

export const ASSET_SCOPES = Object.freeze(['family', 'personal']);

export function actorId(req) {
  return req.authUserId || req.session?.userId || null;
}

export function isAdmin(req) {
  return req.authRole === 'admin' || req.session?.role === 'admin';
}

export function inventoryVisibilityWhere(alias = 'ii', bind = '@me', admin = false) {
  const shared = visibilityWhere(alias, 'inventory_item_assignments', 'item_id', bind);
  return admin ? `(${alias}.asset_scope = 'family' OR ${shared})` : shared;
}

export function canReadItem(item, userId, admin = false) {
  if (!item || !userId) return false;
  if (admin && item.asset_scope === 'family') return true;
  if (Number(item.created_by) === Number(userId)) return true;
  if (item.visibility === 'all') return true;
  if (item.visibility !== 'assignees') return false;
  return Boolean(db.get().prepare(`
    SELECT 1 FROM inventory_item_assignments WHERE item_id = ? AND user_id = ?
  `).get(item.id, userId));
}

export function canEditItem(item, userId, admin = false) {
  if (!item || !userId) return false;
  if (item.asset_scope === 'family') return admin;
  return Number(item.created_by) === Number(userId);
}

export function loadAssignedUsers(itemIds) {
  const result = new Map();
  if (!itemIds.length) return result;
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db.get().prepare(`
    SELECT ia.item_id, u.id, u.display_name, u.username, u.avatar_data
    FROM inventory_item_assignments ia
    JOIN users u ON u.id = ia.user_id
    WHERE ia.item_id IN (${placeholders})
    ORDER BY u.display_name COLLATE NOCASE, u.username COLLATE NOCASE
  `).all(...itemIds);
  for (const row of rows) {
    if (!result.has(row.item_id)) result.set(row.item_id, []);
    const { item_id: _itemId, ...user } = row;
    result.get(row.item_id).push(user);
  }
  return result;
}

export function validateAssignedUserIds(raw) {
  if (raw === undefined) return { value: undefined, error: null };
  if (!Array.isArray(raw)) return { value: null, error: 'assigned_user_ids must be an array.' };
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) {
    return { value: null, error: 'assigned_user_ids contains an invalid user ID.' };
  }
  if (!ids.length) return { value: [], error: null };
  const placeholders = ids.map(() => '?').join(',');
  const found = db.get().prepare(`SELECT id FROM users WHERE id IN (${placeholders})`).all(...ids);
  if (found.length !== ids.length) return { value: null, error: 'Assigned user not found.' };
  return { value: ids, error: null };
}

export function replaceAssignments(itemId, userIds = []) {
  const database = db.get();
  database.prepare('DELETE FROM inventory_item_assignments WHERE item_id = ?').run(itemId);
  const insert = database.prepare(`
    INSERT INTO inventory_item_assignments (item_id, user_id) VALUES (?, ?)
  `);
  for (const userId of userIds) insert.run(itemId, userId);
}

export function normalizeAssetVisibility(scope, value) {
  return normalizeVisibility(value, scope === 'personal' ? 'private' : 'all');
}
