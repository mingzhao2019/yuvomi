/**
 * Modul: Feiertage & Schulferien (Holidays)
 * Zweck: Fetch von der OpenHolidays API, Caching in holiday_cache-Tabelle,
 *        periodischer Sync. Kein API-Key erforderlich.
 * Quelle: https://openholidaysapi.org (open source, kostenlos)
 * Abhängigkeiten: node-fetch, server/db.js
 */

import nodeFetch from 'node-fetch';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { resolveHouseholdLocale } from '../utils/i18n.js';

const log = createLogger('Holidays');

const BASE_URL          = 'https://openholidaysapi.org';
const FETCH_TIMEOUT_MS  = 15_000;
const SYNC_YEARS_BACK   = 1;
const SYNC_YEARS_AHEAD  = 2;
const THROTTLE_MS       = 30 * 24 * 60 * 60 * 1000;
// WARTEZEIT NACH EINEM GESCHEITERTEN SPRACH-NACHLAUF. Ein Sprachwechsel wirkt
// sofort - aber wenn der Abruf scheitert, bleibt der Merker offen, und ohne
// diese Bremse liefe bei einem Ausfall der Fremd-API alle
// SYNC_INTERVAL_MINUTES (Voreinstellung 15) ein neuer Anlauf.
const LANGUAGE_RETRY_MS = 60 * 60 * 1000;

// Injizierbare fetch-Implementierung (Default: node-fetch). Nur Tests
// überschreiben dies via __setFetchImpl, um die OpenHolidays-API zu mocken.
let fetchImpl = nodeFetch;
function __setFetchImpl(fn) { fetchImpl = fn ?? nodeFetch; }

// --------------------------------------------------------
// API-Abfragen
// --------------------------------------------------------

async function apiFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Alle verfügbaren Länder abrufen.
 * @returns {Promise<Array<{isoCode: string, name: string}>>}
 */
