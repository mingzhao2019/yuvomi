/**
 * message-pusher notification provider.
 *
 * The generic webhook provider remains intentionally separate: it keeps its
 * existing Yuvomi JSON/template/Bearer contract. This adapter speaks the
 * message-pusher `/push/<username>` contract and never puts a token into an
 * error message or log line.
 */

import { renderTextTemplate } from './webhook.js';

const METHODS = new Set(['GET', 'POST']);
const FORMATS = new Set(['json', 'form']);
const FIELDS = new Set(['content', 'description']);

function responseError(status) {
  if (status === 401 || status === 403) return new Error('message-pusher authentication failed.');
  if (status === 404) return new Error('message-pusher endpoint was not found.');
  return new Error(`message-pusher returned HTTP ${status}.`);
}

function endpointFor(config) {
  const url = new URL(config.baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/push/${encodeURIComponent(config.username)}`;
  return url;
}

function absoluteAppUrl(path, env = process.env) {
  const base = String(env?.BASE_URL ?? '').trim();
  const relativePath = String(path ?? '').trim();
  if (!base || !relativePath.startsWith('/') || relativePath.startsWith('//')) return '';
  try {
    const baseUrl = new URL(base);
    if (!['http:', 'https:'].includes(baseUrl.protocol)) return '';
    return new URL(relativePath, baseUrl.origin).toString();
  } catch {
    return '';
  }
}

function pusherPayload(payload = {}, env = process.env) {
  return {
    ...payload,
    // Raw timestamps are UTC storage values. If the notification path did not
    // provide a household-local alias, omit them rather than leaking an ISO
    // value with a misleading timezone into a human-facing message.
    remindAt: Object.hasOwn(payload, 'remindAtLocal') ? (payload.remindAtLocal ?? '') : '',
    sentAt: Object.hasOwn(payload, 'sentAtLocal') ? (payload.sentAtLocal ?? '') : '',
    url: absoluteAppUrl(payload.url, env),
  };
}

function fieldsFor(channel, payload = {}, env = process.env) {
  const config = channel?.config || {};
  const renderedPayload = pusherPayload(payload, env);
  const template = String(config.messageTemplate ?? '').trim();
  const fields = {
    title: String(renderedPayload.title ?? ''),
  };
  const body = template
    ? renderTextTemplate(template, renderedPayload)
    : String(renderedPayload.content ?? renderedPayload.body ?? '');
  // message-pusher documents description/content as alternative message
  // representations for most channels. The setting chooses the field that
  // receives Yuvomi's rendered notification body; the task/event description
  // remains available to an explicit {{description}} template placeholder.
  fields[config.messageField === 'description' ? 'description' : 'content'] = body;
  if (config.channel) fields.channel = String(config.channel);
  if (channel?.secrets?.token) {
    fields.token = String(channel.secrets.token);
  }
  return fields;
}

function addQueryFields(url, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== '') url.searchParams.set(key, value);
  }
}

function addTokenQuery(url, fields) {
  if (fields.token) {
    url.searchParams.set('token', fields.token);
    delete fields.token;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export const messagePusherProvider = {
  id: 'message_pusher',

  async send({ channel, payload, fetchImpl = fetch, signal, env = process.env } = {}) {
    const config = channel?.config || {};
    const method = String(config.method || 'POST').toUpperCase();
    const format = String(config.postFormat || 'json').toLowerCase();
    const messageField = String(config.messageField || 'content').toLowerCase();
    if (!METHODS.has(method)) throw new Error('Invalid message-pusher request method.');
    if (method === 'POST' && !FORMATS.has(format)) throw new Error('Invalid message-pusher POST format.');
    if (!FIELDS.has(messageField)) throw new Error('Invalid message-pusher message field.');

    const url = endpointFor(config);
    const fields = fieldsFor({ ...channel, config: { ...config, messageField } }, payload, env);
    const tokenInQuery = method === 'GET' || config.tokenInQuery === true;
    const headers = {};
    const options = { method, headers, signal };

    if (method === 'GET') {
      addQueryFields(url, fields);
    } else if (format === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (tokenInQuery) addTokenQuery(url, fields);
      options.body = new URLSearchParams(fields).toString();
    } else {
      headers['Content-Type'] = 'application/json';
      if (tokenInQuery) addTokenQuery(url, fields);
      options.body = JSON.stringify(fields);
    }

    const response = await fetchImpl(url.toString(), options);
    const data = await readJson(response);
    if (!response.ok) {
      throw responseError(response.status);
    }
    if (data && (data.success === false || data.success === 'false')) {
      throw new Error('message-pusher rejected notification.');
    }
    return { ok: true, status: response.status };
  },
};

export const __test = { endpointFor, fieldsFor, absoluteAppUrl, pusherPayload };

export default messagePusherProvider;
