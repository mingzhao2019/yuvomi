/**
 * Modul: Holidays-Test (Feiertage & Schulferien)
 * Zweck: Validiert den Holiday-Service – Cache-Lese-Pfad (getForRange) mit
 *        Datumsüberlappung, Layer-Toggles, Subdivision-Matching und Farb-
 *        Zuordnung; sowie sync()/getCountries()/getSubdivisions() gegen eine
 *        gemockte OpenHolidays-API (kein Netzwerk).
 * Ausführen: node --experimental-sqlite test/test-holidays.js
 */

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { MIGRATIONS, _setTestDatabase, _resetTestDatabase } from '../server/db.js';
import { sync, getForRange, getCountries, getSubdivisions, getGroups, __setFetchImpl } from '../server/services/holidays.js';

// In-Memory-DB mit allen Migrationen (inkl. v49 holiday_cache) aufbauen.
function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

// ---- Helpers ----------------------------------------------------------------

function resetState() {
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'holiday_%'").run();
  // AUCH DIE DATENSPRACHE, und das ist keine Kosmetik: seit #946 entscheidet
  // sie, in welcher Sprache die Namen im Cache landen. Bliebe sie zwischen
  // zwei Tests stehen, haetten die Erwartungen des einen die Voraussetzung des
  // naechsten gesetzt - der ganze Rest der Suite haenge dann an der Reihenfolge.
  db.prepare("DELETE FROM sync_config WHERE key IN ('language', 'region')").run();
  db.prepare('DELETE FROM holiday_cache').run();
}

function setConfig(cfg) {
  const set = db.prepare(`INSERT INTO sync_config (key, value) VALUES (?, ?)
                          ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined || v === null) continue;
    set.run(k, String(v));
  }
}

function seedHoliday({ type, country = 'DE', subdivision = null, group = null, start, end, name = 'Test', year }) {
  db.prepare(`INSERT INTO holiday_cache (type, country, subdivision, start_date, end_date, name, year, group_code)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(type, country, subdivision, start, end, name, year ?? Number(start.slice(0, 4)), group);
}

const okJson = (data) => ({ ok: true, json: async () => data });

// Fängt alle console-Kanäle ab, damit ein Lauf beobachtbar wird, welche
// Log-Level der Service tatsächlich benutzt. Der Logger schreibt debug über
// console.log und info über console.info (server/logger.js), sodass eine
// leere info-Liste beweist: nichts landet im Standard-Log-Level.
async function captureConsole(fn) {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const lines = { log: [], info: [], warn: [], error: [] };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => lines[level].push(args.join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

// fetch-Mock, das je nach OpenHolidays-Endpoint deterministische Daten liefert.
function makeApiMock() {
  const calls = [];
  const fn = async (url) => {
    const s = String(url);
    calls.push(s);
    const path = new URL(s).pathname;
    const country = new URL(s).searchParams.get('countryIsoCode');
    if (path === '/PublicHolidays') {
      if (country === 'BR') return okJson([]);
      // Spanien wie in #946: die Landessprache steht ZUERST im Array, Englisch
      // weiter hinten - und "Reyes" fuehrt die API nur auf Spanisch und
      // Katalanisch. So laesst sich beides pruefen: die Wahl der Wunschsprache
      // und der Rueckfall, wenn es sie nicht gibt.
      if (country === 'ES') {
        return okJson([
          { startDate: '2026-12-25', endDate: '2026-12-25',
            name: [
              { language: 'ES', text: 'Navidad' },
              { language: 'CA', text: 'Nadal' },
              { language: 'EN', text: 'Christmas Day' },
              { language: 'DE', text: 'Weihnachtstag' },
            ] },
          { startDate: '2026-01-06', endDate: '2026-01-06',
            name: [
              { language: 'ES', text: 'Reyes' },
              { language: 'CA', text: 'Reis' },
            ] },
          // Weder Deutsch noch die Landessprache zuerst-genommen: dieser
          // Eintrag trennt die mittlere Stufe der Kaskade (Englisch) von der
          // letzten (die erste angebotene). Ohne ihn waeren beide Fassungen
          // gleich und ein Test darueber bewiese nichts.
          { startDate: '2026-05-01', endDate: '2026-05-01',
            name: [
              { language: 'ES', text: 'Fiesta del Trabajo' },
              { language: 'CA', text: 'Festa del Treball' },
              { language: 'EN', text: 'Labour Day' },
            ] },
        ]);
      }
      return okJson([{ startDate: '2026-01-01', endDate: '2026-01-01',
        name: [{ language: 'DE', text: 'Neujahr' }, { language: 'EN', text: "New Year's Day" }] }]);
    }
    if (path === '/SchoolHolidays') {
      return okJson([
        { startDate: '2026-07-20', endDate: '2026-08-30',
          name: [{ language: 'DE', text: 'Sommerferien' }, { language: 'EN', text: 'Summer break' }] },
        // Sub-regionale Insel-Ausnahme (Sylt/Föhr/…): abweichendes Enddatum,
        // von OpenHolidays mit "Exception" getaggt – muss verworfen werden (#434).
        { startDate: '2026-07-20', endDate: '2026-08-23', tags: ['Exception'],
          name: [{ language: 'DE', text: 'Sommerferien' }, { language: 'EN', text: 'Summer break' }] },
      ]);
    }
    if (path === '/Countries') {
      return okJson([
        { isoCode: 'DE', name: [{ language: 'EN', text: 'Germany' }, { language: 'DE', text: 'Deutschland' }] },
        { isoCode: 'FR', name: [{ language: 'EN', text: 'France' }] },
      ]);
    }
    if (path === '/Subdivisions') {
      return okJson([
        { isoCode: 'DE-BY', name: [{ language: 'EN', text: 'Bavaria' }, { language: 'DE', text: 'Bayern' }] },
        { code: 'DE-BW', name: [], shortName: 'BW' },
      ]);
    }
    return okJson([]);
  };
  fn.calls = calls;
  return fn;
}

const SYNC_YEAR_SPAN = 4; // currentYear-1 .. currentYear+2
const BRAZIL_PUBLIC_HOLIDAYS_PER_YEAR = 10;

beforeEach(() => { resetState(); __setFetchImpl(null); });

// ---- getForRange -------------------------------------------------------------

test('getForRange: [] when no country configured', () => {
  setConfig({ holiday_show_public: '1' });
  assert.deepEqual(getForRange('2026-01-01', '2026-12-31'), []);
});

test('getForRange: [] when both layers disabled', () => {
  setConfig({ holiday_country: 'DE', holiday_show_public: '0', holiday_show_school: '0' });
  seedHoliday({ type: 'public', start: '2026-01-01', end: '2026-01-01' });
  assert.deepEqual(getForRange('2026-01-01', '2026-12-31'), []);
});

test('getForRange: returns public holiday with configured public color', () => {
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_public_color: '#AA0000' });
  seedHoliday({ type: 'public', start: '2026-01-01', end: '2026-01-01', name: 'Neujahr' });
  const rows = getForRange('2026-01-01', '2026-01-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'public');
  assert.equal(rows[0].name, 'Neujahr');
  assert.equal(rows[0].color, '#AA0000');
});

test('getForRange: school holiday uses the school color, not the public one', () => {
  setConfig({ holiday_country: 'DE', holiday_show_school: '1',
    holiday_public_color: '#AA0000', holiday_school_color: '#00AA00' });
  seedHoliday({ type: 'school', start: '2026-07-20', end: '2026-08-30', name: 'Sommerferien' });
  const rows = getForRange('2026-08-01', '2026-08-10');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].color, '#00AA00');
});

