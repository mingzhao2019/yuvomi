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

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENCY_SYMBOLS = { CNY: '¥', EUR: '€', USD: '$' };
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
  return category?.name || category?.key || tr('unknownCategory');
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
  const progress = targetDays && daysUsed ? Math.min(1, daysUsed / targetDays) : null;
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
    if (state.sort === 'cost-desc') return compareNullable(a.costPerDay, b.costPerDay, -1) || a.name.localeCompare(b.name);
    if (state.sort === 'cost-asc') return compareNullable(a.costPerDay, b.costPerDay, 1) || a.name.localeCompare(b.name);
    if (state.sort === 'price-desc') return compareNullable(a.purchasePrice, b.purchasePrice, -1) || a.name.localeCompare(b.name);
    if (state.sort === 'days-desc') return compareNullable(a.daysUsed, b.daysUsed, -1) || a.name.localeCompare(b.name);
    return String(b.purchase_date || '').localeCompare(String(a.purchase_date || '')) || a.name.localeCompare(b.name);
  });
  return result;
}

function imageHtml(item) {
  if (item.photo_data) {
    return `<img class="asset-cost-card__image" src="${esc(item.photo_data)}" alt="">`;
  }
  return '<span class="asset-cost-card__image-fallback"><i data-lucide="image" aria-hidden="true"></i></span>';
}

