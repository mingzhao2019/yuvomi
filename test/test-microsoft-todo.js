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
const completions = await import('../server/services/task-completions.js');

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

test('existing To Do recurrence is provider-owned while unrelated fields remain editable', () => {
  const task = {
    external_source: 'microsoft_todo',
    is_recurring: 1,
    recurrence_rule: 'FREQ=MONTHLY;INTERVAL=3',
    recurrence_from_completion: 0,
  };

  assert.equal(todo.changesMicrosoftTodoRecurrence(task, { title: 'Renamed' }), false);
  assert.equal(todo.changesMicrosoftTodoRecurrence(task, {
    is_recurring: 1,
    recurrence_rule: 'FREQ=MONTHLY;INTERVAL=3',
    recurrence_from_completion: 0,
    description: 'Still editable',
  }), false);
  assert.equal(todo.changesMicrosoftTodoRecurrence(task, {
    recurrence_rule: 'FREQ=MONTHLY;INTERVAL=4',
  }), true);
  assert.equal(todo.changesMicrosoftTodoRecurrence(task, {
    is_recurring: 0,
    recurrence_rule: null,
  }), true);
  assert.equal(todo.changesMicrosoftTodoRecurrence(
    { ...task, external_source: 'local' },
    { recurrence_rule: 'FREQ=MONTHLY;INTERVAL=4' },
  ), false);
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
  const completionOwnerId = insertUser('todo-owner-payload-completion');
  const completionTaskId = database.prepare(`
    INSERT INTO tasks (title, created_by, status) VALUES ('Completed payload', ?, 'done')
  `).run(completionOwnerId).lastInsertRowid;
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, '2026-08-31T12:34:56.789Z')
  `).run(completionTaskId, completionTaskId, completionOwnerId);
  const completedPayload = todo.__test.graphTaskPayload(
    { id: completionTaskId, title: 'Completed payload', status: 'done' },
    'Europe/Helsinki',
    database,
    { operation: 'update', includeCompletion: true },
  );
  assert.deepEqual(completedPayload.completedDateTime, {
    dateTime: '2026-08-31T12:34:56',
    timeZone: 'UTC',
  });
  assert.equal(Object.hasOwn(completedPayload, 'recurrence'), false);
  database.prepare('UPDATE task_completions SET completed_at = ? WHERE task_id = ?')
    .run('not-a-timestamp', completionTaskId);
  assert.equal(Object.hasOwn(todo.__test.graphTaskPayload(
    { id: completionTaskId, title: 'Completed payload', status: 'done' },
    'UTC',
    database,
    { operation: 'update' },
  ), 'completedDateTime'), false, 'invalid completion events must not fabricate a timestamp');
  for (const status of ['open', 'in_progress']) {
    assert.equal(
      Object.hasOwn(todo.__test.graphTaskPayload(
        { id: completionTaskId, title: 'Completed payload', status },
        'UTC',
        database,
        { operation: 'update' },
      ), 'completedDateTime'),
      false,
      `${status} updates must not carry completedDateTime`,
    );
  }
  assert.equal(Object.hasOwn(todo.__test.graphTaskPayload({
    external_source: 'microsoft_todo',
    is_recurring: 0,
    recurrence_rule: null,
  }, 'UTC', null, { operation: 'update' }), 'recurrence'), false);
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
  assert.equal(Object.hasOwn(todo.__test.graphTaskPayload(
    { id: completionTaskId, title: 'Completed payload', status: 'done', is_recurring: 1, recurrence_rule: 'FREQ=MONTHLY', due_date: '2026-08-31' },
    'UTC',
    database,
    { operation: 'create' },
  ), 'completedDateTime'), false, 'create payloads must keep the existing contract');
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
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, '2026-08-31T12:34:56Z')
  `).run(taskId, taskId, ownerId);
  assert.equal(completions.markMicrosoftTodoCompletionIntent(database, taskId), true);

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    calls.push({
      path: parsed.pathname,
      search: parsed.search,
      method,
      body: options.body ? JSON.parse(options.body) : null,
    });
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-recurring', displayName: 'Recurring' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-recurring/tasks/remote-current' && method === 'PATCH') {
      if (Object.hasOwn(calls.at(-1).body, 'recurrence')) {
        return response(400, {
          error: {
            code: 'InvalidRequest',
            message: 'Invalid JSON, Error converting value "2026-08-15" to type Microsoft.OData.Edm.Date.',
          },
        });
      }
      return response(204);
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-recurring/tasks/delta') {
      const token = parsed.searchParams.get('$deltatoken');
      if (!token) {
        return response(200, {
          value: [{
            id: 'remote-current',
            title: 'Monthly task',
            status: 'completed',
            importance: 'normal',
            dueDateTime: { dateTime: '2026-08-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring/tasks/delta?$deltatoken=cursor-1',
        });
      }
      if (token === 'cursor-1') {
        return response(200, {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring/tasks/delta?$deltatoken=cursor-2',
        });
      }
      if (token === 'cursor-2') {
        return response(200, {
          value: [{
            id: 'remote-next',
            title: 'Monthly task',
            status: 'notStarted',
            importance: 'normal',
            dueDateTime: { dateTime: '2026-09-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring/tasks/delta?$deltatoken=cursor-3',
        });
      }
    }
    throw new Error('Unexpected Graph request ' + method + ' ' + parsed.pathname + parsed.search);
  };

  const waits = [];
  const result = await todo.sync({
    database,
    fetchImpl,
    completionTaskIds: [taskId],
    waitForSuccessor: async (delayMs) => waits.push(delayMs),
  });

  assert.equal(result.success, true);
  assert.equal(result.updated, 2, 'one outbound update and one imported completion');
  assert.equal(result.created, 1);
  const patchCall = calls.find((call) => call.method === 'PATCH');
  assert.equal(patchCall.body.status, 'completed');
  assert.deepEqual(patchCall.body.completedDateTime, {
    dateTime: '2026-08-31T12:34:56',
    timeZone: 'UTC',
  });
  assert.equal(Object.hasOwn(patchCall.body, 'recurrence'), false);
  assert.ok(calls.findIndex((call) => call.method === 'PATCH') < calls.findIndex((call) => call.path.endsWith('/tasks/delta')));
  assert.deepEqual(waits, [1000, 3000]);
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith('/tasks/delta')).map((call) => call.search),
    ['', '?$deltatoken=cursor-1', '?$deltatoken=cursor-2'],
  );
  assert.equal(database.prepare('SELECT status, outbound_dirty FROM tasks WHERE id = ?').get(taskId).status, 'done');
  assert.equal(database.prepare('SELECT outbound_dirty FROM tasks WHERE id = ?').get(taskId).outbound_dirty, 0);
  const syncedList = database.prepare('SELECT sync_cursor, last_full_sync FROM task_lists WHERE id = ?').get(listId);
  assert.equal(syncedList.sync_cursor, '/me/todo/lists/list-recurring/tasks/delta?$deltatoken=cursor-3');
  assert.ok(syncedList.last_full_sync, 'successor refills must preserve the initial full-sync checkpoint');
  const next = database.prepare(`SELECT status, due_date FROM tasks WHERE external_uid = 'remote-next'`).get();
  assert.deepEqual(next, { status: 'open', due_date: '2026-09-15' });
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE external_uid = 'remote-current'`).get().n, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM tasks WHERE task_list_id = ? AND recurrence_origin_id IS NOT NULL
  `).get(listId).n, 0);
});

