/**
 * Test: Extension module i18n
 * Run: node --test test/test-extension-i18n.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearExtensionTranslations,
  registerExtensionTranslations,
  setExtensionLocaleBundles,
  resolveExtensionTranslation,
  extensionLocaleChain,
  t,
} from '../public/i18n.js';
import {
  extensionTranslationKey,
  resolveExtensionLabel,
  isValidExtensionLabelKey,
  moduleDisplayLabel,
  widgetDisplayLabel,
  optionFieldLabel,
} from '../public/utils/extension-i18n.js';

test.after(() => {
  clearExtensionTranslations();
});

test('registerExtensionTranslations merges flat keys under extensions.moduleId', () => {
  clearExtensionTranslations();
  registerExtensionTranslations('demo-mod', {
    menu: 'Demo Menu',
    'widgets.summary': 'Summary',
  });
  assert.equal(t('extensions.demo-mod.menu'), 'Demo Menu');
  assert.equal(t('extensions.demo-mod.widgets.summary'), 'Summary');
});

test('multi-locale bundles fall back UI locale -> defaultLocale -> en -> de', () => {
  clearExtensionTranslations();
  setExtensionLocaleBundles('demo-mod', {
    defaultLocale: 'en',
    trees: {
      en: { menu: 'English Menu' },
      de: { menu: 'Deutsch Menu' },
    },
  });
  assert.deepEqual(extensionLocaleChain('en', 'ru'), ['ru', 'en', 'de']);
  assert.equal(resolveExtensionTranslation('extensions.demo-mod.menu', 'ru'), 'English Menu');
  assert.equal(resolveExtensionTranslation('extensions.demo-mod.menu', 'de'), 'Deutsch Menu');
  assert.equal(resolveExtensionTranslation('extensions.demo-mod.menu', 'en'), 'English Menu');
});

test('extensionTranslationKey accepts short and full keys', () => {
  assert.equal(extensionTranslationKey('demo-mod', 'menu'), 'extensions.demo-mod.menu');
  assert.equal(extensionTranslationKey('demo-mod', 'extensions.demo-mod.menu'), 'extensions.demo-mod.menu');
});

test('resolveExtensionLabel prefers translation over static label', () => {
  clearExtensionTranslations();
  registerExtensionTranslations('demo-mod', { menu: 'Lokalisiert' });
  assert.equal(resolveExtensionLabel('demo-mod', { labelKey: 'menu', label: 'Static' }), 'Lokalisiert');
  assert.equal(resolveExtensionLabel('demo-mod', { label: 'Static' }), 'Static');
});

test('resolveExtensionLabel uses static label when no locale bundle matches', () => {
  clearExtensionTranslations();
  assert.equal(resolveExtensionLabel('demo-mod', {
    labelKey: 'menu',
    label: 'Static fallback',
  }), 'Static fallback');
});

test('moduleDisplayLabel and widgetDisplayLabel use manifest fallbacks', () => {
  clearExtensionTranslations();
  setExtensionLocaleBundles('demo-mod', {
    defaultLocale: 'en',
    trees: {
      en: {
        menu: 'Menu EN',
        module: 'Module EN',
        widgets: { summary: 'Widget EN' },
        options: { compact: 'Compact EN' },
      },
    },
  });
  const mod = {
    id: 'demo-mod',
    name: 'Demo',
    menu: { label: 'Menu static', labelKey: 'menu' },
    capabilities: { permissionModule: { label: 'Module static', labelKey: 'module' } },
  };
  assert.equal(moduleDisplayLabel(mod), 'Menu EN');
  assert.equal(widgetDisplayLabel({
    id: 'demo-mod:summary',
    moduleId: 'demo-mod',
    label: 'Widget static',
    labelKey: 'widgets.summary',
  }), 'Widget EN');
  assert.equal(optionFieldLabel('demo-mod', { title: 'Compact static', titleKey: 'options.compact' }, 'compact'), 'Compact EN');
});

test('isValidExtensionLabelKey rejects invalid keys', () => {
  assert.equal(isValidExtensionLabelKey('widgets.summary'), true);
  assert.equal(isValidExtensionLabelKey('Bad Key'), false);
  assert.equal(isValidExtensionLabelKey(''), false);
});

test('clearExtensionTranslations removes overlay', () => {
  registerExtensionTranslations('demo-mod', { menu: 'X' });
  clearExtensionTranslations();
  assert.equal(t('extensions.demo-mod.menu'), 'extensions.demo-mod.menu');
});