test('getForRange: date overlap – includes spanning ranges, excludes outside ones', () => {
  setConfig({ holiday_country: 'DE', holiday_show_public: '1' });
  seedHoliday({ type: 'public', start: '2025-12-31', end: '2025-12-31', name: 'Silvester' }); // before
  seedHoliday({ type: 'public', start: '2026-01-01', end: '2026-01-06', name: 'Spanning' });   // overlaps start edge
  seedHoliday({ type: 'public', start: '2026-06-15', end: '2026-06-15', name: 'Inside' });      // inside
  seedHoliday({ type: 'public', start: '2027-01-01', end: '2027-01-01', name: 'After' });        // after
  const names = getForRange('2026-01-05', '2026-12-31').map((r) => r.name).sort();
  assert.deepEqual(names, ['Inside', 'Spanning']);
});

test('getForRange: type toggle hides school when only public is enabled', () => {
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0' });
  seedHoliday({ type: 'public', start: '2026-05-01', end: '2026-05-01', name: 'Labour Day' });
  seedHoliday({ type: 'school', start: '2026-05-01', end: '2026-05-10', name: 'May break' });
  const rows = getForRange('2026-05-01', '2026-05-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'public');
});

test('getForRange: subdivision – national + matching region shown, other region hidden', () => {
  setConfig({ holiday_country: 'DE', holiday_subdivision: 'DE-BY', holiday_show_public: '1' });
  seedHoliday({ type: 'public', subdivision: null,    start: '2026-10-03', end: '2026-10-03', name: 'National' });
  seedHoliday({ type: 'public', subdivision: 'DE-BY', start: '2026-11-01', end: '2026-11-01', name: 'Bavaria only' });
  seedHoliday({ type: 'public', subdivision: 'DE-BW', start: '2026-11-01', end: '2026-11-01', name: 'BW only' });
  const names = getForRange('2026-01-01', '2026-12-31').map((r) => r.name).sort();
  assert.deepEqual(names, ['Bavaria only', 'National']);
});

test('getForRange: collapses identical holidays left over from an old scope – no duplicates (#434)', () => {
  // Simuliert einen Alt-Cache aus der Zeit vor dem DELETE-all-Fix: derselbe
  // Feiertag liegt sowohl im länderweiten (NULL-) als auch im heutigen
  // Regions-Scope. Der Kalender darf ihn trotzdem nur einmal anzeigen.
  setConfig({ holiday_country: 'DE', holiday_subdivision: 'DE-SH', holiday_show_public: '1' });
  seedHoliday({ type: 'public', subdivision: null,    start: '2026-01-01', end: '2026-01-01', name: 'Neujahr' });
  seedHoliday({ type: 'public', subdivision: 'DE-SH', start: '2026-01-01', end: '2026-01-01', name: 'Neujahr' });
  seedHoliday({ type: 'public', subdivision: '',      start: '2026-01-01', end: '2026-01-01', name: 'Neujahr' });
  const rows = getForRange('2026-01-01', '2026-12-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Neujahr');
});

test('getForRange: collapses overlapping same-name school variants into one union span (#434, CH-BE)', () => {
  // OpenHolidays liefert für Kanton Bern zwei "Sommerferien" mit abweichenden
  // Terminen (deutsch- vs. französischsprachige Schulregion, groups CH-BE-VS/-EO).
  // Kein "Exception"-Tag, unterschiedliche Daten → beide landen im Cache. Der
  // Kalender darf trotzdem nur EINEN Balken zeigen: die Union-Spanne.
  setConfig({ holiday_country: 'CH', holiday_subdivision: 'CH-BE', holiday_show_school: '1' });
  seedHoliday({ type: 'school', country: 'CH', subdivision: 'CH-BE',
    start: '2026-07-04', end: '2026-08-09', name: 'Sommerferien' });
  seedHoliday({ type: 'school', country: 'CH', subdivision: 'CH-BE',
    start: '2026-07-06', end: '2026-08-14', name: 'Sommerferien' });

  const rows = getForRange('2026-07-01', '2026-08-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Sommerferien');
  assert.equal(rows[0].start_date, '2026-07-04'); // frühester Start
  assert.equal(rows[0].end_date, '2026-08-14');   // spätestes Ende
});

test('getForRange: keeps non-overlapping same-name entries separate (movable days)', () => {
  // Gleichnamige, aber zeitlich getrennte Einträge (z. B. mehrere bewegliche
  // Ferientage) dürfen NICHT zu einer Monatsspanne verschmolzen werden.
  setConfig({ holiday_country: 'CH', holiday_show_school: '1' });
  seedHoliday({ type: 'school', country: 'CH', start: '2026-03-02', end: '2026-03-02', name: 'Ferientag' });
  seedHoliday({ type: 'school', country: 'CH', start: '2026-06-15', end: '2026-06-15', name: 'Ferientag' });
  const rows = getForRange('2026-01-01', '2026-12-31');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.start_date), ['2026-03-02', '2026-06-15']);
});

