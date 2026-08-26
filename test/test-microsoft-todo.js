/** Microsoft Graph To Do list/task sync contract tests. */
process.env.DB_PATH = ':memory:';
process.env.MS_CLIENT_ID = 'test-client';
process.env.MS_CLIENT_SECRET = 'test-secret';
process.env.MS_REDIRECT_URI = 'http://localhost/api/v1/calendar/outlook/callback';

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const dbModule = await import('../server/db.js');
const database = dbModule.get();
const todo = await import('../server/services/microsoft-todo.js');
const outlook = await import('../server/services/outlook-calendar.js');

function response(status, data = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

function insertUser(username = 'todo-user') {
  return database.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'x', 'member')
  `).run(username, username).lastInsertRowid;
}

function insertAccount(ownerId) {
  return database.prepare(`
    INSERT INTO outlook_accounts
      (name, ms_user_id, email, access_token, refresh_token, token_expiry, owner_user_id)
    VALUES ('Microsoft', ?, ?, 'access', 'refresh', ?, ?)
  `).run(
    `ms-todo-${ownerId}`,
    `todo-${ownerId}@example.test`,
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ownerId,
  ).lastInsertRowid;
}

test('normalizes Graph pagination links before calling the v1.0 helper', () => {
  assert.equal(
    outlook.__test.graphPath('https://graph.microsoft.com/v1.0/me/todo/lists?$skiptoken=next'),
    '/me/todo/lists?$skiptoken=next',
  );
  assert.equal(
    outlook.__test.graphPath('/v1.0/me/todo/lists/list/tasks/delta?$deltatoken=cursor'),
    '/me/todo/lists/list/tasks/delta?$deltatoken=cursor',
  );
  assert.equal(outlook.__test.graphPath('https://evil.example/v1.0/me'), null);
});

test('converts To Do due dates through the household timezone and keeps date-only values', () => {
  assert.deepEqual(
    todo.__test.dueDateParts({
      dateTime: '2026-08-30T09:30:00.0000000',
      timeZone: 'UTC',
    }, 'America/Toronto'),
    { due_date: '2026-08-30', due_time: '05:30' },
  );
  assert.deepEqual(
    todo.__test.dueDateParts({
      dateTime: '2026-08-30T00:00:00.0000000',
      timeZone: 'America/Toronto',
    }, 'America/Toronto'),
    { due_date: '2026-08-30', due_time: null },
  );
  assert.deepEqual(
    todo.__test.dueDateParts({
      dateTime: '2026-01-15T09:30:00.0000000',
      timeZone: 'Pacific Standard Time',
    }, 'UTC'),
    { due_date: '2026-01-15', due_time: '17:30' },
  );
  assert.deepEqual(
    todo.__test.dueDateParts({
      dateTime: '2026-01-15T09:30:00.0000000',
      timeZone: 'W. Europe Standard Time',
    }, 'UTC'),
    { due_date: '2026-01-15', due_time: '08:30' },
  );
  assert.equal(
    todo.__test.remoteTaskValues({
      title: 'HTML task',
      body: { content: '<p>Line &amp; one</p><p>Line two</p>', contentType: 'html' },
      importance: 'normal',
      status: 'notStarted',
    }, 'UTC').description,
    'Line & one\nLine two',
  );
  assert.deepEqual(
    todo.__test.graphTaskPayload({
      title: 'Write',
      description: 'Line & <tag>\nNext',
      priority: 'medium',
      status: 'open',
      due_date: '2026-08-30',
      due_time: '09:30',
    }, 'Europe/Berlin'),
    {
      title: 'Write',
      status: 'notStarted',
      importance: 'normal',
      body: { content: 'Line &amp; &lt;tag&gt;<br>Next', contentType: 'html' },
      dueDateTime: {
        dateTime: '2026-08-30T07:30:00',
        timeZone: 'UTC',
      },
    },
  );
});

test('discovers lists, imports delta tasks, and persists the per-list cursor', async () => {
  const ownerId = insertUser();
  const accountId = insertAccount(ownerId);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, search: parsed.search, method: options.method || 'GET' });
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-work', displayName: 'Work' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-work/tasks/delta') {
      return response(200, {
        value: [{
          id: 'remote-1',
          title: 'Prepare presentation',
          body: { content: 'Slides', contentType: 'text' },
          importance: 'high',
          status: 'notStarted',
          dueDateTime: { dateTime: '2026-08-30T09:30:00.0000000', timeZone: 'UTC' },
        }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-work/tasks/delta?$deltatoken=cursor-1',
      });
    }
    throw new Error(`Unexpected Graph request ${parsed.pathname}${parsed.search}`);
  };

  const result = await todo.sync({ database, fetchImpl });
  assert.equal(result.syncedAccounts, 1);
  assert.equal(result.created, 1);

  const list = database.prepare(`
    SELECT * FROM task_lists WHERE provider = 'microsoft_todo' AND external_list_id = 'list-work'
  `).get();
  assert.equal(list.name, 'Work');
  assert.equal(list.sync_cursor, '/me/todo/lists/list-work/tasks/delta?$deltatoken=cursor-1');
  assert.equal(list.last_error, null);

  const task = database.prepare(`
    SELECT * FROM tasks WHERE external_source = 'microsoft_todo' AND external_uid = 'remote-1'
  `).get();
  assert.equal(task.title, 'Prepare presentation');
  assert.equal(task.description, 'Slides');
  assert.equal(task.priority, 'high');
  assert.equal(task.status, 'open');
  assert.equal(task.due_date, '2026-08-30');
  assert.equal(task.due_time, '09:30');
  assert.equal(task.task_list_id, list.id);
  assert.deepEqual(calls.map((call) => call.path), [
    '/v1.0/me/todo/lists',
    '/v1.0/me/todo/lists/list-work/tasks/delta',
  ]);
  assert.equal(calls[0].search, '?$top=100');
});

test('creates local tasks remotely and flushes deletion tombstones', async () => {
  const ownerId = insertUser('todo-owner-2');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists (name, provider, external_account_id, external_list_id, created_by)
    VALUES ('Personal', 'microsoft_todo', ?, 'list-personal', ?)
  `).run(accountId, ownerId).lastInsertRowid;
  const localTaskId = database.prepare(`
    INSERT INTO tasks (title, created_by, external_source, task_list_id)
    VALUES ('Renew insurance', ?, 'local', ?)
  `).run(ownerId, listId).lastInsertRowid;

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, method: options.method || 'GET', body });
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-personal', displayName: 'Personal' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-personal/tasks/delta') {
      return response(200, {
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-personal/tasks/delta?$deltatoken=next',
      });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-personal/tasks' && options.method === 'POST') {
      return response(201, { id: 'remote-created' });
    }
    if (parsed.pathname.endsWith('/tasks/remote-created') && options.method === 'DELETE') {
      return response(204, {});
    }
    throw new Error(`Unexpected Graph request ${options.method || 'GET'} ${parsed.pathname}`);
  };

  const first = await todo.sync({ database, fetchImpl });
  assert.equal(first.created, 1);
  const mirrored = database.prepare('SELECT * FROM tasks WHERE id = ?').get(localTaskId);
  assert.equal(mirrored.external_source, 'microsoft_todo');
  assert.equal(mirrored.external_uid, 'remote-created');

  todo.queueTaskDeletion(mirrored, database);
  database.prepare('DELETE FROM tasks WHERE id = ?').run(localTaskId);
  const tombstone = database.prepare('SELECT * FROM microsoft_todo_pending_deletions').get();
  assert.equal(tombstone.task_uid, 'remote-created');

  const second = await todo.sync({ database, fetchImpl });
  assert.equal(second.deleted, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM microsoft_todo_pending_deletions').get().n, 0);
  assert.ok(calls.some((call) => call.method === 'DELETE'));
});

