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
      dateTime: '2026-08-30T00:00:00.0000000',
      timeZone: 'UTC',
    }, 'Europe/Helsinki'),
    { due_date: '2026-08-30', due_time: null },
    'date-only midnight must not become a Helsinki 03:00 task',
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
  assert.deepEqual(
    todo.__test.dueDateParts({
      dateTime: '2026-01-15T09:30:00.0000000',
      timeZone: 'FLE Standard Time',
    }, 'Europe/Helsinki'),
    { due_date: '2026-01-15', due_time: '09:30' },
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
  assert.equal(todo.__test.remoteTaskValues({ importance: 'normal' }, 'UTC').priority, 'none');
  assert.equal(todo.__test.remoteTaskValues({ importance: 'low' }, 'UTC').priority, 'none');
  assert.deepEqual(
    todo.__test.remoteTaskValues({
      dueDateTime: { dateTime: '2026-08-15T00:00:00.0000000', timeZone: 'UTC' },
      recurrence: {
        pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
        range: { type: 'noEnd', startDate: '2026-08-15' },
      },
    }, 'UTC'),
    {
      title: 'Microsoft To Do task',
      description: null,
      priority: 'none',
      status: 'open',
      due_date: '2026-08-15',
      due_time: null,
      remind_at: null,
      is_recurring: 1,
      recurrence_rule: 'FREQ=MONTHLY',
    },
  );
  assert.equal(
    todo.__test.remoteTaskValues({
      isReminderOn: true,
      reminderDateTime: { dateTime: '2026-01-15T09:30:00.0000000Z' },
    }, 'UTC').remind_at,
    '2026-01-15T09:30:00',
  );
  assert.equal(todo.__test.graphTaskPayload({ priority: 'low' }, 'UTC').importance, 'normal');
  assert.equal(todo.__test.graphTaskPayload({ priority: 'urgent' }, 'UTC').importance, 'high');
  assert.equal(todo.__test.graphTaskPayload({
    external_source: 'microsoft_todo',
    is_recurring: 0,
    recurrence_rule: null,
  }, 'UTC').recurrence, null);
  assert.deepEqual(
    todo.__test.graphTaskPayload({
      title: 'Monthly task',
      is_recurring: 1,
      recurrence_rule: 'FREQ=MONTHLY',
      due_date: '2026-08-15',
    }, 'Europe/Helsinki').recurrence,
    {
      pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
      range: { type: 'noEnd', startDate: '2026-08-15', recurrenceTimeZone: 'Europe/Helsinki' },
    },
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
      isReminderOn: false,
      reminderDateTime: null,
    },
  );
  assert.deepEqual(
    todo.__test.graphTaskPayload({ due_date: '2026-08-30' }, 'Europe/Helsinki').dueDateTime,
    { dateTime: '2026-08-30T00:00:00', timeZone: 'Europe/Helsinki' },
    'date-only outbound values retain the selected household date',
  );
});

