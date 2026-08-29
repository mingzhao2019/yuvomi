/**
 * Tests: shared page-search caret behaviour.
 * Ausführen: node --loader ./test-browser-loader.mjs --test test-page-search.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

global.document = { activeElement: null };
const animationFrames = [];
global.requestAnimationFrame = (callback) => { animationFrames.push(callback); };
const { wirePageSearch } = await import('../public/utils/page-search.js');

function flushAnimationFrames() {
  while (animationFrames.length) animationFrames.shift()();
}

function makeSearch(value) {
  const inputListeners = new Map();
  const controlListeners = new Map();
  let selection = null;
  let focusOptions = null;
  const clearButton = {
    hidden: !value,
    addEventListener() {},
    contains(target) { return target === this || target === this.icon; },
  };
  clearButton.icon = { parent: clearButton };
  const control = {
    addEventListener(type, handler) { controlListeners.set(type, handler); },
    querySelector: () => clearButton,
  };
  const input = {
    value,
    addEventListener(type, handler) { inputListeners.set(type, handler); },
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
    icon: { parent: control },
    clearButton,
    dispatchInput(type, event) { inputListeners.get(type)?.(event); },
    dispatchControl(type, event) { controlListeners.get(type)?.(event); },
    get selection() { return selection; },
    get focusOptions() { return focusOptions; },
  };
}

test('re-entering a populated search places the caret at the end', () => {
  const search = makeSearch('找任务');
  global.document.activeElement = { tagName: 'BODY' };
  let prevented = false;
  search.dispatchControl('pointerdown', {
    target: search.input,
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, false, 'native pointer focus must stay intact for the mobile keyboard');
  assert.equal(search.selection, null, 'selection waits until native focus has completed');
  assert.equal(search.focusOptions, null, 'the handler must not replace native focus');

  // Browser default action between pointerdown and click.
  global.document.activeElement = search.input;
  search.dispatchControl('click', { target: search.input });
  assert.equal(search.selection, null, 'native click placement must finish before selection changes');
  flushAnimationFrames();
  assert.deepEqual(search.selection, [3, 3]);
  assert.equal(global.document.activeElement, search.input);
});

test('tapping the search icon also re-enters a populated search at the end', () => {
  const search = makeSearch('ab');
  global.document.activeElement = { tagName: 'BODY' };
  search.dispatchControl('pointerdown', { target: search.icon });
  // The click listener runs before the label's native activation focuses its
  // associated input. The deferred selection must survive that exact order.
  search.dispatchControl('click', { target: search.icon });
  assert.equal(search.selection, null);
  global.document.activeElement = search.input;
  flushAnimationFrames();
  assert.deepEqual(search.selection, [2, 2]);
});

test('an already focused search still allows normal caret placement', () => {
  const search = makeSearch('task');
  global.document.activeElement = search.input;
  let prevented = false;
  search.dispatchControl('pointerdown', {
    target: search.input,
    preventDefault() { prevented = true; },
  });
  search.dispatchControl('click', { target: search.input });
  flushAnimationFrames();
  assert.equal(prevented, false);
  assert.equal(search.selection, null);
});

test('a cancelled pointer does not move the caret on a later click', () => {
  const search = makeSearch('task');
  global.document.activeElement = { tagName: 'BODY' };
  search.dispatchControl('pointerdown', { target: search.input });
  search.dispatchControl('pointercancel', { target: search.input });
  global.document.activeElement = search.input;
  search.dispatchControl('click', { target: search.input });
  flushAnimationFrames();
  assert.equal(search.selection, null);
});

test('the clear affordance never schedules a stale caret move', () => {
  const search = makeSearch('task');
  global.document.activeElement = { tagName: 'BODY' };
  search.dispatchControl('pointerdown', { target: search.clearButton.icon });
  global.document.activeElement = search.input;
  search.dispatchControl('click', { target: search.clearButton.icon });
  flushAnimationFrames();
  assert.equal(search.selection, null);
});
