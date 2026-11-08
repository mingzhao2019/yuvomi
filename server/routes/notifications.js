/**
 * Modul: Notification-Routen
 * Zweck: Persönliche und haushaltsweite Notification-Channels verwalten und
 * Testbenachrichtigungen senden.
 * Abhaengigkeiten: express, notification-channels.js, notifications.js
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { createNotificationChannelStore, NOTIFICATION_PROVIDERS } from '../services/notification-channels.js';
import { notificationService as defaultNotificationService, formatNotificationWallTime } from '../services/notifications.js';
import { NotificationProviderError } from '../services/notification-providers/provider-error.js';
import { remoteFailure } from '../utils/http.js';
import { householdTimeZone } from '../utils/timezone.js';

const log = createLogger('NotificationRoutes');

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * What a failed channel test stores as `last_error`: a provider's own sentence,
 * the code of a network error, or a fixed sentence (Phase 0 section H).
 */
function storedTestError(err) {
  if (err instanceof NotificationProviderError) return err.message;
  const failure = remoteFailure(err);
  if (failure?.reason === 'remote_unreachable') return failure.detail;
  return 'The test notification could not be delivered.';
}

/**
 * Validation and the database used to share one catch that sent every message
 * as a 400 - SQLite's included (Phase 0 section H). The channel checks mark
 * their own sentences (`notification_channel_invalid`); everything else is a
 * fixed 500 and goes into the log.
 */
