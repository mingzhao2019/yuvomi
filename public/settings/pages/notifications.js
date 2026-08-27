/**
 * Settings-Seite: Push-Benachrichtigungen (pro Gerät) und persönliche bzw.
 * haushaltsweite Notification-Channels.
 */
import { t } from '/i18n.js';
import { pushSupported, pushStatus, enablePush, disablePush, repairPush } from '/push.js';
import { api, notifications } from '/api.js';
import { confirmModal } from '/components/modal.js';
import { esc } from '/utils/html.js';
import { getPwaInstallState } from '/utils/pwa-install.js';
import { toggleRowHtml } from '/settings/components.js';

const DEFAULT_PROVIDERS = [
  { id: 'gotify', name: 'Gotify' },
  { id: 'ntfy', name: 'ntfy' },
  { id: 'webhook', name: 'Webhook' },
  { id: 'message_pusher', name: 'message-pusher' },
];

// Die Beispiele bleiben absichtlich in der Seite und nicht nur im Tooltip:
// Ein HTML-placeholder ist sichtbar, aber nicht mit der Maus markierbar. Der
// Kopierknopf liest deshalb genau diese Werte aus. Beide Bereiche verwenden
// denselben Yuvomi-Webhookschema; der Haushaltskanal zeigt zusätzlich die
// technische Herkunft und Zustellungsdaten aller Module.
const TEMPLATE_EXAMPLES = Object.freeze({
  user: Object.freeze({
    webhook: String.raw`{"event":"notification","notification":{"title":"🔔 {{title}}","body":"📌 {{body}}","description":"📄 {{description}}","dueDate":"📅 {{dueDate}}","dueTime":"{{dueTime}}","startDate":"🚀 {{startDate}}","startTime":"{{startTime}}","endDate":"🏁 {{endDate}}","endTime":"{{endTime}}","url":"🔗 {{url}}"},"sentAt":"{{sentAt}}"}`,
    message_pusher: `🔔 {{title}} — {{body}}
📄 {{description}}
📅 {{dueDate}} {{dueTime}}
🚀 {{startDate}} {{startTime}}
🔗 {{url}}`,
  }),
  household: Object.freeze({
    webhook: String.raw`{"event":"notification","notification":{"title":"🔔 {{title}}","body":"📌 {{body}}","description":"📄 {{description}}","details":"📝 {{details}}","entityType":"🧩 {{entityType}}","entityId":"{{entityId}}","dueDate":"📅 {{dueDate}}","dueTime":"{{dueTime}}","startDate":"🚀 {{startDate}}","startTime":"{{startTime}}","endDate":"🏁 {{endDate}}","endTime":"{{endTime}}","remindAt":"⏰ {{remindAt}}","url":"🔗 {{url}}","tag":"{{tag}}","priority":"{{priority}}","category":"{{category}}","taskPriority":"{{taskPriority}}","status":"{{status}}","location":"{{location}}","allDay":"{{allDay}}"},"sentAt":"📤 {{sentAt}}"}`,
    message_pusher: `🔔 {{title}} — {{body}}
📄 {{description}}
📅 {{dueDate}} {{dueTime}}
🚀 {{startDate}} {{startTime}}
🧩 {{entityType}} #{{entityId}}
📝 {{details}}
⏰ {{remindAt}}
📤 {{sentAt}}
🔗 {{url}}`,
  }),
});

function selected(value, expected) {
  return value === expected ? ' selected' : '';
}

function templateExample(provider, scope) {
  const group = scope === 'user' ? TEMPLATE_EXAMPLES.user : TEMPLATE_EXAMPLES.household;
  return group[provider] || '';
}

