/**
 * Modul: Mailadresse eines Haushaltsmitglieds
 * Zweck: Die eine Antwort auf "wie erreiche ich dieses Mitglied per Mail" (#944).
 * Abhaengigkeiten: server/db.js
 *
 * EIN MITGLIED HAT KEINE EIGENE ADRESSE. `users` traegt keine Mailspalte; die
 * Adresse haengt am verknuepften Kontakt (`contacts.family_user_id`). Wer das
 * nicht weiss, sucht sie an der falschen Stelle - und wer es an einer zweiten
 * Stelle nachbaut, hat zwei Fassungen derselben Frage. Der Passwort-Reset
 * beantwortete sie bereits so; seit dem Versand der Einkaufsliste tut es ein
 * zweiter Aufrufer, und beide fragen hier.
 */
import * as dbModule from '../db.js';

const EMAIL_SQL = `
  SELECT email FROM contacts
  WHERE family_user_id = ? AND email IS NOT NULL AND email != ''
  LIMIT 1
`;

/**
 * @returns {string|null} Adresse des Mitglieds, oder null wenn keine hinterlegt ist.
 */
export function memberEmail(userId, { db } = {}) {
  const database = db || dbModule.get();
  const row = database.prepare(EMAIL_SQL).get(userId);
  return row?.email ?? null;
}

/**
 * Mitglieder, die per Mail erreichbar sind - fuer eine Empfaengerauswahl.
 *
 * Hauspersonal bleibt draussen, wie in `/family/members`: dort steht dieselbe
 * Ausnahme, und eine Empfaengerliste, die mehr Leute kennt als die
 * Mitgliederliste, waere eine Ueberraschung.
 */
export function listEmailableMembers({ db } = {}) {
  const database = db || dbModule.get();
  return database.prepare(`
    SELECT u.id, u.display_name, c.email
    FROM users u
    JOIN contacts c ON c.family_user_id = u.id
    WHERE c.email IS NOT NULL AND c.email != ''
      AND NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
    ORDER BY u.display_name COLLATE NOCASE ASC
  `).all();
}