function sendChannelWriteFailure(res, err) {
  // Keep the custom personal-channel ownership boundary visible to the caller.
  // It is an application-level refusal, not a database or provider failure.
  if (Number.isInteger(err?.statusCode) && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message || 'Permission denied.', code: err.statusCode });
  }
  if (err?.code === 'notification_channel_invalid') return res.status(400).json({ error: err.message, code: 400 });
  log.error('Error writing notification channel:', err);
  return res.status(500).json({ error: 'Internal error.', code: 500 });
}
export function buildRouter({
  database,
  channelStore,
  notificationService = defaultNotificationService,
} = {}) {
  const getDb = () => (database || db.get());
  const store = channelStore || createNotificationChannelStore({ db: getDb() });
  const router = express.Router();

  function userId(req) {
    return req.authUserId ?? req.session?.userId ?? null;
  }

  function isAdmin(req) {
    return isAdminRequest(req);
  }

  function permissionError(message = 'Permission denied.') {
    const error = new Error(message);
    error.statusCode = 403;
    return error;
  }

  function channelIsManageable(req, channel) {
    if (!channel) return false;
    if (channel.scope === 'household') return isAdmin(req);
    return channel.scope === 'user' && channel.userId === userId(req);
  }

  function channelInputForCreate(req, input) {
    const requested = input?.scope == null
      ? (isAdmin(req) ? 'household' : 'user')
      : String(input.scope).trim();
    if (!['household', 'user'].includes(requested)) {
      const error = new Error('Invalid notification channel scope.');
      error.code = 'notification_channel_invalid';
      throw error;
    }
    if (!isAdmin(req) && requested !== 'user') {
      throw permissionError('Only administrators can create household notification channels.');
    }

    const ownerId = userId(req);
    if (requested === 'user') {
      if (!ownerId) throw permissionError('A personal notification channel needs an authenticated user.');
      const requestedOwner = input?.userId ?? input?.user_id;
      if (requestedOwner != null && Number(requestedOwner) !== Number(ownerId)) {
        throw permissionError('A personal notification channel can only belong to the current user.');
      }
      return { ...input, scope: 'user', userId: ownerId };
    }

    // A household channel has no personal owner, even if a caller sends a
    // stale userId from an earlier form version.
    return { ...input, scope: 'household', userId: null };
  }

  function channelInputForUpdate(req, input, existing) {
    if (!channelIsManageable(req, existing)) throw permissionError();
    // The UI groups channels by scope rather than exposing a second scope
    // selector. Keep the existing ownership boundary on update as well.
    return {
      ...input,
      scope: existing.scope,
      userId: existing.scope === 'user' ? existing.userId : null,
    };
  }

  function sendError(res, error, fallback, defaultStatus = 400) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : defaultStatus;
    const message = status < 500 ? (error?.message || fallback) : fallback;
    res.status(status).json({ error: message, code: status });
  }

  router.get('/providers', (req, res) => {
    try {
      void req;
      const available = NOTIFICATION_PROVIDERS
        .filter((provider) => notificationService.providers?.[provider.id])
        .map((provider) => {
          const adapter = notificationService.providers[provider.id];
          if (typeof adapter.isAvailable !== 'function') return provider;
          let ready = false;
          try {
            ready = adapter.isAvailable() === true;
          } catch (err) {
            log.warn(`Provider ${provider.id} availability check failed:`, err.message);
          }
          return { ...provider, ready };
        });
      res.json({ data: available });
    } catch (err) {
      log.error('Error reading notification providers:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.get('/channels', (req, res) => {
    try {
      const currentUserId = userId(req);
      if (!currentUserId) throw permissionError('Authenticated user is required.');
      res.json({
        data: store.listChannelsForUser(currentUserId, { includeHousehold: isAdmin(req) }),
      });
    } catch (err) {
      log.error('Error reading notification channels:', err.message);
      sendError(res, err, 'Internal error.', 500);
    }
  });

  router.post('/channels', (req, res) => {
    try {
      const channel = store.createChannel(channelInputForCreate(req, req.body || {}));
      res.status(201).json({ data: channel });
    } catch (err) {
      sendChannelWriteFailure(res, err);
    }
  });

  router.put('/channels/:id', (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
      const existing = store.getChannel(id);
      if (!existing) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      const channel = store.updateChannel(id, channelInputForUpdate(req, req.body || {}, existing));
      res.json({ data: channel });
    } catch (err) {
      sendChannelWriteFailure(res, err);
    }
  });

  router.delete('/channels/:id', (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
      const existing = store.getChannel(id);
      if (!existing) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      if (!channelIsManageable(req, existing)) throw permissionError();
      const deleted = store.deleteChannel(id);
      if (!deleted) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      res.json({ data: { deleted: true } });
    } catch (err) {
      log.error('Error deleting notification channel:', err.message);
      sendError(res, err, 'Internal error.', 500);
    }
  });

  router.post('/channels/:id/test', async (req, res) => {
    let channel = null;
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
      channel = store.getChannel(id, { includeSecrets: true });
      if (!channel) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      if (!channelIsManageable(req, channel)) throw permissionError();
      const sentAt = new Date().toISOString();
      const payload = {
        title: 'Yuvomi',
        body: 'Yuvomi notification test',
        description: 'This is a sample task description.',
        details: 'category: misc\npriority: high\nstatus: open',
        entityType: 'task',
        entityId: 42,
        dueDate: '2026-08-27',
        dueTime: '18:30',
        startDate: '2026-08-27',
        startTime: '09:00',
        endDate: '',
        endTime: '',
        remindAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        sentAt,
        url: '/tasks?open=42',
        tag: `notification-channel-test-${id}`,
        priority: 'default',
        category: 'misc',
        taskPriority: 'high',
        status: 'open',
        location: '',
        allDay: false,
      };
      const timeZone = householdTimeZone(getDb());
      payload.remindAtLocal = formatNotificationWallTime(payload.remindAt, timeZone);
      payload.sentAtLocal = formatNotificationWallTime(payload.sentAt, timeZone);
      const result = await notificationService.testChannel({ channel, payload });
      store.markChannelTestResult(id, { ok: true });
      res.json({ data: result });
    } catch (err) {
      log.error('Error testing notification channel:', err.message);
      const id = parseId(req.params.id);
      if (id && channel && channelIsManageable(req, channel)) {
        store.markChannelTestResult(id, { ok: false, error: storedTestError(err) });
      }
      if (Number.isInteger(err?.statusCode) && err.statusCode < 500) {
        return res.status(err.statusCode).json({ error: err.message || 'Permission denied.', code: err.statusCode });
      }
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  return router;
}

export default buildRouter();
