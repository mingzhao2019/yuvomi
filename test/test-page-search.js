/**
 * Tests: shared page-search wiring and compact reveal behaviour.
 * Ausführen: node --loader ./test-browser-loader.mjs --test test-page-search.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

global.document = { activeElement: null };
const { wirePageSearch, wirePageSearchReveal } = await import('../public/utils/page-search.js');

function makeSearch(value) {
  const inputListeners = new Map();
  const controlListeners = new Map();
  const searchRootListeners = new Map();
  const triggerListeners = new Map();
  const rootClasses = new Set();
  const triggerAttributes = new Map();
  let selection = null;
  let focusOptions = null;
  let input;
  let clearButton;
  const root = {
    classList: {
      toggle(name, on) {
        if (on) rootClasses.add(name);
        else rootClasses.delete(name);
      },
    },
  };
  const searchRoot = {
    addEventListener(type, handler) { searchRootListeners.set(type, handler); },
    contains(target) { return target === input || target === clearButton; },
  };
  clearButton = {
    hidden: !value,
    listeners: new Map(),
    addEventListener(type, handler) { this.listeners.set(type, handler); },
  };
  const control = {
    addEventListener(type, handler) { controlListeners.set(type, handler); },
    querySelector: () => clearButton,
  };
  input = {
    value,
    addEventListener(type, handler) { inputListeners.set(type, handler); },
    closest(selector) {
      if (selector === '.page-search__control') return control;
      if (selector === '.page-search') return searchRoot;
      return null;
    },
    focus(options) {
      focusOptions = options;
      global.document.activeElement = input;
    },
    setSelectionRange(start, end) { selection = [start, end]; },
  };
  const trigger = {
    addEventListener(type, handler) { triggerListeners.set(type, handler); },
    setAttribute(name, valueToSet) { triggerAttributes.set(name, valueToSet); },
  };
  const container = { querySelector: () => input };
  const queries = [];
  const wired = wirePageSearch(container, {
    id: 'task-search',
    onQuery: (query) => queries.push(query),
    delay: 0,
  });
  const reveal = wirePageSearchReveal({
    input: wired.input,
    trigger,
    root,
    openClass: 'toolbar--search-open',
  });
  return {
    input,
    clearButton,
    controlListeners,
    queries,
    reveal,
    clickTrigger() { triggerListeners.get('click')?.(); },
    focusOut() { searchRootListeners.get('focusout')?.(); },
    dispatchInput() { inputListeners.get('input')?.(); },
    clickClear() { clearButton.listeners.get('click')?.(); },
    hasRootClass(name) { return rootClasses.has(name); },
    triggerAttribute(name) { return triggerAttributes.get(name); },
    get selection() { return selection; },
    get focusOptions() { return focusOptions; },
  };
}

test('a separate trigger reveals the input and places a populated query caret at the end', () => {
  const search = makeSearch('找任务');
  global.document.activeElement = { tagName: 'BODY' };
  search.clickTrigger();

  assert.equal(search.hasRootClass('toolbar--search-open'), true);
  assert.equal(search.triggerAttribute('aria-expanded'), 'true');
  assert.deepEqual(search.focusOptions, { preventScroll: true });
  assert.deepEqual(search.selection, [3, 3]);
  assert.equal(global.document.activeElement, search.input);
});

test('generic search wiring leaves direct input pointer placement native', () => {
  const search = makeSearch('task');
  assert.equal(search.controlListeners.has('pointerdown'), false);
  assert.equal(search.controlListeners.has('pointercancel'), false);
  assert.equal(search.controlListeners.has('click'), false);
});

test('leaving the revealed search collapses it after focus settles', async () => {
  const search = makeSearch('task');
  search.clickTrigger();
  global.document.activeElement = { tagName: 'BODY' };
  search.focusOut();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(search.hasRootClass('toolbar--search-open'), false);
  assert.equal(search.triggerAttribute('aria-expanded'), 'false');
});

test('clear-button focus handoff keeps the revealed search open', async () => {
  const search = makeSearch('task');
  search.clickTrigger();
  global.document.activeElement = search.clearButton;
  search.focusOut();
  search.clickClear();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(search.input.value, '');
  assert.deepEqual(search.queries, ['']);
  assert.equal(global.document.activeElement, search.input);
  assert.equal(search.hasRootClass('toolbar--search-open'), true);
});

test('typing still updates the shared query callback', () => {
  const search = makeSearch('');
  search.input.value = 'ab';
  search.dispatchInput();
  assert.deepEqual(search.queries, ['ab']);
  assert.equal(search.clearButton.hidden, false);
});

test('reveal wiring safely ignores incomplete markup', () => {
  assert.equal(wirePageSearchReveal({}), null);
});