test('remote reopening revokes the old completion before a later local completion', async () => {
  const ownerId = insertUser('todo-owner-remote-reopen');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Remote reopen', 'microsoft_todo', ?, 'list-remote-reopen', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Reopen me', ?, 'microsoft_todo', ?, 'remote-reopen', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY', 0)
  `).run(ownerId, accountId, listId).lastInsertRowid;
  const oldCompletion = '2026-08-01T10:20:30Z';
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, ?)
  `).run(taskId, taskId, ownerId, oldCompletion);
  const oldCompletionId = database.prepare(
    'SELECT id FROM task_completions WHERE task_id = ?'
  ).get(taskId).id;

  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-remote-reopen', displayName: 'Remote reopen' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-remote-reopen/tasks/delta') {
      return response(200, {
        value: [
          {
            id: 'remote-reopen',
            title: 'Reopen me',
            status: 'notStarted',
            dueDateTime: { dateTime: '2026-08-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          },
          { id: 'remote-completed-import', title: 'Imported complete', status: 'completed' },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-remote-reopen/tasks/delta?$deltatoken=reopen-1',
      });
    }
    throw new Error(`Unexpected Graph request ${parsed.pathname}${parsed.search}`);
  };

  const result = await todo.sync({ database, fetchImpl });
  assert.equal(result.success, true);
  assert.equal(database.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status, 'open');
  assert.equal(
    database.prepare('SELECT 1 FROM task_completions WHERE task_id = ?').get(taskId),
    undefined,
  );
  assert.equal(
    database.prepare('SELECT 1 FROM microsoft_todo_completion_intents WHERE task_id = ?').get(taskId),
    undefined,
  );
  const imported = database.prepare(
    "SELECT id, status FROM tasks WHERE external_uid = 'remote-completed-import'"
  ).get();
  assert.deepEqual(imported && { status: imported.status }, { status: 'done' });
  assert.equal(
    database.prepare('SELECT 1 FROM task_completions WHERE task_id = ?').get(imported.id),
    undefined,
  );

  database.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId);
  completions.syncTaskCompletion(database, taskId, 'open', 'done', ownerId);
  const newCompletion = database.prepare(
    'SELECT completed_at FROM task_completions WHERE task_id = ?'
  ).get(taskId).completed_at;
  assert.notEqual(newCompletion, oldCompletion);
  const newIntent = database.prepare(
    'SELECT completion_id, state FROM microsoft_todo_completion_intents WHERE task_id = ?'
  ).get(taskId);
  assert.notEqual(newIntent.completion_id, oldCompletionId);
  assert.equal(newIntent.state, 'patch');
  assert.equal(Object.hasOwn(todo.__test.graphTaskPayload(
    { id: taskId, title: 'Reopen me', status: 'done' },
    'Europe/Helsinki',
    database,
    { operation: 'update' },
  ), 'completedDateTime'), false);
  assert.deepEqual(todo.__test.graphTaskPayload(
    { id: taskId, title: 'Reopen me', status: 'done' },
    'Europe/Helsinki',
    database,
    { operation: 'update', includeCompletion: true },
  ).completedDateTime, {
    dateTime: newCompletion.slice(0, 19),
    timeZone: 'UTC',
  });
});

