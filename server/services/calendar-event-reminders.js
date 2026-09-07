/**
 * Calendar event reminder policy.
 *
 * This is the single place that turns a user's calendar defaults and a calendar
 * event into reminder rows. Provider adapters only translate their own wire
 * format into absolute reminder timestamps and call the helpers below.
 *
 * Stored reminder timestamps intentionally keep the historical Yuvomi shape:
 * UTC ISO values without the trailing `Z`.
 */

import { fanOutEventReminders } from './event-reminder-fanout.js';
import {
  householdTimeZone,
  hasExplicitZone,
  localToUTC,
  shiftDateKey,
  storedToInstantMs,
} from '../utils/timezone.js';

export const DEFAULT_EVENT_REMINDER_OFFSET = 15;
export const DEFAULT_ALL_DAY_REMINDER_TIME = '09:00';
export const VALID_EVENT_REMINDER_OFFSETS = Object.freeze([
  0, 15, 30, 60, 1440, 2880, 10080, 20160,
]);

const MAX_EVENT_REMINDERS = 5;
const ALL_DAY_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const BACKFILL_MARKER = 'calendar_event_reminder_backfill_v1';

function tableExists(database, table) {
  try {
    return !!database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(table);
  } catch {
    return false;
  }
}

function configValue(database, key) {
  try {
    return database.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null;
  } catch {
    // Small provider test databases and early startup probes may not have the
    // optional preference table yet. That is the same as an unconfigured key.
    return null;
  }
}

function userConfigValue(database, key, userId) {
  if (!userId) return null;
  return configValue(database, `${key}:user:${Number(userId)}`);
}

function canonicalUtc(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19);
}

function dateTimeWithSeconds(value) {
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
  return raw;
}

function reminderInstantMs(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return NaN;
  const instant = new Date(hasExplicitZone(raw) ? raw : `${raw}Z`);
  return instant.getTime();
}

