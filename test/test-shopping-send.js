/**
 * Test: Einkaufsliste per Mail senden (#944)
 * Zweck: Die Zusagen der Versandroute, allen voran die eine, die sie sicher
 *        macht: DER EMPFAENGER IST EINE ID, NIE EINE ADRESSE. Naehme die Route
 *        eine Adresse aus dem Rumpf, waere Yuvomi fuer jeden angemeldeten
 *        Nutzer ein offener Mailversender - beliebiger Inhalt an beliebige
 *        Empfaenger, abgeschickt ueber den SMTP-Server des Haushalts und auf
 *        dessen Ruf.
 *
 *        Dazu: nur offene Artikel, in der Reihenfolge der Kategorien (die den
 *        Weg durch den Laden abbildet), Nutzertexte escaped, drei
 *        unterscheidbare Absagegruende statt einem "ging nicht", und der
 *        Listenname im Betreff ohne Zeilenumbruch.
 * Ausfuehren: node --experimental-sqlite --test test/test-shopping-send.js
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: shoppingRouter, __test: shoppingInternals } = await import('../server/routes/shopping.js');
const db = dbmod.get();

const SENDER = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('ulas','Ulas','x','admin')"
).run().lastInsertRowid;
const OMA = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('oma','Oma','x','member')"
).run().lastInsertRowid;
const OHNE_MAIL = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('kid','Kind','x','member')"
).run().lastInsertRowid;

db.prepare("INSERT INTO contacts (name, first_name, email, family_user_id) VALUES ('Oma','Oma','oma@example.org',?)").run(OMA);
db.prepare("INSERT INTO contacts (name, first_name, email, family_user_id) VALUES ('Ulas','Ulas','ulas@example.org',?)").run(SENDER);

let mailer = null;
/**
 * Die Versandschranke gilt je IP, und in dieser Suite kommen alle Faelle von
 * derselben. Sie wird deshalb zwischen den Faellen zurueckgesetzt - geprueft
 * wird sie als eigene Zusage weiter unten, nicht nebenbei durch ein 429 in
 * einem Test, der etwas ganz anderes meint.
 */
function resetLimiter() {
  for (const key of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    try { shoppingInternals.sendListLimiter.resetKey(key); } catch { /* Schluessel unbekannt */ }
  }
}

function resetMailer({ configured = true } = {}) {
  resetLimiter();
  mailer = {
    sent: [],
    isConfigured: () => configured,
    sendMail: async (message) => { mailer.sent.push(message); return { messageId: 'x' }; },
  };
  app.locals.emailService = mailer;
  return mailer;
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = SENDER;
  req.authRole = 'admin';
  next();
});
app.use('/', shoppingRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

/** Eine Liste mit drei offenen und einem abgehakten Artikel ueber drei Kategorien. */
function seedList(name = 'Wocheneinkauf') {
  const listId = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run(name, SENDER).lastInsertRowid;
  const rows = [
    // Absichtlich in FALSCHER Reihenfolge eingefuegt: die Mail muss nach der
    // Kategorie-Reihenfolge sortieren, nicht nach der Einfuegereihenfolge.
    ['Milch', '2 L', 'Milchprodukte', 0],
    ['Apfel', '1 kg', 'Obst & Gemüse', 0],
    ['Brot', '', 'Backwaren', 0],
    ['Butter', '', 'Milchprodukte', 1],
  ];
  for (const [n, q, c, checked] of rows) {
    db.prepare('INSERT INTO shopping_items (list_id, name, quantity, category, is_checked) VALUES (?,?,?,?,?)')
      .run(listId, n, q, c, checked);
  }
  return listId;
}

test('DIE ADRESSE KOMMT NIE AUS DEM REQUEST (#944)', async () => {
  resetMailer();
  const listId = seedList();
  // Der Angriff, gegen den die ganze Bauart steht: eine fremde Adresse im
  // Rumpf mitschicken und hoffen, dass sie durchgereicht wird.
  const res = await call('POST', `/${listId}/send`, {
    userId: OMA,
    email: 'angreifer@example.com',
    to: 'angreifer@example.com',
    toAddress: 'angreifer@example.com',
  });
  assert.equal(res.status, 200);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'oma@example.org',
    'die Adresse muss aus dem Kontakt des Mitglieds stammen, nicht aus dem Rumpf');
  assert.doesNotMatch(JSON.stringify(mailer.sent[0]), /angreifer@example\.com/,
    'nichts aus dem Rumpf darf irgendwo in der Nachricht landen');
});

