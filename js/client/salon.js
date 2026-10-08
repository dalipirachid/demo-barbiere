// Infos pratiques du salon : statut d'ouverture, libellés de jours, liens
// (itinéraire, appel, Instagram) et titre de la page.
// Les liens ne sont construits qu'à partir de valeurs vérifiées.

import { html } from '../ui/dom.js';
import { DEFAULT_TZ, zonedParts, todayYMD, addDaysYMD, fmtClock, fmtDayLong } from '../core/dates.js';
import { dayIntervals } from '../core/slots.js';
import { normalizePhone, fmtPhone } from '../core/validate.js';
import { errorMessage } from '../core/errors.js';

export const TODO_MARK = '[À COMPLÉTER]';

export function tzOf(salon) {
  return (salon && salon.timezone) || DEFAULT_TZ;
}

/** Texte du salon à afficher : une information encore à fournir est surlignée. */
export function txt(value) {
  const s = String(value ?? '');
  return s.includes(TODO_MARK) ? html`<span class="todo">${s}</span>` : s;
}

/** Première lettre en capitale (« mardi 7 octobre » → « Mardi 7 octobre »). */
export function cap(value) {
  const s = String(value ?? '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** « Adresse, Ville » (ce qui est renseigné). */
export function addressText(salon) {
  return [salon.address, salon.city].map((v) => String(v || '').trim()).filter(Boolean).join(', ');
}

/** Lien d'itinéraire (Google Maps, simple lien : rien n'est chargé dans la page). */
export function mapsUrl(salon) {
  const query = addressText(salon);
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : '';
}

/** 'tel:+33…' si le téléphone du salon est valide, sinon ''. */
export function telUrl(salon) {
  const e164 = normalizePhone(salon && salon.phone);
  return e164 ? `tel:${e164}` : '';
}

/** Réservation suspendue (CLOSED) : pas d'invitation à appeler sans numéro du salon. */
export function closedText(salon) {
  return telUrl(salon)
    ? errorMessage('CLOSED')
    : 'La réservation en ligne est momentanément suspendue. Revenez un peu plus tard.';
}

/** Téléphone du salon au format français lisible ('' si absent ou invalide). */
export function phoneLabel(salon) {
  const e164 = normalizePhone(salon && salon.phone);
  return e164 ? fmtPhone(e164) : '';
}

function instagramHandle(salon) {
  const raw = String((salon && salon.instagram) || '').trim();
  if (!raw) return '';
  const m = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i.exec(raw);
  const handle = m ? m[1] : raw.replace(/^@/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(handle) ? handle : '';
}

/** Lien vers le compte Instagram ('' si le compte renseigné n'est pas lisible). */
export function instagramUrl(salon) {
  const handle = instagramHandle(salon);
  return handle ? `https://www.instagram.com/${handle}/` : '';
}

/** Intervalles d'ouverture d'un jour, plages qui se touchent fusionnées. */
function openRanges(salon, ymd) {
  const out = [];
  for (const [open, close] of dayIntervals(salon, ymd)) {
    const last = out[out.length - 1];
    if (last && open <= last[1]) last[1] = Math.max(last[1], close);
    else out.push([open, close]);
  }
  return out;
}

/**
 * Statut d'ouverture à l'instant `now`, dans le fuseau du salon.
 * → { open, text } : « Ouvert jusqu’à 19h00 », « Fermé — rouvre à 13h30 »,
 *   « Fermé — ouvre demain à 9h00 », « Fermé — ouvre mardi à 9h00 ».
 */
export function openStatus(salon, now = new Date()) {
  const { ymd, minutes } = zonedParts(now, tzOf(salon));
  const today = openRanges(salon, ymd);
  const current = today.find(([o, c]) => minutes >= o && minutes < c);
  if (current) return { open: true, text: `Ouvert jusqu’à ${fmtClock(current[1])}` };

  const later = today.find(([o]) => o > minutes);
  if (later) {
    const verb = today.some(([, c]) => c <= minutes) ? 'rouvre' : 'ouvre';
    return { open: false, text: `Fermé — ${verb} à ${fmtClock(later[0])}` };
  }
  for (let i = 1; i <= 7; i++) {
    const day = addDaysYMD(ymd, i);
    const ranges = openRanges(salon, day);
    if (ranges.length) {
      const label = i === 1 ? 'demain' : i < 7 ? fmtDayLong(day).split(' ')[0] : fmtDayLong(day);
      return { open: false, text: `Fermé — ouvre ${label} à ${fmtClock(ranges[0][0])}` };
    }
  }
  return { open: false, text: 'Fermé pour le moment' };
}

/**
 * Jour en clair, relatif à aujourd'hui : « aujourd’hui », « demain »,
 * « jeudi » (dans la semaine qui vient), sinon « jeudi 16 octobre ».
 */
export function dayLabel(ymd, tz = DEFAULT_TZ, now = new Date()) {
  const today = todayYMD(tz, now);
  if (ymd === today) return 'aujourd’hui';
  if (ymd === addDaysYMD(today, 1)) return 'demain';
  if (ymd > today && ymd < addDaysYMD(today, 7)) return fmtDayLong(ymd).split(' ')[0];
  return fmtDayLong(ymd);
}

/** Titre de l'onglet : « Écran · Nom du salon » (accueil : « Nom du salon — Réserver en ligne »). */
export function setDocumentTitle(salon, label = '') {
  const name = String((salon && salon.name) || '').trim() || 'Réservation';
  document.title = label ? `${label} · ${name}` : `${name} — Réserver en ligne`;
}