test('serializes concurrent sync calls so a local task is created only once', async () => {
  const ownerId = insertUser('todo-owner-concurrent');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists (name, provider, external_account_id, external_list_id, created_by)
    VALUES ('Concurrent', 'microsoft_todo', ?, 'list-concurrent', ?)
  `).run(accountId, ownerId).lastInsertRowid;
  database.prepare(`
    INSERT INTO tasks (title, created_by, external_source, task_list_id)
    VALUES ('Only once', ?, 'local', ?)
  `).run(ownerId, listId);

  let postCount = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-concurrent', displayName: 'Concurrent' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-concurrent/tasks/delta') {
      return response(200, {
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-concurrent/tasks/delta?$deltatoken=concurrent',
      });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-concurrent/tasks' && options.method === 'POST') {
      postCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return response(201, { id: 'remote-concurrent' });
    }
    throw new Error(`Unexpected Graph request ${options.method || 'GET'} ${parsed.pathname}`);
  };

  const first = todo.sync({ database, fetchImpl });
  const second = todo.sync({ database, fetchImpl });
  assert.strictEqual(first, second);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.created, 1);
  assert.strictEqual(firstResult, secondResult);
  assert.equal(postCount, 1);
});

test('preserves a local edit made while the first remote create is in flight', async () => {
  const ownerId = insertUser('todo-owner-edit-race');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists (name, provider, external_account_id, external_list_id, created_by)
    VALUES ('Edit race', 'microsoft_todo', ?, 'list-edit-race', ?)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks (title, description, created_by, external_source, task_list_id)
    VALUES ('Race', 'before', ?, 'local', ?)
  `).run(ownerId, listId).lastInsertRowid;

  let postBody;
  let patchBody;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-edit-race', displayName: 'Edit race' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-edit-race/tasks/delta') {
      return response(200, {
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-edit-race/tasks/delta?$deltatoken=edit-race',
      });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-edit-race/tasks' && options.method === 'POST') {
      postBody = JSON.parse(options.body);
      const before = database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      database.prepare('UPDATE tasks SET description = ? WHERE id = ?').run('edited while pushing', taskId);
      const after = database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      assert.equal(todo.markTaskOutbound(before, after, database), true);
      return response(201, { id: 'remote-edit-race' });
    }
    if (parsed.pathname.endsWith('/tasks/remote-edit-race') && options.method === 'PATCH') {
      patchBody = JSON.parse(options.body);
      return response(204, {});
    }
    throw new Error(`Unexpected Graph request ${options.method || 'GET'} ${parsed.pathname}`);
  };

  const first = await todo.sync({ database, fetchImpl });
  assert.equal(first.created, 1);
  const afterCreate = database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  assert.equal(afterCreate.description, 'edited while pushing');
  assert.equal(afterCreate.outbound_dirty, 1);
  assert.equal(postBody.body.content, 'before');

  const second = await todo.sync({ database, fetchImpl });
  assert.equal(second.failed, 0);
  assert.equal(patchBody.body.content, 'edited while pushing');
  assert.equal(database.prepare('SELECT outbound_dirty FROM tasks WHERE id = ?').get(taskId).outbound_dirty, 0);
});

