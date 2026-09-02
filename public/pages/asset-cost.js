import { api } from '/api.js';
import { getLocale, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import {
  openModal,
  closeModal,
  confirmModal,
} from '/components/modal.js';
import {
  renderUserMultiSelect,
  getSelectedUserIds,
  bindUserMultiSelect,
} from '/components/user-multi-select.js';
import { attachOverlay } from '/utils/overlay-history.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENCY_SYMBOLS = { CNY: '¥', EUR: '€', USD: '$' };
const ASSET_COST_METRICS = new Set(['current', 'target']);
const ASSET_SUMMARY_THEMES = new Set(['aurora', 'ocean', 'sunset', 'neutral']);
const IMAGE_SOURCE_ORDER = ['google', 'duckduckgo', 'brave', 'openverse'];
const IMAGE_SOURCE_LABEL_KEYS = {
  google: 'imageSearchProviderGoogle',
  duckduckgo: 'imageSearchProviderDuckDuckGo',
  brave: 'imageSearchProviderBrave',
  openverse: 'imageSearchProviderOpenverse',
};
const SORTS = [
  ['cost-desc', 'sortCostDesc'],
  ['cost-asc', 'sortCostAsc'],
  ['price-desc', 'sortPriceDesc'],
  ['days-desc', 'sortDaysDesc'],
  ['purchase-desc', 'sortPurchaseDesc'],
];

const state = {
  items: [],
  categories: [],
  householdCurrency: 'EUR',
  summaryCurrency: 'EUR',
  query: '',
  category: 'all',
  status: 'all',
  scope: 'all',
  sort: 'cost-desc',
  container: null,
  body: null,
  text: {},
  members: [],
  currentUser: null,
  assetDefaultScope: 'personal',
  assetDefaultVisibility: 'private',
  assetDefaultAssigneeIds: [],
  metric: 'current',
  summaryTheme: 'aurora',
};

function tr(key, vars = {}) {
  let value = state.text[key] || key;
  for (const [name, replacement] of Object.entries(vars)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

async function loadLocale() {
  const locale = String(getLocale?.() || document.documentElement.lang || 'zh-CN');
  const file = locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  try {
    const response = await fetch(`/asset-cost-locales/${file}.json`, {
      cache: 'no-store',
    });
    if (response.ok) state.text = await response.json();
  } catch {
    // The page remains usable with translation keys if a module asset is
    // temporarily unavailable during a live module reload.
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dateToUtc(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return null;
  const [year, month, day] = String(key).split('-').map(Number);
  const value = Date.UTC(year, month - 1, day);
  const check = new Date(value);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return value;
}

function daysBetween(start, end) {
  const first = dateToUtc(start);
  const last = dateToUtc(end);
  if (first == null || last == null) return null;
  return Math.max(1, Math.floor((last - first) / DAY_MS));
}

function currencyCode(item) {
  return String(item.currency || state.householdCurrency || 'EUR').toUpperCase();
}

function formatMoney(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const amount = Number(value);
  const code = String(currency || state.householdCurrency || 'EUR').toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const formatted = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return symbol ? `${symbol}${formatted}` : `${formatted} ${code}`;
}

function categoryName(category) {
  return category?.label_key ? t(category.label_key) : (category?.name || category?.key || tr('unknownCategory'));
}

function statusGroup(status) {
  if (status === 'active') return 'active';
  if (status === 'sold') return 'sold';
  return 'retired';
}

function statusLabel(status) {
  if (status === 'active') return tr('activeStatus');
  if (status === 'sold') return tr('soldStatus');
  if (status === 'lost') return tr('lostStatus');
  return tr('retiredStatus');
}

function derive(item) {
  const status = String(item.status || 'active');
  const endDate = status === 'sold'
    ? (item.sold_date || todayKey())
    : status === 'active'
      ? todayKey()
      : (item.retired_date || todayKey());
  const daysUsed = daysBetween(item.purchase_date, endDate);
  const purchasePrice = item.purchase_price == null ? null : Number(item.purchase_price);
  const soldPrice = item.sold_price == null ? 0 : Number(item.sold_price);
  const netCost = status === 'sold' && purchasePrice != null ? purchasePrice - soldPrice : purchasePrice;
  const costPerDay = netCost != null && daysUsed ? netCost / daysUsed : null;
  const targetDays = item.target_days == null ? null : Number(item.target_days);
  const targetCostPerDay = netCost != null && targetDays > 0 ? netCost / targetDays : null;
  const progress = targetDays > 0 && daysUsed != null ? Math.min(1, daysUsed / targetDays) : null;
  return {
    ...item,
    status,
    statusGroup: statusGroup(status),
    endDate,
    daysUsed,
    purchasePrice,
    soldPrice,
    netCost,
    costPerDay,
    targetCostPerDay,
    displayCost: state.metric === 'target' ? targetCostPerDay : costPerDay,
    targetDays,
    progress,
  };
}

function allCategories() {
  return [{ key: 'all', name: tr('all') }, ...state.categories];
}

function availableCurrencies(items) {
  const currencies = [...new Set(items.map(currencyCode))].filter(Boolean);
  return currencies.sort((a, b) => a.localeCompare(b));
}

function currentItems() {
  const query = state.query.trim().toLocaleLowerCase();
  const result = state.items.map(derive).filter((item) => {
    if (state.category !== 'all' && item.category !== state.category) return false;
    if (state.status !== 'all' && item.statusGroup !== state.status) return false;
    if (state.scope !== 'all' && item.asset_scope !== state.scope) return false;
    if (!query) return true;
    return [item.name, item.brand, item.model, item.serial_number]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(query));
  });

  const compareNullable = (a, b, direction = -1) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (a - b) * direction;
  };
  result.sort((a, b) => {
    const nameCompare = String(a.name || '').localeCompare(String(b.name || ''));
    if (state.sort === 'cost-desc') return compareNullable(a.displayCost, b.displayCost, -1) || nameCompare;
    if (state.sort === 'cost-asc') return compareNullable(a.displayCost, b.displayCost, 1) || nameCompare;
    if (state.sort === 'price-desc') return compareNullable(a.purchasePrice, b.purchasePrice, -1) || nameCompare;
    if (state.sort === 'days-desc') return compareNullable(a.daysUsed, b.daysUsed, -1) || nameCompare;
    return String(b.purchase_date || '').localeCompare(String(a.purchase_date || '')) || nameCompare;
  });
  return result;
}

function imageHtml(item) {
  if (item.photo_data) {
    return `<img class="asset-cost-card__image" src="${esc(item.photo_data)}" alt="">`;
  }
  return '<span class="asset-cost-card__image-fallback"><i data-lucide="image" aria-hidden="true"></i></span>';
}

function metricLabel(metric = state.metric) {
  return metric === 'target' ? tr('targetDailyCost') : tr('currentDailyCost');
}

function cardHtml(item) {
  const dailyValue = item.displayCost == null && state.metric === 'target' && item.targetDays == null
    ? tr('noTargetCost') : formatMoney(item.displayCost, currencyCode(item));
  const goal = item.progress == null ? '' : `
    <div class="asset-cost-card__goal">
      <div class="asset-cost-card__progress" data-progress="${item.progress * 100}"><span></span></div>
      <span>${esc(item.progress >= 1 ? tr('goalReached') : tr('daysRemaining', { days: Math.max(0, item.targetDays - (item.daysUsed || 0)) }))}</span>
    </div>`;
  return `
    <article class="asset-cost-card" data-edit-id="${item.id}" tabindex="0">
      <div class="asset-cost-card__visual">
        ${imageHtml(item)}
        <span class="asset-cost-status asset-cost-status--${esc(item.statusGroup)}">${esc(statusLabel(item.status))}</span>
        ${item.can_delete ? `<button type="button" class="asset-cost-card__delete" data-delete-id="${item.id}" aria-label="${esc(tr('delete'))}">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>` : ''}
      </div>
      <h3 class="asset-cost-card__name">${esc(item.name)}</h3>
      <div class="asset-cost-card__meta">
        <span>${esc(formatMoney(item.purchasePrice, currencyCode(item)))}</span>
        <span>${item.daysUsed == null ? '—' : `${item.daysUsed} ${esc(tr('days'))}`}</span>
      </div>
      <div class="asset-cost-card__daily">${esc(dailyValue)}<small>${esc(tr('perDay'))}</small><em>${esc(metricLabel())}</em></div>
      ${goal}
    </article>`;
}

function summaryHtml(items) {
  const currency = state.summaryCurrency;
  const currencyItems = items.filter((item) => currencyCode(item) === currency);
  const totalPrice = currencyItems.reduce((sum, item) => sum + (item.purchasePrice ?? 0), 0);
  const metricItems = currencyItems.filter((item) => item.displayCost != null);
  const dailyCost = metricItems.reduce((sum, item) => sum + item.displayCost, 0);
  const summaryCost = state.metric === 'target' && !metricItems.length ? null : dailyCost;
  const active = items.filter((item) => item.statusGroup === 'active').length;
  const retired = items.filter((item) => item.statusGroup === 'retired').length;
  const sold = items.filter((item) => item.statusGroup === 'sold').length;
  const total = active + retired + sold;
  const stats = [
    ['active', active, 'asset-cost-summary__bar--active'],
    ['retired', retired, 'asset-cost-summary__bar--retired'],
    ['sold', sold, 'asset-cost-summary__bar--sold'],
  ];
  return `
    <section class="asset-cost-summary asset-cost-summary--${state.summaryTheme}" aria-label="${esc(tr('overview'))}">
      <div class="asset-cost-summary__heading">
        <div class="asset-cost-summary__heading-title"><h2>${esc(tr('overview'))}</h2><span>${items.length}/${state.items.length}</span></div>
        <div class="asset-cost-summary__actions">
          <div class="asset-cost-metric-toggle" role="group" aria-label="${esc(tr('costMetric'))}">
            <button type="button" class="${state.metric === 'current' ? 'is-selected' : ''}" data-cost-metric="current">${esc(tr('currentMetric'))}</button>
            <button type="button" class="${state.metric === 'target' ? 'is-selected' : ''}" data-cost-metric="target">${esc(tr('targetMetric'))}</button>
          </div>
          <button type="button" class="asset-cost-theme-toggle" data-summary-theme-toggle aria-expanded="false" aria-label="${esc(tr('summaryTheme'))}"><i data-lucide="palette" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="asset-cost-theme-menu" data-summary-theme-menu hidden>
        ${[
          ['aurora', 'themeAurora'],
          ['ocean', 'themeOcean'],
          ['sunset', 'themeSunset'],
          ['neutral', 'themeNeutral'],
        ].map(([value, label]) => `<button type="button" class="${state.summaryTheme === value ? 'is-selected' : ''}" data-theme-choice="${value}">${esc(tr(label))}</button>`).join('')}
      </div>
      <div class="asset-cost-summary__metrics">
        <div><span>${esc(tr('totalAssets'))}</span><strong>${esc(formatMoney(totalPrice, currency))}</strong></div>
        <div><span>${esc(metricLabel(state.metric))}</span><strong>${esc(formatMoney(summaryCost, currency))}</strong></div>
      </div>
      <div class="asset-cost-summary__status">
        ${stats.map(([key, count, className]) => `
          <div class="asset-cost-summary__status-item">
            <span>${esc(tr(key))} <b>${count}</b></span>
            <div class="asset-cost-summary__bar ${className}" data-count="${count}" data-total="${total}"><span></span></div>
          </div>`).join('')}
      </div>
      <p class="asset-cost-summary__currency">${esc(tr('currency'))}: ${esc(currency)} · ${esc(tr('currencyHint'))}</p>
    </section>`;
}

function controlsHtml(items) {
  const currencies = availableCurrencies(items);
  const selectedCategory = state.category;
  const canManageCategories = state.currentUser?.role === 'admin';
  return `
    <div class="asset-cost-categories-row">
      <div class="asset-cost-categories" role="tablist" aria-label="${esc(tr('categories'))}">
        ${allCategories().map((category) => `
          <button type="button" role="tab" aria-selected="${selectedCategory === category.key}" class="asset-cost-category ${selectedCategory === category.key ? 'is-selected' : ''}" data-category="${esc(category.key)}">
            ${esc(categoryName(category))}</button>`).join('')}
      </div>
      ${canManageCategories ? `<button type="button" class="asset-cost-category asset-cost-category--manage" data-manage-categories><i data-lucide="settings-2" aria-hidden="true"></i>${esc(tr('manageCategories'))}</button>` : ''}
    </div>
    <div class="asset-cost-controls">
      <div class="asset-cost-status-filter" role="group" aria-label="${esc(tr('status'))}">
        ${[['all', 'allScopes'], ['family', 'familyAssets'], ['personal', 'personalAssets']].map(([value, label]) => `
          <button type="button" class="asset-cost-filter ${state.scope === value ? 'is-selected' : ''}" data-scope="${value}">${esc(tr(label))}</button>`).join('')}
      </div>
      <div class="asset-cost-status-filter" role="group" aria-label="${esc(tr('status'))}">
        ${[['all', 'all'], ['active', 'active'], ['retired', 'retired'], ['sold', 'sold']].map(([value, label]) => `
          <button type="button" class="asset-cost-filter ${state.status === value ? 'is-selected' : ''}" data-status="${value}">${esc(tr(label))}</button>`).join('')}
      </div>
      <div class="asset-cost-controls__right">
        ${currencies.length > 1 ? `<label class="asset-cost-select-label"><span>${esc(tr('currency'))}</span><select data-summary-currency>${currencies.map((code) => `<option value="${esc(code)}" ${code === state.summaryCurrency ? 'selected' : ''}>${esc(code)}</option>`).join('')}</select></label>` : ''}
        <label class="asset-cost-select-label"><span>${esc(tr('sort'))}</span><select data-sort>${SORTS.map(([value, label]) => `<option value="${value}" ${value === state.sort ? 'selected' : ''}>${esc(tr(label))}</option>`).join('')}</select></label>
      </div>
    </div>`;
}

async function openCategoryManager() {
  if (state.currentUser?.role !== 'admin') return;
  await import('/components/category-manager.js');

  let changed = false;
  const onChanged = async () => {
    changed = true;
    try {
      const response = await api.get('/inventory/categories');
      state.categories = response.data || [];
      renderBody();
    } catch {
      // The manager displays the mutation error; keep the current page usable.
    }
  };
  let manager = null;
  openModal({
    title: t('inventory.manageCategories'),
    size: 'lg',
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    onSave: (panel) => {
      manager = panel.querySelector('yuvomi-category-manager');
      manager.addEventListener('category-manager-changed', onChanged);
      manager.configure({
        basePath: '/inventory/categories',
        groups: [{ key: '', labelKey: '', addLabelKey: 'inventory.addCategory' }],
        labelResolver: categoryName,
        titleKey: 'inventory.manageCategories',
        hintKey: 'inventory.manageCategoriesHint',
        addPlaceholderKey: 'inventory.addCategory',
        deleteDetailKey: 'inventory.categoryDeleteConfirmDetail',
        errorKeyMap: { category_protected: 'inventory.categoryOtherNotDeletable' },
      });
    },
    onClose: async () => {
      manager?.removeEventListener('category-manager-changed', onChanged);
      manager = null;
      if (changed) {
        await loadData();
        renderBody();
      }
    },
  });
}

function renderBody() {
  if (!state.body) return;
  const items = currentItems();
  state.body.replaceChildren();
  state.body.insertAdjacentHTML('beforeend', `
    ${summaryHtml(items)}
    ${controlsHtml(items)}
    <section class="asset-cost-grid" aria-live="polite">
      ${items.length ? items.map(cardHtml).join('') : `<p class="asset-cost-empty">${esc(state.items.length ? tr('noResults') : tr('empty'))}</p>`}
    </section>`);

  state.body.querySelectorAll('[data-progress]').forEach((bar) => {
    const value = Math.max(0, Math.min(100, Number(bar.dataset.progress) || 0));
    bar.querySelector('span').style.width = `${value}%`;
  });
  state.body.querySelectorAll('[data-count]').forEach((bar) => {
    const count = Number(bar.dataset.count) || 0;
    const total = Number(bar.dataset.total) || 0;
    bar.querySelector('span').style.width = `${total ? (count / total) * 100 : 0}%`;
  });
  if (window.lucide) window.lucide.createIcons({ el: state.body });
}

let preferenceWrite = Promise.resolve();

function saveAssetPreferences(values) {
  preferenceWrite = preferenceWrite
    .catch(() => {})
    .then(() => api.put('/preferences', values));
  return preferenceWrite;
}

function bindBody() {
  state.body.addEventListener('click', (event) => {
    const metric = event.target.closest('[data-cost-metric]');
    if (metric) {
      const next = metric.dataset.costMetric;
      if (!ASSET_COST_METRICS.has(next) || next === state.metric) return;
      const previous = state.metric;
      state.metric = next;
      renderBody();
      saveAssetPreferences({ asset_cost_metric: next }).catch(() => {
        state.metric = previous;
        renderBody();
        window.yuvomi?.showToast(tr('defaultsSaveFailed'), 'danger');
      });
      return;
    }
    const themeToggle = event.target.closest('[data-summary-theme-toggle]');
    if (themeToggle) {
      const menu = state.body.querySelector('[data-summary-theme-menu]');
      if (menu) {
        menu.hidden = !menu.hidden;
        themeToggle.setAttribute('aria-expanded', String(!menu.hidden));
      }
      return;
    }
    const themeChoice = event.target.closest('[data-theme-choice]');
    if (themeChoice) {
      const next = themeChoice.dataset.themeChoice;
      if (!ASSET_SUMMARY_THEMES.has(next) || next === state.summaryTheme) return;
      const previous = state.summaryTheme;
      state.summaryTheme = next;
      renderBody();
      saveAssetPreferences({ asset_summary_theme: next }).catch(() => {
        state.summaryTheme = previous;
        renderBody();
        window.yuvomi?.showToast(tr('defaultsSaveFailed'), 'danger');
      });
      return;
    }
    const manageCategories = event.target.closest('[data-manage-categories]');
    if (manageCategories) {
      event.stopPropagation();
      openCategoryManager();
      return;
    }
    const category = event.target.closest('[data-category]');
    if (category) {
      state.category = category.dataset.category;
      renderBody();
      return;
    }
    const status = event.target.closest('[data-status]');
    if (status) {
      state.status = status.dataset.status;
      renderBody();
      return;
    }
    const scope = event.target.closest('[data-scope]');
    if (scope) {
      state.scope = scope.dataset.scope;
      renderBody();
      return;
    }
    const deleteButton = event.target.closest('[data-delete-id]');
    if (deleteButton) {
      event.stopPropagation();
      const item = state.items.find((entry) => String(entry.id) === deleteButton.dataset.deleteId);
      if (item) removeAsset(item);
      return;
    }
    const card = event.target.closest('[data-edit-id]');
    if (card) {
      const item = state.items.find((entry) => String(entry.id) === card.dataset.editId);
      if (item) openAssetModal(item);
    }
  });
  state.body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('[data-edit-id]');
    if (!card || event.target.closest('button')) return;
    event.preventDefault();
    const item = state.items.find((entry) => String(entry.id) === card.dataset.editId);
    if (item) openAssetModal(item);
  });
  state.body.addEventListener('change', (event) => {
    if (event.target.matches('[data-sort]')) state.sort = event.target.value;
    if (event.target.matches('[data-summary-currency]')) state.summaryCurrency = event.target.value;
    renderBody();
  });
}

function categoryOptions(selected) {
  return state.categories.map((category) => `<option value="${esc(category.key)}" ${category.key === selected ? 'selected' : ''}>${esc(categoryName(category))}</option>`).join('');
}

function formContent(item) {
  const currentStatus = item?.status || 'active';
  const admin = state.currentUser?.role === 'admin';
  const preferredScope = admin && state.assetDefaultScope === 'family' ? 'family' : 'personal';
  const scope = item?.asset_scope || preferredScope;
  const visibility = item?.visibility || state.assetDefaultVisibility || (scope === 'family' ? 'all' : 'private');
  const selectedIds = item?.assigned_user_ids || item?.assigned_users?.map((user) => user.id) || state.assetDefaultAssigneeIds;
  const imageQuery = item?.name || '';
  return `
    <div class="asset-cost-form">
      ${item && !item.can_edit ? `<p class="asset-cost-readonly"><i data-lucide="eye" aria-hidden="true"></i>${esc(tr('sharedReadOnly'))}</p>` : ''}
      <div class="asset-cost-form__row">
        <div class="form-group"><label class="form-label" for="asset-cost-scope">${esc(tr('assetScope'))}</label><select id="asset-cost-scope" class="form-input" ${item || !admin ? 'disabled' : ''}>
          ${admin ? `<option value="family" ${scope === 'family' ? 'selected' : ''}>${esc(tr('familyAsset'))}</option>` : ''}
          <option value="personal" ${scope === 'personal' ? 'selected' : ''}>${esc(tr('personalAsset'))}</option>
        </select></div>
        <div class="form-group"><label class="form-label" for="asset-cost-visibility">${esc(tr('visibility'))}</label><select id="asset-cost-visibility" class="form-input">
          <option value="all" ${visibility === 'all' ? 'selected' : ''}>${esc(tr('visibilityAll'))}</option>
          <option value="assignees" ${visibility === 'assignees' ? 'selected' : ''}>${esc(tr('visibilitySelected'))}</option>
          <option value="private" ${visibility === 'private' ? 'selected' : ''}>${esc(tr('visibilityPrivate'))}</option>
        </select></div>
      </div>
      <div data-asset-assignees ${visibility === 'assignees' ? '' : 'hidden'}>
        ${renderUserMultiSelect(state.members, selectedIds, 'asset_assigned', 'common.visibility.assignees')}
      </div>
      <div class="asset-cost-form__name-row">
        <div class="form-group"><label class="form-label" for="asset-cost-name">${esc(tr('name'))}</label><input id="asset-cost-name" class="form-input" type="text" required value="${esc(imageQuery)}"></div>
        <button type="button" class="asset-cost-image-search-trigger btn btn--secondary" data-open-image-search ${imageQuery.trim() ? '' : 'disabled'} title="${esc(tr('searchImages'))}" aria-label="${esc(tr('searchImages'))}">
          <i data-lucide="search" aria-hidden="true"></i>
        </button>
      </div>
      <div class="asset-cost-form__photo">
        <button type="button" class="asset-cost-form__photo-preview" data-photo-preview aria-label="${esc(tr('choosePhoto'))}">
          ${item?.photo_data ? `<img src="${esc(item.photo_data)}" alt="">` : '<i data-lucide="image" aria-hidden="true"></i>'}
        </button>
        <div class="asset-cost-form__photo-actions">
          <input class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" data-photo-file>
          <button type="button" class="btn btn--secondary btn--sm" data-choose-photo>${esc(tr('choosePhoto'))}</button>
        </div>
      </div>
      <div class="asset-cost-form__row">
        <div class="form-group"><label class="form-label" for="asset-cost-category">${esc(tr('category'))}</label><select id="asset-cost-category" class="form-input">${categoryOptions(item?.category || state.categories[0]?.key || 'other')}</select></div>
        <div class="form-group"><label class="form-label" for="asset-cost-status">${esc(tr('statusField'))}</label><select id="asset-cost-status" class="form-input">
          <option value="active" ${currentStatus === 'active' ? 'selected' : ''}>${esc(tr('activeStatus'))}</option>
          <option value="disposed" ${currentStatus === 'disposed' ? 'selected' : ''}>${esc(tr('retiredStatus'))}</option>
          <option value="lost" ${currentStatus === 'lost' ? 'selected' : ''}>${esc(tr('lostStatus'))}</option>
          <option value="sold" ${currentStatus === 'sold' ? 'selected' : ''}>${esc(tr('soldStatus'))}</option>
        </select></div>
      </div>
      <div class="asset-cost-form__row">
        <div class="form-group"><label class="form-label" for="asset-cost-purchase-date">${esc(tr('purchaseDate'))}</label><yuvomi-datepicker id="asset-cost-purchase-date" type="date" required label="${esc(tr('purchaseDate'))}" value="${esc(item?.purchase_date || '')}"></yuvomi-datepicker></div>
        <div class="form-group"><label class="form-label" for="asset-cost-purchase-price">${esc(tr('purchasePrice'))}</label><input id="asset-cost-purchase-price" class="form-input" type="number" min="0" step="0.01" inputmode="decimal" required value="${item?.purchase_price == null ? '' : esc(item.purchase_price)}"></div>
      </div>
      <div class="asset-cost-form__row">
        <div class="form-group"><label class="form-label" for="asset-cost-currency">${esc(tr('currencyField'))}</label><input id="asset-cost-currency" class="form-input" type="text" maxlength="3" minlength="3" value="${esc(item?.currency || state.householdCurrency)}"></div>
        <div class="form-group"><label class="form-label" for="asset-cost-target-days">${esc(tr('targetDays'))}</label><input id="asset-cost-target-days" class="form-input" type="number" min="1" step="1" inputmode="numeric" placeholder="${esc(tr('targetDaysHint'))}" value="${item?.target_days == null ? '' : esc(item.target_days)}"></div>
      </div>
      <details class="asset-cost-form__advanced" ${item?.sold_date || item?.sold_price != null || item?.retired_date ? 'open' : ''}>
        <summary>${esc(tr('advanced'))}</summary>
        <div class="asset-cost-form__row"><div class="form-group"><label class="form-label" for="asset-cost-sold-date">${esc(tr('soldDate'))}</label><yuvomi-datepicker id="asset-cost-sold-date" type="date" label="${esc(tr('soldDate'))}" value="${esc(item?.sold_date || '')}"></yuvomi-datepicker></div>
        <div class="form-group"><label class="form-label" for="asset-cost-sold-price">${esc(tr('soldPrice'))}</label><input id="asset-cost-sold-price" class="form-input" type="number" min="0" step="0.01" inputmode="decimal" value="${item?.sold_price == null ? '' : esc(item.sold_price)}"></div></div>
        <div class="form-group"><label class="form-label" for="asset-cost-retired-date">${esc(tr('retiredDate'))}</label><yuvomi-datepicker id="asset-cost-retired-date" type="date" label="${esc(tr('retiredDate'))}" value="${esc(item?.retired_date || '')}"></yuvomi-datepicker></div>
      </details>
      <div class="form-group"><label class="form-label" for="asset-cost-notes">${esc(tr('notes'))}</label><textarea id="asset-cost-notes" class="form-input" rows="3">${esc(item?.notes || '')}</textarea></div>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(tr('cancel'))}</button>
        <button type="button" class="btn btn--primary" id="asset-cost-save">${esc(tr('save'))}</button>
      </div>
    </div>`;
}

function setFormPhoto(panel, photoData) {
  const preview = panel.querySelector('[data-photo-preview]');
  preview.replaceChildren();
  preview.insertAdjacentHTML('beforeend', photoData ? `<img src="${esc(photoData)}" alt="">` : '<i data-lucide="image" aria-hidden="true"></i>');
  if (window.lucide) window.lucide.createIcons({ el: preview });
}

async function cropFile(file) {
  const { pickCroppedImage } = await import('/utils/avatar-crop.js');
  return pickCroppedImage(file, {
    messageKeys: {
      dataTooLarge: 'inventory.photoTooLarge',
    },
  });
}

function imageSourceLabel(provider) {
  return tr(IMAGE_SOURCE_LABEL_KEYS[provider] || provider);
}

function normalizeImageSources(data) {
  if (Array.isArray(data?.sources)) {
    return data.sources
      .filter((source) => source && typeof source.provider === 'string')
      .map((source) => ({
        provider: source.provider,
        status: source.status || (source.results?.length ? 'ok' : 'empty'),
        results: Array.isArray(source.results) ? source.results : [],
      }));
  }
  if (data?.provider && Array.isArray(data.results)) {
    return [{ provider: data.provider, status: data.results.length ? 'ok' : 'empty', results: data.results }];
  }
  return [];
}

function orderedImageSources(sources) {
  return [...sources].sort((a, b) => {
    const left = IMAGE_SOURCE_ORDER.indexOf(a.provider);
    const right = IMAGE_SOURCE_ORDER.indexOf(b.provider);
    return (left === -1 ? IMAGE_SOURCE_ORDER.length : left) - (right === -1 ? IMAGE_SOURCE_ORDER.length : right);
  });
}

function flattenedImageResults(sources) {
  const results = [];
  const seen = new Set();
  for (const source of orderedImageSources(sources)) {
    for (const result of source.results) {
      const key = result.image_url || result.thumbnail_url || result.preview_url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(result);
    }
  }
  return results;
}

function renderImageSearchResults(dialog, sources, selectedProvider, { loading = false, error = false } = {}) {
  const tabs = dialog.querySelector('[data-image-search-sources]');
  const target = dialog.querySelector('[data-image-search-results]');
  const ordered = orderedImageSources(sources);
  tabs.replaceChildren();
  tabs.insertAdjacentHTML('beforeend', `
    <button type="button" class="asset-cost-image-search-dialog__source is-selected" data-image-search-source="all" role="tab" aria-selected="true">
      ${esc(tr('imageSearchAll'))}
    </button>
    ${ordered.map((source) => `
      <button type="button" class="asset-cost-image-search-dialog__source" data-image-search-source="${esc(source.provider)}" role="tab" aria-selected="false">
        ${esc(imageSourceLabel(source.provider))}${source.status === 'error' ? ` · ${esc(tr('imageSearchProviderErrorShort'))}` : ''}
      </button>`).join('')}`);

  tabs.querySelectorAll('[data-image-search-source]').forEach((button) => {
    const active = button.dataset.imageSearchSource === selectedProvider;
    button.classList.toggle('is-selected', active);
    button.setAttribute('aria-selected', String(active));
  });

  if (loading) {
    target.replaceChildren();
    target.insertAdjacentHTML('beforeend', `<p class="asset-cost-image-search-dialog__state">${esc(tr('searching'))}</p>`);
    target._assetResults = [];
    return;
  }

  const selected = selectedProvider === 'all'
    ? null
    : ordered.find((source) => source.provider === selectedProvider);
  const results = selected ? selected.results : flattenedImageResults(sources);
  const stateMessage = error || selected?.status === 'error'
    ? tr('imageSearchProviderError')
    : tr('noImageResults');
  if (!results.length) {
    target.replaceChildren();
    target.insertAdjacentHTML('beforeend', `<p class="asset-cost-image-search-dialog__state">${esc(stateMessage)}</p>`);
    target._assetResults = [];
    return;
  }

  target.replaceChildren();
  target.insertAdjacentHTML('beforeend', results.map((result, index) => `
    <button type="button" class="asset-cost-image-result" data-image-result="${index}" aria-label="${esc(result.title || tr('photo'))}">
      <img src="${esc(result.thumbnail_preview_url || result.preview_url)}" loading="lazy" alt="">
      <span>${esc(result.title || tr('photo'))}</span>
      <small>${esc(imageSourceLabel(result.provider))}${result.license ? ` · ${esc(result.license)}` : ''}</small>
    </button>`).join(''));
  target._assetResults = results;
  target.querySelectorAll('img').forEach((image) => {
    image.addEventListener('error', () => image.closest('.asset-cost-image-result')?.classList.add('is-unavailable'), { once: true });
  });
}

async function fetchImageBlob(result) {
  const urls = [...new Set([result.preview_url, result.thumbnail_preview_url].filter(Boolean))];
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(tr('loadError'));
      const blob = await response.blob();
      if (!blob.size) throw new Error(tr('loadError'));
      return blob;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(tr('loadError'));
}

async function chooseImage(result, setPhoto, resultButton, closeSearch, isClosed) {
  resultButton.disabled = true;
  try {
    const blob = await fetchImageBlob(result);
    const file = new File([blob], 'asset-search-image', { type: blob.type || 'image/jpeg' });
    const cropped = await cropFile(file);
    if (cropped !== undefined && !isClosed()) {
      setPhoto(cropped);
      closeSearch();
      window.yuvomi?.showToast(tr('photoSelected'), 'success');
    }
  } catch (err) {
    if (!isClosed()) window.yuvomi?.showToast(err.message || tr('loadError'), 'danger');
  } finally {
    resultButton.disabled = false;
  }
}

function openImageSearchDialog(formPanel, setPhoto) {
  const initialQuery = formPanel.querySelector('#asset-cost-name')?.value.trim() || '';
  if (!initialQuery) {
    window.yuvomi?.showToast(tr('nameRequired'), 'danger');
    formPanel.querySelector('#asset-cost-name')?.focus();
    return;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'asset-cost-image-search-dialog';
  dialog.setAttribute('aria-labelledby', 'asset-cost-image-search-title');
  dialog.insertAdjacentHTML('beforeend', `
    <div class="asset-cost-image-search-dialog__body">
      <header class="asset-cost-image-search-dialog__header">
        <h2 id="asset-cost-image-search-title">${esc(tr('imageSearchTitle'))}</h2>
        <button type="button" class="btn btn--ghost" data-image-search-close aria-label="${esc(tr('imageSearchClose'))}">
          <i data-lucide="x" aria-hidden="true"></i>
        </button>
      </header>
      <div class="asset-cost-image-search-dialog__query">
        <label class="sr-only" for="asset-cost-image-search-query">${esc(tr('imageSearchQueryLabel'))}</label>
        <input id="asset-cost-image-search-query" class="form-input" type="search" autocomplete="off" inputmode="search" value="${esc(initialQuery)}" placeholder="${esc(tr('imageQuery'))}">
        <button type="button" class="btn btn--primary" data-image-search-submit aria-label="${esc(tr('imageSearchSubmit'))}">
          <i data-lucide="search" aria-hidden="true"></i>
        </button>
      </div>
      <div class="asset-cost-image-search-dialog__sources" data-image-search-sources role="tablist" aria-label="${esc(tr('imageSource'))}"></div>
      <div class="asset-cost-image-results" data-image-search-results aria-live="polite"></div>
    </div>`);

  let closed = false;
  let sources = [];
  let selectedProvider = 'all';
  let requestSequence = 0;
  const queryInput = dialog.querySelector('#asset-cost-image-search-query');
  const submitButton = dialog.querySelector('[data-image-search-submit]');

  const close = () => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  const runSearch = async () => {
    const query = queryInput.value.trim();
    if (!query) {
      queryInput.focus();
      return;
    }
    const sequence = ++requestSequence;
    submitButton.disabled = true;
    renderImageSearchResults(dialog, [], 'all', { loading: true });
    try {
      const response = await api.get(`/inventory/image-search?q=${encodeURIComponent(query)}`);
      if (closed || sequence !== requestSequence) return;
      sources = normalizeImageSources(response.data);
      selectedProvider = 'all';
      renderImageSearchResults(dialog, sources, selectedProvider);
    } catch (err) {
      if (closed || sequence !== requestSequence) return;
      sources = [];
      selectedProvider = 'all';
      renderImageSearchResults(dialog, sources, selectedProvider, { error: true });
    } finally {
      if (!closed && sequence === requestSequence) submitButton.disabled = false;
    }
  };

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  // The asset editor has a document-level Escape handler. Keep the nested
  // image picker on top so Escape closes only this dialog, not both layers.
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') event.stopPropagation();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.querySelector('[data-image-search-close]').addEventListener('click', close);
  submitButton.addEventListener('click', runSearch);
  queryInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    }
  });
  dialog.querySelector('[data-image-search-sources]').addEventListener('click', (event) => {
    const sourceButton = event.target.closest('[data-image-search-source]');
    if (!sourceButton || submitButton.disabled) return;
    selectedProvider = sourceButton.dataset.imageSearchSource;
    renderImageSearchResults(dialog, sources, selectedProvider);
  });
  dialog.querySelector('[data-image-search-results]').addEventListener('click', (event) => {
    const resultButton = event.target.closest('[data-image-result]');
    if (!resultButton) return;
    const result = dialog.querySelector('[data-image-search-results]')._assetResults?.[Number(resultButton.dataset.imageResult)];
    if (result) chooseImage(result, setPhoto, resultButton, close, () => closed);
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  attachOverlay(dialog, close);
  if (window.lucide) window.lucide.createIcons({ el: dialog });
  queryInput.focus();
  queryInput.setSelectionRange(queryInput.value.length, queryInput.value.length);
  runSearch();
}

function controlValue(panel, selector) {
  return panel.querySelector(selector)?.value || '';
}

function buildPayload(panel, item, photoData) {
  const optionalNumber = (selector) => {
    const value = panel.querySelector(selector).value.trim();
    return value === '' ? null : Number(value);
  };
  const payload = {
    name: panel.querySelector('#asset-cost-name').value.trim(),
    category: panel.querySelector('#asset-cost-category').value,
    purchase_date: controlValue(panel, '#asset-cost-purchase-date') || null,
    purchase_price: optionalNumber('#asset-cost-purchase-price'),
    currency: panel.querySelector('#asset-cost-currency').value.trim().toUpperCase(),
    status: panel.querySelector('#asset-cost-status').value,
    target_days: optionalNumber('#asset-cost-target-days'),
    sold_date: controlValue(panel, '#asset-cost-sold-date') || null,
    sold_price: optionalNumber('#asset-cost-sold-price'),
    retired_date: controlValue(panel, '#asset-cost-retired-date') || null,
    notes: panel.querySelector('#asset-cost-notes').value.trim() || null,
    photo_data: photoData || null,
    asset_scope: item?.asset_scope || panel.querySelector('#asset-cost-scope').value,
    visibility: panel.querySelector('#asset-cost-visibility').value,
    assigned_user_ids: getSelectedUserIds(panel, 'asset_assigned'),
  };
  if (item) {
    // Inventory PUT is a full replace. Preserve fields that this focused form
    // intentionally does not edit, including links, warranty, and location.
    Object.assign(payload, {
      brand: item.brand ?? null,
      model: item.model ?? null,
      serial_number: item.serial_number ?? null,
      location_id: item.location_id ?? null,
      vendor: item.vendor ?? null,
      warranty_months: item.warranty_months ?? null,
      condition: item.condition || 'good',
      tracked_dates: item.tracked_dates || [],
    });
  } else {
    Object.assign(payload, {
      brand: null,
      model: null,
      serial_number: null,
      location_id: null,
      vendor: null,
      warranty_months: null,
      condition: 'good',
    });
  }
  return payload;
}

function openAssetModal(item = null) {
  let photoData = item?.photo_data || null;
  openModal({
    title: item ? tr('edit') : tr('add'),
    size: 'md',
    content: formContent(item),
    onSave: (panel) => {
      bindUserMultiSelect(panel, 'asset_assigned');
      const visibilitySelect = panel.querySelector('#asset-cost-visibility');
      const assignees = panel.querySelector('[data-asset-assignees]');
      visibilitySelect?.addEventListener('change', () => {
        assignees.hidden = visibilitySelect.value !== 'assignees';
      });
      if (item && !item.can_edit) {
        panel.querySelectorAll('.asset-cost-form input, .asset-cost-form select, .asset-cost-form textarea, .asset-cost-form yuvomi-datepicker').forEach((control) => { control.disabled = true; });
        panel.querySelectorAll('[data-choose-photo], [data-open-image-search], #asset-cost-save').forEach((control) => { control.hidden = true; });
        if (window.lucide) window.lucide.createIcons({ el: panel });
        return;
      }
      const fileInput = panel.querySelector('[data-photo-file]');
      const photoPreview = panel.querySelector('[data-photo-preview]');
      const nameInput = panel.querySelector('#asset-cost-name');
      const imageSearchTrigger = panel.querySelector('[data-open-image-search]');
      const setPhoto = (value) => {
        photoData = value;
        setFormPhoto(panel, photoData);
      };
      const chooseFile = () => fileInput.click();
      photoPreview.addEventListener('click', chooseFile);
      panel.querySelector('[data-choose-photo]').addEventListener('click', chooseFile);
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        try {
          const cropped = await cropFile(file);
          if (cropped !== undefined) setPhoto(cropped);
        } catch (err) {
          window.yuvomi?.showToast(err.message, 'danger');
        }
      });
      const updateImageSearchStatus = () => {
        if (imageSearchTrigger) imageSearchTrigger.disabled = !nameInput?.value.trim();
      };
      nameInput?.addEventListener('input', updateImageSearchStatus);
      updateImageSearchStatus();
      imageSearchTrigger?.addEventListener('click', () => openImageSearchDialog(panel, setPhoto));
      panel.querySelector('#asset-cost-save')?.addEventListener('click', () => saveAsset(panel, item, photoData));
      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

async function saveAsset(panel, item, photoData) {
  const name = panel.querySelector('#asset-cost-name').value.trim();
  const purchaseDate = controlValue(panel, '#asset-cost-purchase-date');
  const purchasePrice = panel.querySelector('#asset-cost-purchase-price').value.trim();
  const currency = panel.querySelector('#asset-cost-currency').value.trim();
  if (!name) return window.yuvomi?.showToast(tr('nameRequired'), 'danger');
  if (!purchaseDate || purchasePrice === '') return window.yuvomi?.showToast(tr('purchaseRequired'), 'danger');
  if (!/^[A-Za-z]{3}$/.test(currency)) return window.yuvomi?.showToast(tr('invalidCurrency'), 'danger');
  const payload = buildPayload(panel, item, photoData);
  const saveButton = panel.querySelector('#asset-cost-save');
  if (saveButton) saveButton.disabled = true;
  let createdDefaults = null;
  try {
    if (item) await api.put(`/inventory/items/${item.id}`, payload);
    else {
      await api.post('/inventory/items', payload);
      createdDefaults = {
        scope: payload.asset_scope,
        visibility: payload.visibility,
        assigneeIds: payload.assigned_user_ids,
      };
    }
    try {
      await saveAssetPreferences({
        asset_default_scope: payload.asset_scope,
        asset_default_visibility: payload.visibility,
        asset_default_assignee_ids: payload.assigned_user_ids,
      });
    } catch {
      // The asset was already saved. Keep the current session defaults and
      // report only the optional preference failure to avoid duplicate saves.
      window.yuvomi?.showToast(tr('defaultsSaveFailed'), 'danger');
    }
    await loadData();
    if (createdDefaults) {
      state.assetDefaultScope = createdDefaults.scope;
      state.assetDefaultVisibility = createdDefaults.visibility;
      state.assetDefaultAssigneeIds = createdDefaults.assigneeIds;
    }
    await closeModal({ force: true });
    renderBody();
    window.yuvomi?.showToast(item ? tr('updated') : tr('created'), 'success');
  } catch (err) {
    if (saveButton) saveButton.disabled = false;
    window.yuvomi?.showToast(err.data?.error || tr('loadError'), 'danger');
  }
}

async function removeAsset(item) {
  const confirmed = await confirmModal(tr('confirmDelete', { name: item.name }), {
    danger: true,
    detail: t('inventory.deleteConfirmDetail'),
  });
  if (!confirmed) return;
  try {
    await api.delete(`/inventory/items/${item.id}`);
    await loadData();
    renderBody();
    window.yuvomi?.showToast(tr('deleted'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error || tr('loadError'), 'danger');
  }
}

async function loadData() {
  const [items, categories, preferences, members] = await Promise.all([
    api.get('/inventory/items'),
    api.get('/inventory/categories'),
    api.get('/preferences').catch(() => ({ data: {} })),
    api.get('/family/members').catch(() => ({ data: [] })),
  ]);
  state.items = items.data || [];
  state.categories = categories.data || [];
  const prefData = preferences.data || {};
  const admin = state.currentUser?.role === 'admin';
  state.assetDefaultScope = admin && prefData.asset_default_scope === 'family' ? 'family' : 'personal';
  state.assetDefaultVisibility = ['all', 'assignees', 'private'].includes(prefData.asset_default_visibility)
    ? prefData.asset_default_visibility : (state.assetDefaultScope === 'family' ? 'all' : 'private');
  state.assetDefaultAssigneeIds = Array.isArray(prefData.asset_default_assignee_ids)
    ? prefData.asset_default_assignee_ids : [];
  state.metric = ASSET_COST_METRICS.has(prefData.asset_cost_metric) ? prefData.asset_cost_metric : 'current';
  state.summaryTheme = ASSET_SUMMARY_THEMES.has(prefData.asset_summary_theme) ? prefData.asset_summary_theme : 'aurora';
  state.householdCurrency = String(prefData.currency || 'EUR').toUpperCase();
  state.members = members.data || [];
  const currencies = availableCurrencies(state.items);
  if (!currencies.includes(state.summaryCurrency)) state.summaryCurrency = currencies.includes(state.householdCurrency) ? state.householdCurrency : (currencies[0] || state.householdCurrency);
}

function buildPage(container) {
  const page = document.createElement('div');
  page.className = 'asset-cost-page page';
  page.insertAdjacentHTML('beforeend', `
    <div class="asset-cost-toolbar page-toolbar page-toolbar--wrap">
      <h1 class="page-toolbar__title"><i data-lucide="calculator" aria-hidden="true"></i>${esc(tr('title'))}</h1>
      <div class="asset-cost-toolbar__search">${renderPageSearch({
        id: 'asset-cost-search',
        label: tr('search'),
        placeholder: tr('search'),
        value: state.query,
        className: 'asset-cost-search',
      })}</div>
    </div>
    <main class="asset-cost-body"></main>`);
  const fab = document.createElement('button');
  fab.className = 'page-fab';
  fab.type = 'button';
  fab.dataset.dockLabel = t('newLabel.assetCost');
  fab.setAttribute('aria-label', tr('add'));
  fab.insertAdjacentHTML('beforeend', '<i data-lucide="plus" aria-hidden="true"></i>');
  page.append(fab);
  container.replaceChildren(page);
  state.body = page.querySelector('.asset-cost-body');
  state.body.setAttribute('aria-label', tr('title'));
  wirePageSearch(page, {
    id: 'asset-cost-search',
    onQuery: (value) => {
      state.query = value;
      renderBody();
    },
  });
  fab.addEventListener('click', () => openAssetModal());
  bindBody();
  if (window.lucide) window.lucide.createIcons({ el: page });
}

export async function render(container, { user } = {}) {
  state.container = container;
  state.currentUser = user || null;
  await loadLocale();
  buildPage(container);
  try {
    await loadData();
    renderBody();
  } catch (err) {
    state.body.replaceChildren();
    state.body.insertAdjacentHTML('beforeend', `<p class="asset-cost-empty">${esc(err.data?.error || tr('loadError'))}</p>`);
  }
}
