/**
 * message-pusher notification provider.
 *
 * The generic webhook provider remains intentionally separate: it keeps its
 * existing Yuvomi JSON/template/Bearer contract. This adapter speaks the
 * message-pusher `/push/<username>` contract and never puts a token into an
 * error message or log line.
 */

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

function fieldsFor(channel, payload = {}) {
  const config = channel?.config || {};
  const fields = {
    title: String(payload.title ?? ''),
  };
  const body = String(payload.body ?? '');
  // message-pusher documents description/content as alternative message
  // representations for most channels. The setting chooses the one that
  // receives Yuvomi's notification body, so we never send both at once.
  if (config.messageField === 'description') fields.description = String(payload.description ?? body);
  else fields.content = String(payload.content ?? body);
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

  async send({ channel, payload, fetchImpl = fetch, signal } = {}) {
    const config = channel?.config || {};
    const method = String(config.method || 'POST').toUpperCase();
    const format = String(config.postFormat || 'json').toLowerCase();
    const messageField = String(config.messageField || 'content').toLowerCase();
    if (!METHODS.has(method)) throw new Error('Invalid message-pusher request method.');
    if (method === 'POST' && !FORMATS.has(format)) throw new Error('Invalid message-pusher POST format.');
    if (!FIELDS.has(messageField)) throw new Error('Invalid message-pusher message field.');

    const url = endpointFor(config);
    const fields = fieldsFor({ ...channel, config: { ...config, messageField } }, payload);
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

export const __test = { endpointFor, fieldsFor };

export default messagePusherProvider;