test('queues a remote deletion when a local task disappears during create', async () => {
  const ownerId = insertUser('todo-owner-delete-race');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists (name, provider, external_account_id, external_list_id, created_by)
    VALUES ('Delete race', 'microsoft_todo', ?, 'list-delete-race', ?)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks (title, created_by, external_source, task_list_id)
    VALUES ('Delete race', ?, 'local', ?)
  `).run(ownerId, listId).lastInsertRowid;

  let deleteCount = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-delete-race', displayName: 'Delete race' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-delete-race/tasks/delta') {
      return response(200, {
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-delete-race/tasks/delta?$deltatoken=delete-race',
      });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-delete-race/tasks' && options.method === 'POST') {
      database.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      return response(201, { id: 'remote-delete-race' });
    }
    if (parsed.pathname.endsWith('/tasks/remote-delete-race') && options.method === 'DELETE') {
      deleteCount += 1;
      return response(204, {});
    }
    throw new Error(`Unexpected Graph request ${options.method || 'GET'} ${parsed.pathname}`);
  };

  const first = await todo.sync({ database, fetchImpl });
  assert.equal(first.created, 1);
  assert.equal(database.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId), undefined);
  assert.equal(
    database.prepare('SELECT task_uid FROM microsoft_todo_pending_deletions WHERE account_id = ?').get(accountId).task_uid,
    'remote-delete-race',
  );

  const second = await todo.sync({ database, fetchImpl });
  assert.equal(second.deleted, 1);
  assert.equal(deleteCount, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM microsoft_todo_pending_deletions').get().n, 0);
});

test('detaches tasks and removes a list deleted remotely', async () => {
  const ownerId = insertUser('todo-owner-3');
  const accountId = insertAccount(ownerId);
  const staleListId = database.prepare(`
    INSERT INTO task_lists (name, provider, external_account_id, external_list_id, created_by)
    VALUES ('Old List', 'microsoft_todo', ?, 'list-old', ?)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id)
    VALUES ('Keep locally', ?, 'microsoft_todo', ?, 'remote-old', ?)
  `).run(ownerId, accountId, staleListId).lastInsertRowid;

  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-new', displayName: 'New List' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-new/tasks/delta') {
      return response(200, {
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-new/tasks/delta?$deltatoken=new',
      });
    }
    throw new Error(`Unexpected Graph request ${parsed.pathname}`);
  };

  await todo.sync({ database, fetchImpl });

  assert.equal(database.prepare('SELECT 1 FROM task_lists WHERE id = ?').get(staleListId), undefined);
  const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  assert.equal(task.external_source, 'local');
  assert.equal(task.external_uid, null);
  assert.equal(task.task_list_id, null);
  assert.ok(database.prepare(`
    SELECT 1 FROM task_lists WHERE provider = 'microsoft_todo' AND external_list_id = 'list-new'
  `).get());
});

test('migration v164 preserves provider values from extension-backed installations', () => {
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    INSERT INTO users (id) VALUES (1);
    CREATE TABLE outlook_accounts (id INTEGER PRIMARY KEY);
    CREATE TABLE task_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_account_id INTEGER,
      external_list_id TEXT,
      created_by INTEGER
    );
    CREATE TABLE search_index (entity TEXT, entity_id INTEGER, title TEXT, body TEXT);
    CREATE TABLE task_tags (task_id INTEGER, tag TEXT);
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'misc',
      priority TEXT NOT NULL DEFAULT 'none',
      status TEXT NOT NULL DEFAULT 'open',
      due_date TEXT,
      due_time TEXT,
      assigned_to INTEGER,
      created_by INTEGER NOT NULL,
      is_recurring INTEGER NOT NULL DEFAULT 0,
      recurrence_rule TEXT,
      parent_task_id INTEGER,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      start_date TEXT,
      external_uid TEXT,
      external_source TEXT NOT NULL DEFAULT 'local',
      external_account_id INTEGER,
      points INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'all',
      external_object_url TEXT,
      outbound_dirty INTEGER NOT NULL DEFAULT 0,
      outbound_attempts INTEGER NOT NULL DEFAULT 0,
      recurrence_origin_id INTEGER,
      recurrence_from_completion INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      target_caldav_account_id INTEGER,
      target_caldav_list_url TEXT,
      countdown INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      task_list_id INTEGER
    );
    INSERT INTO tasks (title, created_by, external_source) VALUES ('Extension task', 1, 'notion');
  `);

  const migration = dbModule.MIGRATIONS.find(({ version }) => version === 164);
  assert.ok(migration, 'migration v164 must exist');
  legacy.exec(migration.up);

  assert.equal(
    legacy.prepare('SELECT external_source FROM tasks WHERE title = ?').get('Extension task').external_source,
    'notion',
  );
  assert.doesNotThrow(() => legacy.prepare(`
    INSERT INTO tasks (title, created_by, external_source) VALUES ('Another extension task', 1, 'custom_provider')
  `).run());
});
