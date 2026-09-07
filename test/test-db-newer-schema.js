/**
 * Downgrade protection: an older app must not silently write to a newer schema.
 * Run with: npm run test:db-newer-schema
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

delete process.env.DB_ENCRYPTION_KEY;
delete process.env.DB_ALLOW_NEWER_SCHEMA;
const dir = mkdtempSync(join(tmpdir(), 'yuvomi-newer-schema-'));
const dbPath = join(dir, 'yuvomi.db');
let scenario = 0;

function boot() {
  process.env.DB_PATH = dbPath;
  return import(`../server/db.js?newer=${++scenario}`);
}

test.after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('a database from this build starts without an unknown migration', async () => {
  const mod = await boot();
  assert.deepEqual(mod.unknownMigrationVersions(mod.get()), []);
  mod.get().prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(999999, 'from a newer version');
  assert.deepEqual(mod.unknownMigrationVersions(mod.get()), [999999]);
  mod.get().close();
});

test('an older app refuses the newer schema and explains the recovery switch', async () => {
  await assert.rejects(boot(), (err) => {
    assert.match(err.message, /newer Yuvomi/);
    assert.match(err.message, /999999/);
    assert.match(err.message, /DB_ALLOW_NEWER_SCHEMA/);
    return true;
  });
});

test('DB_ALLOW_NEWER_SCHEMA=1 starts with a warning and keeps the database usable', async () => {
  process.env.DB_ALLOW_NEWER_SCHEMA = '1';
  try {
    const mod = await boot();
    assert.doesNotThrow(() => mod.get().prepare('SELECT 1').get());
    assert.deepEqual(mod.unknownMigrationVersions(mod.get()), [999999]);
    mod.get().close();
  } finally {
    delete process.env.DB_ALLOW_NEWER_SCHEMA;
  }
});

test('an empty DB_ALLOW_NEWER_SCHEMA value does not opt in', async () => {
  process.env.DB_ALLOW_NEWER_SCHEMA = '';
  try {
    await assert.rejects(boot(), /newer Yuvomi/);
  } finally {
    delete process.env.DB_ALLOW_NEWER_SCHEMA;
  }
});
