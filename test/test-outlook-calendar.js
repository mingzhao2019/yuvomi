/**
 * Modul: Outlook Calendar Sync - Unit- und Sync-Tests
 * Zweck: Validiert das RRULE→Graph-Mapping, die Ganztags-/Datetime-Konvertierung
 *        und den bidirektionalen Delta-/Konflikt-Algorithmus mit injiziertem
 *        fetch.
 * Ausführen: node test/test-outlook-calendar.js
 */

// Env VOR den Imports setzen: db.js verbindet sich beim Import mit DB_PATH,
// der Service liest die MS_*-Variablen zur Laufzeit.
process.env.DB_PATH = ':memory:';
process.env.MS_CLIENT_ID = 'test-client';
process.env.MS_CLIENT_SECRET = 'test-secret';
process.env.MS_REDIRECT_URI = 'http://localhost/api/v1/calendar/outlook/callback';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const outlook = await import('../server/services/outlook-calendar.js');
const { rruleToGraphRecurrence, allDayEndToExclusive, toGraphDateTime,
        localEventToGraph, contentHash, graphDateTimeValue, remoteEventSnapshot } = outlook.__test;

// Die Haushaltszone EXPLIZIT setzen (#829). Bis v2.27.0 stand im Push fest
// 'Europe/Berlin', und die Tests prueften genau diesen Literalwert - eine
// Zusicherung, die den Fehler nicht sehen konnte, weil sie ihn abschrieb. Jetzt
// folgt der Push der Einstellung, und ohne diese Zeile pruefte die Suite die
// Zone des Rechners, auf dem sie laeuft: in der UTC-CI 'UTC', auf einem Laptop
// irgendetwas anderes. Bewusst NICHT 'Europe/Berlin', damit ein Rueckfall auf
// den alten Festwert auffliegt.
const HOUSEHOLD_TZ = 'America/Toronto';
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)")
  .run(HOUSEHOLD_TZ);

// --------------------------------------------------------
// Fake-fetch-Helfer
// --------------------------------------------------------

function jsonRes(status, data = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

/** Zeichnet alle Requests auf und delegiert an einen Handler. */
function makeFetch(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    const call = {
      url,
      method: options.method || 'GET',
      body: options.body && options.headers?.['Content-Type'] === 'application/json'
        ? JSON.parse(options.body)
        : options.body || null,
    };
    calls.push(call);
    return handler(call);
  };
  fn.calls = calls;
  return fn;
}

// --------------------------------------------------------
// RRULE → Graph recurrence
// --------------------------------------------------------

describe('rruleToGraphRecurrence', () => {
  it('DAILY mit INTERVAL und offenem Ende', () => {
    const r = rruleToGraphRecurrence('FREQ=DAILY;INTERVAL=2', '2026-06-10');
    assert.deepEqual(r.pattern, { type: 'daily', interval: 2 });
    assert.equal(r.range.type, 'noEnd');
    assert.equal(r.range.startDate, '2026-06-10');
    assert.equal(r.range.recurrenceTimeZone, HOUSEHOLD_TZ);
  });

  it('WEEKLY mit BYDAY und COUNT', () => {
    const r = rruleToGraphRecurrence('FREQ=WEEKLY;BYDAY=MO,TH;COUNT=10', '2026-06-10');
    assert.equal(r.pattern.type, 'weekly');
    assert.deepEqual(r.pattern.daysOfWeek, ['monday', 'thursday']);
    assert.equal(r.pattern.firstDayOfWeek, 'monday');
    assert.deepEqual(
      { type: r.range.type, numberOfOccurrences: r.range.numberOfOccurrences },
      { type: 'numbered', numberOfOccurrences: 10 }
    );
  });

  it('WEEKLY ohne BYDAY fällt auf den Start-Wochentag zurück', () => {
    // 2026-06-10 ist ein Mittwoch.
    const r = rruleToGraphRecurrence('FREQ=WEEKLY', '2026-06-10');
    assert.deepEqual(r.pattern.daysOfWeek, ['wednesday']);
  });

  it('MONTHLY mit UNTIL wird absoluteMonthly mit endDate', () => {
    const r = rruleToGraphRecurrence('FREQ=MONTHLY;UNTIL=20261231', '2026-06-15');
    assert.deepEqual(r.pattern, { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 });
    assert.equal(r.range.type, 'endDate');
    assert.equal(r.range.endDate, '2026-12-31');
  });

  it('YEARLY trägt Monat und Tag aus dem Startdatum', () => {
    const r = rruleToGraphRecurrence('FREQ=YEARLY', '2026-03-07');
    assert.deepEqual(r.pattern, { type: 'absoluteYearly', interval: 1, dayOfMonth: 7, month: 3 });
  });

  it('akzeptiert das RRULE:-Präfix', () => {
    const r = rruleToGraphRecurrence('RRULE:FREQ=DAILY', '2026-06-10');
    assert.equal(r.pattern.type, 'daily');
  });

  it('liefert null für nicht unterstützte/ungültige Regeln', () => {
    assert.equal(rruleToGraphRecurrence('FREQ=HOURLY', '2026-06-10'), null);
    assert.equal(rruleToGraphRecurrence('', '2026-06-10'), null);
    assert.equal(rruleToGraphRecurrence('FREQ=DAILY', ''), null);
  });
});

