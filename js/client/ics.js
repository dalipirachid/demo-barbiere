// Fichier agenda (.ics, RFC 5545) pour « Ajouter à mon agenda ».
// Heures en UTC (suffixe Z), lignes terminées par CRLF et repliées à
// 75 octets, textes échappés (\ ; , et retours à la ligne).
// Le fichier est fabriqué dans le téléphone (Blob) : rien n'est envoyé.

const CRLF = '\r\n';
const encoder = new TextEncoder();

/** Échappe une valeur de type TEXT (RFC 5545 §3.3.11). */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Instant → '20261008T120000Z' (UTC). */
export function utcStamp(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (Number.isNaN(d.getTime())) throw new TypeError(`Date invalide : ${dateOrIso}`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** Replie une ligne à 75 octets (UTF-8) ; les suites commencent par une espace. */
export function foldLine(line) {
  const parts = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {                 // par caractère : jamais un caractère coupé en deux
    const size = encoder.encode(ch).length;
    if (bytes + size > 75) {
      parts.push(current);
      current = ' ' + ch;
      bytes = 1 + size;
    } else {
      current += ch;
      bytes += size;
    }
  }
  parts.push(current);
  return parts.join(CRLF);
}

/** Durée de déclenchement du rappel : 120 → '-PT2H', 90 → '-PT90M'. */
function trigger(minutes) {
  const m = Math.max(0, Math.round(minutes));
  return m % 60 === 0 ? `-PT${m / 60}H` : `-PT${m}M`;
}

/**
 * Construit le contenu du fichier .ics d'un rendez-vous.
 *   uid          identifiant stable (jeton@barbiere) : réimporter met à jour au lieu de dupliquer
 *   start / end  instants (ISO ou Date)
 *   alarmMinutes rappel avant le début (120 = 2 h), 0 = sans rappel
 */
export function buildICS({
  uid, start, end, summary, location = '', description = '', url = '',
  alarmMinutes = 120, alarmText = '', now = new Date(),
}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Planning Barbiere//Reservation en ligne//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeText(uid)}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${escapeText(summary)}`,
  ];
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (/^https?:\/\/\S+$/.test(url)) lines.push(`URL:${url}`);   // type URI : pas d'échappement texte
  lines.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE');
  if (alarmMinutes > 0) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(alarmText || summary)}`,
      `TRIGGER:${trigger(alarmMinutes)}`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** Propose le fichier au téléphone (téléchargement / ouverture par l'agenda). */
export function downloadICS(filename, content) {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
