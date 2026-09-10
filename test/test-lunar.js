import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatChineseLunarDate,
  isChineseLunarContext,
  isChineseLunarSupported,
  shouldDisplayChineseLunar,
} from '../public/utils/lunar.js';

test('Chinese lunar support is detected without a network dependency', () => {
  assert.equal(typeof isChineseLunarSupported(), 'boolean');
});

test('Chinese region or UI language enables the lunar context', () => {
  assert.equal(isChineseLunarContext('zh-CN', 'en'), true);
  assert.equal(isChineseLunarContext('de-DE', 'zh'), true);
  assert.equal(isChineseLunarContext('de-DE', 'zh-CN'), true);
  assert.equal(isChineseLunarContext('de-DE', 'de'), false);
});

test('display gating uses the same context rule as the settings card', () => {
  assert.equal(shouldDisplayChineseLunar({ enabled: true, region: 'de-DE', locale: 'de' }), false);
  assert.equal(shouldDisplayChineseLunar({ enabled: false, region: 'zh-CN', locale: 'zh' }), false);
  if (isChineseLunarSupported()) {
    assert.equal(shouldDisplayChineseLunar({ enabled: true, region: 'zh-CN', locale: 'en' }), true);
    assert.equal(shouldDisplayChineseLunar({ enabled: true, region: 'de-DE', locale: 'zh' }), true);
  }
});

test('known Gregorian dates render stable Chinese lunar dates', { skip: !isChineseLunarSupported() }, () => {
  assert.equal(formatChineseLunarDate('2026-02-17'), '正月初一');
  assert.equal(formatChineseLunarDate('2026-06-19'), '五月初五');
  assert.equal(formatChineseLunarDate('2026-10-25'), '九月十六');
  assert.equal(formatChineseLunarDate('2026-02-17', { includeYear: true }), '农历丙午年正月初一');
});

test('invalid date keys fail closed', () => {
  assert.equal(formatChineseLunarDate('2026-02-30'), '');
  assert.equal(formatChineseLunarDate('not-a-date'), '');
});
