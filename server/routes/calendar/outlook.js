/**
 * Modul: Kalender (Calendar) - Outlook-Sync (Microsoft Graph, bidirektional)
 * OAuth-Connect, Konten, Kalenderauswahl, manueller Sync, Status.
 *
 * Konten entstehen ausschließlich über den OAuth-Callback (kein POST /accounts).
 * Alle Verwaltungsrouten sind admin-only (Parität caldav_accounts); Familien-
 * mitglieder erhalten die wählbaren Ziele über die gemeinsame Lese-Route
 * GET /calendar/sync-targets (#618).
 */

import { createLogger } from '../../logger.js';
import express from 'express';
import * as outlookCalendar from '../../services/outlook-calendar.js';
import * as microsoftTodo from '../../services/microsoft-todo.js';
import { requireAdmin } from '../../auth.js';

const log = createLogger('Calendar');
const router = express.Router();

/**
 * GET /api/v1/calendar/outlook/auth
 * Admin only. Leitet zum Microsoft-Consent-Screen weiter (persönliche Konten).
 */
router.get('/outlook/auth', requireAdmin, (req, res) => {
  try {
    const url = outlookCalendar.getAuthUrl(req.session);
    res.redirect(url);
  } catch (err) {
    log.error('', err);
    res.status(503).json({ error: err.message, code: 503 });
  }
});

/**
 * GET /api/v1/calendar/outlook/callback
 * OAuth-Callback von Microsoft. Tauscht Code gegen Tokens, lädt die Kalender
 * und stößt einen initialen Push an.
 * Query: ?code=...&state=...
 */
router.get('/outlook/callback', async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) return res.redirect('/settings?sync_error=outlook');
    if (!code)  return res.status(400).json({ error: 'Kein Code erhalten.', code: 400 });

    // OAuth CSRF-Schutz: state-Parameter validieren
    if (!state || !req.session.outlookOAuthState || state !== req.session.outlookOAuthState) {
      log.error('Outlook OAuth state mismatch');
      return res.redirect('/settings?sync_error=outlook');
    }
    delete req.session.outlookOAuthState;

    await outlookCalendar.handleCallback(code);
    await outlookCalendar.sync();
    await microsoftTodo.sync();

    res.redirect('/settings?sync_ok=outlook');
  } catch (err) {
    log.error('', err);
    res.redirect('/settings?sync_error=outlook');
  }
});

/**
 * GET /api/v1/calendar/outlook/accounts
 * Admin only (Kontoverwaltung in den Einstellungen; der Termin-Dialog liest
 * über /calendar/sync-targets).
 * Response: { data: [{ id, name, email, needsReauth, lastSync, lastError,
 *                      autoSyncCalendarId, ownerUserId }] }
 */
router.get('/outlook/accounts', requireAdmin, (req, res) => {
  try {
    // Laut wie Google (/google/calendars): fehlende Konfiguration wirft und
    // landet als Error im Log, statt still eine leere Liste zu liefern.
    outlookCalendar.assertConfigured();
    res.json({ data: outlookCalendar.listAccounts() });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message || 'Failed to list Outlook accounts.', code: 500 });
  }
});

/**
 * PUT /api/v1/calendar/outlook/accounts/:id
 * Admin only. Partial-Update: Name, Auto-Sync-Zielkalender, Konto-Owner.
 * Body: { name?, autoSyncCalendarId?: string|null, ownerUserId?: number|null }
 * Auto-Sync ist aktiv, sobald Zielkalender UND Owner gesetzt sind; null
 * deaktiviert das jeweilige Feld.
 */
router.put('/outlook/accounts/:id', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { name, autoSyncCalendarId, ownerUserId } = req.body;
    const result = outlookCalendar.updateAccount(accountId, { name, autoSyncCalendarId, ownerUserId });
    res.json({ data: result });
  } catch (err) {
    log.error('Outlook account update failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update Outlook account.', code: 500 });
  }
});

