/**
 * Modul: Erinnerungen und die Sichtbarkeit ihres Ziels
 * Zweck: Eine Erinnerung zeigt auf eine Zeile eines anderen Moduls, und der
 *        Verweis ist ein weicher (`entity_type` + `entity_id`, kein
 *        Fremdschluessel). Der Router fragte fuer jeden Schreibweg nur das
 *        MODULRECHT (`mayTouchOrigin()`), nie die Zeile selbst: weder ob es
 *        sie gibt, noch ob der Anfragende sie sehen darf. `GET /pending` und
 *        die Zustellung loesten danach den Titel ohne Sichtbarkeitsklausel
 *        auf. Diese Suite haelt beide Enden fest:
 *          1. SCHREIBEN (POST, PUT): eine Erinnerung entsteht nur auf einer
 *             Zeile, die es gibt und die der Anfragende sieht - sonst dieselbe
 *             404 wie fuer eine Kennung, die es nie gab. Je Herkunft mit
 *             eigener Zeilen-Sichtbarkeit ein Fall: Aufgabe (private,
 *             assignees), Termin (private, fremdes ungeteiltes ICS-Abo), Abo
 *             (private im persoenlichen Budget-Modus).
 *          2. LESEN (`/pending`, Push, Kanal): der Titel wird nur fuer eine
 *             sichtbare Zeile aufgeloest. Das deckt Bestandszeilen von vor dem
 *             Fix und Ziele, die NACH dem Anlegen privat wurden. Die Zeile
 *             wird uebersprungen, nicht geloescht.
 *          3. Die Gegenrichtung: eigene Erinnerungen, Zugewiesene, `all`,
 *             das Verteilen an die Zugewiesenen eines Termins, Inventar (hat
 *             keine Zeilen-Sichtbarkeit) und das Aufraeumen der eigenen Zeile.
 *
 * Netzfrei: In-Memory-SQLite ueber die volle Migrationskette, Push-Dienst und
 * Kanal-Provider sind Attrappen, der Router laeuft auf einem Loopback-Port.
 * Ausfuehren: npm run test:reminder-target-visibility
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const remindersModule = await import('../server/routes/reminders.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { TARGET_ENTITY_TYPES } = await import('../server/services/reminder-targets.js');

const NOW = new Date('2024-06-15T12:00:00Z');
const PAST = '2000-01-01T00:00:00';
// Jeder Titel traegt dieses Wort: so laesst sich an JEDER Nutzlast pruefen, ob
// etwas Verborgenes hinausging, statt nur an der einen erwarteten Meldung.
const SECRET = 'GEHEIM';

function freshDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(database); else database.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  _setTestDatabase(database);
  // Inventar ist per Migration haushaltweit abgeschaltet; hier geht es um die
  // Zeile, nicht um den Schalter.
  for (const [key, value] of [['household_timezone', 'UTC'], ['disabled_modules', '[]']]) {
    database.prepare(`
      INSERT INTO sync_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
  createNotificationChannelStore({ db: database }).createChannel({
    provider: 'ntfy', name: 'ntfy', enabled: true,
    config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {},
  });
  return database;
}

function setBudgetMode(database, mode) {
  database.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(mode);
}

let userSeq = 0;
function freshUser(database) {
  userSeq += 1;
  const id = database.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, '$2b$12$x', 'member', 'other')`,
  ).run(`rtv-u${userSeq}`, `User ${userSeq}`).lastInsertRowid;
  database.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
    .run(id, `https://push.test/${id}`, 'p', 'a');
  return id;
}

function makeTask(database, owner, visibility = 'all', assignees = []) {
  const id = database.prepare(
    `INSERT INTO tasks (title, category, status, created_by, visibility) VALUES (?, 'misc', 'open', ?, ?)`,
  ).run(`${SECRET}-Aufgabe`, owner, visibility).lastInsertRowid;
  for (const uid of assignees) database.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, uid);
  return id;
}

function makeEvent(database, owner, visibility = 'all', assignees = []) {
  const id = database.prepare(
    `INSERT INTO calendar_events (title, start_datetime, created_by, visibility) VALUES (?, '2024-07-01T19:00', ?, ?)`,
  ).run(`${SECRET}-Termin`, owner, visibility).lastInsertRowid;
  for (const uid of assignees) database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, uid);
  return id;
}

/** Ein Termin aus einem ICS-Abo; `shared` entscheidet, ob andere ihn im Kalender sehen. */
function makeIcsEvent(database, owner, shared) {
  const sub = database.prepare(
    `INSERT INTO ics_subscriptions (name, url, shared, created_by) VALUES ('Abo', 'https://ics.test/a.ics', ?, ?)`,
  ).run(shared ? 1 : 0, owner).lastInsertRowid;
  return database.prepare(`
    INSERT INTO calendar_events (title, start_datetime, created_by, external_source, subscription_id)
    VALUES (?, '2024-07-01T19:00', ?, 'ics', ?)
  `).run(`${SECRET}-ICS-Termin`, owner, sub).lastInsertRowid;
}