function channelDefaults(provider = 'gotify', scope = 'household') {
  if (provider === 'ntfy') {
    return {
      provider: 'ntfy',
      name: '',
      enabled: false,
      scope,
      userId: null,
      config: { baseUrl: '', topic: '', priority: 'default', authType: 'none' },
      secretSet: false,
    };
  }
  if (provider === 'webhook') {
    return {
      provider: 'webhook',
      name: '',
      enabled: false,
      scope,
      userId: null,
      // Leere Vorlage = Yuvomi-Standardbody. Empfaenger mit eigenem Pflichtschema
      // (Discord, Slack) tragen hier ihre Form ein, statt einen Adapter je Dienst
      // zu brauchen (#692).
      config: { baseUrl: '', payloadTemplate: '' },
      secretSet: false,
    };
  }
  if (provider === 'message_pusher') {
    return {
      provider: 'message_pusher',
      name: '',
      enabled: false,
      scope,
      userId: null,
      config: {
        baseUrl: '', username: '', method: 'POST', postFormat: 'json',
        messageField: 'content', messageTemplate: '', channel: '', tokenInQuery: false,
      },
      secretSet: false,
    };
  }
  return {
    provider: 'gotify',
    name: '',
    enabled: false,
    scope,
    userId: null,
    config: { baseUrl: '', priority: 5 },
    secretSet: false,
  };
}