test('nur die offenen Artikel, in der Reihenfolge der Kategorien (#944)', async () => {
  resetMailer();
  const listId = seedList();
  const res = await call('POST', `/${listId}/send`, { userId: OMA });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.items, 3, 'der abgehakte Artikel zaehlt nicht mit');

  const { text } = mailer.sent[0];
  assert.doesNotMatch(text, /Butter/, 'ein abgehakter Artikel steht auf keinem Einkaufszettel');
  // Obst & Gemüse (sort_order 0) vor Backwaren (1) vor Milchprodukte (2) -
  // der Weg durch den Laden, nicht das Alphabet und nicht die Eingabereihenfolge.
  const order = ['Apfel', 'Brot', 'Milch'].map((name) => text.indexOf(name));
  assert.deepEqual([...order].sort((a, b) => a - b), order,
    `Reihenfolge stimmt nicht: ${JSON.stringify(order)}`);
  assert.match(text, /Apfel \(1 kg\)/, 'die Menge gehoert an den Artikel');
  assert.match(text, /- Brot$/m, 'ohne Menge bleibt der Name allein stehen');
});

test('die Mail nennt Absender, Liste und ihren Zeitpunkt (#944)', async () => {
  resetMailer();
  const listId = seedList('Baumarkt');
  await call('POST', `/${listId}/send`, { userId: OMA });
  const { subject, text } = mailer.sent[0];
  assert.match(subject, /Baumarkt/, 'im Posteingang ist nur der Betreff sichtbar - er nennt die Liste');
  assert.match(subject, /\(3\)/, 'und wie viel drin ist');
  assert.match(text, /Ulas sent you this shopping list/, 'wer sie geschickt hat');
  // Der Zeitstempel ist die einzige Angabe, an der sich ablesen laesst, wie alt
  // diese Abschrift ist. Ohne ihn sieht eine Stunde alte Liste aus wie eine neue.
  assert.match(text, /snapshot taken on \d{4}-\d{2}-\d{2}/, 'und wann');
});

test('wer sie sich selbst schickt, bekommt keinen Absendersatz (#944)', async () => {
  resetMailer();
  const listId = seedList();
  const res = await call('POST', `/${listId}/send`, { userId: SENDER });
  assert.equal(res.status, 200);
  assert.equal(mailer.sent[0].to, 'ulas@example.org', 'sich selbst schicken ist erlaubt');
  assert.doesNotMatch(mailer.sent[0].text, /sent you this shopping list/,
    '"Ulas hat dir diese Liste geschickt" ueber der eigenen Liste ist Unsinn');
});

test('Nutzertexte werden fuer den HTML-Teil escaped (#944)', async () => {
  resetMailer();
  const listId = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
    .run('<script>alert(1)</script>', SENDER).lastInsertRowid;
  db.prepare('INSERT INTO shopping_items (list_id, name, quantity, category) VALUES (?,?,?,?)')
    .run(listId, 'Käse <b>extra</b> & mehr', '2 & 3', 'Milchprodukte');
  await call('POST', `/${listId}/send`, { userId: OMA });

  const { html, subject } = mailer.sent[0];
  assert.doesNotMatch(html, /<script>/, 'kein durchgereichtes Markup');
  assert.doesNotMatch(html, /<b>extra<\/b>/);
  assert.match(html, /&lt;b&gt;extra&lt;\/b&gt;/, 'sondern escaped');
  assert.match(html, /&amp; mehr/);
  assert.ok(subject.includes('<script>'), 'der Betreff ist kein HTML - dort waere Escaping falsch');
});

test('ein Listenname mit Zeilenumbruch oeffnet keinen zweiten Header (#944)', async () => {
  resetMailer();
  const listId = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
    .run('Einkauf\nBcc: fremd@example.org', SENDER).lastInsertRowid;
  db.prepare("INSERT INTO shopping_items (list_id, name, category) VALUES (?, 'Milch', 'Milchprodukte')").run(listId);
  await call('POST', `/${listId}/send`, { userId: OMA });
  assert.doesNotMatch(mailer.sent[0].subject, /[\r\n]/, 'der Betreff ist ein Header und bleibt einzeilig');
});

test('der Betreff bleibt aus dem Log - er traegt Listennamen (#944)', async () => {
  resetMailer();
  const listId = seedList('Geburtstagsgeschenke');
  await call('POST', `/${listId}/send`, { userId: OMA });
  const mail = mailer.sent[0];
  assert.match(mail.subject, /Geburtstagsgeschenke/);
  assert.equal(mail.logLabel, 'shopping list',
    'sonst schreibt sendMail() den Listennamen auf stdout des Containers');
});