test('discovers lists, imports delta tasks, and persists the per-list cursor', async () => {
  const ownerId = insertUser();
  const accountId = insertAccount(ownerId);
  database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Work', 'microsoft_todo', ?, 'list-work', ?, 1)
  `).run(accountId, ownerId);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({
      path: parsed.pathname,
      search: parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    });
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
          isReminderOn: true,
          reminderDateTime: { dateTime: '2026-08-30T08:30:00.0000000', timeZone: 'UTC' },
          checklistItems: [{ id: 'step-1', displayName: 'Bring card', isChecked: false }],
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
  assert.equal(database.prepare(`
    SELECT remind_at FROM reminders WHERE entity_type = 'task' AND entity_id = ? AND created_by = ?
  `).get(task.id, ownerId).remind_at, '2026-08-30T08:30:00');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?').get(task.id).n, 0);
  assert.deepEqual(calls.map((call) => call.path), [
    '/v1.0/me/todo/lists',
    '/v1.0/me/todo/lists/list-work/tasks/delta',
  ]);
  assert.equal(calls[0].search, '?$top=100');
  assert.equal(calls[1].search, '');
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
});

test('completing a recurring To Do task pushes status before importing the next occurrence', async () => {
  const ownerId = insertUser('todo-owner-recurring-completion');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Recurring', 'microsoft_todo', ?, 'list-recurring', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Monthly task', ?, 'microsoft_todo', ?, 'remote-current', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY', 1)
  `).run(ownerId, accountId, listId).lastInsertRowid;

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    calls.push({ path: parsed.pathname, method, body: options.body ? JSON.parse(options.body) : null });
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-recurring', displayName: 'Recurring' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-recurring/tasks/remote-current' && method === 'PATCH') {
      return response(204);
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-recurring/tasks/delta') {
      return response(200, {
        value: [
          {
            id: 'remote-current',
            title: 'Monthly task',
            status: 'completed',
            importance: 'normal',
            dueDateTime: { dateTime: '2026-08-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          },
          {
            id: 'remote-next',
            title: 'Monthly task',
            status: 'notStarted',
            importance: 'normal',
            dueDateTime: { dateTime: '2026-09-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring/tasks/delta?$deltatoken=next-occurrence',
      });
    }
    throw new Error('Unexpected Graph request ' + method + ' ' + parsed.pathname + parsed.search);
  };

  const result = await todo.sync({ database, fetchImpl });

  assert.equal(result.success, true);
  assert.equal(result.updated, 2, 'one outbound update and one imported completion');
  assert.equal(result.created, 1);
  assert.equal(calls.find((call) => call.method === 'PATCH').body.status, 'completed');
  assert.ok(calls.findIndex((call) => call.method === 'PATCH') < calls.findIndex((call) => call.path.endsWith('/tasks/delta')));
  assert.equal(database.prepare('SELECT status, outbound_dirty FROM tasks WHERE id = ?').get(taskId).status, 'done');
  assert.equal(database.prepare('SELECT outbound_dirty FROM tasks WHERE id = ?').get(taskId).outbound_dirty, 0);
  const next = database.prepare(`SELECT status, due_date FROM tasks WHERE external_uid = 'remote-next'`).get();
  assert.deepEqual(next, { status: 'open', due_date: '2026-09-15' });
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE external_uid = 'remote-current'`).get().n, 1);
});

test('manual sync forces a full reconciliation and removes a stale mirrored task', async () => {
  const ownerId = insertUser('todo-owner-full');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, sync_cursor, last_full_sync)
    VALUES ('Full', 'microsoft_todo', ?, 'list-full', ?,
            '/me/todo/lists/list-full/tasks/delta?$deltatoken=old', ?)
  `).run(accountId, ownerId, new Date().toISOString()).lastInsertRowid;
  const staleTaskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id)
    VALUES ('Stale remote task', ?, 'microsoft_todo', ?, 'remote-stale', ?)
  `).run(ownerId, accountId, listId).lastInsertRowid;
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('task', ?, '2026-08-30T01:30:00', ?)
  `).run(staleTaskId, ownerId);

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, search: parsed.search, method: options.method || 'GET' });
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-full', displayName: 'Full' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-full/tasks/delta') {
      assert.equal(parsed.search, '', 'forced full sync must not reuse the saved cursor');
      return response(200, {
        value: [{
          id: 'remote-current',
          title: 'Current remote task',
          body: { content: '', contentType: 'text' },
          status: 'notStarted',
          importance: 'normal',
        }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-full/tasks/delta?$deltatoken=fresh',
      });
    }
    throw new Error(`Unexpected Graph request ${options.method || 'GET'} ${parsed.pathname}${parsed.search}`);
  };

  const result = await todo.sync({ database, fetchImpl, forceFull: true });

  assert.equal(result.success, true);
  assert.ok(result.fullResyncLists >= 1);
  assert.equal(result.deleted, 1);
  assert.equal(database.prepare('SELECT 1 FROM tasks WHERE id = ?').get(staleTaskId), undefined);
  assert.equal(database.prepare('SELECT 1 FROM reminders WHERE entity_type = \'task\' AND entity_id = ?').get(staleTaskId), undefined);
  assert.equal(
    database.prepare(`
      SELECT title FROM tasks
       WHERE external_source = 'microsoft_todo' AND external_uid = 'remote-current'
    `).get().title,
    'Current remote task',
  );
  const list = database.prepare('SELECT sync_cursor, last_full_sync FROM task_lists WHERE id = ?').get(listId);
  assert.equal(list.sync_cursor, '/me/todo/lists/list-full/tasks/delta?$deltatoken=fresh');
  assert.ok(list.last_full_sync);
  assert.ok(calls.filter(({ path }) => path === '/v1.0/me/todo/lists').length >= 1);
  assert.ok(calls.filter(({ path }) => path === '/v1.0/me/todo/lists/list-full/tasks/delta').length >= 1);
});

