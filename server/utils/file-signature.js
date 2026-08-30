/**
 * Modul: Dateisignaturen (Magic Bytes)
 * Zweck: Prueft, ob der Inhalt eines Uploads zu dem Typ passt, als der er
 *        deklariert wurde.
 *
 * WARUM DAS NOETIG IST. Jeder Upload-Pfad in Yuvomi nimmt eine data-URL entgegen
 * und glaubt bisher deren Praefix: `data:application/pdf;base64,...` galt als PDF,
 * weil dort "application/pdf" steht. Diese Angabe kommt aus dem Browser des
 * Absenders und laesst sich mit einem einzigen HTTP-Request frei setzen.
 *
 * Der Auslieferungspfad ist gegen die Folgen bereits gut gesichert - fester
 * Content-Type, `nosniff` und eine enge CSP verhindern, dass ein falsch
 * deklarierter Inhalt je als HTML oder Skript ausgefuehrt wird. Was er nicht
 * verhindert, ist der stille Fall: Ein Familienplaner ist ein Ablageort auf
 * Jahre. Eine Datei, die als "Versicherungsschein.pdf" abgelegt wird und keins
 * ist, faellt erst auf, wenn jemand sie braucht. Eine Pruefung beim Hochladen
 * kostet ein paar Bytes Vergleich und meldet den Fehler dem, der ihn noch
 * beheben kann.
 *
 * WAS HIER BEWUSST NICHT PASSIERT. Fuer `text/plain` und `text/csv` gibt es
 * keine Signatur - Text faengt mit dem an, was drinsteht. Ein Heuristik-Versuch
 * ("faengt es mit < an, ist es HTML") wuerde eine CSV ablehnen, deren erste
 * Zelle spitze Klammern enthaelt. Diese Typen passieren deshalb ungeprueft; sie
 * traegt die Auslieferungsseite.
 *
 * Abhaengigkeiten: keine.
 */

// Ein Praefix-Vergleich. `offset` fuer Formate, deren Kennung nicht am Anfang steht.
const prefix = (bytes, offset = 0) => (buf) =>
  buf.length >= offset + bytes.length
  && bytes.every((b, i) => buf[offset + i] === b);

const ascii = (text, offset = 0) => prefix([...text].map((c) => c.charCodeAt(0)), offset);

// Ein PDF darf laut Adobes eigener Auslegung bis zu 1024 Bytes Vorlauf haben
// (Mailer und Scanner haengen gern etwas davor). Wer strikt auf Byte 0 prueft,
// lehnt reale, in jedem Reader funktionierende Dateien ab.
const pdfHeader = (buf) => buf.subarray(0, 1024).includes('%PDF-');

// ZIP-Container. Office-Formate ab 2007 sind ZIPs; `PK\x03\x04` ist der Anfang
// des ersten Eintrags und bei einem Dokument mit Inhalt immer der Start.
const zipHeader = prefix([0x50, 0x4b, 0x03, 0x04]);

// OLE2 Compound File - die Huelle der Office-Formate vor 2007.
const oleHeader = prefix([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const webpHeader = (buf) => ascii('RIFF')(buf) && ascii('WEBP', 8)(buf);

const gifHeader = (buf) => ascii('GIF87a')(buf) || ascii('GIF89a')(buf);

/**
 * MIME-Typ → Pruefung seiner Signatur. Ein Typ, der hier fehlt, hat keine
 * (Text) oder wird nirgends akzeptiert.
 */
const SIGNATURES = new Map([
  ['application/pdf', pdfHeader],
  ['image/png', prefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  // Alle JPEG-Varianten (JFIF, Exif, roh) beginnen mit SOI + dem naechsten Marker.
  ['image/jpeg', prefix([0xff, 0xd8, 0xff])],
  ['image/webp', webpHeader],
  ['image/gif', gifHeader],
  ['application/msword', oleHeader],
  ['application/vnd.ms-excel', oleHeader],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', zipHeader],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zipHeader],
]);

// `image/jpg` ist kein registrierter Typ, kommt aus aelteren Clients aber vor und
// wird an mehreren Stellen akzeptiert - dieselbe Signatur wie image/jpeg.
SIGNATURES.set('image/jpg', SIGNATURES.get('image/jpeg'));

/**
 * Passt der Inhalt zum deklarierten Typ?
 *
 * Liefert `true` auch fuer Typen ohne bekannte Signatur - "nicht widerlegt" ist
 * hier die richtige Antwort, nicht "abgelehnt": Diese Funktion entscheidet nicht,
 * WELCHE Typen erlaubt sind (das tun die Allowlists der Aufrufer), sondern nur,
 * ob ein erlaubter Typ haelt, was er verspricht.
 *
 * @param {Buffer|Uint8Array} buffer Roher Dateiinhalt
 * @param {string} mime              Deklarierter MIME-Typ (klein geschrieben)
 * @returns {boolean}
 */
export function contentMatchesMime(buffer, mime) {
  const check = SIGNATURES.get(String(mime || '').toLowerCase());
  if (!check) return true;
  if (!buffer || !buffer.length) return false;
  return check(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

/** Kennt dieses Modul eine Signatur fuer den Typ? Fuer Tests und Diagnose. */
export function hasSignature(mime) {
  return SIGNATURES.has(String(mime || '').toLowerCase());
}

// Zum Pruefen reicht der Anfang der Datei. 2048 Base64-Zeichen sind 1536 Bytes -
// mehr als die 1024, die der laengste Test (PDF) durchsucht, und unabhaengig
// davon, ob die Datei 4 KB oder 5 MB gross ist.
const HEAD_B64_CHARS = 2048;

/**
 * Passt der Inhalt einer Base64-data-URL zu ihrem eigenen MIME-Praefix?
 *
 * Fuer die Bild-Uploads (Geburtstagsfoto, Haushaltshilfe, Schnellzugriff-Icon,
 * Abo-Logo), die die data-URL als String behalten und sie nie ganz dekodieren.
 * Dekodiert nur den Kopf, nicht die ganze Datei.
 *
 * @param {unknown} dataUrl
 * @returns {boolean} false nur, wenn eine bekannte Signatur widerlegt wurde
 */
export function dataUrlContentMatches(dataUrl) {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(String(dataUrl || ''));
  if (!match) return false;
  const mime = match[1].toLowerCase();
  if (!hasSignature(mime)) return true;
  // Base64 dekodiert in 4er-Gruppen; ein angeschnittener Rest ergaebe Fuellbytes.
  const b64 = match[2].replace(/\s/g, '').slice(0, HEAD_B64_CHARS);
  const head = Buffer.from(b64.slice(0, b64.length - (b64.length % 4)), 'base64');
  return contentMatchesMime(head, mime);
}