// --------------------------------------------------------
// Datums-/Payload-Konvertierung
// --------------------------------------------------------

describe('Datums- und Payload-Konvertierung', () => {
  it('allDayEndToExclusive addiert einen Tag (inklusive → exklusive)', () => {
    assert.equal(allDayEndToExclusive('2026-01-02'), '2026-01-03');
    assert.equal(allDayEndToExclusive('2026-02-28'), '2026-03-01');
    assert.equal(allDayEndToExclusive(null), null);
  });

  it('toGraphDateTime ergänzt Sekunden bei naiver Lokalzeit', () => {
    assert.deepEqual(toGraphDateTime('2026-06-10T10:00'),
      { dateTime: '2026-06-10T10:00:00', timeZone: HOUSEHOLD_TZ });
  });

  it('toGraphDateTime nimmt die Haushaltszone, nicht mehr fest Europe/Berlin (#829)', () => {
    // Der Gegenbeweis zum Festwert: ein Haushalt in Toronto schickte seine
    // Termine sechs Stunden verschoben zu Outlook, und installation.md fuehrte
    // das als Einschraenkung ("folgt NICHT deinem TZ-Setting").
    assert.notEqual(toGraphDateTime('2026-06-10T10:00').timeZone, 'Europe/Berlin');
  });

  it('toGraphDateTime normalisiert Z-Zeiten nach UTC', () => {
    assert.deepEqual(toGraphDateTime('2026-06-10T10:00:00Z'),
      { dateTime: '2026-06-10T10:00:00', timeZone: 'UTC' });
  });

  it('normalisiert Outlook-Zeiten genau einmal in die Haushalts-Wanduhr', () => {
    assert.deepEqual(
      graphDateTimeValue({
        dateTime: '2026-06-10T17:00:00.0000000',
        timeZone: 'FLE Standard Time',
      }, { fallbackTimeZone: 'Europe/Helsinki' }),
      { value: '2026-06-10T17:00', timeZone: null },
    );
    assert.deepEqual(
      graphDateTimeValue({
        dateTime: '2026-06-10T17:00:00.0000000Z',
      }, { fallbackTimeZone: 'Europe/Helsinki' }),
      { value: '2026-06-10T20:00', timeZone: null },
    );
    assert.deepEqual(
      remoteEventSnapshot({
        id: 'finnish-1',
        subject: 'Finnish event',
        start: { dateTime: '2026-06-10T17:00:00', timeZone: 'FLE Standard Time' },
        end: { dateTime: '2026-06-10T18:00:00', timeZone: 'FLE Standard Time' },
      }, 'Europe/Helsinki'),
      {
        title: 'Finnish event',
        description: null,
        location: null,
        start_datetime: '2026-06-10T17:00',
        end_datetime: '2026-06-10T18:00',
        all_day: 0,
        recurrence_rule: null,
        tzid: null,
        external_object_url: 'https://graph.microsoft.com/v1.0/me/events/finnish-1',
      },
    );
  });

  it('localEventToGraph baut getimte Events mit Ort und Beschreibung', () => {
    const p = localEventToGraph({
      title: 'Zahnarzt', description: 'Kontrolle', location: 'Praxis',
      all_day: 0, start_datetime: '2026-06-10T10:00', end_datetime: '2026-06-10T11:00',
    });
    assert.equal(p.subject, 'Zahnarzt');
    assert.deepEqual(p.body, { contentType: 'text', content: 'Kontrolle' });
    assert.deepEqual(p.location, { displayName: 'Praxis' });
    assert.equal(p.start.dateTime, '2026-06-10T10:00:00');
    assert.equal(p.end.dateTime, '2026-06-10T11:00:00');
    assert.equal(p.isAllDay, undefined);
  });

  it('localEventToGraph baut Ganztags-Events Mitternacht-zu-Mitternacht exklusiv', () => {
    const p = localEventToGraph({
      title: 'Urlaub', all_day: 1,
      start_datetime: '2026-01-01', end_datetime: '2026-01-02',
    });
    assert.equal(p.isAllDay, true);
    assert.equal(p.start.dateTime, '2026-01-01T00:00:00');
    assert.equal(p.end.dateTime, '2026-01-03T00:00:00');
  });

  it('localEventToGraph hängt die Graph-Recurrence an Serien', () => {
    const p = localEventToGraph({
      title: 'Sport', all_day: 0,
      start_datetime: '2026-06-10T18:00', end_datetime: '2026-06-10T19:00',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE',
    });
    assert.equal(p.recurrence.pattern.type, 'weekly');
    assert.equal(p.recurrence.range.startDate, '2026-06-10');
  });

  it('contentHash ist stabil und kalender-sensitiv', () => {
    const payload = { subject: 'A', start: { dateTime: 'x' } };
    assert.equal(contentHash(payload, 'cal-1'), contentHash({ ...payload }, 'cal-1'));
    assert.notEqual(contentHash(payload, 'cal-1'), contentHash(payload, 'cal-2'));
  });
});