/**
 * DELETE /api/v1/calendar/outlook/accounts/:id
 * Admin only. Konto trennen und löschen. Bereits gepushte Events bleiben
 * in Outlook stehen; lokale Events verlieren ihr Outlook-Ziel.
 */
router.delete('/outlook/accounts/:id', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const result = outlookCalendar.deleteAccount(accountId);
    res.json({ data: result });
  } catch (err) {
    log.error('Outlook account deletion failed:', err);
    res.status(500).json({ error: err.message || 'Failed to delete Outlook account.', code: 500 });
  }
});

/**
 * GET /api/v1/calendar/outlook/accounts/:id/calendars
 * Admin only. Kalenderliste eines Kontos (aus der DB; ?refresh=true lädt neu
 * von Graph).
 */
router.get('/outlook/accounts/:id/calendars', requireAdmin, async (req, res) => {
  try {
    outlookCalendar.assertConfigured();
    const accountId = parseInt(req.params.id, 10);
    const refresh = req.query.refresh === 'true';
    const calendars = await outlookCalendar.listCalendars(accountId, { refresh });
    res.json({ data: calendars });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message || 'Failed to fetch calendars.', code: 500 });
  }
});

/**
 * PATCH /api/v1/calendar/outlook/accounts/:id/calendars
 * Admin only. Kalender für den bidirektionalen Sync aktivieren/deaktivieren
 * und den absoluten Beginn des Importfensters setzen.
 * Body: { calendarId: string, enabled?: boolean, syncStartDate?: string|null }
 */
router.patch('/outlook/accounts/:id/calendars', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { calendarId, enabled, syncStartDate } = req.body;
    if (!calendarId || typeof calendarId !== 'string') {
      return res.status(400).json({ error: 'calendarId fehlt oder ist ungültig.', code: 400 });
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled muss ein Boolean sein.', code: 400 });
    }
    if (syncStartDate !== undefined
        && syncStartDate !== null
        && typeof syncStartDate !== 'string') {
      return res.status(400).json({ error: 'syncStartDate muss ein Datum oder null sein.', code: 400 });
    }
    if (enabled === undefined && syncStartDate === undefined) {
      return res.status(400).json({ error: 'Keine Kalender-Einstellung angegeben.', code: 400 });
    }
    const result = syncStartDate !== undefined
      ? outlookCalendar.setCalendarSyncStartDate(accountId, calendarId, syncStartDate)
      : { success: true };
    if (enabled !== undefined) outlookCalendar.setCalendarEnabled(accountId, calendarId, enabled);
    res.json({ data: result });
  } catch (err) {
    log.error('Outlook calendar selection update failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update calendar selection.', code: 500 });
  }
});

/**
 * GET /api/v1/calendar/outlook/conflicts
 * Admin only. Liefert ungeklärte Zwei-Wege-Konflikte inklusive lokaler und
 * Outlook-Version, damit die Settings-Seite eine Auswahl anbieten kann.
 */
router.get('/outlook/conflicts', requireAdmin, (req, res) => {
  try {
    const status = req.query.status || 'pending';
    if (!['pending', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'status muss pending oder resolved sein.', code: 400 });
    }
    res.json({ data: outlookCalendar.listConflicts({ status }) });
  } catch (err) {
    log.error('Outlook conflict list failed:', err);
    res.status(500).json({ error: err.message || 'Failed to list Outlook conflicts.', code: 500 });
  }
});

/**
 * POST /api/v1/calendar/outlook/conflicts/:id/resolve
 * Admin only. Resolution is deliberately explicit: local or remote wins.
 */
