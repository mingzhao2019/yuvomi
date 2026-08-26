/**
 * Test: PWA-Manifest (zwei Quellen, eine Wahrheit)
 * Zweck: Das Manifest liegt doppelt vor - `public/manifest.json` als statische
 *        Datei (vom Service Worker precached) und `/manifest.webmanifest` aus
 *        server/index.js, das den in den Einstellungen gesetzten App-Namen
 *        einsetzt. Beide zusammenzuhalten war bisher ein Kommentar; ein
 *        Kommentar merkt nicht, wenn eine der beiden Stellen geaendert wird.
 *
 *        Dazu die Orientierung: `orientation` ist eine Sperre, keine
 *        Bevorzugung. `portrait-primary` zwang die installierte App auf einem
 *        Tablet in den schmalen Hochkant-Streifen (#890) - der Schluessel
 *        gehoert in keine der beiden Quellen, auch nicht als 'any'.
 * Ausführen: node --test test/test-pwa-manifest.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_PATH = path.join(HERE, '..', 'public', 'manifest.json');
const SERVER_PATH = path.join(HERE, '..', 'server', 'index.js');

const staticManifest = JSON.parse(fs.readFileSync(STATIC_PATH, 'utf8'));
const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');

/**
 * Das Objektliteral der `/manifest.webmanifest`-Route als Text.
 *
 * Bewusst statisch statt per Import: server/index.js startet beim Laden den
 * Server samt DB. Fuer die Frage, welche Schluessel dort stehen, reicht der
 * Quelltext - und er faellt auch dann auf, wenn jemand den Wert nur in einem
 * Zweig setzt.
 */
function serverManifestSource() {
  const start = serverSource.indexOf("app.get('/manifest.webmanifest'");
  assert.notEqual(start, -1, 'Route /manifest.webmanifest nicht gefunden');
  const end = serverSource.indexOf('\n});', start);
  assert.notEqual(end, -1, 'Routenende nicht gefunden');
  return serverSource.slice(start, end);
}

/** Grobwert eines Schluessels aus dem Routen-Literal (String/Array-Literal als Text). */
function serverValue(key) {
  const m = serverManifestSource().match(new RegExp(`^\\s*${key}:\\s*(.+?),\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

// --------------------------------------------------------
// Orientierung (#890)
// --------------------------------------------------------

test('kein orientation-Schluessel im statischen Manifest (#890)', () => {
  assert.ok(!('orientation' in staticManifest),
    'orientation sperrt die installierte App auf eine Lage; ohne den Schluessel folgt sie dem Geraet');
});

test('kein orientation-Schluessel in der Server-Route (#890)', () => {
  assert.equal(serverValue('orientation'), null,
    'orientation sperrt die installierte App auf eine Lage; ohne den Schluessel folgt sie dem Geraet');
});

// --------------------------------------------------------
// Die zwei Quellen bleiben zusammen
// --------------------------------------------------------

// name/short_name stehen bewusst nicht hier: die Server-Route setzt dort den
// in den Einstellungen gewaehlten App-Namen ein, die statische Datei den
// Standard. Alles andere muss identisch sein.
const SHARED_STRING_KEYS = ['description', 'id', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'lang'];

for (const key of SHARED_STRING_KEYS) {
  test(`${key} ist in beiden Manifest-Quellen gleich`, () => {
    const raw = serverValue(key);
    assert.notEqual(raw, null, `${key} fehlt in der Server-Route`);
    assert.equal(raw.replace(/^'|'$/g, ''), String(staticManifest[key]),
      `${key} ist auseinandergelaufen - eine Quelle wurde ohne die andere geaendert`);
  });
}

test('display_override ist in beiden Quellen gleich', () => {
  const raw = serverValue('display_override');
  assert.notEqual(raw, null, 'display_override fehlt in der Server-Route');
  const parsed = JSON.parse(raw.replace(/'/g, '"'));
  assert.deepEqual(parsed, staticManifest.display_override);
});

test('beide Quellen fuehren dieselben Icons', () => {
  const src = serverManifestSource();
  for (const icon of staticManifest.icons) {
    assert.ok(src.includes(`src: '${icon.src}'`),
      `${icon.src} fehlt in der Server-Route`);
  }
  const serverIconCount = (src.match(/src: '\/icons\//g) || []).length;
  assert.equal(serverIconCount, staticManifest.icons.length,
    'die Server-Route fuehrt eine andere Zahl Icons als die statische Datei');
});

// `--neutral-100` ist selbst eine Weiterleitung auf `--_neutral-100`; der
// Rohwert steht dort und wird im Dark-Theme ueberschrieben. Verglichen wird
// gegen die erste Definition, also die des hellen `:root` - das ist die Farbe,
// die die Installations-Huelle traegt.
test('theme_color folgt dem Rohwert von --_neutral-100 aus tokens.css', () => {
  const tokens = fs.readFileSync(path.join(HERE, '..', 'public', 'styles', 'tokens.css'), 'utf8');
  const m = tokens.match(/--_neutral-100:\s*(#[0-9a-fA-F]{3,8})\s*;/);
  assert.notEqual(m, null, '--_neutral-100 nicht in tokens.css gefunden');
  assert.equal(staticManifest.theme_color.toUpperCase(), m[1].trim().toUpperCase(),
    'der App-Grund im Manifest ist nicht mehr der Token-Wert');
});

// Gegenprobe zur Ableitung selbst: findet der Leser den Wert ueberhaupt, oder
// waeren die Vergleiche oben null gegen null?
test('serverValue liest die Route wirklich aus', () => {
  assert.equal(serverValue('display'), "'standalone'");
  assert.equal(serverValue('nicht_vorhanden'), null);
});