// --------------------------------------------------------
// Bidirektionaler Outlook-Sync (Delta + explizite Konfliktwahl)
// --------------------------------------------------------

const DELTA_RE = /\/me\/calendars\/([^/]+)\/calendarView\/delta/;
let deltaToken = 0;

function answerDelta(call, changesByCalendar = {}) {
  const match = call.method === 'GET' ? call.url.match(DELTA_RE) : null;
  if (!match) return null;
  const calendarId = decodeURIComponent(match[1]);
  const value = Object.hasOwn(changesByCalendar, calendarId)
    ? changesByCalendar[calendarId]
    : [];
  deltaToken += 1;
  return jsonRes(200, {
    value,
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/'
      + encodeURIComponent(calendarId)
      + '/calendarView/delta?token=test-'
      + deltaToken,
  });
}

function remoteEvent(id, overrides = {}) {
  return {
    id,
    subject: 'Outlook-Termin',
    body: { contentType: 'text', content: 'Outlook-Beschreibung' },
    start: { dateTime: '2026-06-10T10:00:00', timeZone: HOUSEHOLD_TZ },
    end: { dateTime: '2026-06-10T11:00:00', timeZone: HOUSEHOLD_TZ },
    isAllDay: false,
    location: { displayName: 'Outlook-Raum' },
    changeKey: 'remote-1',
    webLink: 'https://outlook.example/events/' + id,
    ...overrides,
  };
}

