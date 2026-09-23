import {
  op, jsonBody, idParam, stringPathParam, DOCUMENT_LINKS_READ_NOTE, BUDGET_LINKS_READ_NOTE,
} from '../helpers.js';

export function inventoryPaths() {
  return {
    '/api/v1/inventory/locations': {
      get: op({ summary: 'List inventory locations (two-level tree)', tag: 'Inventory' }),
      post: op({ summary: 'Create a top-level inventory location', tag: 'Inventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/locations/reorder': {
      patch: op({ summary: 'Reorder top-level inventory locations', tag: 'Inventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/locations/{id}': {
      put: op({ summary: 'Update an inventory location', tag: 'Inventory', params: [idParam('id', 'Location ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({
        summary: 'Delete an inventory location',
        description: 'Never blocked. Items and child locations become location-less/parent-less instead of moving.',
        tag: 'Inventory',
        params: [idParam('id', 'Location ID')],
        stateChanging: true,
      }),
    },
    '/api/v1/inventory/locations/{parentId}/subcategories': {
      post: op({ summary: 'Create a child inventory location', tag: 'Inventory', params: [idParam('parentId', 'Parent location ID')], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/locations/{parentId}/subcategories/reorder': {
      patch: op({ summary: 'Reorder child inventory locations', tag: 'Inventory', params: [idParam('parentId', 'Parent location ID')], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/locations/{parentId}/subcategories/{id}': {
      put: op({ summary: 'Update a child inventory location', tag: 'Inventory', params: [idParam('parentId', 'Parent location ID'), idParam('id', 'Location ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a child inventory location', tag: 'Inventory', params: [idParam('parentId', 'Parent location ID'), idParam('id', 'Location ID')], stateChanging: true }),
    },
    '/api/v1/inventory/categories': {
      get: op({ summary: 'List inventory categories', tag: 'Inventory' }),
      post: op({ summary: 'Create an inventory category', tag: 'Inventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/categories/reorder': {
      patch: op({ summary: 'Reorder inventory categories', tag: 'Inventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/categories/{key}': {
      put: op({ summary: 'Update an inventory category', tag: 'Inventory', params: [stringPathParam('key', 'Category key')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({
        summary: 'Delete an inventory category',
        description: "Never blocked, except the protected 'other' category. Affected items are reassigned to 'other'.",
        tag: 'Inventory',
        params: [stringPathParam('key', 'Category key')],
        stateChanging: true,
      }),
    },
    '/api/v1/inventory/items': {
      get: op({ summary: 'List inventory items', description: `Filters: category, location_id, status, q. Each item carries \`attachments\`. ${DOCUMENT_LINKS_READ_NOTE} ${BUDGET_LINKS_READ_NOTE}`, tag: 'Inventory' }),
      post: op({ summary: 'Create an inventory item (optional `attachment_document_ids`: documents from the documents module; optional `entry_id`: prefills purchase_price from that booking if it has no existing links; optional `tracked_dates`: array of custom {label, date, reminder_offset_days} entries)', tag: 'Inventory', description: DOCUMENT_LINKS_READ_NOTE, stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/items/{id}': {
      get: op({ summary: 'Get an inventory item', description: `The item carries \`attachments\`. ${DOCUMENT_LINKS_READ_NOTE} ${BUDGET_LINKS_READ_NOTE}`, tag: 'Inventory', params: [idParam('id', 'Item ID')] }),
      put: op({ summary: 'Replace an inventory item (`attachment_document_ids` replaces the document links, omit to leave untouched; `tracked_dates` replaces the whole set of custom tracked dates, omit to leave untouched)', tag: 'Inventory', params: [idParam('id', 'Item ID')], description: DOCUMENT_LINKS_READ_NOTE, stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an inventory item', tag: 'Inventory', params: [idParam('id', 'Item ID')], stateChanging: true }),
    },
    '/api/v1/inventory/image-search': {
      get: op({ summary: 'Search web image providers for an inventory photo', description: 'Searches the configured Google Programmable Search plus DuckDuckGo Images, Brave Images, and Openverse in parallel. The response keeps a backwards-compatible flat `results` array and also returns provider-grouped `sources`; one provider failure does not discard other results. The Google API key is never returned to the browser.', tag: 'Inventory' }),
    },
    '/api/v1/inventory/image-search/preview': {
      get: op({ summary: 'Proxy a selected inventory image through the SSRF-guarded downloader', tag: 'Inventory' }),
    },
    '/api/v1/inventory/items/{id}/entries': {
      post: op({
        summary: "Link a budget entry to an inventory item (role defaults to 'purchase')",
        description: BUDGET_LINKS_READ_NOTE,
        tag: 'Inventory',
        params: [idParam('id', 'Item ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/inventory/items/{id}/entries/{entryId}': {
      delete: op({
        summary: 'Unlink a budget entry from an inventory item (removes all roles for this pair)',
        description: BUDGET_LINKS_READ_NOTE,
        tag: 'Inventory',
        params: [idParam('id', 'Item ID'), idParam('entryId', 'Budget entry ID')],
        stateChanging: true,
      }),
    },
    '/api/v1/inventory/entries/{entryId}/items': {
      get: op({
        summary: 'List inventory items linked to a budget entry',
        description: 'Needs read access to the Budget module (for API tokens a `budget:read` scope); without it the entry answers 404 like an unknown one.',
        tag: 'Inventory',
        params: [idParam('entryId', 'Budget entry ID')],
      }),
    },
    '/api/v1/inventory/deadlines-feed': {
      get: op({ summary: 'Get own inventory deadlines ICS feed status', tag: 'Inventory' }),
      delete: op({ summary: 'Disable own inventory deadlines ICS feed', tag: 'Inventory', stateChanging: true }),
    },
    '/api/v1/inventory/deadlines-feed/regenerate': {
      post: op({ summary: 'Regenerate own inventory deadlines ICS feed token', tag: 'Inventory', stateChanging: true }),
    },
  };
}
