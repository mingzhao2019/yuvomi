import test from 'node:test';
import assert from 'node:assert/strict';

import { messagePusherProvider } from '../server/services/notification-providers/message-pusher.js';
import { normalizeChannelInput } from '../server/services/notification-channels.js';

function response(status, data = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function channel(overrides = {}) {
  return {
    id: 1,
    provider: 'message_pusher',
    config: {
      baseUrl: 'https://push.example.test',
      username: 'family',
      method: 'POST',
      postFormat: 'json',
      messageField: 'content',
      channel: '',
      tokenInQuery: false,
      ...overrides.config,
    },
    secrets: { token: 'secret-token', ...overrides.secrets },
  };
}

test('GET uses the message-pusher path and query contract', async () => {
  let request;
  await messagePusherProvider.send({
    channel: channel({ config: { method: 'GET', channel: 'lark' } }),
    payload: { title: '标题', body: '**Markdown**' },
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return response(200, { success: true });
    },
  });

  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.body, undefined);
  assert.equal(request.url.pathname, '/push/family');
  assert.equal(request.url.searchParams.get('title'), '标题');
  assert.equal(request.url.searchParams.get('content'), '**Markdown**');
  assert.equal(request.url.searchParams.get('channel'), 'lark');
  assert.equal(request.url.searchParams.get('token'), 'secret-token');
});

test('POST JSON sends application/json and token in the body by default', async () => {
  let request;
  await messagePusherProvider.send({
    channel: channel(),
    payload: { title: 'Title', body: 'Description' },
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options, body: JSON.parse(options.body) };
      return response(200, { success: true });
    },
  });

  assert.equal(request.url.pathname, '/push/family');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(request.body, {
    title: 'Title',
    content: 'Description',
    token: 'secret-token',
  });
});

test('POST Form can put token in the URL query', async () => {
  let request;
  await messagePusherProvider.send({
    channel: channel({ config: { postFormat: 'form', messageField: 'description', tokenInQuery: true } }),
    payload: { title: 'Title', body: 'Plain text' },
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options, body: new URLSearchParams(options.body) };
      return response(200, { success: true });
    },
  });

  assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(request.url.searchParams.get('token'), 'secret-token');
  assert.equal(request.url.searchParams.get('title'), null);
  assert.equal(request.url.searchParams.get('description'), null);
  assert.equal(request.body.get('description'), 'Plain text');
  assert.equal(request.body.get('token'), null);
});

test('message-pusher rejects a negative API response and validates configuration', async () => {
  await assert.rejects(
    messagePusherProvider.send({
      channel: channel(),
      payload: { title: 'Title', body: 'Body' },
      fetchImpl: async () => response(200, { success: false, message: 'bad channel' }),
    }),
    /bad channel/,
  );

  assert.throws(() => normalizeChannelInput({
    provider: 'message_pusher',
    name: 'Push',
    config: { baseUrl: 'https://push.example.test', username: '' },
  }), /username is required/);
});