// ---- Schulferien-Gruppen (#434) ---------------------------------------------

test('getForRange: configured group shows only that regime, not the union (#434, CH-BE-VS)', () => {
  // Deutschsprachiger Kantonsteil (CH-BE-VS) endet am 09.08.; die
  // französischsprachige Variante (CH-BE-EO) bis 14.08. muss ausgeblendet
  // bleiben, statt zu einer falschen Union-Spanne zu verschmelzen.
  setConfig({ holiday_country: 'CH', holiday_subdivision: 'CH-BE',
    holiday_group: 'CH-BE-VS', holiday_show_school: '1' });
  seedHoliday({ type: 'school', country: 'CH', subdivision: 'CH-BE', group: 'CH-BE-VS',
    start: '2026-07-04', end: '2026-08-09', name: 'Sommerferien' });
  seedHoliday({ type: 'school', country: 'CH', subdivision: 'CH-BE', group: 'CH-BE-EO',
    start: '2026-07-06', end: '2026-08-14', name: 'Sommerferien' });

  const rows = getForRange('2026-07-01', '2026-08-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].end_date, '2026-08-09'); // nur das VS-Regime
});

test('getForRange: configured group still shows group-less rows (public holidays) (#434)', () => {
  // Feiertage tragen keine Gruppe (group_code NULL) und gelten für die ganze
  // Subdivision – sie dürfen trotz gewählter Schulferien-Gruppe erscheinen.
  setConfig({ holiday_country: 'CH', holiday_subdivision: 'CH-BE',
    holiday_group: 'CH-BE-EO', holiday_show_public: '1', holiday_show_school: '1' });
  seedHoliday({ type: 'public', country: 'CH', subdivision: 'CH-BE', group: null,
    start: '2026-08-01', end: '2026-08-01', name: 'Bundesfeier' });
  seedHoliday({ type: 'school', country: 'CH', subdivision: 'CH-BE', group: 'CH-BE-VS',
    start: '2026-01-31', end: '2026-02-08', name: 'Februarwoche' }); // nur VS
  const names = getForRange('2026-01-01', '2026-12-31').map((r) => r.name).sort();
  assert.deepEqual(names, ['Bundesfeier']); // Februarwoche (VS) ausgeblendet
});

test('getGroups: returns groups for a multilingual subdivision, sorted', async () => {
  __setFetchImpl(async (url) => {
    assert.equal(new URL(String(url)).pathname, '/Subdivisions');
    return okJson([
      { code: 'CH-BE', name: [], shortName: 'BE', groups: [
        { code: 'CH-BE-VS', shortName: 'BE-VS' },
        { code: 'CH-BE-EO', shortName: 'BE-EO' },
      ] },
      { code: 'CH-ZH', name: [], shortName: 'ZH', groups: [] },
    ]);
  });
  const groups = await getGroups('CH', 'CH-BE');
  assert.deepEqual(groups, [
    { code: 'CH-BE-EO', name: 'BE-EO' },
    { code: 'CH-BE-VS', name: 'BE-VS' },
  ]);
});

test('getGroups: [] for a subdivision without groups', async () => {
  __setFetchImpl(async () => okJson([
    { code: 'CH-ZH', name: [], shortName: 'ZH', groups: [] },
  ]));
  assert.deepEqual(await getGroups('CH', 'CH-ZH'), []);
});

test('sync: stores group_code from the OpenHolidays groups field (#434)', async () => {
  __setFetchImpl(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/SchoolHolidays') {
      return okJson([
        { startDate: '2026-07-04', endDate: '2026-08-09',
          name: [{ language: 'DE', text: 'Sommerferien' }], groups: [{ code: 'CH-BE-VS' }] },
        { startDate: '2026-07-06', endDate: '2026-08-14',
          name: [{ language: 'DE', text: 'Sommerferien' }], groups: [{ code: 'CH-BE-EO' }] },
      ]);
    }
    return okJson([]);
  });
  setConfig({ holiday_country: 'CH', holiday_subdivision: 'CH-BE', holiday_show_school: '1' });
  await sync(true);
  const stored = db.prepare(
    "SELECT group_code FROM holiday_cache WHERE end_date = '2026-08-09'",
  ).get();
  assert.equal(stored.group_code, 'CH-BE-VS');
});