test('ordinary edits to an already completed recurring task do not trigger successor reconciliation', async () => {
  const ownerId = insertUser('todo-owner-recurring-edit');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Recurring edit', 'microsoft_todo', ?, 'list-recurring-edit', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Edit me', ?, 'microsoft_todo', ?, 'remote-edit', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY', 1)
  `).run(ownerId, accountId, listId).lastInsertRowid;
  const sameSecond = database.prepare('SELECT updated_at FROM tasks WHERE id = ?').get(taskId).updated_at;
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, ?)
  `).run(taskId, taskId, ownerId, sameSecond);
  const reminderId = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('task', ?, '2026-08-20T08:00:00Z', ?)
  `).run(taskId, ownerId).lastInsertRowid;
  database.prepare(`
    UPDATE tasks
       SET title = ?, description = ?, priority = ?, due_date = ?, due_time = ?
     WHERE id = ?
  `).run('Edited same second', 'Updated description', 'high', '2026-08-20', '09:15', taskId);
  database.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?')
    .run('2026-08-21T10:30:00Z', reminderId);

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, search: parsed.search, method, body });
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-recurring-edit', displayName: 'Recurring edit' }] });
    }
    if (parsed.pathname.endsWith('/tasks/remote-edit') && method === 'PATCH') {
      assert.equal(Object.hasOwn(body, 'completedDateTime'), false);
      assert.deepEqual(body.reminderDateTime, {
        dateTime: '2026-08-21T10:30:00',
        timeZone: 'UTC',
      });
      assert.equal(Object.hasOwn(body, 'recurrence'), false);
      return response(204);
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-recurring-edit/tasks/delta') {
      return response(200, {
        value: [{
          id: 'remote-edit',
          title: 'Edit me',
          status: 'completed',
          dueDateTime: { dateTime: '2026-08-15T00:00:00.0000000', timeZone: 'UTC' },
          recurrence: {
            pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
            range: { type: 'noEnd', startDate: '2026-08-15' },
          },
        }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring-edit/tasks/delta?$deltatoken=edit-1',
      });
    }
    throw new Error(`Unexpected Graph request ${method} ${parsed.pathname}${parsed.search}`);
  };

  const waits = [];
  const result = await todo.sync({
    database,
    fetchImpl,
    waitForSuccessor: async (delayMs) => waits.push(delayMs),
  });

  assert.equal(result.success, true);
  assert.deepEqual(waits, []);
  assert.equal(calls.filter((call) => call.path.endsWith('/tasks/delta')).length, 1);
  assert.equal(database.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status, 'done');
  assert.equal(database.prepare('SELECT outbound_dirty FROM tasks WHERE id = ?').get(taskId).outbound_dirty, 0);
  assert.equal(
    database.prepare('SELECT 1 FROM microsoft_todo_completion_intents WHERE task_id = ?').get(taskId),
    undefined,
  );
  assert.equal(
    database.prepare('SELECT sync_cursor FROM task_lists WHERE id = ?').get(listId).sync_cursor,
    '/me/todo/lists/list-recurring-edit/tasks/delta?$deltatoken=edit-1',
  );
});

test('keeps successor reconciliation when Delta clears the current recurrence fields', async () => {
  const ownerId = insertUser('todo-owner-recurrence-cleared');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Recurrence cleared', 'microsoft_todo', ?, 'list-recurrence-cleared', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Cleared current', ?, 'microsoft_todo', ?, 'remote-cleared-current', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY', 0)
  `).run(ownerId, accountId, listId).lastInsertRowid;
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, '2026-08-31T12:34:56Z')
  `).run(taskId, taskId, ownerId);
  assert.equal(completions.markMicrosoftTodoCompletionIntent(database, taskId), true);
  assert.equal(
    completions.markMicrosoftTodoCompletionIntentReconciled(
      database,
      taskId,
      database.prepare('SELECT id FROM task_completions WHERE task_id = ?').get(taskId).id,
    ),
    true,
  );

  const deltaTokens = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-recurrence-cleared', displayName: 'Recurrence cleared' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-recurrence-cleared/tasks/delta') {
      const token = parsed.searchParams.get('$deltatoken');
      deltaTokens.push(token || 'initial');
      const link = (nextToken) => (
        `https://graph.microsoft.com/v1.0/me/todo/lists/list-recurrence-cleared/tasks/delta?$deltatoken=${nextToken}`
      );
      if (!token) {
        return response(200, {
          value: [{
            id: 'remote-cleared-current',
            title: 'Cleared current',
            status: 'completed',
            dueDateTime: { dateTime: '2026-08-15T00:00:00.0000000', timeZone: 'UTC' },
          }],
          '@odata.deltaLink': link('cleared-c1'),
        });
      }
      if (token === 'cleared-c1') {
        return response(200, { value: [], '@odata.deltaLink': link('cleared-c2') });
      }
      if (token === 'cleared-c2') {
        return response(200, {
          value: [{
            id: 'remote-cleared-next',
            title: 'Cleared current',
            status: 'notStarted',
            dueDateTime: { dateTime: '2026-09-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          }],
          '@odata.deltaLink': link('cleared-c3'),
        });
      }
      if (token === 'cleared-c3') {
        return response(200, { value: [], '@odata.deltaLink': link('cleared-c4') });
      }
    }
    throw new Error(`Unexpected Graph request ${method} ${parsed.pathname}${parsed.search}`);
  };

  const waits = [];
  const result = await todo.sync({
    database,
    fetchImpl,
    waitForSuccessor: async (delayMs) => waits.push(delayMs),
  });

  assert.equal(result.success, true);
  assert.deepEqual(deltaTokens, ['initial', 'cleared-c1', 'cleared-c2']);
  assert.deepEqual(waits, [1000, 3000]);
  assert.equal(database.prepare('SELECT is_recurring, recurrence_rule FROM tasks WHERE id = ?').get(taskId).is_recurring, 0);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE external_uid = 'remote-cleared-next'").get().n,
    1,
  );
  assert.equal(
    database.prepare('SELECT 1 FROM microsoft_todo_completion_intents WHERE task_id = ?').get(taskId),
    undefined,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE recurrence_origin_id IS NOT NULL').get().n,
    0,
  );
});

