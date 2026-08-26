// --------------------------------------------------------
// tsdav-Client für ein caldav_accounts-Konto.
//
// Termine (caldav-sync.js), VTODO-Inbound (caldav-reminders-sync.js) und der
// VTODO-Outbound (caldav-todo-outbound.js) sprechen denselben Server mit
// denselben Zugangsdaten an; die Factory lag dreimal wortgleich herum. tsdav wird
// bewusst dynamisch geladen: der Import zieht spürbar Code nach, und wer keinen
// CalDAV-Account eingerichtet hat, soll ihn nie laden.
// --------------------------------------------------------

/**
 * @param {{caldav_url: string, username: string, password: string}} account
 * @returns {Promise<object>} tsdav-Client
 */
export async function createCalDAVClient(account) {
  const { createDAVClient } = await import('tsdav');
  const client = await createDAVClient({
    serverUrl:          account.caldav_url,
    credentials:        { username: account.username, password: account.password },
    authMethod:         'Basic',
    defaultAccountType: 'caldav',
  });
  return withCalendarObjectUrlFilter(client);
}

/**
 * Pfad einer Objekt-URL, vergleichbar gemacht. Absolute URL und href aus einer
 * Server-Antwort laufen beide hier durch, damit der Vergleich in
 * `calendarObjectUrlFilter` nicht an Host oder Schreibweise scheitert.
 */
function pathOf(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try { return new URL(raw, 'http://caldav.invalid/').pathname; } catch { return raw; }
}

/**
 * Welche href aus einer `calendar-query`-Antwort ist ein Kalenderobjekt?
 *
 * tsdav filtert hier per Default auf `.ics` im Pfad (`fetchCalendarObjects`,
 * v2.3.1). Die Endung ist aber reine Konvention: RFC 4791 schreibt keinen
 * Namen für die Objekt-Ressource vor, und ein Server darf sie frei vergeben.
 * Stalwart tut das für alles, was über JMAP angelegt wurde ("NZtPkIOMoK"),
 * während per CalDAV-PUT abgelegte Objekte den Clientnamen `<uid>.ics`
 * behalten - im selben Kalender fielen deshalb einzelne Termine still aus dem
 * Sync (#883), ohne dass sie je abgerufen und damit je geloggt wurden.
 *
 * Was der Filter wirklich fernhalten muss, ist die Collection selbst: manche
 * Server liefern sie bei `Depth: 1` mit. Genau so macht es tsdav auf der
 * CardDAV-Seite (`fetchVCards` filtert `urlEquals(url, addressBook.url)`), nur
 * auf der CalDAV-Seite eben nicht.
 *
 * @param {string} collectionUrl  URL des Kalenders, dessen Objekte geholt werden
 */
export function calendarObjectUrlFilter(collectionUrl) {
  const collection = pathOf(collectionUrl).replace(/\/+$/, '');
  return (url) => {
    const path = pathOf(url);
    if (!path) return false;
    if (path.endsWith('/')) return false; // Collection, kein Objekt
    return path.replace(/\/+$/, '') !== collection;
  };
}

/**
 * Hängt `calendarObjectUrlFilter` als Default an `fetchCalendarObjects`.
 *
 * Der Filter sitzt am Client statt an den Aufrufstellen, weil er einen
 * Bibliotheks-Default neutralisiert: fünf Stellen holen Kalenderobjekte, und
 * eine sechste würde die Regel sonst wieder verlieren. Ein explizit
 * übergebener `urlFilter` gewinnt weiterhin.
 */
export function withCalendarObjectUrlFilter(client) {
  const fetchCalendarObjects = client.fetchCalendarObjects.bind(client);
  return {
    ...client,
    fetchCalendarObjects: (params = {}) => fetchCalendarObjects({
      urlFilter: calendarObjectUrlFilter(params?.calendar?.url),
      ...params,
    }),
  };
}

/**
 * Trägt eine Collection die gesuchte iCalendar-Komponente?
 *
 * `supported-calendar-component-set` ist laut RFC 4791 §5.2.3 optional: fehlt die
 * Property, muss der Client alle Komponenten annehmen. tsdav liefert dann ein
 * leeres `components`-Array - wer darauf strikt filtert, blendet auf solchen
 * Servern jede Collection aus. Die Regel steht hier einmal, weil Termine und
 * Aufgaben sie spiegelbildlich brauchen und sie vorher auf der einen Seite fehlte
 * (Aufgabenlisten landeten in der Kalenderauswahl) und auf der anderen zu streng
 * war (#617).
 *
 * @param {{components?: string[]}} cal  Collection aus `fetchCalendars()`
 * @param {string} component            'VEVENT' | 'VTODO'
 */
export function supportsComponent(cal, component) {
  const comps = Array.isArray(cal?.components) ? cal.components : [];
  if (comps.length === 0) return true;
  return comps.map(c => String(c).toUpperCase()).includes(String(component).toUpperCase());
}

/**
 * Collection-URL eines Kalenderobjekts: alles bis zum letzten Segment.
 * CalDAV-Objekte liegen unmittelbar in ihrer Collection, deshalb ist der Pfad
 * ohne Dateinamen die Liste, zu der das Objekt gehört. Nötig, weil tsdav ein
 * Objekt nur innerhalb seiner Collection adressiert, Aufgaben und Einkaufsposten
 * aber nur ihre Objekt-URL tragen.
 */
export function collectionUrlOf(objectUrl) {
  const url = String(objectUrl || '');
  const cut = url.lastIndexOf('/');
  return cut === -1 ? null : url.slice(0, cut + 1);
}
