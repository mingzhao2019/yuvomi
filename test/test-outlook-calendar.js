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

import { describe, it, after, before, beforeEach } from 'node:test';
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

  it('"am letzten Tag des Monats" wird gar nicht gepusht statt falsch (#960)', () => {
    // Graph hat dafuer keine Entsprechung, und der naheliegende Ersatz ist
    // keiner: relativeMonthly mit index "last" ueber alle sieben Wochentage
    // liest sich wie "der letzte Tag", trifft ihn aber nicht - Graph nimmt bei
    // mehreren daysOfWeek den ersten passenden Tag. Zurueck ueber ICS kaeme ein
    // BYSETPOS-Muster, das diese Engine nicht liest. Ein Einzeltermin ist
    // sichtbar unvollstaendig, eine Serie am falschen Tag nicht.
    assert.equal(rruleToGraphRecurrence('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-15'), null);
  });

  it('ohne die Angabe bleibt es beim Starttag', () => {
    const r = rruleToGraphRecurrence('FREQ=MONTHLY', '2026-01-15');
    assert.equal(r.pattern.type, 'absoluteMonthly');
    assert.equal(r.pattern.dayOfMonth, 15);
  });

  it('eine nicht abbildbare Wiederholung wird drueben ausdruecklich geloescht', () => {
    // PATCH laesst ein ausgelassenes Feld unveraendert: die Serie liefe in
    // Outlook mit ihrer ALTEN Wiederholung weiter, waehrend der Inhalts-Hash
    // gespeichert wird, als sei alles zusammengelaufen.
    const payload = localEventToGraph({
      title: 'Zaehlerstand', start_datetime: '2026-01-15T09:00:00', end_datetime: '2026-01-15T09:30:00',
      recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
    });
    assert.ok('recurrence' in payload, 'das Feld muss im Payload STEHEN');
    assert.equal(payload.recurrence, null, 'und ausdruecklich null sein');
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
        reminder_minutes_before_start: null,
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

  function setupBidirectionalFixture() {
    db.prepare('DELETE FROM outlook_calendar_conflicts').run();
    db.prepare('DELETE FROM outlook_event_links').run();
    db.prepare('DELETE FROM calendar_events').run();
    db.prepare('DELETE FROM outlook_calendar_selection').run();
    db.prepare('DELETE FROM outlook_accounts').run();
    db.prepare("DELETE FROM users WHERE username = 'outlook-bidirectional-tester'").run();

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
  }

  before(setupBidirectionalFixture);

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

  describe('Outlook auto-sync', () => {
    let anna;
    let ben;
    let stranger;
    let accountA;
    let accountB;

    function insertUser(name) {
      return db.prepare(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES (?, ?, 'x', 'member')`
      ).run(name.toLowerCase(), name).lastInsertRowid;
    }

    function insertAccount(name, ownerId, autoCalId) {
      const id = db.prepare(
        `INSERT INTO outlook_accounts
          (name, ms_user_id, email, access_token, refresh_token, token_expiry,
           auto_sync_calendar_id, owner_user_id)
         VALUES (?, ?, ?, 'tok', 'ref', ?, ?, ?)`
      ).run(name, `ms-${name}`, `${name.toLowerCase()}@example.com`, futureExpiry, autoCalId, ownerId).lastInsertRowid;
      db.prepare(
        `INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled)
         VALUES (?, ?, 'Yuvomi', 1, 1)`
      ).run(id, autoCalId);
      return id;
    }

    function insertEvent({ title, createdBy, visibility = 'all', source = 'local', assignees = [] }) {
      const id = db.prepare(
        `INSERT INTO calendar_events
          (title, start_datetime, color, created_by, visibility, external_source)
         VALUES (?, '2026-09-01T10:00', '#007AFF', ?, ?, ?)`
      ).run(title, createdBy, visibility, source).lastInsertRowid;
      for (const uid of assignees) {
        db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, uid);
      }
      return id;
    }

    before(() => {
      db.prepare('DELETE FROM outlook_calendar_conflicts').run();
      db.prepare('DELETE FROM outlook_event_links').run();
      db.prepare('DELETE FROM calendar_events').run();
      db.prepare('DELETE FROM outlook_calendar_selection').run();
      db.prepare('DELETE FROM outlook_accounts').run();

      anna = insertUser('Anna');
      ben = insertUser('Ben');
      stranger = insertUser('Zoe');
      accountA = insertAccount('Anna Outlook', anna, 'yuvomi-cal-A');
      accountB = insertAccount('Ben Outlook', ben, 'yuvomi-cal-B');
    });

    after(() => {
      setupBidirectionalFixture();
    });

  it('updateAccount participates in an existing transaction', () => {
    db.transaction(() => {
      outlook.updateAccount(accountA, { ownerUserId: anna });
    })();
    assert.equal(
      db.prepare('SELECT owner_user_id FROM outlook_accounts WHERE id = ?').get(accountA).owner_user_id,
      Number(anna),
    );
  });

  it('updateAccount lehnt Auto-Sync-Aktivierung bei sichtbaren verknüpften Ausnahmen atomar ab', () => {
    const guardedAccountId = db.prepare(`
      INSERT INTO outlook_accounts
        (name, ms_user_id, email, access_token, refresh_token, token_expiry, owner_user_id)
      VALUES ('Activation guard', 'ms-activation-guard', 'guard@example.com', 'tok', 'ref', ?, ?)
    `).run(futureExpiry, anna).lastInsertRowid;
    db.prepare(`
      INSERT INTO outlook_calendar_selection
        (account_id, calendar_id, calendar_name, can_edit, enabled)
      VALUES (?, 'guard-cal', 'Guard', 1, 0)
    `).run(guardedAccountId);
    const masterId = insertEvent({ title: 'Guarded series', createdBy: anna });
    const childId = insertEvent({ title: 'Guarded occurrence', createdBy: anna });
    db.prepare("UPDATE calendar_events SET recurrence_rule = 'FREQ=DAILY' WHERE id = ?").run(masterId);
    db.prepare(`
      UPDATE calendar_events
      SET recurrence_parent_id = ?, recurrence_id = '2026-09-02', overridden_fields = '["title"]'
      WHERE id = ?
    `).run(masterId, childId);

    assert.throws(
      () => outlook.updateAccount(guardedAccountId, { autoSyncCalendarId: 'guard-cal' }),
      (err) => err.code === 'outlook_auto_sync_overrides' && err.linkedOverrideCount === 1
    );
    assert.equal(db.prepare(
      'SELECT auto_sync_calendar_id FROM outlook_accounts WHERE id = ?'
    ).get(guardedAccountId).auto_sync_calendar_id, null);
    assert.equal(db.prepare(`
      SELECT enabled FROM outlook_calendar_selection WHERE account_id = ? AND calendar_id = 'guard-cal'
    `).get(guardedAccountId).enabled, 0);

    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(masterId);
    db.prepare('DELETE FROM outlook_accounts WHERE id = ?').run(guardedAccountId);
  });

  it('handleCallback erneuert Tokens trotz verknüpfter Ausnahmen und löscht needs_reauth', async () => {
    const guardedAccountId = db.prepare(`
      INSERT INTO outlook_accounts
        (name, ms_user_id, email, access_token, refresh_token, token_expiry,
         needs_reauth, auto_sync_calendar_id, owner_user_id)
      VALUES ('Reauth guard', 'ms-reauth-guard', 'old@example.com', 'old-access', 'old-refresh', ?,
              1, 'reauth-cal', ?)
    `).run(futureExpiry, anna).lastInsertRowid;
    const masterId = insertEvent({ title: 'Reauth guarded series', createdBy: anna });
    const childId = insertEvent({ title: 'Reauth guarded occurrence', createdBy: anna });
    db.prepare("UPDATE calendar_events SET recurrence_rule = 'FREQ=DAILY' WHERE id = ?").run(masterId);
    db.prepare(`
      UPDATE calendar_events
      SET recurrence_parent_id = ?, recurrence_id = '2026-09-02', overridden_fields = '["title"]'
      WHERE id = ?
    `).run(masterId, childId);
    const fetchImpl = makeFetch((call) => {
      if (call.method === 'POST' && call.url.includes('/oauth2/v2.0/token')) {
        return jsonRes(200, {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        });
      }
      if (call.method === 'GET' && call.url.includes('/me?$select=')) {
        return jsonRes(200, {
          id: 'ms-reauth-guard',
          displayName: 'Reauth guard',
          mail: 'new@example.com',
        });
      }
      if (call.method === 'GET' && call.url.includes('/me/calendars?')) {
        return jsonRes(200, { value: [{ id: 'reauth-cal', name: 'Reauth', canEdit: true }] });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await outlook.handleCallback('reauth-code', fetchImpl);
    const stored = db.prepare(`
      SELECT needs_reauth, access_token, refresh_token FROM outlook_accounts WHERE id = ?
    `).get(guardedAccountId);
    assert.deepEqual(stored, { needs_reauth: 0, access_token: 'new-access', refresh_token: 'new-refresh' });
    assert.equal(fetchImpl.calls.length, 3, 'token refresh reloads calendar selection');

    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(masterId);
    db.prepare('DELETE FROM outlook_accounts WHERE id = ?').run(guardedAccountId);
  });

  it('collectCandidates: sichtbar-für-Owner, keine externen Events, explizites Ziel gewinnt', () => {
    const familyEvent  = insertEvent({ title: 'Familienessen', createdBy: anna, assignees: [anna, ben] });
    const plainEvent   = insertEvent({ title: 'Testtermin', createdBy: ben });
    const privateEvent = insertEvent({ title: 'Geheim', createdBy: stranger, visibility: 'private' });
    const icsEvent     = insertEvent({ title: 'Feiertag', createdBy: anna, source: 'ics' });
    const explicitEvent = insertEvent({ title: 'Explizit', createdBy: anna });
    const recurringMaster = insertEvent({ title: 'Lokale Serie', createdBy: anna });
    const linkedChild = insertEvent({ title: 'Lokale Ausnahme', createdBy: anna });
    db.prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = ?')
      .run('FREQ=DAILY', recurringMaster);
    db.prepare(`
      UPDATE calendar_events
      SET recurrence_parent_id = ?, recurrence_id = '2026-09-02',
          overridden_fields = '["title"]', target_outlook_account_id = ?,
          target_outlook_calendar_id = 'extra-cal'
      WHERE id = ?
    `).run(recurringMaster, accountA, linkedChild);
    db.prepare(
      'UPDATE calendar_events SET target_outlook_account_id = ?, target_outlook_calendar_id = ? WHERE id = ?'
    ).run(accountA, 'extra-cal', explicitEvent);

    const account = db.prepare('SELECT * FROM outlook_accounts WHERE id = ?').get(accountA);
    const candidates = outlook.__test.collectCandidates(db, account);

    assert.ok(candidates.has(familyEvent), 'für alle sichtbares Event ist Kandidat');
    assert.ok(candidates.has(plainEvent), 'Event ohne Zuweisung ist Kandidat');
    assert.ok(!candidates.has(privateEvent), 'privates Event einer anderen Person ist KEIN Kandidat');
    assert.ok(!candidates.has(icsEvent), 'extern synchronisiertes Event ist KEIN Kandidat');
    assert.ok(candidates.has(recurringMaster), 'lokaler Serien-Master bleibt Kandidat');
    assert.ok(!candidates.has(linkedChild), 'verknüpfte Ausnahme ist nie ein eigener Outlook-Kandidat');
    assert.equal(candidates.get(familyEvent).calendarId, 'yuvomi-cal-A');
    assert.equal(candidates.get(explicitEvent).calendarId, 'extra-cal', 'explizites Ziel gewinnt');

    const names = JSON.parse(candidates.get(familyEvent).event.assignee_names_json);
    assert.deepEqual(names, ['Anna', 'Ben'], 'Zuweisungs-Namen alphabetisch');

    db.prepare('DELETE FROM calendar_events WHERE id IN (?, ?, ?, ?, ?)')
      .run(privateEvent, icsEvent, explicitEvent, recurringMaster, linkedChild);
  });
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

describe('Outlook occurrence override target guards', () => {
  let owner;
  let otherOwner;
  let accountId;
  let masterId;

  before(() => {
    owner = db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES ('guard-owner', 'Owner', 'x')").run().lastInsertRowid;
    otherOwner = db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES ('guard-other', 'Other', 'x')").run().lastInsertRowid;
  });

  beforeEach(() => {
    db.prepare('DELETE FROM calendar_events').run();
    db.prepare('DELETE FROM outlook_accounts').run();
    accountId = db.prepare(`
      INSERT INTO outlook_accounts (name, access_token, refresh_token, token_expiry, owner_user_id)
      VALUES ('Guard targets', 'tok', 'ref', ?, ?)
    `).run(new Date(Date.now() + 3600000).toISOString(), owner).lastInsertRowid;
    db.prepare(`
      INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled)
      VALUES (?, 'auto', 'Auto', 1, 0), (?, 'explicit', 'Explicit', 1, 0)
    `).run(accountId, accountId);
    masterId = db.prepare(`
      INSERT INTO calendar_events (title, start_datetime, recurrence_rule, created_by)
      VALUES ('Series', '2026-09-01T10:00', 'FREQ=DAILY', ?)
    `).run(owner).lastInsertRowid;
    db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, created_by, recurrence_parent_id, recurrence_id, overridden_fields)
      VALUES ('Override', '2026-09-02T10:00', ?, ?, '2026-09-02', '["title"]')
    `).run(owner, masterId);
  });

  for (const target of [
    { name: 'disabled', canEdit: 1, enabled: 0 },
    { name: 'read-only', canEdit: 0, enabled: 1 },
    { name: 'missing', missing: true },
  ]) {
    it(`allows auto-sync when the effective explicit target is ${target.name}`, async () => {
      db.prepare('UPDATE calendar_events SET target_outlook_account_id = ?, target_outlook_calendar_id = ? WHERE id = ?')
        .run(accountId, 'explicit', masterId);
      if (target.missing) {
        db.prepare("DELETE FROM outlook_calendar_selection WHERE calendar_id = 'explicit'").run();
      } else {
        db.prepare("UPDATE outlook_calendar_selection SET can_edit = ?, enabled = ? WHERE calendar_id = 'explicit'")
          .run(target.canEdit, target.enabled);
      }
      outlook.updateAccount(accountId, { autoSyncCalendarId: 'auto' });
      assert.equal(db.prepare('SELECT auto_sync_calendar_id FROM outlook_accounts WHERE id = ?').get(accountId).auto_sync_calendar_id, 'auto');
      assert.equal(db.prepare("SELECT enabled FROM outlook_calendar_selection WHERE calendar_id = 'auto'").get().enabled, 1);
      const ordinaryId = db.prepare(`
        INSERT INTO calendar_events (title, start_datetime, created_by)
        VALUES ('Ordinary event', '2026-09-03T10:00', ?)
      `).run(owner).lastInsertRowid;
      const fetchImpl = makeFetch((call) => {
        if (call.method === 'POST' && call.url.endsWith('/calendars/auto/events')) {
          return jsonRes(201, { id: 'ordinary-remote', changeKey: 'ck' });
        }
        throw new Error(`Unexpected request: ${call.method} ${call.url}`);
      });
      const result = await outlook.sync({ fetchImpl });
      assert.equal(result.pushed, 1, 'an unpushable linked series must not block unrelated candidates');
      const links = db.prepare('SELECT event_id FROM outlook_event_links').all();
      assert.deepEqual(links.map((link) => link.event_id), [Number(ordinaryId)]);
      const postCall = fetchImpl.calls.find((call) => call.method === 'POST');
      assert.ok(postCall, 'ordinary event must produce a POST');
      assert.equal(postCall.body.subject, 'Ordinary event');
    });
  }

  it('allows an owner change while the effective auto calendar is disabled, then rejects enabling it', () => {
    db.prepare("UPDATE outlook_accounts SET auto_sync_calendar_id = 'auto', owner_user_id = NULL WHERE id = ?").run(accountId);
    outlook.updateAccount(accountId, { ownerUserId: owner });
    assert.equal(db.prepare('SELECT owner_user_id FROM outlook_accounts WHERE id = ?').get(accountId).owner_user_id, Number(owner));
    assert.throws(() => outlook.setCalendarEnabled(accountId, 'auto', true),
      (err) => err.status === 409 && err.linkedOverrideCount === 1);
    assert.equal(db.prepare("SELECT enabled FROM outlook_calendar_selection WHERE calendar_id = 'auto'").get().enabled, 0);
  });

  it('rejects enabling an explicit writable target even with auto-sync disabled', () => {
    db.prepare("UPDATE calendar_events SET target_outlook_account_id = ?, target_outlook_calendar_id = 'explicit' WHERE id = ?")
      .run(accountId, masterId);
    assert.throws(() => outlook.setCalendarEnabled(accountId, 'explicit', true),
      (err) => err.status === 409 && err.linkedOverrideCount === 1);
    assert.equal(db.prepare("SELECT enabled FROM outlook_calendar_selection WHERE calendar_id = 'explicit'").get().enabled, 0);
  });

  it('rejects changing the owner when a private series becomes a writable auto-sync candidate', () => {
    db.prepare("UPDATE calendar_events SET visibility = 'private' WHERE id = ?").run(masterId);
    outlook.updateAccount(accountId, { autoSyncCalendarId: 'auto', ownerUserId: otherOwner });
    assert.throws(() => outlook.updateAccount(accountId, { ownerUserId: owner }),
      (err) => err.status === 409 && err.linkedOverrideCount === 1);
    assert.equal(db.prepare('SELECT owner_user_id FROM outlook_accounts WHERE id = ?').get(accountId).owner_user_id, Number(otherOwner));
  });

  it('does not push a linked master when refresh restores write access to its selected calendar', async () => {
    db.prepare("UPDATE outlook_accounts SET auto_sync_calendar_id = 'auto' WHERE id = ?").run(accountId);
    db.prepare("UPDATE outlook_calendar_selection SET enabled = 1, can_edit = 0 WHERE calendar_id = 'auto'").run();
    const fetchImpl = makeFetch((call) => {
      if (call.method === 'GET' && call.url.includes('/me/calendars')) {
        return jsonRes(200, { value: [{ id: 'auto', name: 'Auto', canEdit: true }] });
      }
      if (call.method === 'POST') return jsonRes(201, { id: 'incorrect-master-push', changeKey: 'ck' });
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    await outlook.__test.refreshCalendarSelection(accountId, 'tok', fetchImpl);
    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.pushed, 0, 'linked series must not be pushed without its occurrence overrides');
    assert.equal(fetchImpl.calls.filter((call) => call.method !== 'GET').length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM outlook_event_links').get().count, 0);
    assert.ok(db.prepare('SELECT last_error FROM outlook_accounts WHERE id = ?').get(accountId).last_error);
  });
});

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
