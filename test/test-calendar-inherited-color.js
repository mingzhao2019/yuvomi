/**
 * 回归测试：事件自己的颜色、继承颜色以及显式清除状态。
 *
 * 这组测试专门验证两个会影响现有数据库的迁移：v170 让 color 可为空，
 * v171 用 color_modified 区分“用户清除了颜色”和“从未学到颜色”。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

process.env.DB_PATH = join(tempDir('yuvomi-color-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const NULLABLE_COLOR_VERSION = 170;
const COLOR_MODIFIED_VERSION = 171;

function applyMigration(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  migration.afterUp?.(database);
}

function applyWithProductionSemantics(database, migration) {
  if (!migration.foreignKeysOff) return applyMigration(database, migration);
  database.pragma('foreign_keys = OFF');
  try {
    applyMigration(database, migration);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

function databaseBefore(version) {
  const database = new Database(join(tempDir('yuvomi-color-db-'), 'db.sqlite'));
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of MIGRATIONS.filter((item) => item.version < version)) {
    applyMigration(database, migration);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

function seed(database) {
  database.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'admin', 'Admin', 'x', 'admin')"
  ).run();
  database.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, role) VALUES (2, 'maria', 'Maria', 'x', 'member')"
  ).run();
  const calendarId = database.prepare(
    "INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav', 'family', 'Family', '#34A853')"
  ).run().lastInsertRowid;
  const insert = database.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, color, external_source, external_calendar_id,
       calendar_ref_id, recurrence_rule, user_modified, icon, visibility, countdown, created_by)
    VALUES (@title, @start, @end, @color, @source, @external, @calendar, @rule, @modified,
            @icon, @visibility, @countdown, 1)
  `);
  const ids = [
    insert.run({ title: 'Local', start: '2026-09-01T19:00', end: '2026-09-01T21:00', color: '#8156C0', source: 'local', external: null, calendar: null, rule: 'FREQ=MONTHLY', modified: 0, icon: 'calendar', visibility: 'all', countdown: 1 }).lastInsertRowid,
    insert.run({ title: 'Remote', start: '2026-09-05T08:30', end: '2026-09-05T09:15', color: '#34A853', source: 'caldav', external: 'uid-1', calendar: calendarId, rule: null, modified: 1, icon: 'tooth', visibility: 'assignees', countdown: 0 }).lastInsertRowid,
    insert.run({ title: 'Birthday', start: '2026-05-04', end: null, color: '#007AFF', source: 'local', external: null, calendar: null, rule: 'FREQ=YEARLY', modified: 0, icon: 'cake', visibility: 'all', countdown: 0 }).lastInsertRowid,
  ];
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(ids[0], 2);
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(ids[0], 1);
  database.prepare("INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, '2026-10-01')").run(ids[0]);
  database.prepare(
    "INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by) VALUES ('Maria', '1990-05-04', ?, 1)"
  ).run(ids[2]);
  return { ids, calendarId };
}

function migration(version) {
  return MIGRATIONS.find((item) => item.version === version);
}

test('v170 重建 calendar_events 时保留数据、关联、索引和触发器', () => {
  const database = databaseBefore(NULLABLE_COLOR_VERSION);
  const seeded = seed(database);
  const before = database.prepare('SELECT * FROM calendar_events ORDER BY id').all();
  const objects = () => database.prepare(
    "SELECT type, name FROM sqlite_master WHERE tbl_name = 'calendar_events' AND type IN ('index', 'trigger') ORDER BY type, name"
  ).all().filter((row) => !row.name.startsWith('sqlite_autoindex'));
  const objectsBefore = objects();

  applyWithProductionSemantics(database, migration(NULLABLE_COLOR_VERSION));

  assert.deepEqual(database.prepare('SELECT * FROM calendar_events ORDER BY id').all(), before);
  assert.deepEqual(objects(), objectsBefore);
  assert.deepEqual(
    database.prepare('SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id').all(seeded.ids[0]),
    [{ user_id: 1 }, { user_id: 2 }],
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM calendar_event_exceptions WHERE event_id = ?').get(seeded.ids[0]).count,
    1,
  );
  assert.equal(
    database.prepare('SELECT calendar_event_id FROM birthdays WHERE name = ?').get('Maria').calendar_event_id,
    seeded.ids[2],
  );
  const color = database.prepare('PRAGMA table_info(calendar_events)').all().find((row) => row.name === 'color');
  assert.equal(color.notnull, 0);
  assert.equal(color.dflt_value, null);
  database.prepare('UPDATE calendar_events SET color = NULL WHERE id = ?').run(seeded.ids[0]);
  assert.equal(database.prepare('SELECT color FROM calendar_events WHERE id = ?').get(seeded.ids[0]).color, null);
  database.close();
});

test('v171 逐行保留旧的颜色保护，并让新记录从 0 开始', () => {
  const database = databaseBefore(COLOR_MODIFIED_VERSION);
  seed(database);
  const oldValues = database.prepare('SELECT user_modified FROM calendar_events ORDER BY id').all()
    .map((row) => row.user_modified);

  applyMigration(database, migration(COLOR_MODIFIED_VERSION));

  assert.deepEqual(
    database.prepare('SELECT color_modified FROM calendar_events ORDER BY id').all().map((row) => row.color_modified),
    oldValues,
  );
  const column = database.prepare('PRAGMA table_info(calendar_events)').all()
    .find((row) => row.name === 'color_modified');
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, '0');
  database.prepare("INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('New', '2040-01-01T09:00', 1)").run();
  assert.equal(database.prepare("SELECT color_modified FROM calendar_events WHERE title = 'New'").get().color_modified, 0);
  database.close();
});

test('测试数据库镜像包含 v171 的颜色状态字段', async () => {
  const { MIGRATIONS_SQL } = await import('../server/db-schema-test.js');
  const database = new Database(':memory:');
  database.pragma('foreign_keys = OFF');
  database.exec(MIGRATIONS_SQL[11]);
  const column = database.prepare('PRAGMA table_info(calendar_events)').all()
    .find((row) => row.name === 'color_modified');
  assert.equal(column.notnull, 1);
  assert.equal(database.prepare('SELECT color_modified FROM calendar_events').get(), undefined);
  database.prepare("INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('New', '2040-01-01T09:00', 1)").run();
  assert.equal(database.prepare('SELECT color_modified FROM calendar_events').get().color_modified, 0);
  database.close();
});

test('der Test-Schema-Auszug haelt die Spalte ebenfalls nullable', async () => {
  // `server/db-schema-test.js` ist ein handgeschriebener AUSZUG, aus dem viele
  // Suiten ihre Datenbank bauen statt die ganze Migrationskette zu fahren. Er
  // driftet still: haelt er `color` weiter NOT NULL, laufen genau die Suiten
  // gruen darueber, die den neuen Zustand pruefen wollten - ihre Fixtures
  // koennen ihn gar nicht herstellen. Dieselbe Datei lag schon einmal sieben
  // Eintraege daneben, und `test:schema-mirror` faellt das nicht auf: der Guard
  // prueft die Zuordnung der Migrationsnummern, nicht die Spaltendefinitionen.
  const { MIGRATIONS_SQL } = await import('../server/db-schema-test.js');

  for (const key of [1, 11]) {
    const sql = MIGRATIONS_SQL[key];
    if (!sql || !/CREATE TABLE[^;]*calendar_events/.test(sql)) continue;
    const db = new Database(join(tempDir('yuvomi-auszug-'), 'db.sqlite'));
    // Jeder Eintrag ist fuer sich lesbar, seine Nachbartabellen fehlen aber - die
    // Suiten fahren jeweils die, die sie brauchen. Geprueft wird hier die
    // Spalte, nicht die Verweisintegritaet, deshalb ohne Fremdschluessel.
    db.pragma('foreign_keys = OFF');
    db.exec(sql);
    const col = db.prepare('PRAGMA table_info(calendar_events)').all().find((c) => c.name === 'color');
    assert.equal(col.notnull, 0, `MIGRATIONS_SQL[${key}]: color muss NULL annehmen wie in Produktion`);

    // Und es wirklich koennen - eine Spaltendefinition ist eine Behauptung,
    // ein INSERT ist der Beleg.
    db.prepare(`INSERT INTO calendar_events (title, start_datetime, color, created_by)
                VALUES ('Farblos', '2040-01-01T09:00', NULL, 1)`).run();
    assert.equal(db.prepare('SELECT color FROM calendar_events').get().color, null);
    db.close();
  }
});

// --------------------------------------------------------
// Die Farbe bekommt einen eigenen Zustand (Migration 167, #899)
// --------------------------------------------------------

test('Migration 167 uebernimmt den bisherigen Schutz Zeile fuer Zeile', () => {
  const db = databaseBefore(COLOR_MODIFIED_VERSION);
  seed(db);

  const vorher = db.prepare('SELECT user_modified FROM calendar_events ORDER BY id').all()
    .map((r) => r.user_modified);
  // VORBEDINGUNG. Waeren alle drei Zeilen gleich, sagte der Vergleich unten
  // nichts: `color_modified = 0` waere dann von `color_modified = user_modified`
  // nicht zu unterscheiden.
  assert.ok(new Set(vorher).size > 1, `der Bestand muss beide Faelle tragen: ${vorher.join()}`);

  applyWithProductionSemantics(db, migration(COLOR_MODIFIED_VERSION));

  const nachher = db.prepare('SELECT user_modified, color_modified FROM calendar_events ORDER BY id').all();
  assert.deepEqual(nachher.map((r) => r.color_modified), vorher,
    'der Backfill ist konservativ: was heute geschuetzt ist, bleibt geschuetzt');
  assert.deepEqual(nachher.map((r) => r.user_modified), vorher,
    'und user_modified behaelt seine eigene Bedeutung');

  const spalte = db.prepare('PRAGMA table_info(calendar_events)').all()
    .find((c) => c.name === 'color_modified');
  assert.equal(spalte.notnull, 1, 'das Flag ist nie unbekannt');
  assert.equal(spalte.dflt_value, '0', 'ein neuer Termin faengt ohne eigene Farbwahl an');
});

test('Migration 167 laesst einen neuen Termin bei 0 anfangen', () => {
  // Die Gegenprobe zum Backfill: er darf nicht als Default durchschlagen, sonst
  // waere jeder frisch importierte Termin gegen die Farbe seines Anbieters
  // gesperrt - genau der Zustand, den #899 aufloest.
  const db = databaseBefore(COLOR_MODIFIED_VERSION);
  seed(db);
  db.prepare("UPDATE calendar_events SET user_modified = 1").run();
  applyWithProductionSemantics(db, migration(COLOR_MODIFIED_VERSION));

  db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by)
              VALUES ('Frisch importiert', '2040-01-01T09:00', 1)`).run();
  const neu = db.prepare("SELECT color_modified FROM calendar_events WHERE title = 'Frisch importiert'").get();
  assert.equal(neu.color_modified, 0);
});

test('der Test-Schema-Auszug kennt den Zustand ebenfalls', async () => {
  // Dieselbe Falle wie bei der nullable Farbe darueber: fehlt die Spalte im
  // Auszug, stirbt jede Suite, die einen Sync-Upsert faehrt, an `no such
  // column` - und zwar an einer Stelle, die mit ihrem Pruefzweck nichts zu tun
  // hat. Der Beleg ist deshalb ein INSERT, keine Spaltendefinition.
  const { MIGRATIONS_SQL } = await import('../server/db-schema-test.js');
  const sql = MIGRATIONS_SQL[11];
  const db = new Database(join(tempDir('yuvomi-auszug-'), 'db.sqlite'));
  db.pragma('foreign_keys = OFF');
  db.exec(sql);
  db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by)
              VALUES ('Farblos', '2040-01-01T09:00', 1)`).run();
  assert.equal(db.prepare('SELECT color_modified FROM calendar_events').get().color_modified, 0);
  db.close();
});

// --------------------------------------------------------
// Wer das Gatter bedient (#899)
// --------------------------------------------------------

/**
 * Quelltext ohne Kommentare. Ein Guard, der im Rohtext sucht, liest einen
 * Kommentar als Regel - und die Kommentare an genau diesen Stellen ERKLAEREN
 * den alten Zustand, nennen also `user_modified` mit voller Absicht.
 */
