/**
 * Reminder-Offset-Helfer (rein, ohne DOM/i18n)
 * Zweck: Rückrechnung des Versatzes zwischen Task-Fälligkeit und gespeichertem
 *        `remind_at`, sowie Auflösung auf ein UI-Preset.
 *
 * Wichtig: `remind_at` wird beim Speichern via `Date#toISOString()` als UTC
 * abgelegt (ohne abschließendes "Z"). Daher muss es hier ebenfalls als UTC
 * interpretiert werden — sonst entsteht ein doppelter Zeitzonen-Offset, der
 * sich bei jedem Speichern erneut aufaddiert (Issue #354).
 */

import { displayTimeZone, zonedFields } from './timezone.js';

const TZ_SUFFIX = /[zZ]|[+-]\d{2}:?\d{2}$/;

/**
 * Parst einen gespeicherten `remind_at`-Wert als UTC, falls keine
 * Zeitzonenangabe vorhanden ist.
 * @param {string} value
 * @returns {Date}
 */
export function parseRemindAtAsUtc(value) {
  return new Date(TZ_SUFFIX.test(value) ? value : `${value}Z`);
}

/**
 * Parst eine Yuvomi-Wanduhrzeit als Zeitpunkt in der Anzeige-/Haushaltszone.
 * Ohne explizite Haushaltszone bleibt die bisherige Browser-Zone der Fallback.
 * @param {string} value YYYY-MM-DDTHH:mm[:ss]
 * @param {string|null} timeZone IANA-Zone oder null für Browser-Lokalzeit
 * @returns {Date}
 */
export function wallTimeToInstant(value, timeZone = displayTimeZone()) {
  const raw = String(value ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match) return new Date(NaN);
  const local = `${match[1]}T${match[2]}:${match[3] || '00'}`;

  if (!timeZone) return new Date(local);

  // `fakeUtc` carries the wall-clock digits as UTC fields. Formatting those
  // digits in the target zone reveals the offset that has to be removed. This
  // is the browser counterpart of server/utils/timezone.js:localToUTC().
  const fakeUtc = new Date(`${local}Z`);
  if (Number.isNaN(fakeUtc.getTime())) return new Date(NaN);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  }).formatToParts(fakeUtc);
  const get = (type) => {
    const part = parts.find((entry) => entry.type === type);
    const valuePart = part ? Number(part.value) : 0;
    return type === 'hour' && valuePart === 24 ? 0 : valuePart;
  };
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = fakeUtc.getTime() - asUtc;
  return new Date(fakeUtc.getTime() + offsetMs);
}

/** 将 Yuvomi 的日期和时间字段保存为现有的 UTC（不带 Z）格式。 */
export function wallTimeToStoredUtc(date, time = '00:00', timeZone = displayTimeZone()) {
  const instant = wallTimeToInstant(`${date}T${time}`, timeZone);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString().slice(0, 19);
}

function taskDueInstant(task) {
  if (!task?.due_date) return null;
  const dueTime = task.due_time || '23:59:59';
  return wallTimeToInstant(`${task.due_date}T${dueTime}`);
}

function absoluteReminderFields(reminder) {
  const instant = parseRemindAtAsUtc(reminder?.remind_at);
  if (Number.isNaN(instant.getTime())) return { date: '', time: '' };
  const fields = zonedFields(instant);
  if (!fields) return { date: '', time: '' };
  const pad = (value) => String(value).padStart(2, '0');
  return {
    date: `${fields.year}-${pad(fields.month)}-${pad(fields.day)}`,
    time: `${pad(fields.hour)}:${pad(fields.minute)}`,
  };
}

/**
 * Millisekunden-Versatz zwischen Fälligkeit (lokal) und Erinnerung (UTC).
 * @returns {number|null} positiver Versatz in ms, oder null bei fehlenden Daten
 */
export function parseOffsetMsFromReminder(task, reminder) {
  if (!task?.due_date || !reminder?.remind_at) return null;
  const due = taskDueInstant(task);
  const remind = parseRemindAtAsUtc(reminder.remind_at);
  if (Number.isNaN(due.getTime()) || Number.isNaN(remind.getTime())) return null;
  return due.getTime() - remind.getTime();
}

const PRESET_MAP = new Map([
  [0, 'offset_at_time'],
  [15 * 60 * 1000, 'offset_15m'],
  [60 * 60 * 1000, 'offset_1h'],
  [24 * 60 * 60 * 1000, 'offset_1d'],
  [2 * 24 * 60 * 60 * 1000, 'offset_2d'],
  [7 * 24 * 60 * 60 * 1000, 'offset_1w'],
  [14 * 24 * 60 * 60 * 1000, 'offset_2w'],
]);

/**
 * Löst Task + Reminder auf das passende UI-Preset auf.
 * @returns {{ preset: string, amount: string, unit: string }}
 */
export function resolveReminderPreset(task, reminder) {
  const offset = parseOffsetMsFromReminder(task, reminder);
  if (offset === null) {
    if (reminder?.remind_at) {
      return { preset: 'offset_absolute', amount: '', unit: '', ...absoluteReminderFields(reminder) };
    }
    return { preset: 'offset_15m', amount: '15', unit: 'minutes' };
  }
  if (offset < 0) {
    return { preset: 'offset_absolute', amount: '', unit: '', ...absoluteReminderFields(reminder) };
  }
  if (PRESET_MAP.has(offset)) return { preset: PRESET_MAP.get(offset), amount: '1', unit: 'days' };
  const minutes = Math.round(offset / 60000);
  if (minutes > 0) return { preset: 'offset_custom', amount: String(minutes), unit: 'minutes' };
  return { preset: 'offset_at_time', amount: '1', unit: 'days' };
}