test('drei Absagegruende, drei Meldungen - keine Mail dabei (#944)', async () => {
  const listId = seedList();

  // Jede Absage traegt zusaetzlich einen maschinenlesbaren `reason`. Ohne ihn
  // koennte die Oberflaeche die drei Faelle nur in der Sprache des Servers
  // ausdruecken - alle drei sind 422, und der Meldungstext ist englisch wie
  // jede Server-Meldung. Der Nutzen der Unterscheidung endete an der
  // Sprachgrenze.

  // 1) Mitglied ohne hinterlegte Adresse.
  resetMailer();
  let res = await call('POST', `/${listId}/send`, { userId: OHNE_MAIL });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /email address/i);
  assert.equal(res.body.reason, 'recipient_no_email');
  assert.equal(mailer.sent.length, 0);

  // 2) SMTP gar nicht eingerichtet.
  resetMailer({ configured: false });
  res = await call('POST', `/${listId}/send`, { userId: OMA });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /SMTP/i, 'die Meldung muss sagen, was zu tun ist');
  assert.equal(res.body.reason, 'smtp_unconfigured');
  assert.equal(mailer.sent.length, 0);

  // 3) Nichts zu senden. Ein stiller Erfolg liesse den Absender glauben, er
  //    haette geholfen.
  resetMailer();
  const leer = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run('Leer', SENDER).lastInsertRowid;
  db.prepare("INSERT INTO shopping_items (list_id, name, category, is_checked) VALUES (?, 'Erledigt', 'Sonstiges', 1)").run(leer);
  res = await call('POST', `/${leer}/send`, { userId: OMA });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /no open items/i);
  assert.equal(res.body.reason, 'nothing_open');
  assert.equal(mailer.sent.length, 0);

  // Die drei Gruende muessen unterscheidbar BLEIBEN - zwei gleiche waeren
  // wieder ein "ging nicht" mit drei Ursachen.
  assert.equal(new Set(['recipient_no_email', 'smtp_unconfigured', 'nothing_open']).size, 3);
});

test('unbekannte Liste, unbekannter Empfaenger, fehlende Angabe (#944)', async () => {
  resetMailer();
  const listId = seedList();
  assert.equal((await call('POST', '/999999/send', { userId: OMA })).status, 404);
  assert.equal((await call('POST', `/${listId}/send`, { userId: 999999 })).status, 404);
  for (const body of [{}, { userId: 0 }, { userId: -1 }, { userId: 'oma' }, { userId: 1.5 }]) {
    resetLimiter();
    const res = await call('POST', `/${listId}/send`, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} muss 400 geben`);
  }
  assert.equal(mailer.sent.length, 0, 'keiner dieser Faelle darf eine Mail ausloesen');
});

test('ein Fehler beim Versand wird nicht als Erfolg gemeldet (#944)', async () => {
  resetLimiter();
  const listId = seedList();
  app.locals.emailService = {
    isConfigured: () => true,
    sendMail: async () => { throw new Error('smtp exploded'); },
  };
  const res = await call('POST', `/${listId}/send`, { userId: OMA });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /could not be sent/i);
  // Die Ursache gehoert ins Log, nicht in die Antwort: sie kann den Hostnamen
  // des Mailservers und Teile der Zugangsdaten enthalten.
  assert.doesNotMatch(JSON.stringify(res.body), /smtp exploded/);
});

test('die Empfaengerliste kennt nur erreichbare Mitglieder (#944)', async () => {
  const { listEmailableMembers, memberEmail } = await import('../server/services/member-email.js');
  const members = listEmailableMembers({ db });
  const ids = members.map((m) => m.id);
  assert.ok(ids.includes(OMA), 'Oma hat eine Adresse');
  assert.ok(ids.includes(SENDER), 'der Absender auch - sich selbst schicken ist erlaubt');
  assert.equal(ids.includes(OHNE_MAIL), false, 'ein Name, den man anklicken kann und der dann scheitert, ist eine Zusage die nicht haelt');
  assert.equal(memberEmail(OMA, { db }), 'oma@example.org');
  assert.equal(memberEmail(OHNE_MAIL, { db }), null);
});

test('die Versandschranke greift, bevor ein Postfach zugeschuettet wird (#944)', async () => {
  // Der API-Limiter darueber erlaubt 300 Anfragen je Minute. Das ist fuer Lesen
  // und Abhaken richtig bemessen und fuer etwas, das eine Mail ausloest, viel zu
  // grosszuegig: 300 Mails in einer Minute an dieselbe Adresse sind keine Hilfe
  // mehr, sondern eine Last fuer das Postfach und fuer den Ruf des SMTP-Servers.
  resetMailer();
  const listId = seedList();
  const codes = [];
  for (let i = 0; i < 14; i++) {
    codes.push((await call('POST', `/${listId}/send`, { userId: OMA })).status);
  }
  assert.ok(codes.includes(429), `keine Schranke gegriffen: ${codes.join(',')}`);
  assert.ok(mailer.sent.length < 14, 'abgewiesene Anfragen duerfen keine Mail ausloesen');
  resetLimiter();
});

test.after(() => server.close());