describe('Outlook bidirectional sync', () => {
  let userId;
  let accountId;
  let localEventId;
  const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString();

  function eventRow(id) {
    return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  }

  function linkRow(id) {
    return db.prepare(
      'SELECT * FROM outlook_event_links WHERE event_id = ? AND account_id = ?'
    ).get(id, accountId);
  }

  function accountRow() {
    return db.prepare('SELECT * FROM outlook_accounts WHERE id = ?').get(accountId);
  }

  function insertLocalEvent({
    title,
    description = null,
    start = '2026-06-10T10:00',
    end = '2026-06-10T11:00',
    source = 'local',
    target = true,
  }) {
    return db.prepare(
      'INSERT INTO calendar_events '
      + '(title, description, start_datetime, end_datetime, all_day, location, color, '
      + 'created_by, external_source, target_outlook_account_id, target_outlook_calendar_id) '
      + 'VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)'
    ).run(
      title,
      description,
      start,
      end,
      null,
      '#007AFF',
      userId,
      source,
      target ? accountId : null,
      target ? 'cal-A' : null,
    ).lastInsertRowid;
  }

  before(() => {
    db.prepare('DELETE FROM outlook_calendar_conflicts').run();
    db.prepare('DELETE FROM outlook_event_links').run();
    db.prepare('DELETE FROM calendar_events').run();
    db.prepare('DELETE FROM outlook_calendar_selection').run();
    db.prepare('DELETE FROM outlook_accounts').run();

    userId = db.prepare(
      "INSERT INTO users (username, display_name, password_hash, role) "
      + "VALUES ('outlook-bidirectional-tester', 'Outlook Tester', 'x', 'admin')"
    ).run().lastInsertRowid;

    accountId = db.prepare(
      'INSERT INTO outlook_accounts '
      + '(name, ms_user_id, email, access_token, refresh_token, token_expiry, owner_user_id) '
      + "VALUES ('Outlook Tester', 'ms-bidirectional', 'outlook@example.com', "
      + "'access-tok', 'refresh-tok', ?, ?)"
    ).run(futureExpiry, userId).lastInsertRowid;

    db.prepare(
      "INSERT INTO outlook_calendar_selection "
      + "(account_id, calendar_id, calendar_name, can_edit, enabled) "
      + "VALUES (?, 'cal-A', 'Kalender A', 1, 1)"
    ).run(accountId);

    db.prepare(
      "INSERT INTO outlook_calendar_selection "
      + "(account_id, calendar_id, calendar_name, can_edit, enabled) "
      + "VALUES (?, 'cal-disabled', 'Deaktiviert', 1, 0)"
    ).run(accountId);

    localEventId = insertLocalEvent({
      title: 'Lokaler Termin',
      description: 'Lokale Beschreibung',
    });
  });

  it('保留自动同步候选规则', () => {
    outlook.updateAccount(accountId, { autoSyncCalendarId: 'cal-A' });
    const candidates = outlook.__test.collectCandidates(db, accountRow());
    assert.equal(candidates.get(localEventId).calendarId, 'cal-A');
    outlook.updateAccount(accountId, { autoSyncCalendarId: null });
  });

  it('一次性替换日历选择并保留未选择项为关闭', () => {
    assert.deepEqual(outlook.setCalendarSelection(accountId, ['cal-disabled'], db), { success: true });
    const rows = db.prepare(
      'SELECT calendar_id, enabled FROM outlook_calendar_selection WHERE account_id = ? ORDER BY calendar_id'
    ).all(accountId);
    assert.deepEqual(rows, [
      { calendar_id: 'cal-A', enabled: 0 },
      { calendar_id: 'cal-disabled', enabled: 1 },
    ]);
    outlook.setCalendarSelection(accountId, ['cal-A'], db);
    outlook.updateAccount(accountId, { autoSyncCalendarId: 'cal-A' });
    outlook.setCalendarSelection(accountId, [], db);
    assert.equal(
      db.prepare(
        "SELECT enabled FROM outlook_calendar_selection WHERE account_id = ? AND calendar_id = 'cal-A'"
      ).get(accountId).enabled,
      1,
    );
    outlook.updateAccount(accountId, { autoSyncCalendarId: null });
  });

  it('使用 calendarView/delta，推送本地事件并保存游标', async () => {
    const fetchImpl = makeFetch((call) => {
      const delta = answerDelta(call);
      if (delta) return delta;
      if (call.method === 'POST' && call.url.endsWith('/me/calendars/cal-A/events')) {
        return jsonRes(201, { id: 'graph-local-1', changeKey: 'local-1' });
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.pushed, 1);
    assert.equal(result.imported, 0);
    assert.equal(result.syncedAccounts, 1);
    assert.deepEqual(fetchImpl.calls.map((call) => call.method), ['GET', 'POST']);

    const link = linkRow(localEventId);
    assert.equal(link.link_type, 'push');
    assert.equal(link.outlook_event_id, 'graph-local-1');
    assert.equal(link.outlook_change_key, 'local-1');
    assert.ok(link.content_hash);
    assert.equal(link.outbound_dirty, 0);

    const selection = db.prepare(
      'SELECT sync_range_start, sync_range_end, sync_cursor '
      + "FROM outlook_calendar_selection WHERE account_id = ? AND calendar_id = 'cal-A'"
    ).get(accountId);
    assert.equal(selection.sync_range_start, outlook.__test.defaultSyncStartDate());
    assert.ok(selection.sync_range_end);
    assert.match(selection.sync_cursor, /test-/);
    assert.match(fetchImpl.calls[0].url, /calendarView\/delta/);
    assert.match(fetchImpl.calls[0].url, /startDateTime=/);
    assert.equal(
      db.prepare(
        'SELECT sync_cursor FROM outlook_calendar_selection '
        + "WHERE account_id = ? AND calendar_id = 'cal-disabled'"
      ).get(accountId).sync_cursor,
      null,
      '禁用日历不参与导入',
    );
  });

  it('没有变化时只消费 delta，不写回 Outlook', async () => {
    const fetchImpl = makeFetch((call) => {
      const delta = answerDelta(call);
      if (delta) return delta;
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.pushed + result.updated + result.deleted + result.imported, 0);
    assert.deepEqual(fetchImpl.calls.map((call) => call.method), ['GET']);
  });

  it('本地修改通过 If-Match 回写 Outlook', async () => {
    const before = eventRow(localEventId);
    db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?')
      .run('本地修改', localEventId);
    const after = eventRow(localEventId);
    assert.equal(outlook.markEventOutbound(before, after), true);

    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const call = {
        url,
        method: options.method || 'GET',
        body: options.body ? JSON.parse(options.body) : null,
        headers: options.headers || {},
      };
      calls.push(call);
      if (call.method === 'PATCH' && call.url.endsWith('/me/events/graph-local-1')) {
        assert.equal(call.body.subject, '本地修改');
        return jsonRes(200, { id: 'graph-local-1', changeKey: 'local-2' });
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    };

    const result = await outlook.flushOutbound({ fetchImpl });
    assert.equal(result.updated, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers['If-Match'], 'local-1');
    assert.equal(linkRow(localEventId).outlook_change_key, 'local-2');
    assert.equal(linkRow(localEventId).outbound_dirty, 0);
  });

  it('Outlook 单方面修改时导入 Outlook 版本，不再静默覆盖', async () => {
    const fetchImpl = makeFetch((call) => {
      const delta = answerDelta(call, {
        'cal-A': [remoteEvent('graph-local-1', {
          subject: 'Outlook 修改',
          body: { contentType: 'text', content: '远端内容' },
          location: { displayName: '远端会议室' },
          changeKey: 'remote-2',
        })],
      });
      if (delta) return delta;
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.updated, 1);
    assert.equal(result.conflicts, 0);
    assert.equal(eventRow(localEventId).title, 'Outlook 修改');
    assert.equal(eventRow(localEventId).description, '远端内容');
    assert.equal(eventRow(localEventId).location, '远端会议室');
    assert.equal(linkRow(localEventId).outlook_change_key, 'remote-2');
    assert.equal(fetchImpl.calls.length, 1, '只读入 delta，不反向 PATCH 自己刚读到的版本');
  });

  it('远端新事件导入为 Outlook 来源，并允许本地编辑后回写', async () => {
    const fetchImpl = makeFetch((call) => {
      const delta = answerDelta(call, {
        'cal-A': [remoteEvent('graph-inbound-1', {
          subject: '远端新事件',
          body: { contentType: 'text', content: '远端说明' },
          changeKey: 'inbound-1',
        })],
      });
      if (delta) return delta;
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.imported, 1);

    const imported = db.prepare(
      'SELECT * FROM calendar_events WHERE external_object_url = ?'
    ).get('https://outlook.example/events/graph-inbound-1');
    assert.ok(imported);
    assert.equal(imported.external_source, 'outlook');
    assert.equal(imported.title, '远端新事件');
    assert.equal(imported.description, '远端说明');
    const importedLink = linkRow(imported.id);
    assert.equal(importedLink.link_type, 'inbound');
    assert.equal(importedLink.outlook_event_id, 'graph-inbound-1');

    const before = eventRow(imported.id);
    db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?')
      .run('本地编辑的远端事件', imported.id);
    const after = eventRow(imported.id);
    assert.equal(outlook.markEventOutbound(before, after), true);

    const pushFetch = makeFetch((call) => {
      if (call.method === 'PATCH' && call.url.endsWith('/me/events/graph-inbound-1')) {
        assert.equal(call.body.subject, '本地编辑的远端事件');
        return jsonRes(200, { id: 'graph-inbound-1', changeKey: 'inbound-2' });
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });
    const pushResult = await outlook.flushOutbound({ fetchImpl: pushFetch });
    assert.equal(pushResult.updated, 1);
    assert.equal(pushFetch.calls.length, 1);
    assert.equal(linkRow(imported.id).outbound_dirty, 0);
  });

  it('双方修改时生成待选择冲突，不自动覆盖或回写', async () => {
    const before = eventRow(localEventId);
    db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?')
      .run('Yuvomi 修改', localEventId);
    const after = eventRow(localEventId);
    outlook.markEventOutbound(before, after);

    const fetchImpl = makeFetch((call) => {
      const delta = answerDelta(call, {
        'cal-A': [remoteEvent('graph-local-1', {
          subject: 'Outlook 同时修改',
          changeKey: 'remote-conflict-1',
        })],
      });
      if (delta) return delta;
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.conflicts, 1);
    assert.equal(eventRow(localEventId).title, 'Yuvomi 修改');
    assert.equal(fetchImpl.calls.length, 1);

    const conflicts = outlook.listConflicts({ accountId, status: 'pending' });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].eventId, localEventId);
    assert.equal(conflicts[0].local.title, 'Yuvomi 修改');
    assert.equal(conflicts[0].remote.title, 'Outlook 同时修改');
  });

  it('选择 Outlook 版本后清除冲突且不再产生回写', async () => {
    const conflict = outlook.listConflicts({ accountId })[0];
    const resolved = outlook.resolveConflict(conflict.id, 'remote');
    assert.equal(resolved.resolution, 'remote');

    const fetchImpl = makeFetch((call) => {
      throw new Error('Unexpected request after remote resolution: ' + call.method + ' ' + call.url);
    });
    const result = await outlook.flushOutbound({ fetchImpl });
    assert.equal(result.updated, 0);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(eventRow(localEventId).title, 'Outlook 同时修改');
    assert.equal(outlook.listConflicts({ accountId }).length, 0);
  });

  it('选择 Yuvomi 版本后通过 PATCH 覆盖 Outlook', async () => {
    const before = eventRow(localEventId);
    db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?')
      .run('Yuvomi 最终版本', localEventId);
    const after = eventRow(localEventId);
    outlook.markEventOutbound(before, after);

    const fetchImpl = makeFetch((call) => {
      const delta = answerDelta(call, {
        'cal-A': [remoteEvent('graph-local-1', {
          subject: 'Outlook 再次修改',
          changeKey: 'remote-conflict-2',
        })],
      });
      if (delta) return delta;
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });
    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.conflicts, 1);

    const conflict = outlook.listConflicts({ accountId })[0];
    outlook.resolveConflict(conflict.id, 'local');
    assert.equal(linkRow(localEventId).outbound_dirty, 1);

    const pushFetch = makeFetch((call) => {
      if (call.method === 'PATCH' && call.url.endsWith('/me/events/graph-local-1')) {
        assert.equal(call.body.subject, 'Yuvomi 最终版本');
        return jsonRes(200, { id: 'graph-local-1', changeKey: 'local-final' });
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });
    const pushResult = await outlook.flushOutbound({ fetchImpl: pushFetch });
    assert.equal(pushResult.updated, 1);
    assert.equal(linkRow(localEventId).outlook_change_key, 'local-final');
    assert.equal(outlook.listConflicts({ accountId }).length, 0);
  });

  it('远端删除有本地未同步修改的事件时生成删除冲突', async () => {
    const deletionConflictEventId = insertLocalEvent({
      title: '待删除冲突',
      start: '2026-06-12T10:00',
      end: '2026-06-12T11:00',
    });
    const createFetch = makeFetch((call) => {
      const delta = answerDelta(call);
      if (delta) return delta;
      if (call.method === 'POST' && call.url.endsWith('/me/calendars/cal-A/events')) {
        return jsonRes(201, { id: 'graph-delete-conflict', changeKey: 'delete-1' });
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });
    await outlook.sync({ fetchImpl: createFetch });

    const before = eventRow(deletionConflictEventId);
    db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?')
      .run('本地保留版本', deletionConflictEventId);
    outlook.markEventOutbound(before, eventRow(deletionConflictEventId));

    const deleteFetch = makeFetch((call) => {
      const delta = answerDelta(call, {
        'cal-A': [{
          id: 'graph-delete-conflict',
          '@removed': { reason: 'deleted' },
        }],
      });
      if (delta) return delta;
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });
    const result = await outlook.sync({ fetchImpl: deleteFetch });
    assert.equal(result.conflicts, 1);
    assert.ok(eventRow(deletionConflictEventId));
    const conflict = outlook.listConflicts({ accountId })[0];
    assert.equal(conflict.remote, null);

    // In a true two-way mirror, accepting the remote deletion removes the
    // local copy as well. A second account link would preserve the shared row.
    outlook.resolveConflict(conflict.id, 'remote');
    assert.equal(eventRow(deletionConflictEventId), undefined);
    assert.equal(linkRow(deletionConflictEventId), undefined);
  });

  it('本地删除通过墓碑发送 DELETE，成功后才清除远端链接', async () => {
    const deletionEventId = insertLocalEvent({
      title: '本地删除',
      start: '2026-06-13T10:00',
      end: '2026-06-13T11:00',
    });
    const createFetch = makeFetch((call) => {
      const delta = answerDelta(call);
      if (delta) return delta;
      if (call.method === 'POST' && call.url.endsWith('/me/calendars/cal-A/events')) {
        return jsonRes(201, { id: 'graph-local-delete', changeKey: 'delete-2' });
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });
    await outlook.sync({ fetchImpl: createFetch });

    const event = eventRow(deletionEventId);
    assert.equal(outlook.queueEventDeletion(event), true);
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(deletionEventId);

    const deleteFetch = makeFetch((call) => {
      const delta = answerDelta(call, {
        'cal-A': [remoteEvent('graph-local-delete', { subject: '远端仍存在' })],
      });
      if (delta) return delta;
      if (call.method === 'DELETE' && call.url.endsWith('/me/events/graph-local-delete')) {
        return jsonRes(204);
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });
    // The inbound pass arrives first in a normal sync. The tombstone must keep
    // this update from resurrecting the locally deleted event.
    const result = await outlook.sync({ fetchImpl: deleteFetch });
    assert.equal(result.deleted, 1);
    assert.deepEqual(deleteFetch.calls.map((call) => call.method), ['GET', 'DELETE']);
    assert.equal(eventRow(deletionEventId), undefined);
    assert.equal(linkRow(deletionEventId), undefined);
  });

  it('修改绝对起始日期时只重置游标，不删除既有事件', () => {
    const eventId = insertLocalEvent({
      title: '日期窗口测试',
      start: '2026-06-14T10:00',
      end: '2026-06-14T11:00',
    });
    db.prepare(
      "UPDATE outlook_calendar_selection SET sync_cursor = 'cursor-before', sync_range_start = '2026-02-01' "
      + "WHERE account_id = ? AND calendar_id = 'cal-A'"
    ).run(accountId);
    const countBefore = db.prepare('SELECT COUNT(*) AS count FROM calendar_events').get().count;

    const selected = outlook.setCalendarSyncStartDate(accountId, 'cal-A', '2025-01-15');
    assert.equal(selected.customSyncStartDate, '2025-01-15');
    assert.equal(selected.syncStartDate, '2025-01-15');
    assert.equal(
      db.prepare(
        "SELECT sync_cursor FROM outlook_calendar_selection "
        + "WHERE account_id = ? AND calendar_id = 'cal-A'"
      ).get(accountId).sync_cursor,
      null,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_events').get().count, countBefore);
    assert.equal(eventRow(eventId).title, '日期窗口测试');

    const reset = outlook.setCalendarSyncStartDate(accountId, 'cal-A', null);
    assert.equal(reset.customSyncStartDate, null);
    assert.equal(reset.syncStartDate, outlook.__test.defaultSyncStartDate());
  });

  it('刷新日历列表时保留同步状态，新日历默认关闭', async () => {
    const fetchImpl = makeFetch((call) => {
      if (call.method === 'GET' && call.url.includes('/me/calendars')) {
        return jsonRes(200, {
          value: [
            { id: 'cal-A', name: 'Kalender A', canEdit: true },
            { id: 'cal-new', name: 'Neu', canEdit: true },
          ],
        });
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });

    await outlook.__test.refreshCalendarSelection(accountId, 'access-tok', fetchImpl);
    const rows = Object.fromEntries(
      db.prepare(
        'SELECT calendar_id, enabled, sync_start_date, sync_cursor '
        + 'FROM outlook_calendar_selection WHERE account_id = ?'
      ).all(accountId).map((row) => [row.calendar_id, row])
    );
    assert.equal(rows['cal-A'].enabled, 1);
    assert.equal(rows['cal-A'].sync_start_date, null);
    assert.equal(rows['cal-A'].sync_cursor, null);
    assert.equal(rows['cal-new'].enabled, 0);
  });

  it('清空本地 Outlook 目标时删除远端副本而不是重新推送', async () => {
    const eventId = insertLocalEvent({
      title: '解除目标',
      start: '2026-06-15T10:00',
      end: '2026-06-15T11:00',
    });
    const createFetch = makeFetch((call) => {
      const delta = answerDelta(call);
      if (delta) return delta;
      if (call.method === 'POST' && call.url.endsWith('/me/calendars/cal-A/events')) {
        return jsonRes(201, { id: 'graph-target-cleared', changeKey: 'target-1' });
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });
    await outlook.sync({ fetchImpl: createFetch });

    const before = eventRow(eventId);
    db.prepare(
      'UPDATE calendar_events SET target_outlook_account_id = NULL, target_outlook_calendar_id = NULL WHERE id = ?'
    ).run(eventId);
    const after = eventRow(eventId);
    assert.equal(outlook.markEventOutbound(before, after), true);

    const deleteFetch = makeFetch((call) => {
      const delta = answerDelta(call);
      if (delta) return delta;
      if (call.method === 'DELETE' && call.url.endsWith('/me/events/graph-target-cleared')) {
        return jsonRes(204);
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });
    const result = await outlook.sync({ fetchImpl: deleteFetch });
    assert.equal(result.deleted, 1);
    assert.equal(linkRow(eventId), undefined);
    assert.ok(eventRow(eventId), '清除同步目标只解除远端关联，不删除本地事件');
  });

  it('invalid_grant 会要求重新连接，后续同步跳过该账户', async () => {
    db.prepare('UPDATE outlook_accounts SET token_expiry = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), accountId);

    const fetchImpl = makeFetch((call) => {
      if (call.url.startsWith('https://login.microsoftonline.com/') && call.url.includes('/token')) {
        return jsonRes(400, { error: 'invalid_grant', error_description: 'AADSTS70000: expired' });
      }
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.syncedAccounts, 0);
    assert.equal(accountRow().needs_reauth, 1);
    assert.match(accountRow().last_error, /Reconnect required/);

    const quietFetch = makeFetch((call) => {
      throw new Error('Unexpected request: ' + call.method + ' ' + call.url);
    });
    await outlook.sync({ fetchImpl: quietFetch });
    assert.equal(quietFetch.calls.length, 0);
  });
});

// --------------------------------------------------------
// 配置守卫
// --------------------------------------------------------

describe('assertConfigured', () => {
  it('没有 MS_* 环境变量时抛出明确配置错误', () => {
    const saved = process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_ID;
    try {
      assert.throws(() => outlook.assertConfigured(), /MS_CLIENT_ID, MS_CLIENT_SECRET, and MS_REDIRECT_URI/);
    } finally {
      process.env.MS_CLIENT_ID = saved;
    }
  });

  it('配置完整时不抛错', () => {
    assert.doesNotThrow(() => outlook.assertConfigured());
  });
});