test('scheduled sync forces a full reconciliation after the checkpoint interval', async () => {
  const ownerId = insertUser('todo-owner-periodic-full');
  const accountId = insertAccount(ownerId);
  database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, sync_cursor, last_full_sync)
    VALUES ('Periodic full', 'microsoft_todo', ?, 'list-periodic-full', ?,
            '/me/todo/lists/list-periodic-full/tasks/delta?$deltatoken=old', ?)
  `).run(
    accountId,
    ownerId,
    new Date(Date.now() - todo.__test.FULL_RESYNC_INTERVAL_MS - 1000).toISOString(),
  );

  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-periodic-full', displayName: 'Periodic full' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-periodic-full/tasks/delta') {
      assert.equal(parsed.search, '');
      return response(200, {
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-periodic-full/tasks/delta?$deltatoken=periodic-fresh',
      });
    }
    throw new Error(`Unexpected Graph request ${parsed.pathname}${parsed.search}`);
  };

  const result = await todo.sync({ database, fetchImpl });

  assert.ok(result.fullResyncLists >= 1);
  assert.ok(database.prepare(`
    SELECT last_full_sync FROM task_lists WHERE external_list_id = 'list-periodic-full'
  `).get().last_full_sync);
});

test('falls back to a full task snapshot when a personal account rejects delta', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, search: parsed.search });
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-fallback', displayName: 'Fallback' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-fallback/tasks/delta') {
      return response(400, { error: { message: 'Invalid request' } });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-fallback/tasks') {
      return response(200, {
        value: [{
          id: 'remote-fallback-1',
          title: 'Imported through snapshot',
          body: { content: '', contentType: 'text' },
          status: 'notStarted',
          importance: 'normal',
        }],
      });
    }
    throw new Error(`Unexpected Graph request ${parsed.pathname}${parsed.search}`);
  };

  const result = await todo.__test.fetchTaskDelta('list-fallback', null, 'access', fetchImpl);
  assert.deepEqual(calls.map((call) => call.path), [
    '/v1.0/me/todo/lists/list-fallback/tasks/delta',
    '/v1.0/me/todo/lists/list-fallback/tasks',
  ]);
  assert.equal(result.deltaLink, null);
  assert.equal(result.fullResync, true);
  assert.equal(result.tasks[0].title, 'Imported through snapshot');
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
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('task', ?, '2026-08-30T01:30:00', ?)
  `).run(localTaskId, ownerId);

  const calls = [];
  let createBody;
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
      createBody = body;
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
  assert.equal(createBody.isReminderOn, true);
  assert.deepEqual(createBody.reminderDateTime, {
    dateTime: '2026-08-30T01:30:00',
    timeZone: 'UTC',
  });

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

test('retains a disabled Microsoft To Do list after list discovery refresh', async () => {
  const ownerId = insertUser('todo-owner-disabled-list');
  const accountId = insertAccount(ownerId);
  database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Old name', 'microsoft_todo', ?, 'list-disabled', ?, 0)
  `).run(accountId, ownerId);

  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/v1.0/me/todo/lists');
    return response(200, { value: [{ id: 'list-disabled', displayName: 'Renamed remotely' }] });
  };

  const lists = await todo.listTaskLists(accountId, { refresh: true, database, fetchImpl });
  assert.equal(lists.length, 1);
  assert.equal(lists[0].listName, 'Renamed remotely');
  assert.equal(lists[0].enabled, false, 'refresh must not re-enable a manually disabled list');
});

test('new Microsoft To Do lists stay disabled until explicitly selected', async () => {
  const ownerId = insertUser('todo-owner-new-list');
  const accountId = insertAccount(ownerId);
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/v1.0/me/todo/lists');
    return response(200, { value: [{ id: 'list-new-disabled', displayName: 'New list' }] });
  };

  const lists = await todo.listTaskLists(accountId, { refresh: true, database, fetchImpl });
  assert.equal(lists.length, 1);
  assert.equal(lists[0].enabled, false, 'a newly discovered list must not import before selection');

  todo.setTaskListSelection(accountId, ['list-new-disabled'], { database });
  assert.equal(database.prepare('SELECT enabled FROM task_lists WHERE external_list_id = ?').get('list-new-disabled').enabled, 1);
  todo.setTaskListSelection(accountId, [], { database });
  assert.equal(database.prepare('SELECT enabled FROM task_lists WHERE external_list_id = ?').get('list-new-disabled').enabled, 0);
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