function makeSubscription(database, owner, visibility = 'shared') {
  return database.prepare(`
    INSERT INTO budget_subscriptions (name, amount, currency, billing_cycle, next_payment_date, created_by, owner_id, visibility)
    VALUES (?, 9.99, 'EUR', 'monthly', '2024-07-01', ?, ?, ?)
  `).run(`${SECRET}-Abo`, owner, owner, visibility).lastInsertRowid;
}

const makeInventoryItem = (database, owner) => database.prepare(
  `INSERT INTO inventory_items (name, created_by) VALUES ('Waschmaschine', ?)`,
).run(owner).lastInsertRowid;
const makeTrackedDate = (database, owner) => database.prepare(
  `INSERT INTO inventory_item_dates (item_id, label, date) VALUES (?, 'Wartung', '2024-07-01')`,
).run(makeInventoryItem(database, owner)).lastInsertRowid;

function insertReminder(database, owner, entityType, entityId, remindAt = PAST) {
  return database.prepare(
    'INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES (?, ?, ?, ?)',
  ).run(entityType, entityId, remindAt, owner).lastInsertRowid;
}

const remindersOf = (database, userId) =>
  database.prepare('SELECT * FROM reminders WHERE created_by = ? ORDER BY id').all(userId);

/** Ein Zustelllauf ueber den echten Pfad; zurueck kommt JEDE Nutzlast, je Weg. */
async function deliver(database, now = NOW) {
  const push = [];
  const channel = [];
  await processDueNotifications({
    database,
    channelStore: createNotificationChannelStore({ db: database }),
    pushService: { sendPushToUser: async (userId, payload) => { push.push({ userId, ...payload }); return 1; } },
    providers: {
      ntfy: { id: 'ntfy', send: async ({ channel: target, payload }) => { channel.push({ ...payload, scope: target.scope, channelUser: target.userId ?? null }); return { ok: true, status: 200 }; } },
    },
    now,
  });
  return { push, channel };
}

const tagOf = (id) => `reminder-${id}`;
const sentVia = (run, id) => ({
  Push: run.push.some((p) => p.tag === tagOf(id)),
  Kanal: run.channel.some((p) => p.tag === tagOf(id)),
});

