/**
 * Tests: shared page-search caret behaviour.
 * Ausführen: node --loader ./test-browser-loader.mjs --test test-page-search.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

global.document = { activeElement: null };
const { wirePageSearch } = await import('../public/utils/page-search.js');

function makeSearch(value) {
  const listeners = new Map();
  let selection = null;
  let focusOptions = null;
  const clearButton = { hidden: !value, addEventListener() {} };
  const control = { querySelector: () => clearButton };
  const input = {
    value,
    addEventListener(type, handler) { listeners.set(type, handler); },
    closest: () => control,
    focus(options) {
      focusOptions = options;
      global.document.activeElement = input;
    },
    setSelectionRange(start, end) { selection = [start, end]; },
  };
  const container = { querySelector: () => input };
  wirePageSearch(container, { id: 'task-search', onQuery: () => {}, delay: 0 });
  return {
    input,
    dispatch(type, event) { listeners.get(type)?.(event); },
    get selection() { return selection; },
    get focusOptions() { return focusOptions; },
  };
}

test('re-entering a populated search places the caret at the end', () => {
  const search = makeSearch('找任务');
  global.document.activeElement = { tagName: 'BODY' };
  let prevented = false;
  search.dispatch('pointerdown', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(search.selection, [3, 3]);
  assert.deepEqual(search.focusOptions, { preventScroll: true });
  assert.equal(global.document.activeElement, search.input);
});

test('an already focused search still allows normal caret placement', () => {
  const search = makeSearch('task');
  global.document.activeElement = search.input;
  let prevented = false;
  search.dispatch('pointerdown', { preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(search.selection, null);
});
