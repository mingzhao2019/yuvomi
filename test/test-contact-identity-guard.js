/**
 * Modul: E-Mail-Adressen verknuepfter Kontakte
 * Zweck: Die E-Mail-Adressen eines Kontakts mit `family_user_id` fuehren zu
 *        seinem Konto (Passwort-Reset, SSO-Verknuepfung). Sie aendern nur die
 *        verknuepfte Person selbst oder ein Admin - ueber jeden Schreibweg.
 *        Alle anderen Felder bleiben fuer Mitglieder editierbar.
 * Ausfuehren: npm run test:contact-identity-guard
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'contact-identity-guard',
  env: { SESSION_SECRET: 'contact-identity-guard-secret-min32chars' },
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

async function call(s, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  else { headers.Cookie = s.cookie; headers['X-CSRF-Token'] = s.csrfToken; }
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const admin = await login('admin', 'adminpass123');
assert.equal((await call(admin, 'POST', '/auth/users', { username: 'kid', display_name: 'Kid', password: 'kidpass1234' })).status, 201);
const kid = await login('kid', 'kidpass1234');

const db = (await import('../server/db.js')).get();
const { findOrCreateOidcUser, buildResetRoutes } = await import('../server/auth.js');
const { createPasswordResetService } = await import('../server/services/password-reset.js');
const { parseAndMergeContact } = await import('../server/services/cardav-sync.js');

const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
const kidId = db.prepare("SELECT id FROM users WHERE username = 'kid'").get().id;
const contactOf = (userId) => {
  let row = db.prepare('SELECT * FROM contacts WHERE family_user_id = ?').get(userId);
  if (!row) {
    db.prepare("INSERT INTO contacts (name, category, family_user_id) VALUES ('Member', 'misc', ?)").run(userId);
    row = db.prepare('SELECT * FROM contacts WHERE family_user_id = ?').get(userId);
  }
  return row;
};
const adminContact = contactOf(adminId);
const kidContact = contactOf(kidId);
db.prepare("UPDATE contacts SET email = 'admin@home.test', phone = '+49 30 5550100' WHERE id = ?").run(adminContact.id);
db.prepare("UPDATE contacts SET email = 'kid@home.test' WHERE id = ?").run(kidContact.id);

const ATTACKER = 'evil@attacker.test';
const emailsOf = (contactId) => ({
  email: db.prepare('SELECT email FROM contacts WHERE id = ?').get(contactId).email,
  emails: db.prepare('SELECT value FROM contact_emails WHERE contact_id = ? ORDER BY id').all(contactId).map((r) => r.value),
});

test('a member cannot change the primary email of another member\'s linked contact', async () => {
  const r = await call(kid, 'PUT', `/contacts/${adminContact.id}`, { email: ATTACKER });
  assert.equal(r.status, 403);
  assert.equal(emailsOf(adminContact.id).email, 'admin@home.test');
});

test('a member cannot add a secondary email to another member\'s linked contact', async () => {
  const r = await call(kid, 'PUT', `/contacts/${adminContact.id}`, {
    emails: [{ label: 'work', value: ` ${ATTACKER} ` }],
  });
  assert.equal(r.status, 403);
  assert.deepEqual(emailsOf(adminContact.id).emails, []);
});

test('a member cannot swap the address set by moving it into the list either', async () => {
  const r = await call(kid, 'PUT', `/contacts/${adminContact.id}`, {
    email: 'admin@home.test',
    emails: [{ label: 'other', value: 'admin@home.test', isPrimary: true }, { label: 'other', value: ATTACKER }],
  });
  assert.equal(r.status, 403);
  assert.deepEqual(emailsOf(adminContact.id), { email: 'admin@home.test', emails: [] });
});

test('a member-scoped API token is held to the same rule', async () => {
  const created = await call(admin, 'POST', '/auth/api-tokens', {
    name: 'kid-contacts', subject_user_id: kidId, scopes: ['contacts:write'],
  });
  assert.equal(created.status, 201);
  const r = await call({ token: created.body.token }, 'PUT', `/contacts/${adminContact.id}`, { email: ATTACKER });
  assert.equal(r.status, 403);
  assert.equal(emailsOf(adminContact.id).email, 'admin@home.test');
});

test('a member can still edit the other fields of a linked contact, with the unchanged form around them', async () => {
  const r = await call(kid, 'PUT', `/contacts/${adminContact.id}`, {
    notes: 'Allergic to cats', address: 'Main St 1',
    // So sendet das Formular: alle Felder, die Hauptadresse als erste Zeile.
    email: 'admin@home.test',
    emails: [{ label: 'other', value: 'admin@home.test', isPrimary: true }],
  });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT notes, address, email FROM contacts WHERE id = ?').get(adminContact.id);
  assert.equal(row.notes, 'Allergic to cats');
  assert.equal(row.address, 'Main St 1');
  assert.equal(row.email, 'admin@home.test');
});

test('a member who only changes the letter case is not refused, and the stored spelling stays', async () => {
  const r = await call(kid, 'PUT', `/contacts/${adminContact.id}`, {
    notes: 'Case only',
    email: ' Admin@Home.TEST ',
    emails: [{ label: 'other', value: 'ADMIN@home.test', isPrimary: true }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(emailsOf(adminContact.id), { email: 'admin@home.test', emails: [] });
  assert.equal(db.prepare('SELECT notes FROM contacts WHERE id = ?').get(adminContact.id).notes, 'Case only');
  // Eine wirklich andere Adresse bleibt verweigert.
  const other = await call(kid, 'PUT', `/contacts/${adminContact.id}`, { email: 'Admin@Home.test.evil' });
  assert.equal(other.status, 403);
  assert.equal(emailsOf(adminContact.id).email, 'admin@home.test');
});

test('the linked person can change their own email', async () => {
  const r = await call(kid, 'PUT', `/contacts/${kidContact.id}`, {
    email: 'kid.new@home.test', emails: [{ label: 'school', value: 'kid@school.test' }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(emailsOf(kidContact.id), { email: 'kid.new@home.test', emails: ['kid@school.test'] });
});

test('an admin can change a member\'s email', async () => {
  const r = await call(admin, 'PUT', `/contacts/${kidContact.id}`, { email: 'kid@home.test' });
  assert.equal(r.status, 200);
  assert.equal(emailsOf(kidContact.id).email, 'kid@home.test');
});

test('a member can still change the email of a contact that is not linked to an account', async () => {
  const c = await call(kid, 'POST', '/contacts', { name: 'Plumber', email: 'plumber@example.test' });
  assert.equal(c.status, 201);
  const r = await call(kid, 'PUT', `/contacts/${c.body.data.id}`, { email: 'plumber2@example.test' });
  assert.equal(r.status, 200);
  assert.equal(emailsOf(c.body.data.id).email, 'plumber2@example.test');
});

test('a CardDAV sync that adopts a linked contact leaves its email addresses alone', async () => {
  const accountId = db.prepare(
    "INSERT INTO carddav_accounts (name, carddav_url, username, password) VALUES ('t', 'https://dav.example.test', 'u', 'p')"
  ).run().lastInsertRowid;
  const abUrl = 'https://dav.example.test/abook/';
  const card = [
    'BEGIN:VCARD', 'VERSION:3.0', 'UID:adopt-admin', 'FN:Admin',
    'TEL;TYPE=CELL:+49 30 5550100', `EMAIL;TYPE=HOME:${ATTACKER}`, 'EMAIL;TYPE=WORK:second@attacker.test',
    'ORG:Synced Org', 'END:VCARD',
  ].join('\r\n');
  const before = emailsOf(adminContact.id);
  assert.equal(before.email, 'admin@home.test');
  const id = await parseAndMergeContact(card, accountId, abUrl);
  assert.equal(Number(id), adminContact.id, 'the phone match adopts the linked contact');
  // Zweiter Lauf: jetzt ueber die UID, mit fillAll = false.
  await parseAndMergeContact(card, accountId, abUrl);
  assert.deepEqual(emailsOf(adminContact.id), before);
  assert.equal(db.prepare('SELECT organization FROM contacts WHERE id = ?').get(adminContact.id).organization, 'Synced Org');
});

test('SSO does not link the attacker address to the admin account', () => {
  const u = findOrCreateOidcUser(db, { sub: 'attacker-sub', email: ATTACKER, email_verified: true });
  assert.notEqual(u?.id, adminId);
});

test('forgot-password still sends the admin\'s reset link to the admin\'s own address', async () => {
  const sent = [];
  const app = express();
  app.use(express.json());
  const router = express.Router();
  buildResetRoutes(router, {
    database: db,
    emailService: { isConfigured: () => true, sendMail: async (m) => { sent.push(m); } },
    resetService: createPasswordResetService({ db }),
    baseUrl: 'https://yuvomi.test',
    limiter: (_req, _res, next) => next(),
  });
  app.use('/auth', router);
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/auth/forgot-password`;
    const ask = (identifier) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier }),
    });
    assert.equal((await ask('admin')).status, 200);
    assert.equal((await ask(ATTACKER)).status, 200);
    assert.deepEqual(sent.map((m) => m.to), ['admin@home.test']);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