function ohneKommentare(quelle) {
  return quelle
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((zeile) => !/^\s*(\/\/|--)/.test(zeile))
    .join('\n');
}

const SYNC_DIENSTE = [
  'server/services/caldav-sync.js',
  'server/services/apple-calendar.js',
  'server/services/google-calendar.js',
];

test('jedes Farb-Gatter des Inbound haengt an color_modified (#899)', async () => {
  // Eine Regel statt einer Allowlist, aus demselben Grund wie beim Fallback
  // darunter: die Stelle sieht in allen drei Diensten gleich aus. Gefunden wird
  // der Ausdruck selbst, nicht seine Datei - der vierte Anbieter faellt damit
  // automatisch unter die Regel.
  const { readFile } = await import('node:fs/promises');
  const GATTER_RE = /CASE\s+WHEN\s+(\w+)\s*=\s*0\s+THEN\s+\?\s+ELSE\s+color\s+END/g;

  let gefunden = 0;
  const falsch = [];
  for (const datei of SYNC_DIENSTE) {
    const quelle = ohneKommentare(await readFile(new URL(`../${datei}`, import.meta.url), 'utf8'));
    for (const treffer of quelle.matchAll(GATTER_RE)) {
      gefunden++;
      if (treffer[1] !== 'color_modified') falsch.push(`${datei}: ${treffer[0]}`);
    }
  }

  // VORBEDINGUNG: findet das Muster nichts, ist die Zusicherung darunter leer.
  // Genau so waere sie gruen geblieben, als das Gatter noch falsch war.
  assert.ok(gefunden >= 5, `nur ${gefunden} Farb-Gatter gefunden - stimmt das Muster noch?`);
  assert.deepEqual(falsch, [],
    'user_modified wird bei JEDER Bearbeitung gesetzt; ein Titel-Edit fror die Farbe damit ein (#899)');
});