// ---- sync --------------------------------------------------------------------

test('sync: no country → no fetch, synced 0', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  const res = await sync();
  assert.deepEqual(res, { synced: 0 });
  assert.equal(mock.calls.length, 0);
});

test('sync: both layers off → no fetch, synced 0', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'DE', holiday_show_public: '0', holiday_show_school: '0' });
  const res = await sync();
  assert.deepEqual(res, { synced: 0 });
  assert.equal(mock.calls.length, 0);
});

// Die drei Skip-Pfade laufen bei jedem Scheduler-Tick. Sie dürfen im
// Standard-Log-Level (info) nichts ausgeben, sonst rauscht das Log zu.
test('sync: no country → schweigt im Standard-Log-Level', async () => {
  __setFetchImpl(makeApiMock());
  const lines = await captureConsole(() => sync());
  assert.deepEqual(lines.info, []);
});

test('sync: both layers off → schweigt im Standard-Log-Level', async () => {
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'DE', holiday_show_public: '0', holiday_show_school: '0' });
  const lines = await captureConsole(() => sync());
  assert.deepEqual(lines.info, []);
});

test('sync: throttled run → schweigt im Standard-Log-Level', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({
    holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0',
    holiday_last_sync: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    // Seit #946 gilt die Sperre nur, solange die Sprache dieselbe ist wie beim
    // letzten Lauf. Ohne diese Zeile HAETTE der Lauf zu recht gefetcht - der
    // Cache stuende dann in einer anderen Sprache als der eingestellten.
    holiday_last_sync_language: 'EN',
  });
  const lines = await captureConsole(() => sync());
  assert.equal(mock.calls.length, 0, 'throttled run darf nicht fetchen');
  assert.deepEqual(lines.info, []);
});

test('sync: public-only fetches PublicHolidays per year, caches them, sets last_sync', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  // Die Datensprache steht ausdruecklich da: sie - nicht das Land - entscheidet
  // seit #946, welcher Name im Cache landet.
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0', language: 'de' });

  const res = await sync(true);

  assert.equal(res.synced, SYNC_YEAR_SPAN);
  assert.ok(mock.calls.every((u) => u.includes('/PublicHolidays')));
  assert.ok(!mock.calls.some((u) => u.includes('/SchoolHolidays')));

  const pub = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='public'").get().c;
  assert.equal(pub, SYNC_YEAR_SPAN);
  // Deutsche Datensprache → deutscher Name aus dem name-Array
  assert.equal(db.prepare('SELECT name FROM holiday_cache LIMIT 1').get().name, 'Neujahr');
  // last_sync persisted
  assert.ok(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync'").get()?.value);
});

