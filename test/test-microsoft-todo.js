/** Microsoft Graph To Do list/task sync contract tests. */
process.env.DB_PATH = ':memory:';
process.env.MS_CLIENT_ID = 'test-client';
process.env.MS_CLIENT_SECRET = 'test-secret';
process.env.MS_REDIRECT_URI = 'http://localhost/api/v1/calendar/outlook/callback';

import test from 'node:test';
import assert from 'node:assert/strict';

const database = (await import('../server/db.js')).get();
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
