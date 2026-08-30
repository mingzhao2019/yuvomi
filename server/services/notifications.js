/**
 * Modul: Notification-Orchestrator
 * Zweck: Reminder an Web Push und externe Notification-Channels fan-outen und Delivery-State pflegen.
 * Abhaengigkeiten: server/db.js, push.js, notification-channels.js, Provider-Adapter
 */
import { createLogger } from '../logger.js';
import * as dbModule from '../db.js';
import { pushService as defaultPushService } from './push.js';
import { createNotificationChannelStore } from './notification-channels.js';
import { gotifyProvider } from './notification-providers/gotify.js';
import { ntfyProvider } from './notification-providers/ntfy.js';
import { webhookProvider } from './notification-providers/webhook.js';
import { messagePusherProvider } from './notification-providers/message-pusher.js';
import { emailProvider } from './notification-providers/email.js';
import { syncAllBirthdayReminders } from './birthdays.js';
import { resolveHouseholdLocale, translate } from '../utils/i18n.js';
import { warrantyEndDate } from './inventory-deadlines.js';
import { syncAllPantryExpiryReminders } from './pantry-reminders.js';

const log = createLogger('Notifications');
const APP_NAME = 'Yuvomi';
// Greift nur, wenn die verknuepfte Entitaet inzwischen geloescht wurde: nie den
// App-Namen als Body wiederholen, sonst besteht die Notification nur aus "Yuvomi" (#581).
const FALLBACK_BODY = 'Reminder';
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const PROVIDER_TIMEOUT_MS = 8_000;