test('sync: is idempotent – re-running does not duplicate cached rows', async () => {
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0' });
  await sync(true);
  await sync(true);
  const pub = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='public'").get().c;
  assert.equal(pub, SYNC_YEAR_SPAN);
});

test('sync: switching region purges the previous scope – no duplicate holidays (#434)', async () => {
  __setFetchImpl(makeApiMock());
  // 1. Erst länderweit synchronisieren (subdivision NULL → nationale Feiertage).
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0' });
  await sync(true);
  // 2. Nutzer wählt danach eine Region und synchronisiert erneut.
  setConfig({ holiday_subdivision: 'DE-SH' });
  await sync(true);

  // Cache darf pro Jahr nur einen Satz enthalten (kein NULL- + Regions-Duplikat).
  const total = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='public'").get().c;
  assert.equal(total, SYNC_YEAR_SPAN);

  // Die veralteten länderweiten (NULL-)Zeilen wurden entfernt; es bleibt nur
  // der aktuell gewählte Regions-Scope übrig.
  const stale = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE subdivision IS NULL").get().c;
  assert.equal(stale, 0);
});

test('sync: both layers enabled caches public and school entries', async () => {
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '1' });
  const res = await sync(true);
  assert.equal(res.synced, SYNC_YEAR_SPAN * 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='public'").get().c, SYNC_YEAR_SPAN);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='school'").get().c, SYNC_YEAR_SPAN);
});

test('sync: drops "Exception"-tagged sub-regional holiday variants – no duplicate school breaks (#434)', async () => {
  __setFetchImpl(makeApiMock());
  // Schleswig-Holstein: OpenHolidays liefert neben den regulären Sommerferien
  // eine zweite, "Exception"-getaggte Variante mit früherem Enddatum (Inseln).
  setConfig({ holiday_country: 'DE', holiday_subdivision: 'DE-SH',
    holiday_show_public: '0', holiday_show_school: '1' });

  const res = await sync(true);

  // Pro Jahr bleibt nur der reguläre Eintrag – die Insel-Ausnahme wird verworfen.
  assert.equal(res.synced, SYNC_YEAR_SPAN);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE type='school'").get().c, SYNC_YEAR_SPAN);
  const ends = db.prepare("SELECT DISTINCT end_date FROM holiday_cache WHERE type='school'").all().map((r) => r.end_date);
  assert.deepEqual(ends, ['2026-08-30']); // nur das reguläre Enddatum, nicht 2026-08-23
});

test('sync: Brazil local fallback follows the data language, not the country', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'BR', holiday_show_public: '1', holiday_show_school: '0', language: 'pt' });

  const res = await sync(true);

  assert.equal(res.synced, SYNC_YEAR_SPAN * BRAZIL_PUBLIC_HOLIDAYS_PER_YEAR);
  assert.ok(mock.calls.every((url) => url.includes('countryIsoCode=BR')));

  const currentYear = new Date().getFullYear();
  const namesOf = () => db.prepare(
    "SELECT name FROM holiday_cache WHERE country='BR' AND type='public' AND year=? ORDER BY start_date"
  ).all(currentYear).map((row) => row.name);
  let names = namesOf();
  assert.ok(names.includes('Tiradentes'));
  assert.ok(names.includes('Dia Nacional de Zumbi e da Consciência Negra'));
  assert.ok(names.includes('Natal'));

  // Derselbe Haushalt, dieselbe Ortsliste - nur die Datensprache wechselt. Der
  // Fallback kennt beide Fassungen; vorher entschied das LAND und Englisch war
  // unerreichbar (#946).
  setConfig({ language: 'en' });
  await sync(true);
  names = namesOf();
  assert.ok(names.includes('Christmas Day'), `EN-Fassung erwartet, bekam: ${names.join(', ')}`);
  assert.ok(!names.includes('Natal'));
});

test('sync: throttles automatic sync if executed within 30 days', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'DE', holiday_show_public: '1', holiday_show_school: '0' });

  // First sync (force=false) - should run because DB has no last_sync
  const res1 = await sync(false);
  assert.equal(res1.synced, SYNC_YEAR_SPAN);
  const firstCallCount = mock.calls.length;
  assert.ok(firstCallCount > 0);

  // Second sync (force=false) - should throttle (skip)
  const res2 = await sync(false);
  assert.deepEqual(res2, { synced: 0 });
  assert.equal(mock.calls.length, firstCallCount); // no new API calls

  // Third sync (force=true) - should bypass throttle
  const res3 = await sync(true);
  assert.equal(res3.synced, SYNC_YEAR_SPAN);
  assert.equal(mock.calls.length, firstCallCount * 2); // new API calls made
});

