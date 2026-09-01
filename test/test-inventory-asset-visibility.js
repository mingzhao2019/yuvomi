/** Inventory family/personal ownership and sharing contract. */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: itemsRouter } = await import('../server/routes/inventory/items.js');
const deadlinesIcs = await import('../server/services/inventory-deadlines-ics.js');
const database = dbmod.get();

function user(username, role = 'member') {
  return database.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'x', ?)
  `).run(username, username, role).lastInsertRowid;
}

const ADMIN = user('admin', 'admin');
const ALICE = user('alice');
const BOB = user('bob');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = Number(req.get('x-test-user'));
  req.authRole = req.get('x-test-role') || 'member';
  req.session = { userId: req.authUserId, role: req.authRole };
  next();
});
app.use('/items', itemsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((resolve) => server.on('listening', () => {
  resolve(`http://127.0.0.1:${server.address().port}`);
}));
test.after(() => server.close());

async function call(actor, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-test-user': String(actor.id),
      'x-test-role': actor.role,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await response.json(); } catch { /* 204 */ }
  return { status: response.status, body: json };
}

const admin = { id: ADMIN, role: 'admin' };
const alice = { id: ALICE, role: 'member' };
const bob = { id: BOB, role: 'member' };

test('family assets are admin-managed and visibility-limited for members', async () => {
  const created = await call(admin, 'POST', '/items', {
    name: 'Family NAS',
    asset_scope: 'family',
    visibility: 'assignees',
    assigned_user_ids: [ALICE],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.can_edit, true);
  const id = created.body.data.id;

  const aliceRead = await call(alice, 'GET', `/items/${id}`);
  assert.equal(aliceRead.status, 200);
  assert.equal(aliceRead.body.data.can_edit, false);
  assert.equal((await call(bob, 'GET', `/items/${id}`)).status, 404);
  assert.equal((await call(alice, 'PUT', `/items/${id}`, { name: 'Nope' })).status, 403);
});

test('personal assets stay private from admins and can be shared read-only', async () => {
  const created = await call(alice, 'POST', '/items', { name: 'Alice laptop' });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.asset_scope, 'personal');
  assert.equal(created.body.data.visibility, 'private');
  const id = created.body.data.id;

  assert.equal((await call(admin, 'GET', `/items/${id}`)).status, 404, 'admin must not bypass personal privacy');
  assert.equal((await call(bob, 'GET', `/items/${id}`)).status, 404);

  const shared = await call(alice, 'PUT', `/items/${id}`, {
    name: 'Alice laptop',
    asset_scope: 'personal',
    visibility: 'assignees',
    assigned_user_ids: [BOB],
  });
  assert.equal(shared.status, 200);
  assert.deepEqual(shared.body.data.assigned_user_ids, [BOB]);

  const bobRead = await call(bob, 'GET', `/items/${id}`);
  assert.equal(bobRead.status, 200);
  assert.equal(bobRead.body.data.can_edit, false);
  assert.equal((await call(bob, 'DELETE', `/items/${id}`)).status, 403);
});

test('members cannot create family assets or change an existing scope', async () => {
  assert.equal((await call(alice, 'POST', '/items', {
    name: 'Forbidden family asset', asset_scope: 'family',
  })).status, 403);

  const created = await call(alice, 'POST', '/items', { name: 'Personal phone' });
  const changed = await call(alice, 'PUT', `/items/${created.body.data.id}`, {
    name: 'Personal phone', asset_scope: 'family',
  });
  assert.equal(changed.status, 400);
});

test('personal deadline feeds apply the same asset visibility', async () => {
  const created = await call(alice, 'POST', '/items', {
    name: 'Private warranty marker',
    purchase_date: '2026-01-01',
    warranty_months: 12,
  });
  const id = created.body.data.id;
  assert.doesNotMatch(deadlinesIcs.buildInventoryDeadlinesFeed(database, BOB), /Private warranty marker/);

  await call(alice, 'PUT', `/items/${id}`, {
    name: 'Private warranty marker',
    purchase_date: '2026-01-01',
    warranty_months: 12,
    asset_scope: 'personal',
    visibility: 'assignees',
    assigned_user_ids: [BOB],
  });
  assert.match(deadlinesIcs.buildInventoryDeadlinesFeed(database, BOB), /Private warranty marker/);
});
