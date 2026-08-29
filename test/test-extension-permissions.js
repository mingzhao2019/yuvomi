/**
 * Test: Extension module permissions
 * Run: node --experimental-sqlite --test test/test-extension-permissions.js
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yuvomi-ext-perms-'));
const MODULES_DIR = path.join(TMP_ROOT, 'modules');
fs.mkdirSync(MODULES_DIR, { recursive: true });

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.MODULES_DIR = MODULES_DIR;

function writeModule(folder, manifest, files = {}) {
  const dir = path.join(MODULES_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

writeModule('demo-ext', {
  id: 'demo-ext',
  name: 'Demo Extension',
  entry: 'index.js',
  capabilities: {
    permissions: {
      module: { label: 'Demo Extension', icon: 'box' },
      widgets: [{ id: 'summary', label: 'Summary' }],
    },
    widgets: [{
      id: 'summary',
      entry: 'widgets/summary.js',
      label: 'Summary widget',
      defaultSize: '1x2',
    }],
    api: { prefix: '/api/extensions/demo-ext' },
  },
}, {
  'index.js': 'export async function render() {}\n',
  'widgets/summary.js': 'export async function renderWidget() {}\n',
});

const dbmod = await import('../server/db.js');
const svc = await import('../server/services/modules.js');
const {
  resolvePermissions,
  permissionCatalog,
  normalizePermissionInput,
  replaceSubjectPermissions,
} = await import('../server/permissions.js');
const { extensionPermissionKey } = await import('../server/services/module-capabilities.js');

const db = dbmod.get();

test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

test('listModules exposes extension capabilities and catalog merge', async () => {
  const mods = await svc.listModules({ admin: false });
  assert.equal(mods.length, 1);
  assert.equal(mods[0].capabilities.permissionModuleKey, 'ext:demo-ext');
  assert.equal(mods[0].capabilities.widgets[0].id, 'demo-ext:summary');

  const catalog = permissionCatalog();
  assert.ok(catalog.modules.some((m) => m.key === 'ext:demo-ext'));
  assert.ok(catalog.widgets.some((w) => w.id === 'demo-ext:summary'));
  assert.ok(catalog.scopeModuleKeys.includes('ext:demo-ext'));
});

test('resolvePermissions includes extension keys and widget inherit', async () => {
  const user = { id: 2, role: 'member', family_role: 'child' };
  replaceSubjectPermissions(db, 'user', user.id, {
    modules: { 'ext:demo-ext': 'none' },
    widgets: {},
  });

  const resolved = resolvePermissions(db, user);
  assert.equal(resolved.modules['ext:demo-ext'], 'none');
  assert.equal(resolved.widgets['demo-ext:summary'], 'none');
});

test('normalizePermissionInput accepts extension widget id', async () => {
  await svc.listModules({ admin: true });
  const rows = normalizePermissionInput({
    modules: { 'ext:demo-ext': 'read' },
    widgets: { 'demo-ext:summary': 'none' },
  });
  assert.ok(rows.some((r) => r.resource_key === 'ext:demo-ext'));
  assert.ok(rows.some((r) => r.resource_key === 'demo-ext:summary'));
});

test('extensionPermissionKey helper', () => {
  assert.equal(extensionPermissionKey('demo-ext'), 'ext:demo-ext');
});