function renderPage(container, user) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.pushToggleTitle')}</h2>
      <div class="settings-card">
        <div class="settings-card__body">
          <p class="form-hint">${t('settings.pushDeviceDescription')}</p>
          <p class="form-hint" id="push-ios-hint" hidden>${t('settings.pushIosHomescreenHint')}</p>
          <p class="form-hint" id="push-status" aria-live="polite">${t('settings.pushChecking')}</p>
          <div class="settings-form-actions">
            ${toggleRowHtml({
              label: t('settings.pushToggleLabel'),
              disabled: true,
              attrs: { id: 'push-toggle' },
            })}
          </div>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--secondary" id="push-test-btn" disabled>
              <i data-lucide="bell-ring" aria-hidden="true"></i>
              <span>${t('settings.pushTestButton')}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
    <section class="settings-section" id="notification-channels-section"></section>
  `);
  renderChannelShell(container, user);
}

function renderChannelShell(container, user) {
  const section = container.querySelector('#notification-channels-section');
  if (!section) return;
  const isAdmin = user?.role === 'admin';
  section.replaceChildren();
  section.insertAdjacentHTML('beforeend', `
    <h2 class="settings-section__title">${t('settings.notificationPersonalTitle')}</h2>
    <p class="form-hint">${t('settings.notificationPersonalDescription')}</p>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary" data-notification-channel-add="user">
        <i data-lucide="plus" aria-hidden="true"></i>
        <span>${t('settings.notificationChannelAdd')}</span>
      </button>
    </div>
    <p class="form-hint" id="notification-channel-status" role="status" aria-live="polite"></p>
    <div id="notification-channel-list-user"></div>
    ${isAdmin ? `
      <h2 class="settings-section__title notification-channel-household-title">${t('settings.notificationHouseholdTitle')}</h2>
      <p class="form-hint">${t('settings.notificationHouseholdDescription')}</p>
      <div class="settings-form-actions">
        <button type="button" class="btn btn--secondary" data-notification-channel-add="household">
          <i data-lucide="plus" aria-hidden="true"></i>
          <span>${t('settings.notificationChannelAdd')}</span>
        </button>
      </div>
      <div id="notification-channel-list-household"></div>
    ` : ''}
  `);
}

function providerOptions(providers, current) {
  return providers.map((provider) => `
    <option value="${esc(provider.id)}"${selected(current, provider.id)}>${esc(provider.name)}</option>
  `).join('');
}

function templateHelp(id) {
  return '<span class="notification-template-help">'
    + '<button type="button" class="notification-template-help__button"'
    + ' aria-label="' + esc(t('settings.notificationChannelTemplateHelpLabel')) + '"'
    + ' aria-describedby="' + esc(id) + '">'
    + '<i data-lucide="info" aria-hidden="true"></i>'
    + '</button>'
    + '<span id="' + esc(id) + '" class="notification-template-help__tooltip" role="tooltip">'
    + esc(t('settings.notificationChannelTemplateHelp'))
    + '</span>'
    + '</span>';
}

async function copyTemplateText(value) {
  const text = String(value ?? '');
  if (!text) return false;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* insecure context/permission: try the legacy fallback below */ }
  }
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.insetInlineStart = '-9999px';
  document.body.appendChild(helper);
  helper.select();
  try {
    return document.execCommand('copy');
  } finally {
    helper.remove();
  }
}

function templateCopyButton() {
  const label = t('settings.notificationChannelTemplateCopy');
  return '<button type="button" class="btn btn--secondary notification-template-copy"'
    + ' data-action="copy-template" aria-label="' + esc(label) + '" title="' + esc(label) + '"'
    + '><i data-lucide="copy" aria-hidden="true"></i><span>' + esc(label) + '</span></button>';
}

function renderChannelList(container, channels, providers = DEFAULT_PROVIDERS, scope = 'household') {
  const list = container.querySelector('#notification-channel-list-' + scope);
  if (!list) return;
  list.replaceChildren();
  const availableProviders = scope === 'user'
    ? providers.filter((provider) => ['webhook', 'message_pusher'].includes(provider.id))
    : providers;
  if (!channels.length) {
    const emptyKey = scope === 'user'
      ? 'settings.notificationChannelPersonalEmpty'
      : 'settings.notificationChannelEmpty';
    list.insertAdjacentHTML('beforeend', `<p class="form-hint">${t(emptyKey)}</p>`);
    return;
  }
  channels.forEach((rawChannel, index) => {
    const channel = { ...channelDefaults(rawChannel.provider, scope), ...rawChannel, config: { ...channelDefaults(rawChannel.provider, scope).config, ...(rawChannel.config || {}) } };
    const suffix = channel.id ? `existing-${channel.id}` : `new-${index}`;
    const isNtfy = channel.provider === 'ntfy';
    const isWebhook = channel.provider === 'webhook';
    const isMessagePusher = channel.provider === 'message_pusher';
    const webhookExample = templateExample('webhook', scope);
    const messagePusherExample = templateExample('message_pusher', scope);
    list.insertAdjacentHTML('beforeend', `
      <form class="settings-card settings-form notification-channel-form" data-channel-index="${index}" data-channel-scope="${scope}" data-channel-id="${esc(channel.id ?? '')}">
        <h3 class="settings-card__title">${esc(channel.name || t('settings.notificationChannelAdd'))}</h3>
        <div class="form-field">
          <label class="form-label" for="notification-provider-${suffix}">${t('settings.notificationChannelProvider')}</label>
          <select class="form-input" id="notification-provider-${suffix}" name="provider">
            ${providerOptions(availableProviders, channel.provider)}
          </select>
        </div>
        <div class="form-field">
          <label class="form-label" for="notification-name-${suffix}">${t('settings.notificationChannelName')}</label>
          <input class="form-input" id="notification-name-${suffix}" name="name" value="${esc(channel.name)}" required>
        </div>
        ${toggleRowHtml({
          label: t('settings.notificationChannelEnabled'),
          checked: !!channel.enabled,
          attrs: { name: 'enabled' },
        })}
        <div class="form-field">
          <label class="form-label" for="notification-base-url-${suffix}">${t('settings.notificationChannelBaseUrl')}</label>
          <input class="form-input" id="notification-base-url-${suffix}" name="baseUrl" value="${esc(channel.config.baseUrl)}" required>
        </div>
        <div class="notification-provider-fields notification-provider-fields--gotify${channel.provider === 'gotify' ? '' : ' settings-card--hidden'}">
          <div class="form-field">
            <label class="form-label" for="notification-gotify-token-${suffix}">${t('settings.notificationChannelGotifyToken')}</label>
            <input class="form-input" id="notification-gotify-token-${suffix}" name="gotifyToken" type="password" autocomplete="new-password" placeholder="${channel.secretSet ? esc(t('settings.notificationChannelSecretKeep')) : ''}">
          </div>
          <div class="form-field">
            <label class="form-label" for="notification-gotify-priority-${suffix}">${t('settings.notificationChannelGotifyPriority')}</label>
            <input class="form-input" id="notification-gotify-priority-${suffix}" name="gotifyPriority" type="number" min="1" max="10" value="${esc(channel.config.priority ?? 5)}">
          </div>
        </div>
        <div class="notification-provider-fields notification-provider-fields--webhook${isWebhook ? '' : ' settings-card--hidden'}">
          <div class="form-field">
            <label class="form-label" for="notification-webhook-token-${suffix}">${t('settings.notificationChannelWebhookToken')}</label>
            <input class="form-input" id="notification-webhook-token-${suffix}" name="webhookToken" type="password" autocomplete="new-password" placeholder="${channel.secretSet ? esc(t('settings.notificationChannelSecretKeep')) : ''}">
          </div>
          <div class="form-field">
            <div class="notification-template-label">
              <label class="form-label" for="notification-webhook-template-${suffix}">${t('settings.notificationChannelWebhookTemplate')}</label>
              ${templateHelp('notification-webhook-template-help-' + suffix)}
            </div>
            <div class="notification-template-input">
              <textarea class="form-input" id="notification-webhook-template-${suffix}" name="webhookTemplate" rows="3" spellcheck="false" placeholder="${esc(webhookExample)}">${esc(channel.config.payloadTemplate ?? '')}</textarea>
              ${templateCopyButton()}
            </div>
            <p class="form-hint">${t('settings.notificationChannelTemplateHint')}</p>
          </div>
        </div>
        <div class="notification-provider-fields notification-provider-fields--message-pusher${isMessagePusher ? '' : ' settings-card--hidden'}">
          <div class="form-field">
            <label class="form-label" for="notification-message-pusher-username-${suffix}">${t('settings.notificationChannelMessagePusherUsername')}</label>
            <input class="form-input" id="notification-message-pusher-username-${suffix}" name="messagePusherUsername" value="${esc(channel.config.username ?? '')}">
          </div>
          <div class="form-field">
            <label class="form-label" for="notification-message-pusher-method-${suffix}">${t('settings.notificationChannelMessagePusherMethod')}</label>
            <select class="form-input" id="notification-message-pusher-method-${suffix}" name="messagePusherMethod">
              <option value="POST"${selected(channel.config.method ?? 'POST', 'POST')}>POST</option>
              <option value="GET"${selected(channel.config.method ?? 'POST', 'GET')}>GET</option>
            </select>
          </div>
          <div class="form-field">
            <label class="form-label" for="notification-message-pusher-format-${suffix}">${t('settings.notificationChannelMessagePusherFormat')}</label>
            <select class="form-input" id="notification-message-pusher-format-${suffix}" name="messagePusherFormat">
              <option value="json"${selected(channel.config.postFormat ?? 'json', 'json')}>JSON</option>
              <option value="form"${selected(channel.config.postFormat ?? 'json', 'form')}>Form</option>
            </select>
          </div>
          <div class="form-field">
            <label class="form-label" for="notification-message-pusher-channel-${suffix}">${t('settings.notificationChannelMessagePusherChannel')}</label>
            <input class="form-input" id="notification-message-pusher-channel-${suffix}" name="messagePusherChannel" value="${esc(channel.config.channel ?? '')}">
          </div>
          <div class="form-field">
            <label class="form-label" for="notification-message-pusher-field-${suffix}">${t('settings.notificationChannelMessagePusherField')}</label>
            <select class="form-input" id="notification-message-pusher-field-${suffix}" name="messagePusherField">
              <option value="content"${selected(channel.config.messageField ?? 'content', 'content')}>${t('settings.notificationChannelMessagePusherContent')}</option>
              <option value="description"${selected(channel.config.messageField ?? 'content', 'description')}>${t('settings.notificationChannelMessagePusherDescription')}</option>
            </select>
          </div>
          <div class="form-field">
            <div class="notification-template-label">
              <label class="form-label" for="notification-message-pusher-template-${suffix}">${t('settings.notificationChannelMessagePusherTemplate')}</label>
              ${templateHelp('notification-message-pusher-template-help-' + suffix)}
            </div>
            <div class="notification-template-input">
              <textarea class="form-input" id="notification-message-pusher-template-${suffix}" name="messagePusherTemplate" rows="3" spellcheck="false" placeholder="${esc(messagePusherExample)}">${esc(channel.config.messageTemplate ?? '')}</textarea>
              ${templateCopyButton()}
            </div>
            <p class="form-hint">${t('settings.notificationChannelMessagePusherTemplateHint')}</p>
          </div>
          <div class="form-field">
            <label class="form-label" for="notification-message-pusher-token-${suffix}">${t('settings.notificationChannelWebhookToken')}</label>
            <input class="form-input" id="notification-message-pusher-token-${suffix}" name="messagePusherToken" type="password" autocomplete="new-password" placeholder="${channel.secretSet ? esc(t('settings.notificationChannelSecretKeep')) : ''}">
          </div>
          <label class="form-checkbox">
            <input type="checkbox" name="messagePusherTokenQuery"${channel.config.tokenInQuery ? ' checked' : ''}>
            <span>${t('settings.notificationChannelMessagePusherTokenQuery')}</span>
          </label>
          <p class="form-hint">${t('settings.notificationChannelMessagePusherHint')}</p>
        </div>
        <div class="notification-provider-fields notification-provider-fields--ntfy${isNtfy ? '' : ' settings-card--hidden'}">
          <div class="form-field">
            <label class="form-label" for="notification-ntfy-topic-${suffix}">${t('settings.notificationChannelNtfyTopic')}</label>
            <input class="form-input" id="notification-ntfy-topic-${suffix}" name="ntfyTopic" value="${esc(channel.config.topic ?? '')}">
          </div>
          <div class="form-field">
            <label class="form-label" for="notification-ntfy-priority-${suffix}">${t('settings.notificationChannelNtfyPriority')}</label>
            <select class="form-input" id="notification-ntfy-priority-${suffix}" name="ntfyPriority">
              ${['min', 'low', 'default', 'high', 'urgent'].map((priority) => `<option value="${priority}"${selected(channel.config.priority ?? 'default', priority)}>${priority}</option>`).join('')}
            </select>
          </div>
          <div class="form-field">
            <label class="form-label" for="notification-ntfy-auth-${suffix}">${t('settings.notificationChannelNtfyAuth')}</label>
            <select class="form-input" id="notification-ntfy-auth-${suffix}" name="ntfyAuth">
              <option value="none"${selected(channel.config.authType ?? 'none', 'none')}>${t('settings.notificationChannelNtfyAuthNone')}</option>
              <option value="token"${selected(channel.config.authType ?? 'none', 'token')}>${t('settings.notificationChannelNtfyAuthToken')}</option>
              <option value="basic"${selected(channel.config.authType ?? 'none', 'basic')}>${t('settings.notificationChannelNtfyAuthBasic')}</option>
            </select>
          </div>
          <div class="form-field notification-ntfy-token-field${channel.config.authType === 'token' ? '' : ' settings-card--hidden'}">
            <label class="form-label" for="notification-ntfy-token-${suffix}">${t('settings.notificationChannelNtfyToken')}</label>
            <input class="form-input" id="notification-ntfy-token-${suffix}" name="ntfyToken" type="password" autocomplete="new-password" placeholder="${channel.secretSet ? esc(t('settings.notificationChannelSecretKeep')) : ''}">
          </div>
          <div class="form-field notification-ntfy-basic-field${channel.config.authType === 'basic' ? '' : ' settings-card--hidden'}">
            <label class="form-label" for="notification-ntfy-username-${suffix}">${t('settings.notificationChannelNtfyUsername')}</label>
            <input class="form-input" id="notification-ntfy-username-${suffix}" name="ntfyUsername" autocomplete="username">
          </div>
          <div class="form-field notification-ntfy-basic-field${channel.config.authType === 'basic' ? '' : ' settings-card--hidden'}">
            <label class="form-label" for="notification-ntfy-password-${suffix}">${t('settings.notificationChannelNtfyPassword')}</label>
            <input class="form-input" id="notification-ntfy-password-${suffix}" name="ntfyPassword" type="password" autocomplete="new-password" placeholder="${channel.secretSet ? esc(t('settings.notificationChannelSecretKeep')) : ''}">
          </div>
        </div>
        <div class="settings-form-actions">
          <button type="submit" class="btn btn--primary">${t('settings.notificationChannelSave')}</button>
          ${channel.id ? `<button type="button" class="btn btn--secondary" data-action="test">${t('settings.notificationChannelTest')}</button>` : ''}
          ${channel.id ? `<button type="button" class="btn btn--danger" data-action="delete">${t('settings.notificationChannelDelete')}</button>` : ''}
        </div>
      </form>
    `);
  });
  window.lucide?.createIcons({ el: list });
}

function readChannelForm(form) {
  const provider = form.elements.provider.value;
  const body = {
    provider,
    name: form.elements.name.value.trim(),
    enabled: form.elements.enabled.checked,
    scope: form.dataset.channelScope || 'household',
    config: {
      baseUrl: form.elements.baseUrl.value.trim(),
    },
    secrets: {},
  };
  if (provider === 'ntfy') {
    body.config.topic = form.elements.ntfyTopic.value.trim();
    body.config.priority = form.elements.ntfyPriority.value;
    body.config.authType = form.elements.ntfyAuth.value;
    if (body.config.authType === 'token' && form.elements.ntfyToken.value) {
      body.secrets.token = form.elements.ntfyToken.value;
    }
    if (body.config.authType === 'basic') {
      if (form.elements.ntfyUsername.value) body.secrets.username = form.elements.ntfyUsername.value;
      if (form.elements.ntfyPassword.value) body.secrets.password = form.elements.ntfyPassword.value;
    }
  } else if (provider === 'webhook') {
    body.config.payloadTemplate = form.elements.webhookTemplate.value.trim();
    if (form.elements.webhookToken.value) body.secrets.token = form.elements.webhookToken.value;
  } else if (provider === 'message_pusher') {
    body.config.username = form.elements.messagePusherUsername.value.trim();
    body.config.method = form.elements.messagePusherMethod.value;
    body.config.postFormat = form.elements.messagePusherFormat.value;
    body.config.channel = form.elements.messagePusherChannel.value.trim();
    body.config.messageField = form.elements.messagePusherField.value;
    body.config.messageTemplate = form.elements.messagePusherTemplate.value.trim();
    body.config.tokenInQuery = form.elements.messagePusherTokenQuery.checked;
    if (form.elements.messagePusherToken.value) body.secrets.token = form.elements.messagePusherToken.value;
  } else {
    body.config.priority = Number(form.elements.gotifyPriority.value || 5);
    if (form.elements.gotifyToken.value) body.secrets.appToken = form.elements.gotifyToken.value;
  }
  if (!Object.keys(body.secrets).length) delete body.secrets;
  return body;
}

function updateProviderVisibility(form) {
  const provider = form.elements.provider.value;
  form.querySelector('.notification-provider-fields--gotify')?.classList.toggle('settings-card--hidden', provider !== 'gotify');
  form.querySelector('.notification-provider-fields--ntfy')?.classList.toggle('settings-card--hidden', provider !== 'ntfy');
  form.querySelector('.notification-provider-fields--webhook')?.classList.toggle('settings-card--hidden', provider !== 'webhook');
  form.querySelector('.notification-provider-fields--message-pusher')?.classList.toggle('settings-card--hidden', provider !== 'message_pusher');
  const auth = form.elements.ntfyAuth?.value || 'none';
  form.querySelector('.notification-ntfy-token-field')?.classList.toggle('settings-card--hidden', auth !== 'token');
  form.querySelectorAll('.notification-ntfy-basic-field').forEach((field) => {
    field.classList.toggle('settings-card--hidden', auth !== 'basic');
  });
  const scope = form.dataset.channelScope || 'household';
  if (form.elements.webhookTemplate) {
    form.elements.webhookTemplate.placeholder = templateExample('webhook', scope);
  }
  if (form.elements.messagePusherTemplate) {
    form.elements.messagePusherTemplate.placeholder = templateExample('message_pusher', scope);
  }
}

function renderChannelLists(container, channelGroups, providers) {
  renderChannelList(container, channelGroups.user, providers, 'user');
  if (container.querySelector('#notification-channel-list-household')) {
    renderChannelList(container, channelGroups.household, providers, 'household');
  }
}

async function setupChannelControls(container) {
  const status = container.querySelector('#notification-channel-status');
  const channelGroups = { user: [], household: [] };
  let providers = DEFAULT_PROVIDERS;
  const setStatus = (message) => { if (status) status.textContent = message; };
  const reload = async () => {
    const [providerResponse, channelResponse] = await Promise.all([
      notifications.providers(),
      notifications.listChannels(),
    ]);
    providers = providerResponse.data || DEFAULT_PROVIDERS;
    const channels = channelResponse.data || [];
    channelGroups.user = channels.filter((channel) => channel.scope === 'user');
    channelGroups.household = channels.filter((channel) => channel.scope === 'household');
    renderChannelLists(container, channelGroups, providers);
  };

  container.querySelectorAll('[data-notification-channel-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const scope = button.dataset.notificationChannelAdd === 'user' ? 'user' : 'household';
      channelGroups[scope] = [
        ...channelGroups[scope],
        channelDefaults(scope === 'user' ? 'webhook' : 'gotify', scope),
      ];
      renderChannelLists(container, channelGroups, providers);
    });
  });

  container.addEventListener('change', (event) => {
    const form = event.target.closest?.('.notification-channel-form');
    if (!form) return;
    if (event.target.name === 'provider') {
      const index = Number(form.dataset.channelIndex);
      const scope = form.dataset.channelScope || 'household';
      if (!form.dataset.channelId) {
        channelGroups[scope][index] = channelDefaults(event.target.value, scope);
      }
    }
    updateProviderVisibility(form);
  });

  container.addEventListener('submit', async (event) => {
    const form = event.target.closest?.('.notification-channel-form');
    if (!form) return;
    event.preventDefault();
    const id = form.dataset.channelId;
    try {
      const body = readChannelForm(form);
      if (id) await notifications.updateChannel(id, body);
      else await notifications.createChannel(body);
      setStatus(t('settings.notificationChannelSaved'));
      await reload();
    } catch {
      setStatus(t('settings.notificationChannelError'));
    }
  });

  container.addEventListener('click', async (event) => {
    const button = event.target.closest?.('button[data-action]');
    if (!button) return;
    const form = button.closest('.notification-channel-form');
    if (button.dataset.action === 'copy-template') {
      const textarea = button.closest('.notification-template-input')?.querySelector('textarea');
      const value = textarea?.value || textarea?.placeholder || '';
      try {
        if (!await copyTemplateText(value)) throw new Error('clipboard unavailable');
        setStatus(t('settings.notificationChannelTemplateCopied'));
      } catch {
        setStatus(t('settings.notificationChannelTemplateCopyFailed'));
      }
      return;
    }
    const id = form?.dataset.channelId;
    if (!id) return;
    if (button.dataset.action === 'test') {
      button.disabled = true;
      try {
        await notifications.testChannel(id);
        setStatus(t('settings.notificationChannelTestSent'));
      } catch {
        setStatus(t('settings.notificationChannelError'));
      } finally {
        button.disabled = false;
      }
    }
    if (button.dataset.action === 'delete') {
      const confirmed = await confirmModal(t('settings.notificationChannelDeleteConfirm'), {
        confirmLabel: t('settings.notificationChannelDelete'),
        danger: true,
        detail: t('settings.notificationChannelDeleteConfirmDetail'),
      });
      if (!confirmed) return;
      try {
        await notifications.deleteChannel(id);
        setStatus(t('settings.notificationChannelDeleted'));
        await reload();
      } catch {
        setStatus(t('settings.notificationChannelError'));
      }
    }
  });

  try {
    await reload();
  } catch {
    setStatus(t('settings.notificationChannelError'));
  }
}

export async function render(container, { user } = {}) {
  try {
    renderPage(container, user);
    window.lucide?.createIcons({ el: container });
    await setupChannelControls(container);

    const toggle  = container.querySelector('#push-toggle');
    const status  = container.querySelector('#push-status');
    const testBtn = container.querySelector('#push-test-btn');
    const iosHint = container.querySelector('#push-ios-hint');

    // getPwaInstallState().ios ist nur true, wenn iOS/iPadOS *und* nicht
    // installiert. Genau dann liefert iOS keinen Web Push aus.
    const iosNotInstalled = getPwaInstallState().ios;
    if (iosNotInstalled) iosHint.hidden = false;

    if (!pushSupported()) {
      status.textContent = iosNotInstalled
        ? t('settings.pushIosNotInstalled')
        : t('settings.pushUnsupported');
      return;
    }

    const applyState = (st) => {
      toggle.checked = st.subscribed;
      toggle.disabled = st.permission === 'denied';
      testBtn.disabled = !st.subscribed;
      if (st.permission === 'denied') status.textContent = t('settings.pushDenied');
      else status.textContent = st.subscribed ? t('settings.pushEnabled') : t('settings.pushDisabled');
    };

    applyState(await pushStatus());

    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        const st = toggle.checked ? await enablePush() : await disablePush();
        applyState({ ...await pushStatus(), ...st });
      } catch {
        status.textContent = t('settings.pushError');
        applyState(await pushStatus());
      }
    });

    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      try {
        const sendTest = () => api.post('/push/test', {
          title: t('settings.pushTestTitle'),
          body: t('settings.pushTestBody'),
        });

        // sent === 0 heisst: nichts zugestellt. Ohne diese Unterscheidung meldet
        // der Button Erfolg, obwohl kein Geraet erreicht wurde.
        let res = await sendTest();
        let sent = Number(res?.data?.sent) || 0;
        let devices = Number(res?.data?.devices) || 0;

        if (sent === 0) {
          // Selbstheilung: Der Browser haelt das Abo fuer aktiv, der Server kennt
          // es nicht (mehr). Einmal neu registrieren und genau einmal erneut senden.
          let repaired = false;
          try { repaired = await repairPush(); } catch { repaired = false; }
          if (repaired) {
            res = await sendTest();
            sent = Number(res?.data?.sent) || 0;
            devices = Number(res?.data?.devices) || 0;
          }
        }

        if (sent > 0) status.textContent = t('settings.pushTestSent');
        else if (devices > 0) status.textContent = t('settings.pushTestFailed');
        else status.textContent = t('settings.pushTestNoDevice');
      } catch {
        status.textContent = t('settings.pushError');
      } finally {
        testBtn.disabled = false;
      }
    });
  } catch (error) {
    container.replaceChildren();
    throw error;
  }
}
