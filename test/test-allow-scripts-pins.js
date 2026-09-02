/**
 * Module: allowScripts pins against the lockfile.
 * Purpose: `allowScripts` in package.json names every package allowed to run
 *          install scripts, with an exact version. The permission applies to
 *          the reviewed package version, not merely its name.
 *
 * This guard prevents dependency bumps from leaving a pin that points at a
 * version no longer installed, or at a package no longer present in the
 * dependency graph.
 *
 * Run with: npm run test:allow-scripts-pins
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf-8'));

/** `puppeteer@25.9.0` -> { name: 'puppeteer', version: '25.9.0' }. */
function splitPin(pin) {
  const at = pin.lastIndexOf('@');
  return { name: pin.slice(0, at), version: pin.slice(at + 1) };
}

test('each allowScripts pin names the installed version', () => {
  const pins = Object.keys(pkg.allowScripts || {});
  assert.ok(pins.length > 0, 'allowScripts must contain at least one pin');

  const drift = [];
  for (const pin of pins) {
    const { name, version } = splitPin(pin);
    const installed = lock.packages?.[`node_modules/${name}`]?.version;
    if (installed !== version) drift.push(`${name}: pin ${version}, lock ${installed ?? 'missing'}`);
  }

  assert.deepEqual(drift, [],
    'allowScripts pins point at versions that are not installed. Update the pin after a dependency bump: '
    + drift.join(' | '));
});

test('each pinned package is still a dependency', () => {
  const allDependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const orphaned = Object.keys(pkg.allowScripts || {})
    .map((pin) => splitPin(pin).name)
    .filter((name) => !(name in allDependencies));

  assert.deepEqual(orphaned, [],
    `allowScripts names packages that are no longer dependencies: ${orphaned.join(', ')}`);
});
