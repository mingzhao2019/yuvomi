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
  assert.equal(prevented, false, 'native pointer focus must stay intact for the mobile keyboard');
  assert.equal(search.selection, null, 'selection waits until native focus has completed');
  assert.equal(search.focusOptions, null, 'the handler must not replace native focus');

  // Browser default action between pointerdown and click.
  global.document.activeElement = search.input;
  search.dispatch('click', {});
  assert.deepEqual(search.selection, [3, 3]);
  assert.equal(global.document.activeElement, search.input);
});

test('an already focused search still allows normal caret placement', () => {
  const search = makeSearch('task');
  global.document.activeElement = search.input;
  let prevented = false;
  search.dispatch('pointerdown', { preventDefault() { prevented = true; } });
  search.dispatch('click', {});
  assert.equal(prevented, false);
  assert.equal(search.selection, null);
});

test('a cancelled pointer does not move the caret on a later click', () => {
  const search = makeSearch('task');
  global.document.activeElement = { tagName: 'BODY' };
  search.dispatch('pointerdown', {});
  search.dispatch('pointercancel', {});
  global.document.activeElement = search.input;
  search.dispatch('click', {});
  assert.equal(search.selection, null);
});