// ---- Sprache der gespeicherten Eintraege (#946) ------------------------------

test('sync: die Namen folgen der Datensprache, nicht dem Land (#946)', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  // Der gemeldete Fall: Land Spanien, Region Katalonien, Datensprache Englisch.
  // Vorher leitete der Dienst die Sprache aus dem LAND ab und speicherte
  // "Navidad" - auch fuer einen Haushalt, der ausdruecklich Englisch gewaehlt
  // hatte und dem der Hinweis unter dem Feld Wirkung auf die Synchronisierung
  // zusagt.
  setConfig({
    holiday_country: 'ES', holiday_subdivision: 'ES-CT',
    holiday_show_public: '1', holiday_show_school: '0', language: 'en',
  });

  await sync(true);

  const namen = db.prepare("SELECT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-12-25'").all().map((r) => r.name);
  assert.ok(namen.length > 0, 'ohne gespeicherte Zeile prueft die Zusicherung darunter nichts');
  assert.deepEqual([...new Set(namen)], ['Christmas Day'],
    'die eingestellte Datensprache entscheidet, nicht das Land');
});

test('sync: eine deutsche Datensprache bekommt denselben Feiertag auf Deutsch (#946)', async () => {
  __setFetchImpl(makeApiMock());
  // Die Gegenprobe zum Test darueber: dasselbe Land, dieselbe Region, nur eine
  // andere Datensprache. Ohne sie belegte der Test oben genauso gut einen
  // Dienst, der IMMER Englisch speichert.
  setConfig({
    holiday_country: 'ES', holiday_subdivision: 'ES-CT',
    holiday_show_public: '1', holiday_show_school: '0', language: 'de',
  });

  await sync(true);

  const namen = db.prepare("SELECT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-12-25'").all().map((r) => r.name);
  assert.deepEqual([...new Set(namen)], ['Weihnachtstag']);
});

test('sync: fehlt die Wunschsprache, gilt Englisch vor der ersten angebotenen (#946)', async () => {
  __setFetchImpl(makeApiMock());
  // Der 1. Mai steht im Mock auf Spanisch, Katalanisch und Englisch - nicht auf
  // Deutsch. Die alte Kaskade hiess "Wunsch, sonst die ERSTE", und die erste
  // ist die Landessprache: ein deutscher Haushalt bekam "Fiesta del Trabajo"
  // untergeschoben, obwohl eine englische Fassung danebenlag. Englisch fuehrt
  // OpenHolidays fuer nahezu jedes Land mit und ist damit die bessere Auskunft
  // als "was der Server zufaellig zuerst nennt".
  setConfig({
    holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'de',
  });

  await sync(true);

  const mai = db.prepare("SELECT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-05-01'").all().map((r) => r.name);
  assert.ok(mai.length > 0, 'ohne gespeicherte Zeile prueft die Zusicherung darunter nichts');
  assert.deepEqual([...new Set(mai)], ['Labour Day'],
    'keine deutsche Fassung, aber eine englische → Englisch, nicht die Landessprache');

  // Und wo es auch kein Englisch gibt, bleibt die erste angebotene der letzte
  // Halt - sonst stuende die Zeile leer da.
  const reyes = db.prepare("SELECT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-01-06'").all().map((r) => r.name);
  assert.deepEqual([...new Set(reyes)], ['Reyes']);
});

test('sync: fragt ohne languageIsoCode, damit die Wahl hier faellt (#946)', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });

  await sync(true);

  assert.ok(mock.calls.length > 0, 'ohne Abruf prueft die Zusicherung darunter nichts');
  const mitFilter = mock.calls.filter((url) => url.includes('languageIsoCode'));
  assert.deepEqual(mitFilter, [],
    'Mit languageIsoCode liefert OpenHolidays je Feiertag nur EINEN Namen - und wenn es\n'
    + 'den in der gefragten Sprache nicht gibt, den der Landessprache. Die Kaskade in\n'
    + 'resolveName laeuft dann ueber ein einelementiges Array und kann nichts mehr waehlen.');
});

