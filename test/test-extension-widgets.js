/**
 * Test: Extension dashboard widgets (client utils)
 * Run: node --test test/test-extension-widgets.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const ext = await import('../public/utils/extension-widgets.js');

const sampleModules = [{
  id: 'demo-ext',
  enabled: true,
  status: 'enabled',
  capabilities: {
    permissionModuleKey: 'ext:demo-ext',
    widgets: [{
      id: 'demo-ext:summary',
      shortId: 'summary',
      entry: '/api/v1/modules/assets/demo-ext/widgets/summary.js',
      label: 'Summary',
      icon: 'box',
      defaultSize: '1x2',
      defaultVisible: false,
      moduleKey: 'ext:demo-ext',
    }],
  },
}];

test('extension widget ids merge with core widgets', () => {
  ext.setExtensionModules(sampleModules);
  const ids = ext.allWidgetIds();
  assert.ok(ids.includes('tasks'));
  assert.ok(ids.includes('demo-ext:summary'));
});

test('normalizeDashboardConfigWithExtensions keeps extension widget ids', () => {
  ext.setExtensionModules(sampleModules);
  const cfg = ext.normalizeDashboardConfigWithExtensions([
    { id: 'demo-ext:summary', visible: true, order: 0, size: '1x2' },
  ]);
  assert.ok(cfg.some((w) => w.id === 'demo-ext:summary'));
});

test('isExtensionWidget detects namespaced ids', () => {
  assert.equal(ext.isExtensionWidget('demo-ext:summary'), true);
  assert.equal(ext.isExtensionWidget('budget'), false);
});

test('buildDefaultWidgetConfig inserts extension widgets before weather', () => {
  ext.setExtensionModules(sampleModules);
  const cfg = ext.buildDefaultWidgetConfig();
  const summaryIdx = cfg.findIndex((w) => w.id === 'demo-ext:summary');
  const weatherIdx = cfg.findIndex((w) => w.id === 'weather');
  assert.ok(summaryIdx >= 0);
  assert.ok(weatherIdx >= 0);
  assert.ok(summaryIdx < weatherIdx);
});