export const defaultProviders = {
  gotify: gotifyProvider,
  ntfy: ntfyProvider,
  webhook: webhookProvider,
  message_pusher: messagePusherProvider,
  email: emailProvider,
};

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeError(error) {
  return String(error?.message || error || 'Notification delivery failed.')
    .replace(/([?&](?:token|access_token|refresh_token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

function datePart(value) {
  const raw = text(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
}

function timePart(value) {
  const raw = text(value).trim();
  if (!raw) return '';
  const match = raw.match(/(?:T|\s)?(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  return match?.[1] || '';
}

function dateTimeParts(value) {
  return { date: datePart(value), time: timePart(value) };
}

function reminderDetails(reminder) {
  const details = [];
  if (reminder.entity_type === 'task') {
    if (reminder.task_category) details.push(`category: ${reminder.task_category}`);
    if (reminder.task_priority && reminder.task_priority !== 'none') {
      details.push(`priority: ${reminder.task_priority}`);
    }
    if (reminder.task_status) details.push(`status: ${reminder.task_status}`);
  } else if (reminder.entity_type === 'event') {
    if (reminder.event_location) details.push(`location: ${reminder.event_location}`);
    if (reminder.event_all_day) details.push('allDay: true');
  }
  return details.join('\n');
}

/**
 * Body einer Abo-Erinnerung: Name, Betrag und Verlaengerungsdatum (#581).
 * Bewusst nur Daten, kein Satzbau - der Server kennt die Sprache des Empfaengers
 * nicht (Locale und Zahlen-/Datumsformat liegen im localStorage des Clients),
 * deshalb ISO-Datum und Betrag mit Waehrungscode statt formulierter Text.
 */
function subscriptionBody(reminder) {
  const parts = [reminder.entity_title];
  const amount = Number(reminder.sub_amount);
  if (Number.isFinite(amount) && reminder.sub_currency) {
    parts.push(`${amount.toFixed(2)} ${reminder.sub_currency}`);
  }
  if (reminder.sub_next_payment_date) parts.push(String(reminder.sub_next_payment_date).slice(0, 10));
  return parts.join(' - ');
}

/**
 * DER TITEL EINER MELDUNG NENNT IHRE HERKUNFT.
 *
 * Die Herkunfts-Regel (Block 2) gibt jeder Meldung ihr Siegel - eine
 * Systembenachrichtigung kann keines tragen: sie hat kein DOM, ihr `icon` zeigt
 * nur ein Teil der Plattformen, und ihr `badge` wird auf Android monochrom
 * maskiert, wodurch der Familienton ohnehin verloren ginge. Was auf JEDER
 * Plattform ankommt, ist der Titel, und der stand bisher app-weit auf „Yuvomi" -
 * also auf dem, was das System darueber ohnehin schon anzeigt. „Kalender" ueber
 * „Zahnarzttermin" beantwortet dieselbe Frage wie das Siegel im Toast.
 *
 * UEBERSETZT UEBER DIE DATENSPRACHE DES HAUSHALTS, nicht ueber die des
 * Empfaengers: die kennt der Server nicht (Locale liegt im localStorage). Das
 * ist dieselbe Sprache, in der er schon Geburtstagstermine ablegt, und dieselbe
 * Quelle - public/locales/*.json ueber utils/i18n.js. Die Keys sind bestehende
 * Modulnamen; eine Meldung braucht dafuer kein eigenes Vokabular.
 */
/*
 * UND DIESELBE HERKUNFT SETZT DAS ZIEL (Critique 2026-08-10).
 *
 * Der Titel nannte das Modul, und der Tipp darauf landete trotzdem im
 * Dashboard: `url` stand fest auf `/reminders`, und diese Route gibt es in
 * `ROUTES` nicht - der Router fiel still auf `/` zurueck, Dokumenttitel
 * „Yuvomi · Yuvomi". Der Befund war schon vorher einer und ist seit der
 * Titel-Herkunft doppelt so teuer: die Meldung sagt jetzt, wo sie herkommt,
 * und schickt den Nutzer trotzdem woandershin.
 *
 * Die Zuordnung stand die ganze Zeit hier - sie wurde nur nicht gefragt. Ein
 * Eintrag traegt beides, Titel und Ziel, damit die zweite Antwort nicht von
 * der ersten wegdriften kann. Push ist der zeitkritischste Pfad der App: wer
 * eine Erinnerung antippt, will an das Ding, nicht an eine Uebersicht.
 *
 * Abonnements zeigen auf `/budget` und nicht auf ihren Tab darin - einen
 * Deep-Link auf `budget.activeTab` gibt es nicht (geprueft). Das Modul ist die
 * genaueste Antwort, die das Ziel heute geben kann, und immer noch eine.
 */
const REMINDER_ORIGINS = {
  task:                   { titleKey: 'nav.tasks',              url: '/tasks' },
  event:                  { titleKey: 'nav.calendar',           url: '/calendar' },
  subscription:           { titleKey: 'subscriptions.tabLabel', url: '/budget' },
  inventory_item:         { titleKey: 'nav.inventory',          url: '/inventory' },
  inventory_tracked_date: { titleKey: 'nav.inventory',          url: '/inventory' },
  pantry_item:            { titleKey: 'nav.pantry',             url: '/pantry' },
};

/**
 * Body einer Garantie-Erinnerung: Gegenstandsname und Garantieende.
 * Gleiche Begruendung wie bei subscriptionBody - reine Daten, kein Satzbau,
 * weil der Server die Sprache des Empfaengers nicht kennt. Faellt das
 * Garantieende nicht berechenbar aus (unplausibles Kaufdatum, geloeschte
 * Felder), bleibt der Name allein stehen statt die Zustellung zu sprengen.
 */
function warrantyBody(reminder) {
  if (!reminder.inv_purchase_date || reminder.inv_warranty_months == null) return reminder.entity_title;
  try {
    return `${reminder.entity_title} - ${warrantyEndDate(reminder.inv_purchase_date, reminder.inv_warranty_months)}`;
  } catch {
    return reminder.entity_title;
  }
}

/**
 * Body einer Fristen-Erinnerung: Gegenstand · Bezeichnung, plus das Datum.
 * Gleiche Begruendung wie subscriptionBody/warrantyBody - reine Daten, kein
 * Satzbau, weil der Server die Sprache des Empfaengers nicht kennt.
 */
function trackedDateBody(reminder) {
  if (!reminder.inv_tracked_date) return reminder.entity_title;
  return `${reminder.entity_title} - ${reminder.inv_tracked_date}`;
}

/**
 * Body einer Ablauf-Erinnerung: Artikelname und Mindesthaltbarkeitsdatum.
 * Gleiche Begruendung wie die drei Funktionen darueber - reine Daten, kein
 * Satzbau, weil der Server die Sprache des Empfaengers nicht kennt.
 */
function pantryExpiryBody(reminder) {
  if (!reminder.pantry_expires_on) return reminder.entity_title;
  return `${reminder.entity_title} - ${reminder.pantry_expires_on}`;
}

export function reminderPayload(reminder, locale, sentAt = '') {
  const title = reminder.entity_title || FALLBACK_BODY;
  const origin = REMINDER_ORIGINS[reminder.entity_type];
  let body = title;
  if (reminder.entity_type === 'subscription' && reminder.entity_title) {
    body = subscriptionBody(reminder);
  } else if (reminder.entity_type === 'inventory_item' && reminder.entity_title) {
    body = warrantyBody(reminder);
  } else if (reminder.entity_type === 'inventory_tracked_date' && reminder.entity_title) {
    body = trackedDateBody(reminder);
  } else if (reminder.entity_type === 'pantry_item' && reminder.entity_title) {
    body = pantryExpiryBody(reminder);
  }
  const eventStart = reminder.entity_type === 'event'
    ? dateTimeParts(reminder.event_start_datetime)
    : { date: '', time: '' };
  const eventEnd = reminder.entity_type === 'event'
    ? dateTimeParts(reminder.event_end_datetime)
    : { date: '', time: '' };
  const dueDate = reminder.entity_type === 'task' ? datePart(reminder.task_due_date) : '';
  const dueTime = reminder.entity_type === 'task' ? timePart(reminder.task_due_time) : '';
  const startDate = reminder.entity_type === 'task'
    ? datePart(reminder.task_start_date)
    : eventStart.date;
  // Tasks currently persist a start date but no start time. Keep the field in
  // the contract so templates work for events now and for task start times if
  // that data is added later.
  const startTime = reminder.entity_type === 'task' ? timePart(reminder.task_start_time) : eventStart.time;

  return {
    // Ohne bekannte Herkunft bleibt der App-Name: er ist nichtssagend, aber nie
    // falsch - und ein roher `entity_type` im Titel waere beides. Das Ziel
    // faellt aus demselben Grund auf die Uebersicht: sie ist die einzige Seite,
    // die es mit Sicherheit gibt.
    title: origin ? translate(locale, origin.titleKey) : APP_NAME,
    body,
    description: text(reminder.entity_description),
    details: reminderDetails(reminder),
    entityType: text(reminder.entity_type),
    entityId: reminder.entity_id ?? null,
    dueDate,
    dueTime,
    startDate,
    startTime,
    endDate: eventEnd.date,
    endTime: eventEnd.time,
    remindAt: text(reminder.remind_at),
    sentAt: text(sentAt),
    url: origin ? origin.url : '/',
    tag: `reminder-${reminder.id}`,
    priority: 'default',
    category: text(reminder.task_category),
    taskPriority: text(reminder.task_priority),
    status: text(reminder.task_status),
    location: text(reminder.event_location),
    allDay: reminder.entity_type === 'event' ? Boolean(reminder.event_all_day) : null,
  };
}

function upsertPendingDelivery(database, { reminderId, provider, channelId = null, targetKey, nowIso }) {
  database.prepare(`
    INSERT INTO notification_deliveries
      (reminder_id, provider, channel_id, target_key, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(reminder_id, provider, target_key) DO NOTHING
  `).run(reminderId, provider, channelId, targetKey, nowIso, nowIso);
  return database.prepare(`
    SELECT * FROM notification_deliveries
    WHERE reminder_id = ? AND provider = ? AND target_key = ?
  `).get(reminderId, provider, targetKey);
}

function shouldAttempt(delivery, nowIso) {
  if (!delivery) return true;
  if (delivery.status === 'sent' || delivery.status === 'skipped') return false;
  if (delivery.status === 'failed' && delivery.next_attempt_at && delivery.next_attempt_at > nowIso) return false;
  return delivery.attempt_count < MAX_ATTEMPTS;
}

function markSent(database, deliveryId, nowIso) {
  database.prepare(`
    UPDATE notification_deliveries
    SET status = 'sent',
        attempt_count = attempt_count + 1,
        last_attempt_at = ?,
        next_attempt_at = NULL,
        sent_at = ?,
        error = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(nowIso, nowIso, nowIso, deliveryId);
}

function markSkipped(database, deliveryId, nowIso, reason) {
  database.prepare(`
    UPDATE notification_deliveries
    SET status = 'skipped',
        next_attempt_at = NULL,
        error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(reason, nowIso, deliveryId);
}

function markFailed(database, deliveryId, now, error) {
  const nowIso = iso(now);
  const row = database.prepare('SELECT attempt_count FROM notification_deliveries WHERE id = ?').get(deliveryId);
  const nextAttempt = (row?.attempt_count ?? 0) + 1;
  const exhausted = nextAttempt >= MAX_ATTEMPTS;
  database.prepare(`
    UPDATE notification_deliveries
    SET status = ?,
        attempt_count = ?,
        last_attempt_at = ?,
        next_attempt_at = ?,
        error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    exhausted ? 'skipped' : 'failed',
    nextAttempt,
    nowIso,
    exhausted ? null : iso(new Date(now.getTime() + RETRY_DELAY_MS)),
    safeError(error),
    nowIso,
    deliveryId
  );
  return exhausted ? 'skipped' : 'failed';
}

function allKnownDeliveriesComplete(database, reminderId, expectedTargets) {
  if (expectedTargets.length === 0) return true;
  const rows = database.prepare(`
    SELECT provider, target_key, status
    FROM notification_deliveries
    WHERE reminder_id = ?
  `).all(reminderId);
  const byKey = new Map(rows.map((row) => [`${row.provider}:${row.target_key}`, row.status]));
  return expectedTargets.every((target) => {
    const status = byKey.get(`${target.provider}:${target.targetKey}`);
    return status === 'sent' || status === 'skipped';
  });
}

async function withTimeout(fn, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan-out for immediate native notifications that do not belong to a reminder
 * row (for example medication doses and task comment mentions). Reminder
 * delivery persistence remains in processDueNotifications; this helper only
 * centralizes the target/provider behavior so every native producer reaches
 * Web Push and configured channels consistently.
 */
export async function fanOutNotification({
  userId,
  payload,
  database,
  pushService = defaultPushService,
  channelStore,
  providers = defaultProviders,
  fetchImpl = fetch,
} = {}) {
  const activeDb = database || dbModule.get();
  const store = channelStore || createNotificationChannelStore({ db: activeDb });
  const result = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  // Keep the service call unconditional. The real push service already
  // handles an absent subscription, and this preserves injectable push-service
  // behavior for medication/mention callers and tests.
  result.attempted += 1;
  try {
    const sent = await pushService.sendPushToUser(userId, payload);
    if (sent > 0) result.sent += 1;
    else result.skipped += 1;
  } catch (err) {
    result.failed += 1;
    log.error(`Web Push delivery failed for user ${userId}:`, safeError(err));
  }

  const channels = store.listEnabledChannelsForUser(userId);
  for (const channel of channels) {
    result.attempted += 1;
    const provider = providers[channel.provider];
    if (!provider) {
      result.failed += 1;
      log.error(`Unknown notification provider ${channel.provider} for channel ${channel.id}.`);
      continue;
    }
    try {
      await withTimeout((signal) => provider.send({ channel, payload, fetchImpl, signal }));
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      log.error(`Notification channel ${channel.id} delivery failed:`, safeError(err));
    }
  }

  return result;
}

export function createNotificationService({ providers = defaultProviders, channelStore } = {}) {
  async function testChannel({ channel, payload, fetchImpl = fetch } = {}) {
    const provider = providers[channel?.provider];
    if (!provider) throw new Error('Unknown notification provider.');
    return withTimeout((signal) => provider.send({ channel, payload, fetchImpl, signal }));
  }

  return { providers, channelStore, testChannel };
}

export async function processDueNotifications({
  database,
  pushService = defaultPushService,
  channelStore,
  providers = defaultProviders,
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  const getDb = () => (database || dbModule.get());
  const activeDb = getDb();
  const nowIso = iso(now);
  const store = channelStore || createNotificationChannelStore({ db: activeDb });

  const users = activeDb.prepare('SELECT id FROM users').all();
  for (const user of users) {
    try {
      syncAllBirthdayReminders(activeDb, user.id, now);
    } catch (err) {
      log.error(`Birthday sync failed for user ${user.id}:`, err?.message || err);
    }
  }

  // DER BESTAND ZIEHT HIER NACH, nicht erst beim naechsten Anfassen. Der
  // Router legt die Erinnerung eines Artikels beim Speichern an - aber ein
  // Vorrat, der schon vor diesem Feature im Regal stand, ist nie gespeichert
  // worden und haette nie gemeldet. Gleiche Bauart und gleiche Stelle wie der
  // Geburtstags-Sync darueber: idempotent, ohne Zustand, bei jedem Lauf erneut.
  // Haushaltsweit statt je Nutzer - der Vorrat gehoert dem Haushalt.
  try {
    syncAllPantryExpiryReminders(activeDb, now);
  } catch (err) {
    log.error('Pantry expiry sync failed:', err?.message || err);
  }

  const due = activeDb.prepare(`
    SELECT r.id, r.created_by, r.entity_type, r.entity_id, r.remind_at,
      CASE r.entity_type
        WHEN 'task'  THEN (SELECT title FROM tasks           WHERE id = r.entity_id)
        WHEN 'event' THEN (SELECT title FROM calendar_events WHERE id = r.entity_id)
        WHEN 'subscription' THEN (SELECT name FROM budget_subscriptions WHERE id = r.entity_id)
        WHEN 'inventory_item' THEN (SELECT name FROM inventory_items WHERE id = r.entity_id)
        WHEN 'inventory_tracked_date' THEN (
          SELECT ii.name || ' · ' || d.label
          FROM inventory_item_dates d JOIN inventory_items ii ON ii.id = d.item_id
          WHERE d.id = r.entity_id
        )
        WHEN 'pantry_item' THEN (SELECT name FROM pantry_items WHERE id = r.entity_id)
      END AS entity_title,
      CASE WHEN r.entity_type = 'task'
        THEN (SELECT description FROM tasks WHERE id = r.entity_id)
        WHEN r.entity_type = 'event'
        THEN (SELECT description FROM calendar_events WHERE id = r.entity_id)
      END AS entity_description,
      CASE WHEN r.entity_type = 'task'
        THEN (SELECT due_date FROM tasks WHERE id = r.entity_id) END AS task_due_date,
      CASE WHEN r.entity_type = 'task'
        THEN (SELECT due_time FROM tasks WHERE id = r.entity_id) END AS task_due_time,
      CASE WHEN r.entity_type = 'task'
        THEN (SELECT start_date FROM tasks WHERE id = r.entity_id) END AS task_start_date,
      CASE WHEN r.entity_type = 'task'
        THEN (SELECT category FROM tasks WHERE id = r.entity_id) END AS task_category,
      CASE WHEN r.entity_type = 'task'
        THEN (SELECT priority FROM tasks WHERE id = r.entity_id) END AS task_priority,
      CASE WHEN r.entity_type = 'task'
        THEN (SELECT status FROM tasks WHERE id = r.entity_id) END AS task_status,
      CASE WHEN r.entity_type = 'event'
        THEN (SELECT start_datetime FROM calendar_events WHERE id = r.entity_id) END AS event_start_datetime,
      CASE WHEN r.entity_type = 'event'
        THEN (SELECT end_datetime FROM calendar_events WHERE id = r.entity_id) END AS event_end_datetime,
      CASE WHEN r.entity_type = 'event'
        THEN (SELECT location FROM calendar_events WHERE id = r.entity_id) END AS event_location,
      CASE WHEN r.entity_type = 'event'
        THEN (SELECT all_day FROM calendar_events WHERE id = r.entity_id) END AS event_all_day,
      CASE WHEN r.entity_type = 'inventory_item'
        THEN (SELECT purchase_date FROM inventory_items WHERE id = r.entity_id) END AS inv_purchase_date,
      CASE WHEN r.entity_type = 'inventory_item'
        THEN (SELECT warranty_months FROM inventory_items WHERE id = r.entity_id) END AS inv_warranty_months,
      CASE WHEN r.entity_type = 'inventory_tracked_date'
        THEN (SELECT date FROM inventory_item_dates WHERE id = r.entity_id) END AS inv_tracked_date,
      CASE WHEN r.entity_type = 'pantry_item'
        THEN (SELECT expires_on FROM pantry_items WHERE id = r.entity_id) END AS pantry_expires_on,
      CASE WHEN r.entity_type = 'subscription'
        THEN (SELECT amount FROM budget_subscriptions WHERE id = r.entity_id) END AS sub_amount,
      CASE WHEN r.entity_type = 'subscription'
        THEN (SELECT currency FROM budget_subscriptions WHERE id = r.entity_id) END AS sub_currency,
      CASE WHEN r.entity_type = 'subscription'
        THEN (SELECT next_payment_date FROM budget_subscriptions WHERE id = r.entity_id)
        END AS sub_next_payment_date
    FROM reminders r
    WHERE r.dismissed = 0 AND r.pushed_at IS NULL AND r.remind_at <= ?
      AND NOT (
        r.entity_type = 'task'
        AND EXISTS (
          SELECT 1 FROM tasks completed_task
           WHERE completed_task.id = r.entity_id AND completed_task.status = 'done'
        )
      )
    ORDER BY r.remind_at ASC
  `).all(nowIso);

  const counters = { due: due.length, attempted: 0, sent: 0, failed: 0, skipped: 0 };
  const markPushed = activeDb.prepare('UPDATE reminders SET pushed_at = ? WHERE id = ?');
  // Einmal je Lauf, nicht je Meldung: die Datensprache gehoert dem Haushalt.
  const locale = resolveHouseholdLocale(activeDb);

  for (const reminder of due) {
    const payload = reminderPayload(reminder, locale, nowIso);
    const channels = store.listEnabledChannelsForUser(reminder.created_by);
    const pushCount = activeDb.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(reminder.created_by).c;
    const targets = [];
    if (pushCount > 0) {
      targets.push({ provider: 'webpush', channelId: null, targetKey: `user:${reminder.created_by}`, send: 'webpush' });
    }
    for (const channel of channels) {
      targets.push({
        provider: channel.provider,
        channelId: channel.id,
        targetKey: `channel:${channel.id}`,
        channel,
        send: 'provider',
      });
    }

    for (const target of targets) {
      const delivery = upsertPendingDelivery(activeDb, {
        reminderId: reminder.id,
        provider: target.provider,
        channelId: target.channelId,
        targetKey: target.targetKey,
        nowIso,
      });
      if (!shouldAttempt(delivery, nowIso)) continue;

      counters.attempted += 1;
      try {
        if (target.send === 'webpush') {
          const sent = await pushService.sendPushToUser(reminder.created_by, payload);
          if (sent > 0) {
            markSent(activeDb, delivery.id, nowIso);
            counters.sent += 1;
          } else {
            markSkipped(activeDb, delivery.id, nowIso, 'No active Web Push subscriptions accepted the notification.');
            counters.skipped += 1;
          }
        } else {
          const provider = providers[target.provider];
          if (!provider) throw new Error('Unknown notification provider.');
          await withTimeout((signal) => provider.send({ channel: target.channel, payload, fetchImpl, signal }));
          markSent(activeDb, delivery.id, nowIso);
          counters.sent += 1;
        }
      } catch (err) {
        const status = markFailed(activeDb, delivery.id, now, err);
        if (status === 'skipped') counters.skipped += 1;
        else counters.failed += 1;
        log.error(`Notification delivery failed for reminder ${reminder.id}:`, safeError(err));
      }
    }

    if (allKnownDeliveriesComplete(activeDb, reminder.id, targets)) {
      markPushed.run(nowIso, reminder.id);
    }
  }

  if (counters.sent) log.info(`Sent ${counters.sent} notification target(s).`);
  return counters;
}

export const notificationService = createNotificationService();