// --------------------------------------------------------
// Der echte Router, mit derselben Rechteaufloesung wie in Produktion.
// --------------------------------------------------------
let currentUid = null;
let currentDb = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = currentDb.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(currentUid);
  req.authUserId = currentUid;
  req.session = { userId: currentUid, role: user?.role || 'member' };
  req.authScopes = null;
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(currentDb, user));
  next();
});
app.use('/api/v1/reminders', remindersModule.default);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/reminders`;
test.after(() => server.close());

async function call(database, userId, method, path, body) {
  currentDb = database;
  currentUid = userId;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const post = (database, userId, type, id) =>
  call(database, userId, 'POST', '/', { entity_type: type, entity_id: id, remind_at: PAST });
const put = (database, userId, type, id) =>
  call(database, userId, 'PUT', `/?entity_type=${type}&entity_id=${id}`, { remind_ats: [PAST] });
const pending = async (database, userId) => (await call(database, userId, 'GET', '/pending')).body.data;

/**
 * Die Ziele, die der Fremde nicht sieht - je Herkunft, die eine eigene
 * Zeilen-Sichtbarkeit hat. `setup` laeuft vor `make`, weil das Budget seine
 * Regel erst im persoenlichen Modus zieht.
 */
const HIDDEN = [
  { label: 'private Aufgabe',                      type: 'task',         make: (d, a) => makeTask(d, a, 'private') },
  { label: 'assignees-Aufgabe ohne Zuweisung',     type: 'task',         make: (d, a, c) => makeTask(d, a, 'assignees', [c]) },
  { label: 'privater Termin',                      type: 'event',        make: (d, a) => makeEvent(d, a, 'private') },
  { label: 'assignees-Termin ohne Zuweisung',      type: 'event',        make: (d, a, c) => makeEvent(d, a, 'assignees', [c]) },
  { label: 'Termin aus fremdem ungeteiltem ICS-Abo', type: 'event',      make: (d, a) => makeIcsEvent(d, a, false) },
  { label: 'privates Abo im persoenlichen Budget', type: 'subscription', make: (d, a) => makeSubscription(d, a, 'private'), setup: (d) => setBudgetMode(d, 'personal') },
];

const SETTABLE = ['task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date'];

// --------------------------------------------------------------------------
// 0. DER GUARD: jede Herkunft, die ein Mensch setzen kann, hat eine Zielregel
//
// Eine neue setzbare Herkunft ohne Eintrag in reminder-targets.js wuerde am
// Schreibweg abgewiesen (Allowlist) - am LESEWEG aber durchgelassen, weil der
// Filter dort nur beurteilt, was er kennt. Diese Zusicherung macht die Luecke
// laut, bevor sie eine ist.
// --------------------------------------------------------------------------
test('jede setzbare Herkunft steht in reminder-targets.js', () => {
  assert.deepEqual([...remindersModule.SETTABLE_ENTITY_TYPES].sort(), [...TARGET_ENTITY_TYPES].sort());
  assert.deepEqual([...SETTABLE].sort(), [...TARGET_ENTITY_TYPES].sort(), 'die Liste dieser Suite ist veraltet');
});

// --------------------------------------------------------------------------
// 1. SCHREIBEN
// --------------------------------------------------------------------------
test('POST und PUT: eine Kennung, die es nicht gibt, ist 404 - fuer jede setzbare Herkunft', async () => {
  const database = freshDb();
  const me = freshUser(database);
  for (const type of SETTABLE) {
    const created = await post(database, me, type, 999999);
    assert.equal(created.status, 404, `POST ${type} auf eine Kennung, die es nicht gibt`);
    const replaced = await put(database, me, type, 999999);
    assert.equal(replaced.status, 404, `PUT ${type} auf eine Kennung, die es nicht gibt`);
    assert.deepEqual(replaced.body, created.body);
  }
  assert.deepEqual(remindersOf(database, me), [], 'eine Erinnerung ohne Ziel wurde geschrieben');
  database.close();
});

for (const hidden of HIDDEN) {
  test(`POST und PUT: ${hidden.label} nimmt von einem Fremden keine Erinnerung an`, async () => {
    const database = freshDb();
    hidden.setup?.(database);
    const owner = freshUser(database);
    const outsider = freshUser(database);
    const assignee = freshUser(database);
    const id = hidden.make(database, owner, assignee);

    const missing = await post(database, outsider, hidden.type, 999999);
    assert.equal(missing.status, 404);

    const created = await post(database, outsider, hidden.type, id);
    assert.equal(created.status, 404, `POST: ${hidden.label}`);
    // Dieselbe Antwort wie fuer eine Kennung, die es nie gab.
    assert.deepEqual(created.body, missing.body, 'die Antwort verraet, dass es die Zeile gibt');
    const replaced = await put(database, outsider, hidden.type, id);
    assert.equal(replaced.status, 404, `PUT: ${hidden.label}`);
    assert.deepEqual(replaced.body, missing.body);
    assert.deepEqual(remindersOf(database, outsider), [], 'die Erinnerung wurde trotzdem geschrieben');

    // Wem die Zeile gehoert, setzt weiter.
    assert.equal((await post(database, owner, hidden.type, id)).status, 201, `${hidden.label}: Ersteller:in`);
    assert.equal((await put(database, owner, hidden.type, id)).status, 200);
    database.close();
  });
}

test('POST und PUT: wer die Zeile sieht, setzt seine Erinnerung weiter', async () => {
  const database = freshDb();
  const owner = freshUser(database);
  const other = freshUser(database);

  const cases = [
    ['task all',                 'task',  makeTask(database, owner, 'all')],
    ['task assignees, zugewiesen', 'task',  makeTask(database, owner, 'assignees', [other])],
    ['event all',                'event', makeEvent(database, owner, 'all')],
    ['event assignees, zugewiesen', 'event', makeEvent(database, owner, 'assignees', [other])],
    ['event aus geteiltem ICS-Abo', 'event', makeIcsEvent(database, owner, true)],
    // Im geteilten Budget-Modus (Vorgabe) sehen alle alles - auch `private`.
    ['subscription, geteilter Modus', 'subscription', makeSubscription(database, owner, 'private')],
    // Inventar hat keine Zeilen-Sichtbarkeit: das Modulrecht ist die ganze Regel.
    ['inventory_item',           'inventory_item', makeInventoryItem(database, owner)],
    ['inventory_tracked_date',   'inventory_tracked_date', makeTrackedDate(database, owner)],
  ];
  for (const [label, type, id] of cases) {
    assert.equal((await post(database, other, type, id)).status, 201, `POST ${label}`);
    assert.equal((await put(database, other, type, id)).status, 200, `PUT ${label}`);
  }

  // Persoenlicher Modus: ein geteiltes Abo bleibt fuer alle da.
  setBudgetMode(database, 'personal');
  assert.equal((await post(database, other, 'subscription', makeSubscription(database, owner, 'shared'))).status, 201);
  database.close();
});

test('PUT durch die Erstellerin verteilt weiter an die Zugewiesenen eines Termins', async () => {
  const database = freshDb();
  const author = freshUser(database);
  const assignee = freshUser(database);
  const id = makeEvent(database, author, 'assignees', [assignee]);

  assert.equal((await put(database, author, 'event', id)).status, 200);
  const inherited = remindersOf(database, assignee);
  assert.equal(inherited.length, 1, 'die Zugewiesene hat die Erinnerung nicht geerbt');
  assert.equal(inherited[0].assigned_from, author);

  const run = await deliver(database);
  // Ein Termin fuer die Zugewiesenen ist nicht fuer alle da: Push ja, Haushaltskanal nein.
  assert.deepEqual(sentVia(run, inherited[0].id), { Push: true, Kanal: false });
  database.close();
});

// --------------------------------------------------------------------------
// 2. LESEN
// --------------------------------------------------------------------------
for (const hidden of HIDDEN) {
  test(`Bestandszeile: ${hidden.label} nennt dem Fremden keinen Titel - weder /pending noch Push noch Kanal`, async () => {
    const database = freshDb();
    hidden.setup?.(database);
    const owner = freshUser(database);
    const outsider = freshUser(database);
    const assignee = freshUser(database);
    const id = hidden.make(database, owner, assignee);

    // Wie eine Zeile von vor dem Fix: direkt geschrieben, am Router vorbei.
    const leaked = insertReminder(database, outsider, hidden.type, id);
    const own = insertReminder(database, owner, hidden.type, id);

    const seen = await pending(database, outsider);
    assert.deepEqual(seen.filter((r) => r.id === leaked), [], `/pending liefert die Zeile: ${JSON.stringify(seen)}`);
    assert.ok(!JSON.stringify(seen).includes(SECRET), '/pending nennt einen verborgenen Titel');
    // Der Gegenfall: wem die Zeile gehoert, liest seine Erinnerung samt Titel.
    const mine = await pending(database, owner);
    assert.ok(mine.some((r) => r.id === own && String(r.entity_title).includes(SECRET)), 'die eigene Erinnerung fehlt');

    const run = await deliver(database);
    assert.deepEqual(sentVia(run, leaked), { Push: false, Kanal: false });
    assert.deepEqual(run.push.filter((p) => p.userId === outsider), [], 'ein Push ging an den Fremden');
    // Die eigene Erinnerung geht an die Person selbst - nicht an den Kanal des
    // Haushalts, der sie allen zustellte (Abschnitt 4).
    assert.deepEqual(sentVia(run, own), { Push: true, Kanal: false }, 'die eigene Erinnerung: Push ja, Haushaltskanal nein');

    // Uebersprungen, nicht geloescht und nicht als zugestellt vermerkt.
    const row = database.prepare('SELECT * FROM reminders WHERE id = ?').get(leaked);
    assert.ok(row, 'die Zeile wurde geloescht');
    assert.equal(row.pushed_at, null, 'die Zeile gilt als zugestellt, obwohl nichts rausging');
    database.close();
  });
}

test('ein Ziel, das nach dem Anlegen privat wird, verstummt - und meldet sich wieder, wenn es zurueckkommt', async () => {
  const database = freshDb();
  const owner = freshUser(database);
  const other = freshUser(database);

  const taskId = makeTask(database, owner, 'all');
  const eventId = makeEvent(database, owner, 'all');
  const taskReminder = (await post(database, other, 'task', taskId)).body.data.id;
  const eventReminder = (await post(database, other, 'event', eventId)).body.data.id;
  assert.equal((await pending(database, other)).length, 2);

  database.prepare(`UPDATE tasks SET visibility = 'private' WHERE id = ?`).run(taskId);
  database.prepare(`UPDATE calendar_events SET visibility = 'private' WHERE id = ?`).run(eventId);

  assert.deepEqual(await pending(database, other), []);
  const quiet = await deliver(database);
  assert.deepEqual(sentVia(quiet, taskReminder), { Push: false, Kanal: false });
  assert.deepEqual(sentVia(quiet, eventReminder), { Push: false, Kanal: false });

  // Die eigene Zeile bleibt aufraeumbar, auch wenn ihr Ziel nicht mehr zu sehen ist.
  assert.equal((await call(database, other, 'DELETE', `/${eventReminder}`)).status, 204);

  database.prepare(`UPDATE tasks SET visibility = 'all' WHERE id = ?`).run(taskId);
  assert.deepEqual((await pending(database, other)).map((r) => r.id), [taskReminder]);
  assert.deepEqual(sentVia(await deliver(database), taskReminder), { Push: true, Kanal: true });
  database.close();
});

test('Inventar: eine Erinnerung ohne Zeilen-Sichtbarkeit laeuft weiter wie bisher', async () => {
  const database = freshDb();
  const owner = freshUser(database);
  const other = freshUser(database);
  const item = insertReminder(database, other, 'inventory_item', makeInventoryItem(database, owner));
  const date = insertReminder(database, other, 'inventory_tracked_date', makeTrackedDate(database, owner));

  assert.deepEqual((await pending(database, other)).map((r) => r.id).sort(), [item, date].sort());
  const run = await deliver(database);
  assert.deepEqual(sentVia(run, item), { Push: true, Kanal: true });
  assert.deepEqual(sentVia(run, date), { Push: true, Kanal: true });
  database.close();
});

test('ein privates Abo ohne Eigentuemer bleibt im persoenlichen Modus verborgen', async () => {
  // `owner_id` ist nullbar. Eine Klausel ueber die leere Spalte ergibt NULL, und
  // ein Filter, der nur "ausdruecklich verborgen" abweist, liesse die Zeile durch.
  const database = freshDb();
  setBudgetMode(database, 'personal');
  const owner = freshUser(database);
  const outsider = freshUser(database);
  const id = makeSubscription(database, owner, 'private');
  database.prepare('UPDATE budget_subscriptions SET owner_id = NULL WHERE id = ?').run(id);

  assert.equal((await post(database, outsider, 'subscription', id)).status, 404);
  const leaked = insertReminder(database, outsider, 'subscription', id);
  assert.deepEqual(await pending(database, outsider), []);
  assert.deepEqual(sentVia(await deliver(database), leaked), { Push: false, Kanal: false });
  database.close();
});

test('eine Waise bleibt, was sie war: der Lese-Filter verbirgt Vorhandenes, nicht Fehlendes', async () => {
  // Abo und Inventar haben keinen Trigger, der die Erinnerung mitnimmt; ihre
  // Waise geht seit #581 mit neutralem Text hinaus (test-notifications.js).
  // Der Filter aendert daran nichts - eine Zeile ohne Ziel nennt keinen Titel.
  const database = freshDb();
  setBudgetMode(database, 'personal');
  const me = freshUser(database);
  const orphans = ['subscription', 'inventory_item', 'inventory_tracked_date']
    .map((type) => insertReminder(database, me, type, 999999));

  const seen = await pending(database, me);
  assert.deepEqual(seen.map((r) => r.id).sort(), [...orphans].sort());
  assert.deepEqual(seen.map((r) => r.entity_title), [null, null, null]);
  const run = await deliver(database);
  for (const id of orphans) assert.deepEqual(sentVia(run, id), { Push: true, Kanal: true });
  database.close();
});

// --------------------------------------------------------------------------
// 4. DER HAUSHALTSKANAL IST EIN LESER WIE JEDER ANDERE
//
// Ein Kanal mit `scope = 'household'` (ntfy-Topic, Gotify, Webhook, E-Mail)
// bekam JEDE faellige Erinnerung jedes Mitglieds, mit Titel. Anlegen kann ihn
// nur ein Admin, und die Oberflaeche legt ausschliesslich solche an - die
// Erinnerung an eine private Aufgabe ging damit an die, vor denen `private`
// sie verbirgt. In den Haushaltskanal geht deshalb nur, was JEDER sehen darf;
// alles andere bleibt bei Push und den persoenlichen Kanaelen der Person.
// --------------------------------------------------------------------------
const viaChannels = (run, id) => run.channel.filter((p) => p.tag === tagOf(id)).map((p) => p.scope).sort();

function personalChannel(database, userId) {
  return createNotificationChannelStore({ db: database }).createChannel({
    provider: 'ntfy', name: `ntfy-${userId}`, enabled: true, scope: 'user', userId,
    config: { baseUrl: 'https://ntfy.test', topic: `user-${userId}` }, secrets: {},
  });
}

for (const hidden of HIDDEN) {
  test(`Haushaltskanal: die eigene Erinnerung an ${hidden.label} geht an Push und den persoenlichen Kanal, nicht an alle`, async () => {
    const database = freshDb();
    hidden.setup?.(database);
    const owner = freshUser(database);
    const assignee = freshUser(database);
    personalChannel(database, owner);
    const id = hidden.make(database, owner, assignee);
    const own = insertReminder(database, owner, hidden.type, id);

    const run = await deliver(database);
    assert.ok(run.push.some((p) => p.tag === tagOf(own) && p.userId === owner), 'der Push an die Person selbst fehlt');
    assert.deepEqual(viaChannels(run, own), ['user'], 'Kanaele, die die Erinnerung bekamen');
    assert.ok(!run.channel.some((p) => p.scope === 'household' && JSON.stringify(p).includes(SECRET)),
      'der Haushaltskanal nennt einen verborgenen Titel');
    assert.notEqual(database.prepare('SELECT pushed_at FROM reminders WHERE id = ?').get(own).pushed_at, null,
      'die Zeile gilt nicht als zugestellt');
    database.close();
  });
}

test('Haushaltskanal: was jeder sehen darf, geht weiter an alle Kanaele', async () => {
  const database = freshDb();
  const owner = freshUser(database);
  personalChannel(database, owner);
  const cases = {
    'Aufgabe fuer alle':        insertReminder(database, owner, 'task', makeTask(database, owner, 'all')),
    'Termin fuer alle':         insertReminder(database, owner, 'event', makeEvent(database, owner, 'all')),
    'Termin aus geteiltem Abo': insertReminder(database, owner, 'event', makeIcsEvent(database, owner, true)),
    // Geteilter Budget-Modus (Vorgabe): dort sehen alle alles, auch `private`.
    'Abo, geteilter Modus':     insertReminder(database, owner, 'subscription', makeSubscription(database, owner, 'private')),
    'Inventar':                 insertReminder(database, owner, 'inventory_item', makeInventoryItem(database, owner)),
    'Inventar-Frist':           insertReminder(database, owner, 'inventory_tracked_date', makeTrackedDate(database, owner)),
    'Waise':                    insertReminder(database, owner, 'subscription', 999999),
  };
  const run = await deliver(database);
  for (const [label, id] of Object.entries(cases)) {
    assert.deepEqual(viaChannels(run, id), ['household', 'user'], label);
  }
  database.close();
});

test('Haushaltskanal: ohne Push und ohne eigenen Kanal bleibt die Erinnerung im Toast, nicht haengen', async () => {
  // Wer weder Push noch einen eigenen Kanal hat, bekam die Meldung bisher nur
  // ueber den Haushaltskanal. Sie faellt dort jetzt weg - /pending zeigt sie
  // weiter, und die Zeile darf nicht ewig als ausstehend im Lauf bleiben.
  const database = freshDb();
  const owner = freshUser(database);
  database.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(owner);
  const own = insertReminder(database, owner, 'task', makeTask(database, owner, 'private'));

  const run = await deliver(database);
  assert.deepEqual(viaChannels(run, own), []);
  assert.ok((await pending(database, owner)).some((r) => r.id === own), '/pending zeigt die eigene Erinnerung nicht');
  assert.notEqual(database.prepare('SELECT pushed_at FROM reminders WHERE id = ?').get(own).pushed_at, null);
  database.close();
});
