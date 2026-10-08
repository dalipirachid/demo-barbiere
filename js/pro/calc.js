/**
 * Espace barbière — calculs purs (ni DOM ni Store), testés sous node
 * (tests/pro.test.mjs).
 *
 *   clampMinutes(iso, day, tz)        minutes d'un instant, bornées au jour affiché
 *   nextGap(d, c, nowMs)              tuile « Trou libre » de l'agenda
 *   blockPeriods({ … })               blocages à créer, un par jour de la période
 *   isFullDayBlock(block, tz)         blocage « toute la journée » (minuit → minuit)
 *   isFreshBooking(a, since)          réservation en ligne non annulée créée après since
 *   latestOnlineCreatedAt(list)       plus récente date de création (horloge du serveur)
 *   nextLastSeen(stored, list)        nouveau repère « nouvelles réservations vues »
 */

import { DEFAULT_TZ, addDaysYMD, dayRangeISO, zonedToUtc, zonedParts, toMs } from '../core/dates.js';
import { dayIntervals, occupiesSlot } from '../core/slots.js';

/** Minutes du jour d'un instant, bornées au jour affiché (0 … 1440). */
export function clampMinutes(iso, day, tz = DEFAULT_TZ) {
  const p = zonedParts(iso, tz);
  if (p.ymd < day) return 0;
  if (p.ymd > day) return 1440;
  return p.minutes;
}

/**
 * Prochain trou libre du jour affiché, en minutes :
 * { start, len } | { full } | { over } (aujourd'hui, après la fermeture) | { past } | { closed }.
 *   d : { salon, tz, day, today, services, blocks }   c : { active, isToday }
 * Aujourd'hui, le trou part de la minute courante, sans arrondi au pas :
 * libre maintenant → start ≤ minute courante (« Libre »), longueur comptée depuis maintenant.
 */
export function nextGap(d, c, nowMs) {
  const { salon, tz, day } = d;
  if (day < d.today) return { past: true };
  const intervals = dayIntervals(salon, day);
  if (!intervals.length) return { closed: true };
  const from = c.isToday ? zonedParts(nowMs, tz).minutes : 0;
  if (from >= intervals[intervals.length - 1][1]) return { over: true };
  const durations = (d.services || []).map((s) => Number(s.durationMin)).filter((n) => n > 0);
  const minDur = durations.length ? Math.min(...durations) : 15;
  // Un lapin (no_show) libère son créneau, comme côté serveur (RES-12).
  const busy = [...c.active.filter((a) => occupiesSlot(a.status)), ...(d.blocks || [])]
    .map((x) => [clampMinutes(x.start, day, tz), clampMinutes(x.end, day, tz)])
    .sort((a, b) => a[0] - b[0]);

  for (const [open, close] of intervals) {
    let cur = Math.max(open, from);
    if (cur >= close) continue;
    for (const [bs, be] of busy) {
      if (be <= cur || bs >= close) continue;
      if (bs - cur >= minDur) return { start: cur, len: bs - cur };
      cur = Math.max(cur, be);
      if (cur >= close) break;
    }
    if (close - cur >= minDur) return { start: cur, len: close - cur };
  }
  return { full: true };
}

/**
 * Blocages à créer pour une période, un par jour, jours de fermeture compris
 * (les horaires peuvent changer ensuite : un congé doit tenir quand même).
 * - allDay : de minuit à minuit (dayRangeISO : 23 h ou 25 h aux changements d'heure) ;
 * - sinon de `from` à `to` (heures murales 'HH:MM') chaque jour ; un jour où
 *   cette plage n'existe pas (passage à l'heure d'été) est ignoré.
 * → [{ ymd, start, end, allDay }] (ISO UTC)
 */
export function blockPeriods({ dayFrom, dayTo, allDay = false, from = '', to = '', tz = DEFAULT_TZ }) {
  const out = [];
  for (let d = dayFrom; d <= dayTo; d = addDaysYMD(d, 1)) {
    if (allDay) {
      const r = dayRangeISO(d, tz);
      out.push({ ymd: d, start: r.from, end: r.to, allDay: true });
      continue;
    }
    const start = zonedToUtc(d, from, tz);
    const end = zonedToUtc(d, to, tz);
    if (end > start) out.push({ ymd: d, start: start.toISOString(), end: end.toISOString(), allDay: false });
  }
  return out;
}

/** Vrai pour un blocage d'un jour entier, de minuit à minuit (heure du salon). */
export function isFullDayBlock(block, tz = DEFAULT_TZ) {
  const s = toMs(block && block.start);
  const e = toMs(block && block.end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  const r = dayRangeISO(zonedParts(s, tz).ymd, tz);
  return s === Date.parse(r.from) && e === Date.parse(r.to);
}

/** Réservation en ligne non annulée, créée après `since` (ms). */
export function isFreshBooking(a, since) {
  return a.source === 'online' && a.status !== 'cancelled' && Date.parse(a.createdAt) > since;
}

/** Plus récente date de création des réservations en ligne non annulées (ms, NaN si aucune). */
export function latestOnlineCreatedAt(list) {
  let max = NaN;
  for (const a of list || []) {
    if (a.source !== 'online' || a.status === 'cancelled') continue;
    const t = Date.parse(a.createdAt);
    if (Number.isFinite(t) && !(t <= max)) max = t;
  }
  return max;
}

/**
 * Repère « vu » à enregistrer après un affichage de l'agenda : la plus récente
 * date de création affichée (horloge du serveur, pas celle du téléphone).
 * N'avance que vers l'avant ; null = rien à écrire.
 */
export function nextLastSeen(storedMs, list) {
  const latest = latestOnlineCreatedAt(list);
  if (!Number.isFinite(latest)) return null;
  if (Number.isFinite(storedMs) && storedMs >= latest) return null;
  return latest;
}