function cardHtml(item) {
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
      <div class="asset-cost-card__daily">${esc(formatMoney(item.costPerDay, currencyCode(item)))}<small>${esc(tr('perDay'))}</small></div>
      ${goal}
    </article>`;
}

function summaryHtml(items) {
  const currency = state.summaryCurrency;
  const currencyItems = items.filter((item) => currencyCode(item) === currency);
  const totalPrice = currencyItems.reduce((sum, item) => sum + (item.purchasePrice ?? 0), 0);
  const dailyCost = currencyItems.reduce((sum, item) => sum + (item.costPerDay ?? 0), 0);
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
    <section class="asset-cost-summary" aria-label="${esc(tr('overview'))}">
      <div class="asset-cost-summary__heading">
        <h2>${esc(tr('overview'))}</h2>
        <span>${items.length}/${state.items.length}</span>
      </div>
      <div class="asset-cost-summary__metrics">
        <div><span>${esc(tr('totalAssets'))}</span><strong>${esc(formatMoney(totalPrice, currency))}</strong></div>
        <div><span>${esc(tr('dailyCost'))}</span><strong>${esc(formatMoney(dailyCost, currency))}</strong></div>
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
  return `
    <div class="asset-cost-categories" role="tablist" aria-label="${esc(tr('categories'))}">
      ${allCategories().map((category) => `
        <button type="button" role="tab" aria-selected="${selectedCategory === category.key}" class="asset-cost-category ${selectedCategory === category.key ? 'is-selected' : ''}" data-category="${esc(category.key)}">
          ${esc(categoryName(category))}
        </button>`).join('')}
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

function bindBody() {
  state.body.addEventListener('click', (event) => {
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
  const scope = item?.asset_scope || (admin ? 'family' : 'personal');
  const visibility = item?.visibility || (scope === 'family' ? 'all' : 'private');
  const selectedIds = item?.assigned_user_ids || item?.assigned_users?.map((user) => user.id) || [];
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
      <div class="asset-cost-form__photo">
        <button type="button" class="asset-cost-form__photo-preview" data-photo-preview aria-label="${esc(tr('choosePhoto'))}">
          ${item?.photo_data ? `<img src="${esc(item.photo_data)}" alt="">` : '<i data-lucide="image" aria-hidden="true"></i>'}
        </button>
        <div class="asset-cost-form__photo-actions">
          <input class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" data-photo-file>
          <button type="button" class="btn btn--secondary btn--sm" data-choose-photo>${esc(tr('choosePhoto'))}</button>
          <button type="button" class="btn btn--secondary btn--sm" data-open-image-search>${esc(tr('searchImages'))}</button>
        </div>
      </div>
      <div class="form-group"><label class="form-label" for="asset-cost-name">${esc(tr('name'))}</label><input id="asset-cost-name" class="form-input" type="text" required value="${esc(item?.name || '')}"></div>
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
        <div class="form-group"><label class="form-label" for="asset-cost-purchase-date">${esc(tr('purchaseDate'))}</label><input id="asset-cost-purchase-date" class="form-input" type="date" required value="${esc(item?.purchase_date || '')}"></div>
        <div class="form-group"><label class="form-label" for="asset-cost-purchase-price">${esc(tr('purchasePrice'))}</label><input id="asset-cost-purchase-price" class="form-input" type="number" min="0" step="0.01" inputmode="decimal" required value="${item?.purchase_price == null ? '' : esc(item.purchase_price)}"></div>
      </div>
      <div class="asset-cost-form__row">
        <div class="form-group"><label class="form-label" for="asset-cost-currency">${esc(tr('currencyField'))}</label><input id="asset-cost-currency" class="form-input" type="text" maxlength="3" minlength="3" value="${esc(item?.currency || state.householdCurrency)}"></div>
        <div class="form-group"><label class="form-label" for="asset-cost-target-days">${esc(tr('targetDays'))}</label><input id="asset-cost-target-days" class="form-input" type="number" min="1" step="1" inputmode="numeric" placeholder="${esc(tr('targetDaysHint'))}" value="${item?.target_days == null ? '' : esc(item.target_days)}"></div>
      </div>
      <details class="asset-cost-form__advanced" ${item?.sold_date || item?.sold_price != null || item?.retired_date ? 'open' : ''}>
        <summary>${esc(tr('advanced'))}</summary>
        <div class="asset-cost-form__row"><div class="form-group"><label class="form-label" for="asset-cost-sold-date">${esc(tr('soldDate'))}</label><input id="asset-cost-sold-date" class="form-input" type="date" value="${esc(item?.sold_date || '')}"></div>
        <div class="form-group"><label class="form-label" for="asset-cost-sold-price">${esc(tr('soldPrice'))}</label><input id="asset-cost-sold-price" class="form-input" type="number" min="0" step="0.01" inputmode="decimal" value="${item?.sold_price == null ? '' : esc(item.sold_price)}"></div></div>
        <div class="form-group"><label class="form-label" for="asset-cost-retired-date">${esc(tr('retiredDate'))}</label><input id="asset-cost-retired-date" class="form-input" type="date" value="${esc(item?.retired_date || '')}"></div>
      </details>
      <div class="form-group"><label class="form-label" for="asset-cost-notes">${esc(tr('notes'))}</label><textarea id="asset-cost-notes" class="form-input" rows="3">${esc(item?.notes || '')}</textarea></div>
      <div class="asset-cost-image-search" data-image-search hidden>
        <div class="asset-cost-image-search__bar"><input class="form-input" type="search" data-image-query placeholder="${esc(tr('imageQuery'))}" value="${esc(item?.name || '')}"><button type="button" class="btn btn--primary btn--sm" data-search-images>${esc(tr('searchImages'))}</button></div>
        <p class="asset-cost-image-search__hint">${esc(tr('imageSearchHint'))}</p>
        <div class="asset-cost-image-results" data-image-results></div>
      </div>
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

function renderImageResults(panel, results) {
  const target = panel.querySelector('[data-image-results]');
  if (!results?.length) {
    target.replaceChildren();
    target.insertAdjacentHTML('beforeend', `<p class="asset-cost-image-results__empty">${esc(tr('noImageResults'))}</p>`);
    return;
  }
  target.replaceChildren();
  target.insertAdjacentHTML('beforeend', results.map((result, index) => `
    <button type="button" class="asset-cost-image-result" data-image-result="${index}">
      <img src="${esc(result.preview_url)}" alt="">
      <span>${esc(result.title || tr('photo'))}</span>
      <small>${esc(result.provider)}${result.license ? ` · ${esc(result.license)}` : ''}</small>
    </button>`).join(''));
  target._assetResults = results;
}

async function searchImages(panel) {
  const query = panel.querySelector('[data-image-query]').value.trim() || panel.querySelector('#asset-cost-name').value.trim();
  if (!query) return;
  const button = panel.querySelector('[data-search-images]');
  const target = panel.querySelector('[data-image-results]');
  button.disabled = true;
  target.replaceChildren();
  target.insertAdjacentHTML('beforeend', `<p class="asset-cost-image-results__empty">${esc(tr('searching'))}</p>`);
  try {
    const response = await api.get(`/inventory/image-search?q=${encodeURIComponent(query)}`);
    renderImageResults(panel, response.data?.results || []);
  } catch (err) {
    target.replaceChildren();
    target.insertAdjacentHTML('beforeend', `<p class="asset-cost-image-results__empty">${esc(err.data?.error || tr('loadError'))}</p>`);
  } finally {
    button.disabled = false;
  }
}

async function chooseImage(panel, result, setPhoto) {
  try {
    const response = await fetch(result.preview_url, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(tr('loadError'));
    const blob = await response.blob();
    const file = new File([blob], 'asset-search-image', { type: blob.type || 'image/jpeg' });
    const cropped = await cropFile(file);
    if (cropped !== undefined) {
      setPhoto(cropped);
      window.yuvomi?.showToast(tr('photoSelected'), 'success');
    }
  } catch (err) {
    window.yuvomi?.showToast(err.message || tr('loadError'), 'danger');
  }
}

function buildPayload(panel, item, photoData) {
  const optionalNumber = (selector) => {
    const value = panel.querySelector(selector).value.trim();
    return value === '' ? null : Number(value);
  };
  const payload = {
    name: panel.querySelector('#asset-cost-name').value.trim(),
    category: panel.querySelector('#asset-cost-category').value,
    purchase_date: panel.querySelector('#asset-cost-purchase-date').value || null,
    purchase_price: optionalNumber('#asset-cost-purchase-price'),
    currency: panel.querySelector('#asset-cost-currency').value.trim().toUpperCase(),
    status: panel.querySelector('#asset-cost-status').value,
    target_days: optionalNumber('#asset-cost-target-days'),
    sold_date: panel.querySelector('#asset-cost-sold-date').value || null,
    sold_price: optionalNumber('#asset-cost-sold-price'),
    retired_date: panel.querySelector('#asset-cost-retired-date').value || null,
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
        panel.querySelectorAll('.asset-cost-form input, .asset-cost-form select, .asset-cost-form textarea').forEach((control) => { control.disabled = true; });
        panel.querySelectorAll('[data-choose-photo], [data-open-image-search], #asset-cost-save').forEach((control) => { control.hidden = true; });
        if (window.lucide) window.lucide.createIcons({ el: panel });
        return;
      }
      const fileInput = panel.querySelector('[data-photo-file]');
      const photoPreview = panel.querySelector('[data-photo-preview]');
      const searchPanel = panel.querySelector('[data-image-search]');
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
      panel.querySelector('[data-open-image-search]').addEventListener('click', () => {
        searchPanel.hidden = !searchPanel.hidden;
        if (!searchPanel.hidden) panel.querySelector('[data-image-query]').focus();
      });
      panel.querySelector('[data-search-images]').addEventListener('click', () => searchImages(panel));
      panel.querySelector('[data-image-query]').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') searchImages(panel);
      });
      panel.querySelector('[data-image-results]').addEventListener('click', (event) => {
        const resultButton = event.target.closest('[data-image-result]');
        if (!resultButton) return;
        const result = panel.querySelector('[data-image-results]')._assetResults?.[Number(resultButton.dataset.imageResult)];
        if (result) chooseImage(panel, result, setPhoto);
      });
      panel.querySelector('#asset-cost-save')?.addEventListener('click', () => saveAsset(panel, item, photoData));
      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

async function saveAsset(panel, item, photoData) {
  const name = panel.querySelector('#asset-cost-name').value.trim();
  const purchaseDate = panel.querySelector('#asset-cost-purchase-date').value;
  const purchasePrice = panel.querySelector('#asset-cost-purchase-price').value.trim();
  const currency = panel.querySelector('#asset-cost-currency').value.trim();
  if (!name) return window.yuvomi?.showToast(tr('nameRequired'), 'danger');
  if (!purchaseDate || purchasePrice === '') return window.yuvomi?.showToast(tr('purchaseRequired'), 'danger');
  if (!/^[A-Za-z]{3}$/.test(currency)) return window.yuvomi?.showToast(tr('invalidCurrency'), 'danger');
  const payload = buildPayload(panel, item, photoData);
  const saveButton = panel.querySelector('#asset-cost-save');
  if (saveButton) saveButton.disabled = true;
  try {
    if (item) await api.put(`/inventory/items/${item.id}`, payload);
    else await api.post('/inventory/items', payload);
    await loadData();
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
  state.householdCurrency = String(preferences.data?.currency || 'EUR').toUpperCase();
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