router.post('/outlook/conflicts/:id/resolve', requireAdmin, async (req, res) => {
  try {
    const conflictId = parseInt(req.params.id, 10);
    if (!Number.isInteger(conflictId) || conflictId < 1) {
      return res.status(400).json({ error: 'Ungültige Konflikt-ID.', code: 400 });
    }
    const result = outlookCalendar.resolveConflict(conflictId, req.body?.resolution);
    // A resolution is an explicit user decision. Push it immediately so the
    // chosen version does not wait for the next scheduled synchronization.
    const sync = await outlookCalendar.flushOutbound();
    res.json({ data: { ...result, sync } });
  } catch (err) {
    log.error('Outlook conflict resolution failed:', err);
    const notFound = /not found/i.test(err.message || '');
    res.status(notFound ? 404 : 400).json({
      error: err.message || 'Failed to resolve Outlook conflict.',
      code: notFound ? 404 : 400,
    });
  }
});

/**
 * GET /api/v1/calendar/outlook/accounts/:id/todo-lists
 * Admin only. Lists are materialized as Yuvomi Task Lists; refresh=true
 * discovers new Microsoft To Do lists while retaining enabled state.
 */
router.get('/outlook/accounts/:id/todo-lists', requireAdmin, async (req, res) => {
  try {
    outlookCalendar.assertConfigured();
    const accountId = parseInt(req.params.id, 10);
    const lists = await microsoftTodo.listTaskLists(accountId, {
      refresh: req.query.refresh === 'true',
    });
    res.json({ data: lists });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message || 'Failed to fetch Microsoft To Do lists.', code: 500 });
  }
});

/**
 * PATCH /api/v1/calendar/outlook/accounts/:id/todo-lists
 * Admin only. Enable or disable one discovered remote list.
 * Body: { listId: string, enabled: boolean }
 */
router.patch('/outlook/accounts/:id/todo-lists', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { listId, enabled } = req.body;
    if (!listId || typeof listId !== 'string') {
      return res.status(400).json({ error: 'listId fehlt oder ist ungültig.', code: 400 });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled muss ein Boolean sein.', code: 400 });
    }
    const result = microsoftTodo.setTaskListEnabled(accountId, listId, enabled);
    res.json({ data: result });
  } catch (err) {
    log.error('Microsoft To Do list selection update failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update Microsoft To Do list.', code: 500 });
  }
});

/** POST /api/v1/calendar/outlook/todo/sync - manual Microsoft To Do sync. */
router.post('/outlook/todo/sync', requireAdmin, async (req, res) => {
  try {
    outlookCalendar.assertConfigured();
    // A user-triggered check must repair missing remote deletions immediately;
    // scheduled runs use the cheaper delta path and periodically force a full
    // reconciliation themselves.
    const result = await microsoftTodo.sync({ forceFull: true });
    res.json({ data: result });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message || 'Microsoft To Do sync failed.', code: 500 });
  }
});

/** GET /api/v1/calendar/outlook/todo/status - non-secret To Do status. */
router.get('/outlook/todo/status', (req, res) => {
  try {
    res.json({ data: microsoftTodo.getStatus() });
  } catch (err) {
    log.error('Microsoft To Do status failed:', err);
    res.status(500).json({ error: 'Failed to get Microsoft To Do status.', code: 500 });
  }
});

/**
 * POST /api/v1/calendar/outlook/sync
 * Admin only. Manueller bidirektionaler Sync-Trigger.
 * Response: { data: { success, syncedAccounts, imported, pushed, updated, deleted, conflicts } }
 */
router.post('/outlook/sync', requireAdmin, async (req, res) => {
  try {
    outlookCalendar.assertConfigured();
    const result = await outlookCalendar.sync();
    res.json({ data: result });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message || 'Outlook sync failed.', code: 500 });
  }
});

/**
 * GET /api/v1/calendar/outlook/status
 * Response: { data: { configured, accounts, totalAccounts } }
 */
router.get('/outlook/status', (req, res) => {
  try {
    res.json({ data: outlookCalendar.getStatus() });
  } catch (err) {
    log.error('Outlook status failed:', err);
    res.status(500).json({ error: 'Failed to get Outlook status.', code: 500 });
  }
});

export default router;
