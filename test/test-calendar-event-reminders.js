/**
 * Focused tests for the calendar event reminder policy.
 * Run with: node --experimental-sqlite --test test/test-calendar-event-reminders.js
 */

process.env.DB_PATH = ':memory:';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const policy = await import('../server/services/calendar-event-reminders.js');

let ownerId;
let assigneeId;

function reset() {
  db.prepare('DELETE FROM reminders').run();
  db.prepare('DELETE FROM event_assignments').run();
  db.prepare('DELETE FROM calendar_events').run();
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'calendar_default_%:user:%' OR key = 'household_timezone' OR key = 'calendar_event_reminder_backfill_v1'").run();
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'America/Toronto')").run();
}

function insertUser(name) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'test', 'member')
  `).run(`${name}-${Date.now()}-${Math.random()}`, name).lastInsertRowid);
}

function insertEvent({ allDay = 0, start = '2030-06-10T10:00', end = '2030-06-10T11:00' } = {}) {
  const result = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source)
    VALUES ('Reminder test', ?, ?, ?, ?, 'local')
  `).run(start, end, allDay, ownerId);
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(result.lastInsertRowid);
}

function setUserDefaults(userId, reminders, allDayTime = '09:00') {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(`calendar_default_reminders:user:${userId}`, JSON.stringify(reminders));
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(`calendar_default_all_day_reminder_time:user:${userId}`, allDayTime);
}

beforeEach(() => {
  reset();
  ownerId = insertUser('Owner');
  assigneeId = insertUser('Assignee');
});

test('uses 15 minutes when the personal default was never configured', () => {
  const event = insertEvent();
  assert.deepEqual(policy.__test.defaultReminderAts(event, db), ['2030-06-10T13:45:00']);
});

test('uses the configured all-day wall-clock time on the event date', () => {
  setUserDefaults(ownerId, [30], '08:00');
  const event = insertEvent({ allDay: 1, start: '2030-06-10', end: '2030-06-11' });
  assert.deepEqual(policy.__test.defaultReminderAts(event, db), ['2030-06-10T12:00:00']);
});

test('explicit empty defaults stay disabled and do not create a reminder', () => {
  setUserDefaults(ownerId, [], '09:00');
  const event = insertEvent();
  assert.deepEqual(policy.__test.defaultReminderAts(event, db), []);
  assert.equal(policy.ensureDefaultEventReminders(db, event), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reminders').get().count, 0);
});

test('owner receives the reminder and assigned members receive the existing fan-out', () => {
  const event = insertEvent();
  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(event.id, assigneeId);
  assert.equal(policy.ensureDefaultEventReminders(db, event), true);
  assert.deepEqual(
    db.prepare('SELECT created_by, assigned_from, remind_at FROM reminders ORDER BY created_by').all(),
    [
      { created_by: ownerId, assigned_from: null, remind_at: '2030-06-10T13:45:00' },
      { created_by: assigneeId, assigned_from: ownerId, remind_at: '2030-06-10T13:45:00' },
    ],
  );
});

test('manual suppression survives a remote event without reminders, but explicit remote reminders re-enable it', () => {
  const event = insertEvent();
  policy.replaceOwnerEventReminders(db, event.id, ownerId, ['2030-06-10T13:45:00']);
  policy.replaceOwnerEventReminders(db, event.id, ownerId, [], { suppressed: true });
  const suppressed = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
  assert.equal(suppressed.reminder_suppressed, 1);
  assert.equal(policy.applyRemoteEventReminders(db, suppressed, [], { explicit: false }), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reminders').get().count, 0);

  assert.equal(policy.applyRemoteEventReminders(
    db,
    suppressed,
    ['2030-06-10T13:30:00'],
    { explicit: true },
  ), true);
  const restored = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
  assert.equal(restored.reminder_suppressed, 0);
  assert.deepEqual(policy.__test.ownerEventReminderAts(db, restored), ['2030-06-10T13:30:00']);
});

test('read-only ICS keeps a local reminder override until reset', () => {
  const event = insertEvent();
  policy.replaceOwnerEventReminders(db, event.id, ownerId, [], { suppressed: true });
  const suppressed = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);

  assert.equal(policy.applyRemoteEventReminders(
    db,
    suppressed,
    ['2030-06-10T13:30:00'],
    { explicit: true, explicitClearsSuppression: false },
  ), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reminders').get().count, 0);

  policy.clearReminderSuppression(db, event.id);
  const reset = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
  assert.equal(policy.applyRemoteEventReminders(
    db,
    reset,
    ['2030-06-10T13:30:00'],
    { explicit: true, explicitClearsSuppression: false },
  ), true);
  assert.deepEqual(policy.__test.ownerEventReminderAts(db, reset), ['2030-06-10T13:30:00']);
});

test('ICS reminder suppression does not freeze unrelated subscription fields', () => {
  const event = insertEvent();
  db.prepare("UPDATE calendar_events SET external_source = 'ics', user_modified = 0 WHERE id = ?").run(event.id);
  assert.ok(policy.recordManualOwnerReminderChange(db, event.id, ownerId, false));
  const stored = db.prepare('SELECT reminder_suppressed, user_modified FROM calendar_events WHERE id = ?').get(event.id);
  assert.deepEqual(stored, { reminder_suppressed: 1, user_modified: 0 });
});

test('backfill runs once, only creates future reminders, and leaves past events alone', () => {
  const future = insertEvent({ start: '2030-06-10T10:00', end: '2030-06-10T11:00' });
  const past = insertEvent({ start: '2020-06-10T10:00', end: '2020-06-10T11:00' });
  const first = policy.backfillCalendarEventReminders(db, {
    nowMs: new Date('2029-01-01T00:00:00Z').getTime(),
  });
  assert.deepEqual(first, { ran: true, updated: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reminders WHERE entity_id = ?').get(future.id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reminders WHERE entity_id = ?').get(past.id).count, 0);
  assert.deepEqual(
    policy.backfillCalendarEventReminders(db, { nowMs: new Date('2029-01-01T00:00:00Z').getTime() }),
    { ran: false, updated: 0 },
  );
});

test('iCalendar relative and absolute alarms become absolute UTC reminder rows', () => {
  const event = insertEvent();
  assert.deepEqual(
    policy.__test.reminderAtsFromIcalAlarms(event, [
      { action: 'DISPLAY', triggerType: 'relative', minutesBeforeStart: 30 },
      { action: 'DISPLAY', triggerType: 'absolute', at: '2030-06-10T13:00:00Z' },
    ], db),
    ['2030-06-10T13:00:00', '2030-06-10T13:30:00'],
  );
});

test('RELATED=END alarms use the event end instead of the start', () => {
  const event = insertEvent();
  assert.deepEqual(
    policy.__test.reminderAtsFromIcalAlarms(event, [
      { action: 'DISPLAY', triggerType: 'relative', minutesBeforeStart: 15, related: 'END' },
    ], db),
    ['2030-06-10T14:45:00'],
  );
});

test('an all-day reminder after midnight is not folded into a provider offset', () => {
  const event = insertEvent({ allDay: 1, start: '2030-06-10', end: '2030-06-10' });
  policy.replaceOwnerEventReminders(db, event.id, ownerId, ['2030-06-10T13:00:00']);
  assert.equal(
    policy.__test.reminderOffsetMinutes(event, '2030-06-10T13:00:00', db),
    null,
  );
  assert.equal(policy.__test.primaryProviderReminderOffset(event, db), null);
});