test('sync: ein Sprachwechsel bricht die 30-Tage-Sperre (#946)', async () => {
  const mock = makeApiMock();
  __setFetchImpl(mock);
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });

  await sync(true);
  const nachErstem = mock.calls.length;
  assert.ok(nachErstem > 0);

  // Gleiche Sprache: die Sperre greift wie bisher.
  assert.deepEqual(await sync(false), { synced: 0 });
  assert.equal(mock.calls.length, nachErstem, 'ohne Sprachwechsel bleibt es beim Bestand');

  // Andere Sprache: die Namen im Cache stehen in der falschen Sprache, also
  // muss der Lauf durch. Sonst saehe der Haushalt bis zu einen Monat lang
  // weiter die alten Namen und meldete den Fehler zu recht erneut.
  setConfig({ language: 'de' });
  const res = await sync(false);
  assert.ok(res.synced > 0, 'ein Sprachwechsel muss den Bestand erneuern');
  assert.ok(mock.calls.length > nachErstem);

  const namen = db.prepare("SELECT name FROM holiday_cache WHERE country='ES' AND start_date LIKE '%-12-25'").all().map((r) => r.name);
  assert.deepEqual([...new Set(namen)], ['Weihnachtstag']);
  assert.equal(
    db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_language'").get()?.value,
    'DE',
    'die benutzte Sprache steht neben dem Zeitstempel, sonst laeuft jeder Lauf erneut durch',
  );
});

test('sync: ein gescheiterter Lauf schreibt die Sprache NICHT fest (#946)', async () => {
  // GEFUNDEN VON CODEX UND claude-review, unabhaengig voneinander. Der
  // Sprach-Merker stand unbedingt nach der Schleife: schlug auch nur ein Jahr
  // fehl, blieb dieser Bereich in der alten Sprache - verbucht wurde der Lauf
  // trotzdem als erledigt, und die 30-Tage-Sperre schrieb den halb
  // uebersetzten Cache fuer einen Monat fest. Dieselbe Sorte Fehler wie ein
  // Sync-Cursor, der ueber einen Fehlschlag hinweglaeuft (#839).
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });
  __setFetchImpl(makeApiMock());
  await sync(true);
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_language'").get()?.value, 'EN');

  // Sprachwechsel, aber die API antwortet nicht mehr.
  setConfig({ language: 'de' });
  const kaputt = async () => { throw new Error('network down'); };
  kaputt.calls = [];
  __setFetchImpl(kaputt);
  await captureConsole(() => sync(true));

  assert.equal(
    db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_language'").get()?.value,
    'EN',
    'ein unvollstaendiger Lauf darf die neue Sprache nicht als erledigt verbuchen',
  );

  // Und der naechste Lauf holt es nach, sobald die API wieder da ist.
  db.prepare("DELETE FROM sync_config WHERE key='holiday_language_retry_after'").run();
  __setFetchImpl(makeApiMock());
  const res = await sync(false);
  assert.ok(res.synced > 0, 'der offene Sprachwechsel muss beim naechsten Lauf greifen');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_language'").get()?.value, 'DE');
});

test('sync: nach einem Fehlschlag wird der Nachlauf gebremst, nicht wiederholt gehaemmert (#946)', async () => {
  // Der Scheduler laeuft alle 15 Minuten (SYNC_INTERVAL_MINUTES). Bliebe der
  // Sprach-Merker offen UND ungebremst, liefe bei einem Ausfall der Fremd-API
  // rund um die Uhr alle 15 Minuten ein neuer Anlauf gegen einen kostenlosen
  // Fremddienst. Gebremst wird NUR der Wiederholungsversuch - ein frischer
  // Sprachwechsel wirkt weiterhin sofort, sonst waere die Bremse genau die
  // Verzoegerung, die dieser Nachlauf abschaffen sollte.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });
  __setFetchImpl(makeApiMock());
  await sync(true);

  setConfig({ language: 'de' });
  const kaputt = async () => { throw new Error('network down'); };
  __setFetchImpl(kaputt);
  await captureConsole(() => sync(true));

  const gebremstBis = db.prepare("SELECT value FROM sync_config WHERE key='holiday_language_retry_after'").get()?.value;
  assert.ok(gebremstBis, 'ein Fehlschlag muss eine Wartemarke hinterlassen');
  assert.ok(new Date(gebremstBis).getTime() > Date.now(), 'die Wartemarke liegt in der Zukunft');

  const mock = makeApiMock();
  __setFetchImpl(mock);
  assert.deepEqual(await sync(false), { synced: 0 }, 'solange die Wartemarke gilt, wird nicht erneut gefetcht');
  assert.equal(mock.calls.length, 0);

  // Von Hand ausgeloest (Knopf "Jetzt synchronisieren") gilt die Bremse nicht.
  const res = await sync(true);
  assert.ok(res.synced > 0, 'force muss die Wartemarke uebergehen');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_language_retry_after'").get()?.value, undefined,
    'ein geglueckter Lauf raeumt die Wartemarke weg');
});