test('recreated completed recurring tasks also reconcile a delayed successor', async () => {
  const ownerId = insertUser('todo-owner-recurring-recreate');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Recurring recreate', 'microsoft_todo', ?, 'list-recurring-recreate', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Recreate me', ?, 'microsoft_todo', ?, 'remote-missing', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY', 1)
  `).run(ownerId, accountId, listId).lastInsertRowid;
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, '2026-08-31T12:34:56Z')
  `).run(taskId, taskId, ownerId);
  assert.equal(completions.markMicrosoftTodoCompletionIntent(database, taskId), true);

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, search: parsed.search, method, body });
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-recurring-recreate', displayName: 'Recurring recreate' }] });
    }
    if (parsed.pathname.endsWith('/tasks/remote-missing') && method === 'PATCH') {
      return response(404, { error: { message: 'task disappeared' } });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-recurring-recreate/tasks' && method === 'POST') {
      return response(201, { id: 'remote-recreated' });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-recurring-recreate/tasks/delta') {
      const token = parsed.searchParams.get('$deltatoken');
      if (!token) {
        return response(200, {
          value: [{
            id: 'remote-recreated',
            title: 'Recreate me',
            status: 'completed',
            dueDateTime: { dateTime: '2026-08-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring-recreate/tasks/delta?$deltatoken=recreate-1',
        });
      }
      if (token === 'recreate-1') {
        return response(200, {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring-recreate/tasks/delta?$deltatoken=recreate-2',
        });
      }
      if (token === 'recreate-2') {
        return response(200, {
          value: [{
            id: 'remote-recreated-next',
            title: 'Recreate me',
            status: 'notStarted',
            dueDateTime: { dateTime: '2026-09-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring-recreate/tasks/delta?$deltatoken=recreate-3',
        });
      }
    }
    throw new Error(`Unexpected Graph request ${method} ${parsed.pathname}${parsed.search}`);
  };

  const waits = [];
  const result = await todo.sync({
    database,
    fetchImpl,
    completionTaskIds: [taskId],
    waitForSuccessor: async (delayMs) => waits.push(delayMs),
  });

  assert.equal(result.success, true);
  const postCall = calls.find((call) => call.method === 'POST');
  assert.deepEqual(postCall.body.recurrence, {
    pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
    range: { type: 'noEnd', startDate: '2026-08-15', recurrenceTimeZone: 'UTC' },
  });
  assert.equal(Object.hasOwn(postCall.body, 'completedDateTime'), false);
  assert.ok(calls.findIndex((call) => call.method === 'PATCH') < calls.findIndex((call) => call.method === 'POST'));
  assert.ok(calls.findIndex((call) => call.method === 'POST') < calls.findIndex((call) => call.path.endsWith('/tasks/delta')));
  assert.deepEqual(waits, [1000, 3000]);
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith('/tasks/delta')).map((call) => call.search),
    ['', '?$deltatoken=recreate-1', '?$deltatoken=recreate-2'],
  );
  assert.equal(
    database.prepare('SELECT external_uid, outbound_dirty FROM tasks WHERE id = ?').get(taskId).external_uid,
    'remote-recreated',
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE external_uid = ?').get('remote-recreated-next').n, 1);
  assert.equal(
    database.prepare('SELECT 1 FROM microsoft_todo_completion_intents WHERE task_id = ?').get(taskId),
    undefined,
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM tasks WHERE task_list_id = ? AND recurrence_origin_id IS NOT NULL
  `).get(listId).n, 0);
  assert.equal(
    database.prepare('SELECT sync_cursor FROM task_lists WHERE id = ?').get(listId).sync_cursor,
    '/me/todo/lists/list-recurring-recreate/tasks/delta?$deltatoken=recreate-3',
  );
});

test('retries a failed successor Delta from the last committed cursor', async () => {
  const ownerId = insertUser('todo-owner-recurring-retry');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Retry', 'microsoft_todo', ?, 'list-recurring-retry', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Retry task', ?, 'microsoft_todo', ?, 'remote-retry-current', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY', 1)
  `).run(ownerId, accountId, listId).lastInsertRowid;
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, '2026-08-31T12:34:56Z')
  `).run(taskId, taskId, ownerId);
  assert.equal(completions.markMicrosoftTodoCompletionIntent(database, taskId), true);

  let failedCursorAttempt = false;
  const deltaTokens = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-recurring-retry', displayName: 'Retry' }] });
    }
    if (parsed.pathname.endsWith('/tasks/remote-retry-current') && method === 'PATCH') {
      return response(204);
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-recurring-retry/tasks/delta') {
      const token = parsed.searchParams.get('$deltatoken');
      deltaTokens.push(token || 'initial');
      if (!token) {
        return response(200, {
          value: [{
            id: 'remote-retry-current',
            title: 'Retry task',
            status: 'completed',
            importance: 'normal',
            dueDateTime: { dateTime: '2026-08-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring-retry/tasks/delta?$deltatoken=retry-c1',
        });
      }
      if (token === 'retry-c1' && !failedCursorAttempt) {
        failedCursorAttempt = true;
        return response(500, { error: { message: 'temporary successor read failure' } });
      }
      assert.equal(token, 'retry-c1', 'the retry must start at the last committed cursor');
      return response(200, {
        value: [{
          id: 'remote-retry-next',
          title: 'Retry task',
          status: 'notStarted',
          importance: 'normal',
          dueDateTime: { dateTime: '2026-09-15T00:00:00.0000000', timeZone: 'UTC' },
          recurrence: {
            pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
            range: { type: 'noEnd', startDate: '2026-08-15' },
          },
        }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring-retry/tasks/delta?$deltatoken=retry-c2',
      });
    }
    throw new Error(`Unexpected Graph request ${method} ${parsed.pathname}${parsed.search}`);
  };

  const result = await todo.sync({
    database,
    fetchImpl,
    completionTaskIds: [taskId],
    waitForSuccessor: async () => {},
  });

  assert.equal(result.success, true, 'a later successful refill clears an intermediate failure');
  assert.equal(result.failed, 0);
  assert.deepEqual(deltaTokens, ['initial', 'retry-c1', 'retry-c1']);
  assert.equal(
    database.prepare('SELECT sync_cursor FROM task_lists WHERE id = ?').get(listId).sync_cursor,
    '/me/todo/lists/list-recurring-retry/tasks/delta?$deltatoken=retry-c2',
  );
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE external_uid = 'remote-retry-next'`).get().n, 1);
  assert.equal(
    database.prepare('SELECT 1 FROM microsoft_todo_completion_intents WHERE task_id = ?').get(taskId),
    undefined,
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM tasks WHERE task_list_id = ? AND recurrence_origin_id IS NOT NULL
  `).get(listId).n, 0);
});

test('keeps the last successful cursor and counts two failed refills once', async () => {
  const ownerId = insertUser('todo-owner-recurring-refill-failure');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Refill failure', 'microsoft_todo', ?, 'list-recurring-refill-failure', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Refill failure task', ?, 'microsoft_todo', ?, 'remote-refill-current', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY', 1)
  `).run(ownerId, accountId, listId).lastInsertRowid;
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, '2026-08-31T12:34:56Z')
  `).run(taskId, taskId, ownerId);
  assert.equal(completions.markMicrosoftTodoCompletionIntent(database, taskId), true);

  const refillAttempts = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-recurring-refill-failure', displayName: 'Refill failure' }] });
    }
    if (parsed.pathname.endsWith('/tasks/remote-refill-current') && method === 'PATCH') {
      return response(204);
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-recurring-refill-failure/tasks/delta') {
      const token = parsed.searchParams.get('$deltatoken');
      if (!token) {
        return response(200, {
          value: [{
            id: 'remote-refill-current',
            title: 'Refill failure task',
            status: 'completed',
            importance: 'normal',
            dueDateTime: { dateTime: '2026-08-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-recurring-refill-failure/tasks/delta?$deltatoken=refill-c1',
        });
      }
      refillAttempts.push(token);
      assert.equal(token, 'refill-c1', 'failed refills must not advance the cursor');
      return response(500, { error: { message: 'successor still not visible' } });
    }
    throw new Error(`Unexpected Graph request ${method} ${parsed.pathname}${parsed.search}`);
  };

  const result = await todo.sync({
    database,
    fetchImpl,
    completionTaskIds: [taskId],
    waitForSuccessor: async () => {},
  });

  assert.equal(result.success, false);
  assert.equal(result.failed, 1, 'both failed refill rounds are one list failure');
  assert.deepEqual(refillAttempts, ['refill-c1', 'refill-c1']);
  assert.equal(
    database.prepare('SELECT sync_cursor FROM task_lists WHERE id = ?').get(listId).sync_cursor,
    '/me/todo/lists/list-recurring-refill-failure/tasks/delta?$deltatoken=refill-c1',
  );
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE external_uid = 'remote-refill-next'`).get().n, 0);
  assert.equal(
    database.prepare('SELECT state FROM microsoft_todo_completion_intents WHERE task_id = ?').get(taskId).state,
    'delta',
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM tasks WHERE task_list_id = ? AND recurrence_origin_id IS NOT NULL
  `).get(listId).n, 0);
  assert.ok(database.prepare('SELECT last_error FROM task_lists WHERE id = ?').get(listId).last_error);
});

test('keeps a completion intent after PATCH failure and recovers it on the next sync', async () => {
  const ownerId = insertUser('todo-owner-completion-recovery');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Completion recovery', 'microsoft_todo', ?, 'list-completion-recovery', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Recover completion', ?, 'microsoft_todo', ?, 'remote-recovery-current', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY', 1)
  `).run(ownerId, accountId, listId).lastInsertRowid;
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, '2026-08-31T12:34:56Z')
  `).run(taskId, taskId, ownerId);
  assert.equal(completions.markMicrosoftTodoCompletionIntent(database, taskId), true);

  let patchAttempts = 0;
  const deltaTokens = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-completion-recovery', displayName: 'Completion recovery' }] });
    }
    if (parsed.pathname.endsWith('/tasks/remote-recovery-current') && method === 'PATCH') {
      patchAttempts += 1;
      return patchAttempts === 1
        ? response(500, { error: { message: 'temporary write failure' } })
        : response(204);
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-completion-recovery/tasks/delta') {
      const token = parsed.searchParams.get('$deltatoken');
      deltaTokens.push(token || 'initial');
      if (!token) {
        return response(200, {
          value: [{
            id: 'remote-recovery-current',
            title: 'Recover completion',
            status: 'completed',
            dueDateTime: { dateTime: '2026-08-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-completion-recovery/tasks/delta?$deltatoken=recovery-c1',
        });
      }
      if (token === 'recovery-c1') {
        return response(200, {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-completion-recovery/tasks/delta?$deltatoken=recovery-c2',
        });
      }
      if (token === 'recovery-c2') {
        return response(200, {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-completion-recovery/tasks/delta?$deltatoken=recovery-c3',
        });
      }
      if (token === 'recovery-c3') {
        return response(200, {
          value: [{
            id: 'remote-recovery-next',
            title: 'Recover completion',
            status: 'notStarted',
            dueDateTime: { dateTime: '2026-09-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-completion-recovery/tasks/delta?$deltatoken=recovery-c4',
        });
      }
    }
    throw new Error(`Unexpected Graph request ${method} ${parsed.pathname}${parsed.search}`);
  };

  const first = await todo.sync({ database, fetchImpl, waitForSuccessor: async () => {} });
  assert.equal(first.success, false);
  assert.equal(first.failed, 1);
  assert.equal(patchAttempts, 1);
  assert.deepEqual(deltaTokens, ['initial']);
  assert.equal(
    database.prepare('SELECT sync_cursor FROM task_lists WHERE id = ?').get(listId).sync_cursor,
    '/me/todo/lists/list-completion-recovery/tasks/delta?$deltatoken=recovery-c1',
  );
  assert.deepEqual(
    database.prepare('SELECT state FROM microsoft_todo_completion_intents WHERE task_id = ?').get(taskId),
    { state: 'patch' },
  );

  const waits = [];
  const second = await todo.sync({
    database,
    fetchImpl,
    waitForSuccessor: async (delayMs) => waits.push(delayMs),
  });
  assert.equal(second.success, true);
  assert.equal(second.failed, 0);
  assert.equal(patchAttempts, 2);
  assert.deepEqual(deltaTokens, ['initial', 'recovery-c1', 'recovery-c2', 'recovery-c3']);
  assert.deepEqual(waits, [1000, 3000]);
  assert.equal(
    database.prepare('SELECT sync_cursor FROM task_lists WHERE id = ?').get(listId).sync_cursor,
    '/me/todo/lists/list-completion-recovery/tasks/delta?$deltatoken=recovery-c4',
  );
  assert.equal(
    database.prepare('SELECT 1 FROM microsoft_todo_completion_intents WHERE task_id = ?').get(taskId),
    undefined,
  );
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE external_uid = 'remote-recovery-next'"
  ).get().n, 1);
});

test('creates a completed recurring local To Do task and reconciles its delayed successor', async () => {
  const ownerId = insertUser('todo-owner-local-completed-create');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Local completed create', 'microsoft_todo', ?, 'list-local-completed-create', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;
  const taskId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, task_list_id, status, due_date,
       is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Create and complete', ?, 'local', ?, 'done', '2026-08-15',
            1, 'FREQ=MONTHLY', 0)
  `).run(ownerId, listId).lastInsertRowid;
  completions.syncTaskCompletion(database, taskId, 'open', 'done', ownerId);
  assert.ok(database.prepare(
    'SELECT 1 FROM microsoft_todo_completion_intents WHERE task_id = ?'
  ).get(taskId));

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, search: parsed.search, method, body });
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-local-completed-create', displayName: 'Local completed create' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-local-completed-create/tasks' && method === 'POST') {
      assert.equal(body.status, 'completed');
      assert.deepEqual(body.recurrence, {
        pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
        range: { type: 'noEnd', startDate: '2026-08-15', recurrenceTimeZone: 'UTC' },
      });
      assert.equal(Object.hasOwn(body, 'completedDateTime'), false);
      return response(201, { id: 'remote-local-completed-current' });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-local-completed-create/tasks/delta') {
      const token = parsed.searchParams.get('$deltatoken');
      if (!token) {
        return response(200, {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-local-completed-create/tasks/delta?$deltatoken=post-c1',
        });
      }
      if (token === 'post-c1') {
        return response(200, {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-local-completed-create/tasks/delta?$deltatoken=post-c2',
        });
      }
      if (token === 'post-c2') {
        return response(200, {
          value: [{
            id: 'remote-local-completed-next',
            title: 'Create and complete',
            status: 'notStarted',
            dueDateTime: { dateTime: '2026-09-15T00:00:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
              range: { type: 'noEnd', startDate: '2026-08-15' },
            },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-local-completed-create/tasks/delta?$deltatoken=post-c3',
        });
      }
    }
    throw new Error(`Unexpected Graph request ${method} ${parsed.pathname}${parsed.search}`);
  };

  const waits = [];
  const result = await todo.sync({
    database,
    fetchImpl,
    waitForSuccessor: async (delayMs) => waits.push(delayMs),
  });
  assert.equal(result.success, true);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
  assert.ok(calls.findIndex((call) => call.method === 'POST') < calls.findIndex((call) => call.path.endsWith('/tasks/delta')));
  assert.deepEqual(waits, [1000, 3000]);
  assert.equal(
    database.prepare('SELECT external_source, external_uid, status FROM tasks WHERE id = ?').get(taskId).external_uid,
    'remote-local-completed-current',
  );
  assert.equal(database.prepare(
    'SELECT COUNT(*) AS n FROM tasks WHERE recurrence_origin_id = ?'
  ).get(taskId).n, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE external_uid = 'remote-local-completed-next'"
  ).get().n, 1);
  assert.equal(
    database.prepare('SELECT 1 FROM microsoft_todo_completion_intents WHERE task_id = ?').get(taskId),
    undefined,
  );
  assert.equal(
    database.prepare('SELECT sync_cursor FROM task_lists WHERE id = ?').get(listId).sync_cursor,
    '/me/todo/lists/list-local-completed-create/tasks/delta?$deltatoken=post-c3',
  );
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
    INSERT INTO tasks
      (title, created_by, external_source, task_list_id, due_date, is_recurring, recurrence_rule)
    VALUES ('Renew insurance', ?, 'local', ?, '2026-08-30', 1, 'FREQ=MONTHLY')
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
  assert.deepEqual(createBody.recurrence, {
    pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 30 },
    range: { type: 'noEnd', startDate: '2026-08-30', recurrenceTimeZone: 'UTC' },
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

test('merges one trailing sync and lets forceFull upgrade its queued options', async () => {
  const ownerId = insertUser('todo-owner-trailing-sync');
  const accountId = insertAccount(ownerId);
  const listId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled, sync_cursor, last_full_sync)
    VALUES ('Trailing', 'microsoft_todo', ?, 'list-trailing', ?, 1,
            '/me/todo/lists/list-trailing/tasks/delta?$deltatoken=base', ?)
  `).run(accountId, ownerId, new Date().toISOString()).lastInsertRowid;

  let releaseFirst;
  let firstDeltaStarted;
  const firstDeltaReady = new Promise((resolve) => { firstDeltaStarted = resolve; });
  const firstDeltaGate = new Promise((resolve) => { releaseFirst = resolve; });
  const deltaSearches = [];
  let deltaCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      return response(200, { value: [{ id: 'list-trailing', displayName: 'Trailing' }] });
    }
    if (parsed.pathname === '/v1.0/me/todo/lists/list-trailing/tasks/delta') {
      deltaCalls += 1;
      deltaSearches.push(parsed.search);
      if (deltaCalls === 1) {
        firstDeltaStarted();
        await firstDeltaGate;
        return response(200, {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-trailing/tasks/delta?$deltatoken=after-first',
        });
      }
      assert.equal(parsed.search, '', 'forceFull must upgrade the queued trailing run');
      return response(200, {
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-trailing/tasks/delta?$deltatoken=after-full',
      });
    }
    throw new Error(`Unexpected Graph request ${parsed.pathname}${parsed.search}`);
  };

  const first = todo.sync({ database, fetchImpl });
  await firstDeltaReady;
  const trailing = todo.sync({
    database,
    fetchImpl,
    queueIfRunning: true,
    waitForSuccessor: async () => {},
  });
  const merged = todo.sync({ database, fetchImpl, queueIfRunning: true });
  const upgraded = todo.sync({ database, fetchImpl, forceFull: true });
  assert.strictEqual(trailing, merged);
  assert.strictEqual(trailing, upgraded);
  assert.strictEqual(todo.sync({ database, fetchImpl }), trailing);

  releaseFirst();
  const [firstResult, trailingResult] = await Promise.all([first, trailing]);
  assert.equal(firstResult.success, true);
  assert.equal(trailingResult.success, true);
  assert.equal(trailingResult.fullResyncLists, 1);
  assert.deepEqual(deltaSearches, [
    '?$deltatoken=base',
    '',
  ]);
  assert.equal(deltaCalls, 2);
  assert.equal(
    database.prepare('SELECT sync_cursor FROM task_lists WHERE id = ?').get(listId).sync_cursor,
    '/me/todo/lists/list-trailing/tasks/delta?$deltatoken=after-full',
  );
});

test('merges completion markers from multiple trailing completion triggers', async () => {
  const ownerId = insertUser('todo-owner-trailing-completions');
  const accountId = insertAccount(ownerId);
  const listAId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Multi A', 'microsoft_todo', ?, 'list-multi-a', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;
  const listBId = database.prepare(`
    INSERT INTO task_lists
      (name, provider, external_account_id, external_list_id, created_by, enabled)
    VALUES ('Multi B', 'microsoft_todo', ?, 'list-multi-b', ?, 1)
  `).run(accountId, ownerId).lastInsertRowid;

  let releaseFirst;
  let firstDeltaStarted;
  const firstDeltaReady = new Promise((resolve) => { firstDeltaStarted = resolve; });
  const firstDeltaGate = new Promise((resolve) => { releaseFirst = resolve; });
  const deltaSearches = [];
  const patchBodies = [];
  let listFetches = 0;
  let targetListFetches = 0;
  const eligibleAccountCount = database.prepare(`
    SELECT COUNT(*) AS n FROM outlook_accounts WHERE COALESCE(todo_needs_reauth, 0) = 0
  `).get().n;

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    if (parsed.pathname === '/v1.0/me/todo/lists') {
      listFetches += 1;
      const isTargetAccount = listFetches % eligibleAccountCount === 0;
      if (isTargetAccount) targetListFetches += 1;
      return response(200, {
        value: isTargetAccount ? [
          { id: 'list-multi-a', displayName: 'Multi A' },
          { id: 'list-multi-b', displayName: 'Multi B' },
        ] : [],
      });
    }

    const listKey = parsed.pathname.includes('/list-multi-a/') ? 'a' : 'b';
    const currentUid = `remote-multi-${listKey}`;
    if (parsed.pathname.endsWith(`/tasks/${currentUid}`) && method === 'PATCH') {
      patchBodies.push({ listKey, body: JSON.parse(options.body) });
      return response(204);
    }

    if (parsed.pathname.endsWith('/tasks/delta')) {
      const token = parsed.searchParams.get('$deltatoken');
      deltaSearches.push(`${listKey}:${token || 'initial'}`);
      const deltaLink = (nextToken) => (
        `https://graph.microsoft.com/v1.0/me/todo/lists/list-multi-${listKey}/tasks/delta?$deltatoken=${nextToken}`
      );
      if (!token) {
        if (listKey === 'a') {
          firstDeltaStarted();
          await firstDeltaGate;
        }
        return response(200, { value: [], '@odata.deltaLink': deltaLink(`${listKey}-1`) });
      }
      if (token === `${listKey}-1`) {
        const dueDate = listKey === 'a' ? '2026-09-01' : '2026-09-02';
        return response(200, {
          value: [{
            id: currentUid,
            title: `Multi ${listKey}`,
            status: 'completed',
            dueDateTime: { dateTime: `${dueDate}T00:00:00.0000000`, timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 1 },
              range: { type: 'noEnd', startDate: dueDate },
            },
          }],
          '@odata.deltaLink': deltaLink(`${listKey}-2`),
        });
      }
      if (token === `${listKey}-2`) {
        return response(200, { value: [], '@odata.deltaLink': deltaLink(`${listKey}-3`) });
      }
      if (token === `${listKey}-3`) {
        return response(200, { value: [], '@odata.deltaLink': deltaLink(`${listKey}-4`) });
      }
    }
    throw new Error(`Unexpected Graph request ${method} ${parsed.pathname}${parsed.search}`);
  };

  const first = todo.sync({ database, fetchImpl });
  await firstDeltaReady;
  const taskAId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Multi a', ?, 'microsoft_todo', ?, 'remote-multi-a', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY', 1)
  `).run(ownerId, accountId, listAId).lastInsertRowid;
  const taskBId = database.prepare(`
    INSERT INTO tasks
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule, outbound_dirty)
    VALUES ('Multi b', ?, 'microsoft_todo', ?, 'remote-multi-b', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY', 1)
  `).run(ownerId, accountId, listBId).lastInsertRowid;
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, '2026-08-01T12:34:56Z'), (?, ?, ?, '2026-08-01T12:34:57Z')
  `).run(taskAId, taskAId, ownerId, taskBId, taskBId, ownerId);
  assert.equal(completions.markMicrosoftTodoCompletionIntent(database, taskAId), true);
  assert.equal(completions.markMicrosoftTodoCompletionIntent(database, taskBId), true);
  const waits = [];
  const waitForSuccessor = async (delayMs) => waits.push(delayMs);
  const trailingA = todo.sync({
    database,
    fetchImpl,
    queueIfRunning: true,
    completionTaskIds: [taskAId],
    waitForSuccessor,
  });
  const trailingB = todo.sync({
    database,
    fetchImpl,
    queueIfRunning: true,
    completionTaskIds: [taskBId],
    waitForSuccessor,
  });
  assert.strictEqual(trailingA, trailingB, 'multiple completion triggers share one trailing run');

  releaseFirst();
  const [firstResult, trailingResult] = await Promise.all([first, trailingA]);
  assert.equal(firstResult.success, true);
  assert.equal(trailingResult.success, true);
  assert.equal(targetListFetches, 2, 'completion triggers must not create more than one trailing run');
  assert.deepEqual(patchBodies.map(({ listKey }) => listKey), ['a', 'b']);
  assert.deepEqual(waits, [1000, 3000, 1000, 3000], 'both completion markers must survive queue merging');
  assert.deepEqual(deltaSearches, [
    'a:initial',
    'b:initial',
    'a:a-1',
    'a:a-2',
    'a:a-3',
    'b:b-1',
    'b:b-2',
    'b:b-3',
  ]);
  assert.equal(
    database.prepare('SELECT sync_cursor FROM task_lists WHERE id = ?').get(listAId).sync_cursor,
    '/me/todo/lists/list-multi-a/tasks/delta?$deltatoken=a-4',
  );
  assert.equal(
    database.prepare('SELECT sync_cursor FROM task_lists WHERE id = ?').get(listBId).sync_cursor,
    '/me/todo/lists/list-multi-b/tasks/delta?$deltatoken=b-4',
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE recurrence_origin_id IS NOT NULL').get().n, 0);
  assert.equal(database.prepare(
    'SELECT COUNT(*) AS n FROM microsoft_todo_completion_intents WHERE task_id IN (?, ?)'
  ).get(taskAId, taskBId).n, 0);
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
      (title, created_by, external_source, external_account_id, external_uid, task_list_id,
       status, due_date, is_recurring, recurrence_rule)
    VALUES ('Keep locally', ?, 'microsoft_todo', ?, 'remote-old', ?,
            'done', '2026-08-15', 1, 'FREQ=MONTHLY')
  `).run(ownerId, accountId, staleListId).lastInsertRowid;
  database.prepare(`
    INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
    VALUES (?, ?, ?, '2026-08-31T12:34:56Z')
  `).run(taskId, taskId, ownerId);
  assert.equal(completions.markMicrosoftTodoCompletionIntent(database, taskId), true);

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
  assert.equal(
    database.prepare('SELECT 1 FROM microsoft_todo_completion_intents WHERE task_id = ?').get(taskId),
    undefined,
  );
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

test('runs a queued completion sync even when the preceding sync rejects', async () => {
  const broken = new DatabaseSync(':memory:');
  broken.close();
  let listFetches = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/v1.0/me/todo/lists');
    listFetches += 1;
    return response(200, { value: [] });
  };

  const first = todo.sync({ database: broken });
  const trailing = todo.sync({ database, fetchImpl, queueIfRunning: true });
  assert.notStrictEqual(first, trailing);
  await assert.rejects(first);
  const result = await trailing;

  assert.equal(result.success, true);
  assert.ok(listFetches > 0, 'the trailing run must execute after a rejected run');
});