async function getCountries() {
  const raw = await apiFetch('/Countries');
  return (raw ?? []).map((c) => ({
    isoCode: c.isoCode,
    name: resolveName(c.name),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Unterteilungen (Bundesländer etc.) für ein Land abrufen.
 * @param {string} countryIsoCode z.B. 'DE'
 * @returns {Promise<Array<{isoCode: string, name: string}>>}
 */
async function getSubdivisions(countryIsoCode) {
  const raw = await apiFetch(`/Subdivisions?countryIsoCode=${encodeURIComponent(countryIsoCode)}`);
  return (raw ?? []).map((s) => ({
    isoCode: s.isoCode ?? s.code,
    name: resolveName(s.name) || s.shortName || s.isoCode || s.code,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Schulferien-Gruppen einer Subdivision abrufen. Manche Subdivisionen (v. a.
 * mehrsprachige Schweizer Kantone) teilen sich in mehrere Schulferien-Regime
 * mit abweichenden Terminen, die OpenHolidays nur über das "groups"-Feld
 * unterscheidet – z. B. CH-BE → CH-BE-VS (deutschsprachig) / CH-BE-EO (Berner
 * Jura). Erst ab zwei Gruppen ist die Auswahl relevant; bei 0/1 Gruppe gibt es
 * keine Mehrdeutigkeit und der Picker bleibt ausgeblendet. Die API liefert für
 * diese Gruppen keinen lesbaren Namen, daher wird shortName als Label genutzt. (#434)
 * @param {string} countryIsoCode  z.B. 'CH'
 * @param {string} subdivisionCode z.B. 'CH-BE'
 * @returns {Promise<Array<{code: string, name: string}>>}
 */
async function getGroups(countryIsoCode, subdivisionCode) {
  const raw = await apiFetch(`/Subdivisions?countryIsoCode=${encodeURIComponent(countryIsoCode)}`);
  const match = (raw ?? []).find((s) => (s.code ?? s.isoCode) === subdivisionCode);
  const groups = Array.isArray(match?.groups) ? match.groups : [];
  return groups
    .map((g) => ({
      code: g.code ?? g.isoCode,
      name: resolveName(g.name) || g.shortName || g.code || g.isoCode,
    }))
    .filter((g) => g.code)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Den Anzeigenamen aus dem name-Array waehlen: Wunschsprache, sonst Englisch,
 * sonst die erste angebotene.
 *
 * DIE ZWEITE STUFE IST DER PUNKT. Vorher hiess die Kaskade "Wunsch, sonst die
 * erste" - und was OpenHolidays als erste liefert, ist die Landessprache. Ein
 * englischsprachiger Haushalt in Katalonien bekam damit fuer jeden Feiertag,
 * den die API nicht auf Englisch fuehrt, den spanischen Namen, ohne dass das
 * irgendwo zu sehen gewesen waere. Englisch ist die Sprache, die OpenHolidays
 * fuer nahezu jedes Land mitliefert; sie ist die bessere Auskunft als "was der
 * Server zufaellig zuerst nennt". Die erste bleibt als letzter Halt.
 *
 * @param {Array<{language, text}>} nameArr
 * @param {string} [preferLang='EN'] Sprachcode in Grossbuchstaben
 */
function resolveName(nameArr, preferLang = 'EN') {
  if (!Array.isArray(nameArr) || nameArr.length === 0) return '';
  const pick = (lang) => nameArr.find((n) => n.language === lang);
  return (pick(preferLang) ?? pick('EN') ?? nameArr[0]).text ?? '';
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function utcDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

function localizedBrazilHolidayName(key, langCode) {
  const names = {
    universalBrotherhood: { PT: 'Confraternização Universal', EN: 'Universal Brotherhood Day' },
    goodFriday:           { PT: 'Sexta-feira Santa', EN: 'Good Friday' },
    tiradentes:           { PT: 'Tiradentes', EN: 'Tiradentes Day' },
    labourDay:            { PT: 'Dia do Trabalho', EN: 'Labour Day' },
    independence:         { PT: 'Independência do Brasil', EN: 'Independence Day' },
    aparecida:            { PT: 'Nossa Senhora Aparecida', EN: 'Our Lady of Aparecida' },
    allSouls:             { PT: 'Finados', EN: "All Souls' Day" },
    republic:             { PT: 'Proclamação da República', EN: 'Republic Proclamation Day' },
    blackConsciousness:   { PT: 'Dia Nacional de Zumbi e da Consciência Negra', EN: 'National Zumbi and Black Consciousness Day' },
    christmas:            { PT: 'Natal', EN: 'Christmas Day' },
  };
  // DIESELBE KASKADE WIE resolveName: Wunschsprache, sonst Englisch, sonst was
  // da ist. Der Rueckfall stand auf PT - was fuer einen brasilianischen
  // Haushalt richtig aussah, aber der Zusage aus #946 widerspricht: ein
  // deutscher Haushalt bekam Portugiesisch, obwohl eine englische Fassung
  // danebenlag. Die Ersatzliste kennt nur PT und EN; welche der beiden gilt,
  // entscheidet damit dieselbe Regel wie bei den Namen aus der API.
  const lang = String(langCode || '').toUpperCase();
  return names[key]?.[lang] ?? names[key]?.EN ?? names[key]?.PT ?? key;
}

function brazilPublicHolidays(year, langCode) {
  const fixed = [
    ['universalBrotherhood', 1, 1],
    ['tiradentes', 4, 21],
    ['labourDay', 5, 1],
    ['independence', 9, 7],
    ['aparecida', 10, 12],
    ['allSouls', 11, 2],
    ['republic', 11, 15],
    ['blackConsciousness', 11, 20],
    ['christmas', 12, 25],
  ].map(([key, month, day]) => {
    const date = formatIsoDate(utcDate(year, month, day));
    return { startDate: date, endDate: date, name: localizedBrazilHolidayName(key, langCode) };
  });

  const goodFriday = formatIsoDate(addDays(easterSunday(year), -2));
  return [
    fixed[0],
    { startDate: goodFriday, endDate: goodFriday, name: localizedBrazilHolidayName('goodFriday', langCode) },
    ...fixed.slice(1),
  ];
}

function localHolidayFallback(country, type, year, langCode) {
  if (country === 'BR' && type === 'public') return brazilPublicHolidays(year, langCode);
  return [];
}

// --------------------------------------------------------
// Sync-Logik
// --------------------------------------------------------

/**
 * Ein Bereich, fuer den nichts zu speichern ist - und die beiden Faelle darin
 * gehen VERSCHIEDEN aus.
 *
 * Ein GESCHEITERTER Abruf sagt nichts ueber den Bestand: der bleibt liegen,
 * dieser Bereich steht danach weiter in der alten Sprache, und `failed` haelt
 * den Sprach-Merker offen.
 *
 * Ein GEGLUECKTER Abruf mit leerem Ergebnis ist dagegen eine Auskunft: hier
 * gibt es nichts. Dann muss auch nichts liegenbleiben - sonst behielte
 * ausgerechnet dieser Bereich seine alten, fremdsprachigen Zeilen, waehrend der
 * Lauf als vollstaendig verbucht wird (gefunden in der PR-Durchsicht: die
 * HTTP-erfolgreiche Leerantwort nimmt einen eigenen Weg, den der Fix fuer den
 * Fehlerfall nicht mit abdeckte). Der Cache spiegelt die API, auch wenn sie
 * "nichts" sagt.
 */
function finishEmpty(fetchFailed, country, type, year) {
  if (fetchFailed) return { count: 0, failed: true };
  db.get().prepare('DELETE FROM holiday_cache WHERE type = ? AND country = ? AND year = ?')
    .run(type, country, year);
  return { count: 0, failed: false };
}

/**
 * Ein Jahr eines Typs holen und in den Cache legen.
 *
 * @param {string} langCode Sprachcode in GROSSBUCHSTABEN, wie OpenHolidays ihn
 *   im `name`-Array fuehrt ('ES', 'EN'). Aufrufer normalisieren, nicht diese
 *   Funktion - sonst stuende dieselbe Umwandlung an zwei Stellen.
 * @returns {Promise<{count: number, failed: boolean}>} `failed` heisst: der
 *   Abruf ist GESCHEITERT und kein lokaler Ersatz sprang ein. Das ist etwas
 *   anderes als `count: 0` - manche Laender fuehren schlicht keine Schulferien,
 *   und diese beiden Faelle auseinanderzuhalten ist der ganze Punkt: nur der
 *   erste darf den Sprach-Merker unten zurueckhalten.
 */
async function syncYearAndType(country, subdivision, year, type, langCode) {
  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;
  const endpoint = type === 'public' ? 'PublicHolidays' : 'SchoolHolidays';

  // OHNE languageIsoCode, UND DAS IST DER FIX ZU #946. Mit dem Parameter
  // liefert OpenHolidays je Feiertag nur EINEN Namen - und wenn es den in der
  // gefragten Sprache nicht gibt, den der Landessprache. Die Kaskade in
  // resolveName (Wunsch, sonst Englisch, sonst die erste) laeuft dann ueber ein
  // einelementiges Array und kann nichts mehr waehlen: sie bekam "Navidad"
  // gereicht und hatte keine Alternative danebenliegen. Ohne den Parameter
  // kommt das vollstaendige name-Array, und die Wahl faellt hier - wo bekannt
  // ist, welche Sprache der Haushalt lesen will. Der Preis ist eine groessere
  // Antwort fuer ein paar Dutzend Eintraege im Jahr.
  let params = `countryIsoCode=${encodeURIComponent(country)}&validFrom=${from}&validTo=${to}`;
  if (subdivision) params += `&subdivisionCode=${encodeURIComponent(subdivision)}`;

  let holidays;
  let fetchFailed = false;
  try {
    holidays = await apiFetch(`/${endpoint}?${params}`);
    // NUR EIN ECHTES LEERES ARRAY IST EINE AUSKUNFT. Ein HTTP 200 mit einem
    // anderen Rumpf - ein Fehlerobjekt eines vorgeschalteten Proxys, eine
    // geaenderte Antwortform - sagt gar nichts, und seit `finishEmpty` einen
    // leeren Bereich RAEUMT, waere daraus Datenverlust geworden: der Cache
    // gelöscht, der Scope als vollstaendig verbucht, und die Feiertage 30 Tage
    // lang weg. Ein Nicht-Array zaehlt deshalb wie ein gescheiterter Abruf
    // (gefunden in der PR-Durchsicht, als Folgefehler genau dieser Aenderung).
    if (!Array.isArray(holidays)) {
      log.warn(`Fetch ${endpoint} ${country}/${subdivision ?? '-'}/${year}: unexpected response shape (${typeof holidays})`);
      fetchFailed = true;
    }
  } catch (err) {
    log.warn(`Fetch ${endpoint} ${country}/${subdivision ?? '-'}/${year}: ${err.message}`);
    fetchFailed = true;
    holidays = localHolidayFallback(country, type, year, langCode);
  }

  if (!Array.isArray(holidays) || holidays.length === 0) {
    holidays = localHolidayFallback(country, type, year, langCode);
  }
  if (!Array.isArray(holidays) || holidays.length === 0) return finishEmpty(fetchFailed, country, type, year);

  // OpenHolidays liefert für Sub-Regionen abweichende Varianten desselben
  // Feiertags/derselben Ferien als eigene, mit "Exception" getaggte Einträge
  // (z. B. Schleswig-Holstein: separate Sommer-/Herbstferien nur für die Inseln
  // Sylt, Föhr, Amrum, Helgoland, Halligen). Diese haben abweichende Start-/
  // Enddaten und lassen sich daher lesen-seitig nicht kollabieren – im Kalender
  // erscheinen sie als zweiter, früher endender/startender Ferien-Eintrag.
  // Für einen Familienkalender ist der reguläre Regions-Eintrag maßgeblich; die
  // Insel-Ausnahmen werden verworfen. (#434)
  holidays = holidays.filter((h) => !(Array.isArray(h.tags) && h.tags.includes('Exception')));
  if (holidays.length === 0) return finishEmpty(fetchFailed, country, type, year);

  const insert = db.get().prepare(`
    INSERT INTO holiday_cache (type, country, subdivision, start_date, end_date, name, year, group_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.get().transaction((rows) => {
    for (const h of rows) {
      const name = typeof h.name === 'string'
        ? h.name
        : resolveName(h.name, langCode);
      // Schulferien-Gruppe (z. B. CH-BE-VS), falls die Subdivision mehrere
      // Regime kennt. Öffentliche Feiertage tragen i. d. R. keine Gruppe → NULL,
      // gilt dann für die gesamte Subdivision. (#434)
      const groupCode = Array.isArray(h.groups) && h.groups.length > 0
        ? (h.groups[0].code ?? h.groups[0].isoCode ?? null)
        : null;
      insert.run(type, country, subdivision ?? null, h.startDate, h.endDate, name, year, groupCode);
    }
  });

  // Alle Einträge dieses Landes/Jahres/Typs löschen – auch aus zuvor gewählten
  // Regionen bzw. dem länderweiten (NULL-)Scope. Verhindert doppelte Feiertage
  // beim Wechsel der Region: es ist immer nur genau eine Region konfiguriert,
  // daher darf nur der aktuell gefetchte Scope im Cache verbleiben (#434).
  db.get().prepare(
    'DELETE FROM holiday_cache WHERE type = ? AND country = ? AND year = ?'
  ).run(type, country, year);

  insertAll(holidays);
  return { count: holidays.length, failed: false };
}

/**
 * Sync Feiertage und/oder Schulferien für das konfigurierte Land/Region.
 * Wird vom Auto-Scheduler und manuell aus den Settings aufgerufen.
 */
async function sync(force = false) {
  const country     = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_country'").get()?.value;
  const subdivision = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_subdivision'").get()?.value ?? null;
  const showPublic  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_public'").get()?.value === '1';
  const showSchool  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_school'").get()?.value === '1';

  if (!country) {
    log.debug('No holiday country configured – skipping sync.');
    return { synced: 0 };
  }

  if (!showPublic && !showSchool) {
    log.debug('Both holiday layers disabled – skipping sync.');
    return { synced: 0 };
  }

  // DIE SPRACHE KOMMT AUS DER EINSTELLUNG, NICHT AUS DEM LAND. Hier stand eine
  // Karte von Land auf Sprache: wer Spanien waehlte, bekam spanische Namen -
  // auch wenn "Sprache gespeicherter Eintraege" auf Englisch stand und der
  // Hinweis darunter ausdruecklich "Wirkt auf API, Kalender-Feed und
  // Synchronisierung" verspricht (#946). Feiertage SIND selbst erzeugte
  // Eintraege; sie fallen unter genau diese Zusage, und `resolveHouseholdLocale`
  // ist die eine Stelle, die sie beantwortet - dieselbe, aus der Geburtstage,
  // Darlehensraten und Benachrichtigungen ihre Sprache holen.
  const langCode = resolveHouseholdLocale(db.get()).toUpperCase();

  // WAS DEN INHALT DES CACHES BESTIMMT, IST MEHR ALS DIE SPRACHE: Sprache,
  // Land, Region und welche Ebenen ueberhaupt geholt werden. Genau diese vier
  // bilden den SCOPE, und der steht neben dem Zeitstempel.
  //
  // Der Merker trug zuerst nur die Sprache, und daran hingen drei Befunde aus
  // der PR-Durchsicht, die alle dieselbe Wurzel hatten: eine abgeschaltete
  // Ebene wurde beim Sprachwechsel nicht mitgeholt, aber als erledigt verbucht
  // (beim Wiedereinschalten blieben ihre alten Namen stehen); ein Wechsel des
  // Landes lief in dieselbe Falle; und ein Fehlschlag OHNE Sprachwechsel wurde
  // gar nicht wiederholt, weil die Reparatur an `languageChanged` hing.
  const scope = [langCode, country, subdivision ?? '', showPublic ? 'P' : '', showSchool ? 'S' : ''].join('|');
  const lastScope = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_scope'").get()?.value ?? null;
  const scopeChanged = lastScope !== scope;

  // EINE OFFENE REPARATUR GILT UNABHAENGIG DAVON, OB SICH ETWAS GEAENDERT HAT.
  // Sie entsteht nur nach einem gescheiterten Abruf und traegt den Scope, bei
  // dem es schiefging: derselbe Scope wird eine Stunde lang nicht erneut
  // versucht (der Scheduler laeuft alle SYNC_INTERVAL_MINUTES, Voreinstellung
  // 15 - ein Ausfall der Fremd-API darf keine Dauerschleife werden), danach
  // schon, und zwar OHNE auf die 30-Tage-Sperre zu warten.
  const retryAfterStr = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_retry_after'").get()?.value;
  const retryScope    = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_retry_scope'").get()?.value;
  const repairOpen    = Boolean(retryAfterStr) && retryScope === scope;
  if (!force && repairOpen) {
    const retryAfter = new Date(retryAfterStr);
    if (!Number.isNaN(retryAfter.getTime()) && Date.now() < retryAfter.getTime()) {
      log.debug('Holiday repair is still on hold – skipping automatic sync.');
      return { synced: 0 };
    }
  }

  // Der normale Auffrischungstakt gilt nur, wenn nichts Neues gewaehlt wurde.
  //
  // EINE OFFENE REPARATUR MUSS HIER NICHT NOCHMAL GEPRUEFT WERDEN, und das ist
  // kein Zufall, sondern der Grund, warum ein Fehlschlag den Merker LOESCHT
  // statt ihn nur nicht zu setzen: danach gilt jeder Scope als neu, also ist
  // `scopeChanged` ohnehin wahr. Eine zusaetzliche `!repairOpen`-Bedingung stand
  // hier kurz und war toter Code - sie sah aus wie ein Schutz und konnte nie
  // greifen, weil Merker und Reparaturmarke sich gegenseitig ausschliessen.
  const lastSyncStr = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync'").get()?.value;
  if (!force && !scopeChanged && lastSyncStr) {
    const lastSyncDate = new Date(lastSyncStr);
    if (!Number.isNaN(lastSyncDate.getTime()) && Date.now() - lastSyncDate.getTime() < THROTTLE_MS) {
      log.debug('Holidays synced recently – skipping automatic sync.');
      return { synced: 0 };
    }
  }

  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear - SYNC_YEARS_BACK; y <= currentYear + SYNC_YEARS_AHEAD; y++) {
    years.push(y);
  }

  // JAHRE, DIE NUR NOCH IM CACHE LIEGEN, KOMMEN BEI EINEM SCOPE-WECHSEL MIT.
  // Das Fenster wandert (currentYear-1 .. +2), der Cache nicht: eine
  // Installation, die 2025 lief, hat Zeilen fuer 2024 liegen, und die faellt
  // 2027 aus dem Fenster. `getForRange()` kennt keine Fenstergrenze und zeigt
  // sie beim Zurueckblaettern weiter - nach einem Sprachwechsel also in der
  // alten Sprache, unbegrenzt lange (gefunden in der PR-Durchsicht).
  //
  // Sie zu loeschen waere konsistent gewesen, haette aber alte Jahre leer
  // gelassen; sie stehen zu lassen heisst, dass der Kalender zwei Sprachen
  // zeigt. Beides unnoetig: es sind wenige Jahre, sie sind bei OpenHolidays
  // abrufbar, und der Zusatzaufwand faellt nur an, wenn sich wirklich etwas
  // geaendert hat. Liefert die Quelle fuer so ein Jahr nichts mehr, raeumt
  // `finishEmpty` es weg - auch dann bleibt nichts Fremdsprachiges stehen.
  if (scopeChanged) {
    const imCache = db.get().prepare('SELECT DISTINCT year FROM holiday_cache WHERE country = ? ORDER BY year').all(country);
    for (const { year } of imCache) {
      if (!years.includes(year)) years.push(year);
    }
  }

  let total = 0;
  let anyFailed = false;
  for (const year of years) {
    for (const type of [showPublic && 'public', showSchool && 'school'].filter(Boolean)) {
      const res = await syncYearAndType(country, subdivision, year, type, langCode);
      total += res.count;
      anyFailed ||= res.failed;
    }
  }

  const now = new Date().toISOString();
  const remember = db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `);
  remember.run('holiday_last_sync', now);
  // DER SPRACH-MERKER ERST NACH EINEM VOLLSTAENDIGEN LAUF. Scheitert auch nur
  // ein Jahr, steht dieser Bereich weiter in der alten Sprache - ihn trotzdem
  // als erledigt zu verbuchen hiesse, einen halb uebersetzten Cache fuer die
  // naechsten 30 Tage festzuschreiben. Genau die Sorte Fehler, bei der ein
  // Cursor ueber einen Fehlschlag hinweglaeuft und die Luecke nie wieder
  // zugeht (#839).
  const forget = db.get().prepare('DELETE FROM sync_config WHERE key = ?');
  if (anyFailed) {
    // DER MERKER WIRD GELOESCHT, NICHT BLOSS NICHT GESETZT. Nach einem
    // Teilfehlschlag steht der Cache GEMISCHT da - einige Bereiche neu, andere
    // alt. Bliebe der alte Scope stehen, waere ein Zurueckwechseln auf ihn
    // "unveraendert", die 30-Tage-Sperre griffe, und die bereits umgestellten
    // Bereiche behielten ihre neuen Namen fuer einen Monat. Ohne Merker gilt
    // jeder Scope als neu, bis einer vollstaendig durchgelaufen ist; gegen die
    // Dauerschleife steht die Reparaturmarke.
    forget.run('holiday_last_sync_scope');
    remember.run('holiday_retry_after', new Date(Date.now() + LANGUAGE_RETRY_MS).toISOString());
    remember.run('holiday_retry_scope', scope);
  } else {
    remember.run('holiday_last_sync_scope', scope);
    forget.run('holiday_retry_after');
    forget.run('holiday_retry_scope');
  }

  // "complete" nur, wenn es das war. Genau diese Zeile hat der Melder von #946
  // zitiert, um zu zeigen, dass die Synchronisierung durchgelaufen sei - eine
  // Erfolgsmeldung ueber einem halb geholten Bestand haette ihn ein zweites Mal
  // in die Irre gefuehrt.
  const wo = `${country}${subdivision ? '/' + subdivision : ''}`;
  if (anyFailed) log.warn(`Holiday sync INCOMPLETE: ${total} entries for ${wo} - some requests failed, the next run retries`);
  else log.info(`Holiday sync complete: ${total} entries for ${wo}`);
  return { synced: total, lastSync: now, incomplete: anyFailed };
}

/**
 * Kollabiert überlappende, gleichnamige Einträge desselben Typs zu einer
 * Union-Spanne (frühester Start, spätestes Ende). Verhindert doppelte Balken,
 * wenn OpenHolidays für eine Subdivision mehrere Schulferien-Varianten mit
 * abweichenden Terminen liefert (regionale Schulkalender, z. B. CH-Kantone).
 * Nicht überlappende gleichnamige Einträge bleiben getrennt. (#434)
 * @param {Array<{id, type, start_date, end_date, name}>} rows nach start_date sortiert
 */
function mergeOverlappingByName(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.type}\x00${r.name}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  const out = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
    let cur = null;
    for (const r of group) {
      // Überlappung/Berührung (start des nächsten <= aktuelles Ende) → vereinen.
      if (cur && r.start_date <= cur.end_date) {
        if (r.end_date > cur.end_date) cur.end_date = r.end_date;
        cur.id = Math.min(cur.id, r.id);
      } else {
        cur = { ...r };
        out.push(cur);
      }
    }
  }

  out.sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
  return out;
}

/**
 * Feiertage/Ferien für einen Datumsbereich aus dem Cache lesen.
 * @param {string} from YYYY-MM-DD
 * @param {string} to   YYYY-MM-DD
 * @returns {Array<{id, type, start_date, end_date, name}>}
 */
function getForRange(from, to) {
  const country     = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_country'").get()?.value;
  const subdivision = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_subdivision'").get()?.value ?? null;
  const group       = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_group'").get()?.value || null;
  const showPublic  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_public'").get()?.value === '1';
  const showSchool  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_school'").get()?.value === '1';
  const pubColor    = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_public_color'").get()?.value ?? '#FF3B30';
  const schColor    = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_school_color'").get()?.value ?? '#34C759';

  if (!country || (!showPublic && !showSchool)) return [];

  const types = [];
  if (showPublic) types.push('public');
  if (showSchool) types.push('school');

  const placeholders = types.map(() => '?').join(', ');

  // Ist eine Schulferien-Gruppe konfiguriert (mehrsprachiger Kanton), werden nur
  // die Zeilen dieser Gruppe sowie gruppenlose Zeilen (group_code NULL, z. B.
  // Feiertage) gezeigt. So bleibt genau EIN korrektes Ferien-Regime übrig und der
  // Union-Merge unten wird zum No-op. Ohne Gruppen-Auswahl greift der Merge als
  // Fallback und kollabiert überlappende Varianten wie bisher. (#434)
  const groupClause = group ? 'AND (group_code IS NULL OR group_code = ?)' : '';
  const groupArgs   = group ? [group] : [];

  // GROUP BY kollabiert identische Feiertage, die aus mehreren Scopes im Cache
  // liegen (z. B. länderweite NULL-Zeilen aus der Zeit vor #434 neben dem heutigen
  // Regions-Scope). So sieht der Kalender nie Duplikate, selbst wenn ein alter
  // Cache-Bestand nie sauber neu synchronisiert wurde. (#434)
  const rows = db.get().prepare(`
    SELECT MIN(id) AS id, type, start_date, end_date, name
    FROM holiday_cache
    WHERE country = ?
      AND (subdivision IS NULL OR subdivision = ? OR subdivision = '')
      ${groupClause}
      AND type IN (${placeholders})
      AND start_date <= ?
      AND end_date   >= ?
    GROUP BY type, start_date, end_date, name
    ORDER BY start_date ASC
  `).all(country, subdivision ?? '', ...groupArgs, ...types, to, from);

  // OpenHolidays modelliert innerhalb EINER Subdivision teils mehrere
  // gleichnamige Schulferien-Varianten mit abweichenden Datumsbereichen –
  // z. B. Kanton Bern: deutsch- vs. französischsprachige Schulregion
  // (groups CH-BE-VS / CH-BE-EO). Diese tragen KEIN "Exception"-Tag und haben
  // unterschiedliche Start-/Enddaten, daher greifen weder der sync-seitige
  // Exception-Filter noch das exakte GROUP BY oben. Für den Familienkalender
  // werden überlappende gleichnamige Einträge desselben Typs zu einer
  // Union-Spanne kollabiert, sodass nie zwei Balken übereinanderliegen.
  // Nicht überlappende gleichnamige Einträge (z. B. mehrere bewegliche
  // Ferientage) bleiben bewusst getrennt. (#434)
  const merged = mergeOverlappingByName(rows);

  return merged.map((r) => ({
    ...r,
    color: r.type === 'public' ? pubColor : schColor,
  }));
}

export { sync, getCountries, getSubdivisions, getGroups, getForRange, __setFetchImpl };
