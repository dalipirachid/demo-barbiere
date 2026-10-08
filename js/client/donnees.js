// Lecture des données publiques (salon, prestations) avec un petit cache :
// les écrans s'enchaînent sans relire ce qui vient de l'être.
// Le cache est vidé à chaque changement signalé par le Store (onChange).

import { dayRangeISO, addDaysYMD } from '../core/dates.js';

const TTL_MS = 30_000;
// getBusy accepte au plus 62 jours : 61 jours restent en dessous même avec un
// changement d'heure (jour de 25 h) dans la tranche.
const BUSY_CHUNK_DAYS = 61;
const MAX_HORIZON_DAYS = 366;   // maxDaysAhead ≤ 365 (validateSalonPatch)
const cache = new Map();   // nom → { at, promise }

function cached(name, loader) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = loader().catch((err) => {
    // Échec : on n'en garde pas la trace, le prochain écran réessaiera.
    if (cache.get(name) && cache.get(name).promise === promise) cache.delete(name);
    throw err;
  });
  cache.set(name, { at: Date.now(), promise });
  return promise;
}

/** Salon (horaires, réglages, coordonnées). */
export const loadSalon = (store) => cached('salon', () => store.getSalon());

/** Prestations actives, triées par position. */
export const loadServices = (store) => cached('services', () => store.listServices());

export function invalidate() {
  cache.clear();
}

/**
 * Nombre de jours proposés à la réservation : d'aujourd'hui à
 * aujourd'hui + maxDaysAhead, comme le serveur (« 3 mois » compris).
 * Les occupations de cette plage sont lues par tranches (loadBusy).
 */
export function horizonDays(salon) {
  const n = Math.round(Number(salon && salon.maxDaysAhead));
  return Math.min(MAX_HORIZON_DAYS, Math.max(1, (Number.isFinite(n) ? n : 30) + 1));
}

/** Tranches { from, to } (ISO UTC, minuit à minuit) couvrant `days` jours à partir de `ymd`. */
export function busyRanges(ymd, tz, days) {
  const ranges = [];
  for (let i = 0; i < days; i += BUSY_CHUNK_DAYS) {
    ranges.push(dayRangeISO(addDaysYMD(ymd, i), tz, Math.min(BUSY_CHUNK_DAYS, days - i)));
  }
  return ranges;
}

/** Occupations (getBusy, sans donnée personnelle) de `days` jours à partir de `ymd`. */
export async function loadBusy(store, ymd, tz, days) {
  const parts = await Promise.all(busyRanges(ymd, tz, days).map(({ from, to }) => store.getBusy(from, to)));
  return parts.flat();
}