test('der Upload merkt sich, dass die hinausgeschickte Farbe unsere ist (#899)', async () => {
  // Der dritte Befund aus #899: beide Abbildungen sind verlustbehaftet (CSS3-
  // Name bzw. eine von elf colorIds). Ohne das Flag holt der naechste
  // Inbound-Lauf den gerundeten Wert zurueck und ersetzt die gewaehlte Farbe.
  //
  // Die Regel haengt an der Stelle, an der ein LOKALER Termin zu einem
  // gespiegelten wird - das ist genau der Moment, in dem die Farbe erstmals
  // hinausgeht, und er ist in jedem Dienst als `external_source = '<anbieter>'`
  // in einer UPDATE-SET-Liste erkennbar.
  //
  // Seit #1837 teilen sich CalDAV und Apple diese Stelle: beide rufen
  // `markEventUploaded` in calendar-outbound.js, das die Quelle als Parameter
  // bindet (`external_source = ?`). Gezaehlt werden deshalb ANBIETER, nicht
  // UPDATEs: jeder der drei muss auf einem der beiden Wege ankommen, und jedes
  // UPDATE, das einen Termin zum Spiegel macht, muss das Flag tragen - das
  // geteilte genauso wie ein woertliches.
  const { readFile } = await import('node:fs/promises');
  const lies = async (datei) => ohneKommentare(await readFile(new URL(`../${datei}`, import.meta.url), 'utf8'));
  const UPDATE_RE = /UPDATE calendar_events\s+SET([\s\S]*?)WHERE/g;
  const HELFER_DATEI = 'server/services/calendar-outbound.js';

  const ohneFlag = [];
  const angekommen = new Set();

  // Der geteilte Helfer: genau das UPDATE, das die Quelle gebunden setzt.
  const helferQuelle = await lies(HELFER_DATEI);
  const helferStart = helferQuelle.indexOf('export function markEventUploaded(');
  assert.ok(helferStart >= 0, 'markEventUploaded fehlt in calendar-outbound.js - stimmt der Guard noch?');
  const helferRumpf = helferQuelle.slice(helferStart, helferQuelle.indexOf('\nexport ', helferStart + 1));
  const helferUpdates = [...helferRumpf.matchAll(UPDATE_RE)]
    .filter((treffer) => /external_source\s*=\s*\?/.test(treffer[1]));
  assert.equal(helferUpdates.length, 1,
    'markEventUploaded setzt external_source nicht mehr in genau einem UPDATE - stimmt der Guard noch?');
  const helferHatFlag = /color_modified/.test(helferUpdates[0][1]);
  if (!helferHatFlag) ohneFlag.push(HELFER_DATEI);

  for (const datei of SYNC_DIENSTE) {
    const quelle = await lies(datei);
    for (const treffer of quelle.matchAll(UPDATE_RE)) {
      const setListe = treffer[1];
      const woertlich = setListe.match(/external_source\s*=\s*'(caldav|apple|google)'/);
      if (!woertlich) continue;
      angekommen.add(woertlich[1]);
      if (!/color_modified/.test(setListe)) ohneFlag.push(datei);
    }
    // Der Aufruf muss die Quelle woertlich nennen: nur so ist belegt, WELCHER
    // Anbieter ueber den Helfer laeuft.
    for (const treffer of quelle.matchAll(/markEventUploaded\(\s*[^,]+,\s*\{[^}]*?source:\s*'(caldav|apple|google)'/g)) {
      angekommen.add(treffer[1]);
    }
  }

  assert.deepEqual([...angekommen].sort(), ['apple', 'caldav', 'google'],
    'jeder der drei Anbieter braucht eine Upload-Stelle, die den Termin zum Spiegel macht');
  assert.deepEqual(ohneFlag, [],
    'der Upload muss color_modified setzen, sonst verliert der Termin seine exakte Farbe an die gemappte');
});

// --------------------------------------------------------
// Die Importpfade
// --------------------------------------------------------

test('三个 inbound 提供方都用 color_modified 保护颜色', () => {
  const files = [
    'server/services/caldav-sync.js',
    'server/services/apple-calendar.js',
    'server/services/google-calendar.js',
  ];
  const guard = /CASE\s+WHEN\s+(\w+)\s*=\s*0\s+THEN\s+\?\s+ELSE\s+color\s+END/g;
  let count = 0;
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((line) => !/^\s*(\/\/|--)/.test(line)).join('\n');
    for (const match of source.matchAll(guard)) {
      count++;
      assert.equal(match[1], 'color_modified', `${file} 不能再用 user_modified 保护颜色`);
    }
  }
  assert.ok(count >= 5, `预期至少 5 个颜色保护表达式，实际 ${count}`);
});