test('sync: der Brasilien-Ersatz folgt derselben Kaskade wie die API-Namen (#946)', async () => {
  // Die Ersatzliste kennt nur PT und EN. Ihr Rueckfall stand auf PT - was fuer
  // einen brasilianischen Haushalt richtig aussieht, aber der Zusage
  // widerspricht, die dieser PR aufstellt: ein deutscher Haushalt bekam
  // Portugiesisch, obwohl eine englische Fassung danebenlag.
  __setFetchImpl(makeApiMock());
  setConfig({ holiday_country: 'BR', holiday_show_public: '1', holiday_show_school: '0', language: 'de' });

  await sync(true);

  const currentYear = new Date().getFullYear();
  const namen = db.prepare(
    "SELECT name FROM holiday_cache WHERE country='BR' AND type='public' AND year=?"
  ).all(currentYear).map((r) => r.name);
  assert.ok(namen.length > 0, 'ohne gespeicherte Zeile prueft die Zusicherung darunter nichts');
  assert.ok(namen.includes('Christmas Day'),
    `keine deutsche Fassung, aber eine englische → Englisch, nicht Portugiesisch. Bekam: ${namen.join(', ')}`);
  assert.ok(!namen.includes('Natal'));
});

test('sync: ein geglueckter LEERER Abruf laesst nichts Altes stehen (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT, als zweite Fassung des Fehlers darueber: die
  // HTTP-erfolgreiche Leerantwort nimmt einen eigenen Weg, den der Fix fuer den
  // FEHLER-Fall nicht mit abdeckte. Sie meldete `failed: false`, ohne die alten
  // Zeilen anzufassen - ausgerechnet dieser Bereich behielt seine
  // fremdsprachigen Namen, waehrend der Lauf als vollstaendig verbucht wurde.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'es' });
  __setFetchImpl(makeApiMock());
  await sync(true);
  const vorher = db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE country='ES'").get().c;
  assert.ok(vorher > 0, 'ohne Bestand prueft die Zusicherung darunter nichts');

  // Dieselbe Quelle, aber sie kennt jetzt nichts mehr - mit HTTP 200.
  const leer = async () => ({ ok: true, json: async () => [] });
  __setFetchImpl(leer);
  setConfig({ language: 'de' });
  const res = await sync(true);

  assert.equal(db.prepare("SELECT COUNT(*) c FROM holiday_cache WHERE country='ES'").get().c, 0,
    'ein geglueckter leerer Abruf ist eine Auskunft - der Cache spiegelt sie, statt Altes zu behalten');
  assert.equal(res.incomplete, false, 'eine Leerantwort ist kein Fehlschlag');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_language'").get()?.value, 'DE',
    'und darf deshalb den Sprach-Merker setzen - es steht ja nichts Fremdsprachiges mehr da');
});

test('sync: die Wartemarke bremst nur die Sprache, bei der es schiefging (#946)', async () => {
  // GEFUNDEN IN DER PR-DURCHSICHT. Die Marke trug zuerst nur einen Zeitpunkt -
  // und bremste damit auch eine INZWISCHEN ANDERS gewaehlte Sprache aus, obwohl
  // deren Versuch neu ist und noch nie gescheitert war.
  setConfig({ holiday_country: 'ES', holiday_show_public: '1', holiday_show_school: '0', language: 'en' });
  __setFetchImpl(makeApiMock());
  await sync(true);

  // Nachlauf auf DE scheitert → Marke fuer DE.
  setConfig({ language: 'de' });
  __setFetchImpl(async () => { throw new Error('network down'); });
  await captureConsole(() => sync(true));
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_language_retry_for'").get()?.value, 'DE');

  // Derselbe Wunsch DE wird gebremst ...
  const mockDe = makeApiMock();
  __setFetchImpl(mockDe);
  assert.deepEqual(await sync(false), { synced: 0 });
  assert.equal(mockDe.calls.length, 0);

  // ... eine FRISCH gewaehlte Sprache nicht.
  setConfig({ language: 'es' });
  const mockEs = makeApiMock();
  __setFetchImpl(mockEs);
  const res = await sync(false);
  assert.ok(res.synced > 0, 'ein neuer Sprachwunsch darf nicht an der Marke der alten haengenbleiben');
  assert.equal(db.prepare("SELECT value FROM sync_config WHERE key='holiday_language_retry_for'").get()?.value, undefined,
    'ein geglueckter Lauf raeumt die Marke weg');
});

// ---- getCountries / getSubdivisions -----------------------------------------

test('getCountries: prefers EN names and sorts alphabetically', async () => {
  __setFetchImpl(makeApiMock());
  const list = await getCountries();
  assert.deepEqual(list, [
    { isoCode: 'FR', name: 'France' },
    { isoCode: 'DE', name: 'Germany' },
  ]);
});

test('getSubdivisions: maps code/name, falls back to shortName, sorts', async () => {
  __setFetchImpl(makeApiMock());
  const list = await getSubdivisions('DE');
  assert.deepEqual(list, [
    { isoCode: 'DE-BY', name: 'Bavaria' },
    { isoCode: 'DE-BW', name: 'BW' },
  ]);
});

test('teardown: restore real database', () => {
  _resetTestDatabase();
});