function escapeIcalText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icalUtcValue(remindAt) {
  const raw = String(remindAt || '').trim();
  const instant = new Date(`${raw}Z`);
  if (Number.isNaN(instant.getTime())) return null;
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Read the effective personal calendar defaults.
 *
 * A missing key is different from a stored empty array: the former is the
 * first-run default, the latter is an explicit user choice to disable defaults.
 */
export function calendarEventDefaults(database, userId) {
  const rawOffsets = userConfigValue(database, 'calendar_default_reminders', userId);
  let reminders = [DEFAULT_EVENT_REMINDER_OFFSET];
  if (rawOffsets !== null) {
    try {
      const parsed = JSON.parse(rawOffsets);
      reminders = Array.isArray(parsed)
        ? [...new Set(parsed.map(Number).filter((n) => VALID_EVENT_REMINDER_OFFSETS.includes(n)))]
            .sort((a, b) => a - b)
        : [];
    } catch {
      reminders = [];
    }
  }

  const rawAllDayTime = userConfigValue(
    database,
    'calendar_default_all_day_reminder_time',
    userId,
  );
  const allDayTime = ALL_DAY_TIME_RE.test(String(rawAllDayTime || ''))
    ? rawAllDayTime
    : DEFAULT_ALL_DAY_REMINDER_TIME;

  return { reminders, allDayTime };
}

/**
 * Convert a stored event start to an instant. Timed naive values mean a wall
 * clock value in the event TZID, or in the household timezone. All-day events
 * use the supplied wall-clock time only when a default reminder is being made.
 */
export function eventStartInstantMs(event, database, { allDayTime = null } = {}) {
  if (!event?.start_datetime) return null;
  const householdZone = householdTimeZone(database);
  if (event.all_day) {
    const time = allDayTime || DEFAULT_ALL_DAY_REMINDER_TIME;
    const local = `${String(event.start_datetime).slice(0, 10)}T${time}:00`;
    const utc = localToUTC(local, event.tzid || householdZone);
    const ms = new Date(utc).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  const zone = event.tzid || householdZone;
  if (hasExplicitZone(event.start_datetime)) {
    const ms = new Date(event.start_datetime).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return storedToInstantMs(dateTimeWithSeconds(event.start_datetime), zone);
}

/** Convert an event end to an instant for RELATED=END VALARMs. */
export function eventEndInstantMs(event, database) {
  if (!event?.start_datetime) return null;
  const householdZone = householdTimeZone(database);
  const endValue = event.end_datetime || event.start_datetime;
  if (event.all_day) {
    // calendar_events stores an inclusive all-day end date, while iCalendar's
    // DTEND is exclusive. The end anchor is therefore the next local midnight.
    const endDate = shiftDateKey(String(endValue).slice(0, 10), 1);
    const utc = localToUTC(`${endDate}T00:00:00`, event.tzid || householdZone);
    const ms = new Date(utc).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  const zone = event.tzid || householdZone;
  if (hasExplicitZone(endValue)) {
    const ms = new Date(endValue).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return storedToInstantMs(dateTimeWithSeconds(endValue), zone);
}

/** Convert an absolute provider/local value to Yuvomi's UTC-without-Z format. */
export function normalizeReminderAt(value, database, fallbackZone = null) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (hasExplicitZone(raw)) return canonicalUtc(new Date(raw));
  const zone = fallbackZone || householdTimeZone(database);
  const utc = localToUTC(dateTimeWithSeconds(raw), zone);
  return canonicalUtc(new Date(utc));
}

/**
 * Make reminder timestamps for offsets before a timed event start.
 * For all-day events callers should use defaultReminderAts, because their
 * configured reminder is a wall-clock time on the event date, not midnight minus
 * an offset.
 */
export function reminderAtsFromOffsets(event, offsets, database, { allDayTime = null } = {}) {
  const startMs = eventStartInstantMs(event, database, { allDayTime });
  if (startMs === null || !Array.isArray(offsets)) return [];
  return [...new Set(offsets
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .slice(0, MAX_EVENT_REMINDERS)
    .map((minutes) => canonicalUtc(new Date(startMs - minutes * 60_000)))
    .filter(Boolean))].sort();
}

/**
 * Translate parsed iCalendar VALARMs into absolute Yuvomi reminder rows.
 * Relative alarms are measured from the provider event start, or from DTEND
 * when RELATED=END is present. For an all-day event that means the provider's
 * midnight anchor; Yuvomi's own fallback is deliberately handled by
 * defaultReminderAts instead.
 */
export function reminderAtsFromIcalAlarms(event, alarms, database, { fallbackZone = null } = {}) {
  if (!Array.isArray(alarms)) return [];
  const startMs = event?.all_day
    ? eventStartInstantMs(event, database, { allDayTime: '00:00' })
    : eventStartInstantMs(event, database);
  const endMs = eventEndInstantMs(event, database);
  const values = [];
  for (const alarm of alarms) {
    if (!alarm || String(alarm.action || 'DISPLAY').toUpperCase() !== 'DISPLAY') continue;
    if (alarm.triggerType === 'relative' && Number.isFinite(Number(alarm.minutesBeforeStart))) {
      const baseMs = String(alarm.related || alarm.relativeTo || '').toUpperCase() === 'END'
        ? endMs
        : startMs;
      if (baseMs === null) continue;
      values.push(canonicalUtc(new Date(
        baseMs - Math.max(0, Number(alarm.minutesBeforeStart)) * 60_000,
      )));
      continue;
    }
    if (alarm.triggerType === 'absolute' && alarm.at) {
      const normalized = normalizeReminderAt(alarm.at, database, alarm.tzid || fallbackZone);
      if (normalized) values.push(normalized);
    }
  }
  return [...new Set(values.filter(Boolean))].sort();
}

/** Make the effective personal defaults for an event. */
export function defaultReminderAts(event, database, userId = event?.created_by) {
  const defaults = calendarEventDefaults(database, userId);
  if (!defaults.reminders.length) return [];
  if (event?.all_day) {
    const startMs = eventStartInstantMs(event, database, { allDayTime: defaults.allDayTime });
    const value = startMs === null ? null : canonicalUtc(new Date(startMs));
    return value ? [value] : [];
  }
  return reminderAtsFromOffsets(event, defaults.reminders, database);
}

function ownerReminderRows(database, eventId, ownerId) {
  if (!tableExists(database, 'reminders')) return [];
  return database.prepare(`
    SELECT remind_at FROM reminders
     WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
     ORDER BY remind_at ASC
  `).all(eventId, ownerId).map((row) => row.remind_at);
}

export function ownerEventReminderAts(database, event) {
  if (!event?.id || !event.created_by) return [];
  return ownerReminderRows(database, event.id, event.created_by);
}

/** Relative provider offset for an existing absolute Yuvomi reminder. */
export function reminderOffsetMinutes(event, remindAt, database, { allDayTime = '00:00' } = {}) {
  const startMs = eventStartInstantMs(event, database, {
    allDayTime: event?.all_day ? allDayTime : null,
  });
  const reminderMs = reminderInstantMs(remindAt);
  if (startMs === null || Number.isNaN(reminderMs)) return null;
  const offset = Math.round((startMs - reminderMs) / 60_000);
  // Google and Outlook only accept reminders at or before the event start.
  // Yuvomi's all-day default is a wall-clock time on the event date (09:00),
  // which is after the provider's midnight anchor and cannot be represented
  // as a positive "minutes before start" value. Returning null keeps that
  // local reminder local instead of silently converting it to midnight.
  return offset >= 0 ? offset : null;
}

/** Outlook exposes one reminder field; keep the earliest Yuvomi trigger. */
export function primaryProviderReminderOffset(event, database) {
  const offsets = ownerEventReminderAts(database, event)
    .map((value) => reminderOffsetMinutes(event, value, database))
    .filter((value) => Number.isFinite(value));
  return offsets.length ? Math.max(...offsets) : null;
}

/** Serialize the owner's reminders as DISPLAY VALARMs for writable CalDAV. */
export function icalAlarmLinesForEvent(event, database) {
  const rows = ownerEventReminderAts(database, event).slice(0, MAX_EVENT_REMINDERS);
  const lines = [];
  const startMs = event?.all_day
    ? eventStartInstantMs(event, database, { allDayTime: '00:00' })
    : eventStartInstantMs(event, database);
  for (const remindAt of rows) {
    const reminderMs = reminderInstantMs(remindAt);
    if (Number.isNaN(reminderMs)) continue;
    let trigger;
    if (event?.all_day || startMs === null || startMs - reminderMs < 0) {
      const absolute = icalUtcValue(remindAt);
      if (!absolute) continue;
      trigger = `TRIGGER;VALUE=DATE-TIME:${absolute}`;
    } else {
      const minutes = Math.max(0, Math.round((startMs - reminderMs) / 60_000));
      trigger = `TRIGGER:-PT${minutes}M`;
    }
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcalText(event?.title || 'Yuvomi reminder')}`,
      trigger,
      'END:VALARM',
    );
  }
  return lines;
}

/** Replace only the event owner's reminder template and fan it out to assignees. */
export function replaceOwnerEventReminders(
  database,
  eventId,
  ownerId,
  remindAts,
  { suppressed = false, fanout = true } = {},
) {
  if (!tableExists(database, 'reminders')) return [];
  const values = [...new Set((Array.isArray(remindAts) ? remindAts : [])
    .map((value) => String(value).trim())
    .filter(Boolean))].sort().slice(0, MAX_EVENT_REMINDERS);
  database.prepare(`
    DELETE FROM reminders
     WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
  `).run(eventId, ownerId);
  const insert = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, ?, ?)
  `);
  for (const value of values) insert.run(eventId, value, ownerId);
  database.prepare(`
    UPDATE calendar_events
       SET reminder_suppressed = ?
     WHERE id = ?
  `).run(suppressed ? 1 : 0, eventId);
  if (fanout) fanOutEventReminders(database, eventId, ownerId);
  return values;
}

/**
 * Apply a provider's reminder state without creating outbound work.
 * `explicit` means the provider supplied an event-level reminder. When it did
 * not, Yuvomi applies the owner's defaults unless the user explicitly disabled
 * reminders for this event.
 */
export function applyRemoteEventReminders(
  database,
  event,
  remoteReminderAts,
  {
    explicit = false,
    preserveSuppressed = true,
    explicitClearsSuppression = true,
  } = {},
) {
  if (!event?.id || !event.created_by) return false;
  if (!tableExists(database, 'reminders')) return false;
  const current = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id) || event;
  if (explicit) {
    // ICS/WebCal is read-only: a local reminder deletion is an override until
    // the user explicitly resets the event to its subscription source. Other
    // providers keep the normal rule that a new explicit remote reminder wins.
    if (preserveSuppressed && current.reminder_suppressed === 1 && !explicitClearsSuppression) {
      return false;
    }
    const desired = [...new Set((Array.isArray(remoteReminderAts) ? remoteReminderAts : [])
      .map((value) => String(value).trim()).filter(Boolean))].sort().slice(0, MAX_EVENT_REMINDERS);
    if (current.reminder_suppressed !== 1
        && JSON.stringify(ownerReminderRows(database, event.id, event.created_by)) === JSON.stringify(desired)) {
      return false;
    }
    replaceOwnerEventReminders(database, event.id, event.created_by, remoteReminderAts, {
      suppressed: false,
    });
    return true;
  }
  if (preserveSuppressed && current.reminder_suppressed === 1) return false;
  const defaults = defaultReminderAts(current, database, current.created_by);
  if (current.reminder_suppressed !== 1
      && JSON.stringify(ownerReminderRows(database, event.id, current.created_by)) === JSON.stringify(defaults)) {
    return false;
  }
  replaceOwnerEventReminders(database, event.id, current.created_by, defaults, {
    suppressed: false,
  });
  return true;
}

/** Add defaults to a future event only when it has no owner reminder yet. */
export function ensureDefaultEventReminders(database, event, { onlyFuture = false, nowMs = Date.now() } = {}) {
  if (!event?.id || !event.created_by || event.reminder_suppressed === 1) return false;
  if (!tableExists(database, 'reminders')) return false;
  if (ownerReminderRows(database, event.id, event.created_by).length) return false;
  let values = defaultReminderAts(event, database, event.created_by);
  if (onlyFuture) {
    values = values.filter((value) => {
      const ms = new Date(`${value}Z`).getTime();
      return Number.isFinite(ms) && ms > nowMs;
    });
  }
  if (!values.length) return false;
  replaceOwnerEventReminders(database, event.id, event.created_by, values, { suppressed: false });
  return true;
}

/** True when the supplied reminder mutation belongs to the event owner. */
export function recordManualOwnerReminderChange(database, eventId, userId, hasReminders) {
  const event = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
  if (!event || Number(event.created_by) !== Number(userId)) return null;
  database.prepare(`
    UPDATE calendar_events
       SET reminder_suppressed = ?
     WHERE id = ?
  `).run(hasReminders ? 0 : 1, eventId);
  return { ...event, reminder_suppressed: hasReminders ? 0 : 1 };
}

export function clearReminderSuppression(database, eventId) {
  database.prepare('UPDATE calendar_events SET reminder_suppressed = 0 WHERE id = ?').run(eventId);
}

/**
 * One-time upgrade pass for existing events. It intentionally only creates
 * future reminders; provider cursors are reset by migration 177 so the next
 * normal provider run can replace these temporary values with remote alarms.
 */
export function backfillCalendarEventReminders(database, {
  marker = BACKFILL_MARKER,
  nowMs = Date.now(),
} = {}) {
  if (configValue(database, marker)) return { ran: false, updated: 0 };
  let updated = 0;
  database.transaction(() => {
    const events = database.prepare('SELECT * FROM calendar_events').all();
    for (const event of events) {
      if (ensureDefaultEventReminders(database, event, { onlyFuture: true, nowMs })) updated++;
    }
    database.prepare(`
      INSERT INTO sync_config (key, value)
      VALUES (?, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).run(marker);
  })();
  return { ran: true, updated };
}

export const __test = {
  canonicalUtc,
  calendarEventDefaults,
  defaultReminderAts,
  eventEndInstantMs,
  eventStartInstantMs,
  normalizeReminderAt,
  ownerEventReminderAts,
  primaryProviderReminderOffset,
  reminderOffsetMinutes,
  reminderAtsFromOffsets,
  reminderAtsFromIcalAlarms,
  icalAlarmLinesForEvent,
};