test('provider color fallbacks remain read-time only', () => {
  const files = [
    'server/services/caldav-sync.js',
    'server/services/apple-calendar.js',
    'server/services/google-calendar.js',
    'server/services/calendar-event-reader.js',
  ];
  const FALLBACK_RE = /\.color\s*\|\|\s*[A-Za-z_$][\w$.]*(?:[Cc]olor|COLOR)/g;
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const matches = [...source.matchAll(FALLBACK_RE)].map((match) => match[0]);
    assert.deepEqual(matches, [],
      `${file}: inherited color must not be written into calendar_events.color`);
  }
});

test('der Lesepfad speist cal_color aus beiden Toepfen', () => {
  const LESEPFADE = [
    'server/routes/calendar/read.js',
    'server/routes/calendar/crud.js',
    'server/services/calendar-event-reader.js',
  ];
  for (const datei of LESEPFADE) {
    const quelle = readFileSync(new URL(`../${datei}`, import.meta.url), 'utf8');
    const anzahl = (quelle.match(/AS cal_color/g) || []).length;
    assert.ok(anzahl > 0, `${datei}: liefert kein cal_color`);
    const fallbacks = quelle.match(/COALESCE\((?:ec\.color,\s*isub\.color|isub\.color,\s*ec\.color)\) AS cal_color/g) || [];
    assert.equal(fallbacks.length, anzahl,
      `${datei}: jedes cal_color muss beide Quellen lesen, sonst verlieren Abo-Termine ihre Farbe`);
    assert.ok(/LEFT JOIN ics_subscriptions isub ON isub\.id = e\.subscription_id/.test(quelle),
      `${datei}: der Join auf ics_subscriptions fehlt`);
  }
});
