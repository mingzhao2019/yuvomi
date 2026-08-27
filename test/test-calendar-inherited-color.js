/**
 * 回归测试：事件自己的颜色、继承颜色以及显式清除状态。
 *
 * 这组测试专门验证两个会影响现有数据库的迁移：v170 让 color 可为空，
 * v171 用 color_modified 区分“用户清除了颜色”和“从未学到颜色”。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'yuvomi-color-')), 'unused.db');
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
  const database = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-color-db-')), 'db.sqlite'));
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
