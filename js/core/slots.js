// Calcul des créneaux : fonctions pures et déterministes (l'heure courante
// est toujours passée en paramètre). Mêmes règles que les fonctions SQL du
// serveur, pour que la démo et le mode en ligne se comportent pareil.

import {
  DEFAULT_TZ, todayYMD, addDaysYMD, weekdayISO, zonedToUtc, zonedParts,
  minutesOf, hhmm, toMs,
} from './dates.js';

const MINUTE = 60_000;

/**
 * Statuts qui occupent réellement leur créneau : confirmé et honoré.
 * Annulé et lapin (no_show) le libèrent, pour qu'un client de passage puisse
 * prendre le temps laissé par un lapin. Même règle que la contrainte
 * d'exclusion SQL (appointments_no_overlap), get_busy et book_appointment.
 */
export const OCCUPYING_STATUSES = Object.freeze(['confirmed', 'done']);

/** Vrai si un RDV de ce statut bloque son créneau. */
export function occupiesSlot(status) {
  return OCCUPYING_STATUSES.includes(status);
}

function settings(salon) {
  const num = (v, def) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : def);
  return {
    tz: salon.timezone || DEFAULT_TZ,
    step: Math.max(5, num(salon.slotStep, 15)),
    notice: Math.max(0, num(salon.minNoticeMin, 60)),
    horizon: Math.max(0, num(salon.maxDaysAhead, 30)),
  };
}

/** Intervalles d'ouverture d'un jour en minutes : [[ouverture, fermeture], …] triés. */
export function dayIntervals(salon, ymd) {
  const list = (salon && salon.hours && salon.hours[String(weekdayISO(ymd))]) || [];
  return list
    .map(([open, close]) => [minutesOf(open), minutesOf(close)])
    .filter(([o, c]) => Number.isFinite(o) && Number.isFinite(c) && c > o)
    .sort((a, b) => a[0] - b[0]);
}

/** Le jour a au moins un intervalle d'ouverture. */
export function isDayOpen(salon, ymd) {
  return dayIntervals(salon, ymd).length > 0;
}

/** Chevauchement strict de deux intervalles [s1, e1) et [s2, e2). */
export function overlaps(s1, e1, s2, e2) {
  return s1 < e2 && e1 > s2;
}

/** Busy[] ({ start, end } en ISO ou Date) → [{ s, e }] en millisecondes. */
function normBusy(busy) {
  const out = [];
  for (const b of busy || []) {
    const s = toMs(b.start);
    const e = toMs(b.end);
    if (Number.isFinite(s) && Number.isFinite(e)) out.push({ s, e });
  }
  return out;
}

/**
 * Créneaux proposés pour un jour.
 * → [{ start: Date, end: Date, hhmm }]
 */
export function computeDaySlots({ salon, durationMin, ymd, busy = [], now = new Date(), forPro = false }) {
  const { tz, step, notice, horizon } = settings(salon);
  const dur = Number(durationMin);
  if (!(dur > 0)) return [];
  const nowMs = toMs(now);

  if (!forPro) {
    const today = todayYMD(tz, now);
    if (ymd < today || ymd > addDaysYMD(today, horizon)) return [];
  }
  const minStart = forPro ? -Infinity : nowMs + notice * MINUTE;
  const taken = normBusy(busy);
  const slots = [];

  for (const [open, close] of dayIntervals(salon, ymd)) {
    // Sans changement d'heure dans l'intervalle (cas normal), on avance en
    // temps absolu ; sinon on recalcule chaque créneau depuis l'heure murale.
    const openMs = zonedToUtc(ymd, hhmm(open), tz).getTime();
    const closeMs = zonedToUtc(ymd, hhmm(close), tz).getTime();
    const linear = closeMs - openMs === (close - open) * MINUTE;

    for (let m = open; m + dur <= close; m += step) {
      const s = linear ? openMs + (m - open) * MINUTE : zonedToUtc(ymd, hhmm(m), tz).getTime();
      const e = s + dur * MINUTE;
      if (s < minStart) continue;
      if (taken.some((b) => s < b.e && e > b.s)) continue;
      slots.push({ start: new Date(s), end: new Date(e), hhmm: hhmm(m) });
    }
  }
  return slots;
}

/** Premier créneau libre sur les `days` prochains jours → { ymd, slot } | null. */
export function firstAvailable({ salon, durationMin, busy = [], now = new Date(), days = 14, forPro = false }) {
  const { tz } = settings(salon);
  const today = todayYMD(tz, now);
  for (let i = 0; i < days; i++) {
    const ymd = addDaysYMD(today, i);
    if (!isDayOpen(salon, ymd)) continue;
    const slots = computeDaySlots({ salon, durationMin, ymd, busy, now, forPro });
    if (slots.length) return { ymd, slot: slots[0] };
  }
  return null;
}

/**
 * Vérifie un créneau comme le ferait le serveur.
 * → null si accepté, sinon 'TOO_SOON' | 'TOO_FAR' | 'OUT_OF_HOURS' | 'SLOT_TAKEN'
 *   ('INVALID' si l'heure ou la durée est illisible).
 * forPro : préavis, horizon et horaires ne s'appliquent pas, seul le
 * chevauchement est interdit.
 */
export function validateSlot({ salon, durationMin, start, busy = [], now = new Date(), forPro = false }) {
  const s = toMs(start);
  const dur = Number(durationMin);
  if (!Number.isFinite(s) || !(dur > 0)) return 'INVALID';
  const e = s + dur * MINUTE;

  if (!forPro) {
    const { tz, notice, horizon } = settings(salon);
    if (s < toMs(now) + notice * MINUTE) return 'TOO_SOON';
    const p = zonedParts(s, tz);
    if (p.ymd > addDaysYMD(todayYMD(tz, now), horizon)) return 'TOO_FAR';
    const fits = dayIntervals(salon, p.ymd).some(([o, c]) => p.minutes >= o && p.minutes + dur <= c);
    if (!fits) return 'OUT_OF_HOURS';
  }
  if (normBusy(busy).some((b) => s < b.e && e > b.s)) return 'SLOT_TAKEN';
  return null;
}
