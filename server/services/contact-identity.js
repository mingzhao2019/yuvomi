/**
 * Modul: Identitaetsfelder eines verknuepften Kontakts
 * Zweck: EINE Regel dafuer, wer die E-Mail-Adressen eines Kontakts mit
 *        `family_user_id` aendern darf - fuer jeden Schreibweg auf contacts.
 *
 * Ein Kontakt mit `family_user_id` IST das Konto eines Menschen im Haushalt,
 * und seine E-Mail-Adressen sind mehr als Kontaktdaten. Sie speisen
 * Anmelde- und Identitaetspfade:
 *
 * - `contacts.email` - forgot-password findet das Konto ueber diese Adresse
 *   (`resolveUser` in server/auth.js) und schickt den Reset-Link dorthin
 *   (`memberEmail()` in server/services/member-email.js); die SSO-Verknuepfung
 *   (`findOrCreateOidcUser`) haengt ein Konto ueber sie an eine
 *   OIDC-Identitaet; derselbe Wert ist Empfaenger fuer Einkaufsliste und
 *   Test-Mail (server/routes/email.js).
 * - `contact_emails.value` - dieselbe SSO-Verknuepfung prueft auch die
 *   Zweitadressen, ebenso die Eindeutigkeitspruefung beim Anlegen eines
 *   SSO-only-Kontos.
 *
 * Die Regel: an einem verknuepften Kontakt aendern diese Adressen nur die
 * verknuepfte Person selbst oder ein Admin. Alle anderen Felder bleiben fuer
 * jeden mit Schreibrecht auf Kontakte editierbar. Ein Schreibweg ohne
 * handelnde Person (der CardDAV-Sync) ist keiner von beiden und laesst die
 * Adressen deshalb stehen.
 */

import { isAdminRequest } from '../middleware/require-admin.js';

/**
 * Wer handelt - aus einem authentifizierten Request.
 * @param {import('express').Request} req
 * @returns {{ userId: number|null, isAdmin: boolean }}
 */
export function contactActorFromRequest(req) {
  return { userId: req.authUserId ?? null, isAdmin: isAdminRequest(req) };
}

/**
 * Darf `actor` die E-Mail-Adressen dieses Kontakts aendern?
 * @param {{ family_user_id?: number|null }} contact
 * @param {{ userId: number|null, isAdmin: boolean }|null} actor
 *   `null` = Schreibweg ohne handelnde Person (Hintergrund-Sync).
 * @returns {boolean}
 */
export function mayChangeContactEmails(contact, actor) {
  if (!contact?.family_user_id) return true;
  if (!actor) return false;
  if (actor.isAdmin === true) return true;
  return actor.userId != null && Number(actor.userId) === Number(contact.family_user_id);
}

const norm = (value) => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
};

/**
 * Aendert ein PUT-Body die E-Mail-Adressen des Kontakts?
 *
 * Verglichen wird, was die Identitaetspfade lesen: die Hauptadresse
 * (`contacts.email`) fuer sich und die Menge ALLER Adressen. Ein unveraendert
 * mitgeschicktes Formular - das Frontend sendet bei jedem Speichern alle
 * Felder - ist damit keine Aenderung, auch wenn es die Hauptadresse
 * zusaetzlich als Zeile in `contact_emails` fuehrt. Labels und die
 * Reihenfolge der Zweitadressen sind keine Identitaet.
 *
 * @param {object} contact  Gespeicherte Zeile aus `contacts`.
 * @param {string[]} storedEmails  Gespeicherte `contact_emails.value`.
 * @param {object} body  Request-Body (email?, emails?).
 * @returns {boolean}
 */
export function bodyChangesContactEmails(contact, storedEmails, body) {
  const oldPrimary = norm(contact.email);
  const newPrimary = body.email !== undefined ? norm(body.email) : oldPrimary;
  if (newPrimary !== oldPrimary) return true;

  const oldSecondary = storedEmails.map(norm).filter(Boolean);
  const newSecondary = Array.isArray(body.emails)
    ? body.emails.map((e) => norm(e?.value)).filter(Boolean)
    : oldSecondary;

  const asSet = (primary, list) => new Set([primary, ...list].filter(Boolean));
  const before = asSet(oldPrimary, oldSecondary);
  const after = asSet(newPrimary, newSecondary);
  if (before.size !== after.size) return true;
  for (const v of after) if (!before.has(v)) return true;
  return false;
}
