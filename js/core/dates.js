// Dates, fuseau horaire et formats français.
// Tout passe par Intl.DateTimeFormat (formatToParts) avec un fuseau explicite :
// le résultat ne dépend jamais du fuseau de l'appareil.
// Conventions : 'YYYY-MM-DD' pour un jour, 'HH:MM' pour une heure murale,
// instants échangés en ISO UTC (toISOString()).

export const DEFAULT_TZ = 'Europe/Paris';

const MINUTE = 60_000;
const DAY = 86_400_000;

const DOW_LONG = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const DOW_SHORT = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.',
  'août', 'sept.', 'oct.', 'nov.', 'déc.'];

const pad = (n) => String(n).padStart(2, '0');

// — Outils internes ———————————————————————————————————————————————

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Instant (Date, ISO ou millisecondes) → millisecondes (NaN si illisible). */
export function toMs(dateOrIso) {
  if (dateOrIso instanceof Date) return dateOrIso.getTime();
  if (typeof dateOrIso === 'number') return dateOrIso;
  if (typeof dateOrIso === 'string' && dateOrIso) return Date.parse(dateOrIso);
  return NaN;
}

/** Heure murale d'un instant dans un fuseau : { year, month, day, hour, minute, second }. */
function wallParts(ms, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0; // anciens moteurs : minuit noté « 24 »
  return out;
}

/** Décalage du fuseau (ms) à un instant donné : heure murale − UTC. */
function offsetMs(ms, tz) {
  const p = wallParts(ms, tz);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/** 'YYYY-MM-DD' → [année, mois, jour] (nombres). */
export function parseYMD(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) throw new TypeError(`Jour invalide : ${ymd}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function ymdFromUtcDate(d) {
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// — API du contrat ——————————————————————————————————————————————

/** Minutes depuis minuit pour 'HH:MM' (NaN si format invalide). */
export function minutesOf(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm).trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes depuis minuit → 'HH:MM'. */
export function hhmm(minutes) {
  const m = Math.round(Number(minutes));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Jour courant 'YYYY-MM-DD' dans le fuseau du salon. */
export function todayYMD(tz = DEFAULT_TZ, now = new Date()) {
  return zonedParts(now, tz).ymd;
}

/** Ajoute n jours (positif ou négatif) à un jour calendaire. */
export function addDaysYMD(ymd, n) {
  const [y, m, d] = parseYMD(ymd);
  return ymdFromUtcDate(new Date(Date.UTC(y, m - 1, d + Number(n))));
}

/** Jour de la semaine ISO : 1 = lundi … 7 = dimanche. */
export function weekdayISO(ymd) {
  const [y, m, d] = parseYMD(ymd);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * Instant UTC correspondant à une heure murale dans un fuseau.
 * Changements d'heure (même règle que Temporal « compatible ») :
 * - heure ambiguë (passage à l'heure d'hiver) → première occurrence ;
 * - heure inexistante (passage à l'heure d'été) → décalée vers l'avant
 *   (02:30 le jour du passage devient 03:30).
 */
export function zonedToUtc(ymd, hm = '00:00', tz = DEFAULT_TZ) {
  const [y, mo, d] = parseYMD(ymd);
  const mins = minutesOf(hm);
  if (Number.isNaN(mins)) throw new TypeError(`Heure invalide : ${hm}`);
  const local = Date.UTC(y, mo - 1, d) + mins * MINUTE;
  const before = offsetMs(local - DAY, tz);
  const after = offsetMs(local + DAY, tz);
  const valid = [];
  for (const off of new Set([before, after])) {
    const t = local - off;
    if (offsetMs(t, tz) === off) valid.push(t);
  }
  if (valid.length) return new Date(Math.min(...valid));
  return new Date(local - before);
}

/** Heure murale d'un instant : { ymd, hhmm, minutes, weekday }. */
export function zonedParts(dateOrIso, tz = DEFAULT_TZ) {
  const ms = toMs(dateOrIso);
  if (Number.isNaN(ms)) throw new TypeError(`Date invalide : ${dateOrIso}`);
  const p = wallParts(ms, tz);
  const ymd = `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`;
  const minutes = p.hour * 60 + p.minute;
  return { ymd, hhmm: hhmm(minutes), minutes, weekday: weekdayISO(ymd) };
}

/** '14h30', '9h00' (sans zéro initial). */
export function fmtTime(dateOrIso, tz = DEFAULT_TZ) {
  return fmtClock(zonedParts(dateOrIso, tz).minutes);
}

/** 'mardi 7 octobre' ('1er' pour le premier du mois). */
export function fmtDayLong(ymd) {
  const [, m, d] = parseYMD(ymd);
  return `${DOW_LONG[weekdayISO(ymd) - 1]} ${d === 1 ? '1er' : d} ${MONTHS[m - 1]}`;
}

/** { dow: 'mar.', day: '7', month: 'oct.' } */
export function fmtDayShort(ymd) {
  const [, m, d] = parseYMD(ymd);
  return { dow: DOW_SHORT[weekdayISO(ymd) - 1], day: String(d), month: MONTHS_SHORT[m - 1] };
}

/** "aujourd'hui" | 'demain' | 'mardi 7 octobre' */
export function fmtRelativeDay(ymd, tz = DEFAULT_TZ, now = new Date()) {
  const today = todayYMD(tz, now);
  if (ymd === today) return "aujourd'hui";
  if (ymd === addDaysYMD(today, 1)) return 'demain';
  return fmtDayLong(ymd);
}

/** '22 €' | '22,50 €' | '1 200 €' (centimes entiers en entrée). */
export function fmtPrice(cents) {
  const n = Math.round(Number(cents) || 0);
  const abs = Math.abs(n);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const rest = abs % 100;
  // Espace insécable : « € » ne se retrouve jamais seul en début de ligne.
  return `${n < 0 ? '-' : ''}${euros}${rest ? ',' + pad(rest) : ''} €`;
}

/** '45 min' | '1 h' | '1 h 15' */
export function fmtDuration(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${pad(r)}` : `${h} h`;
}

// — Compléments (hors contrat initial, documentés dans ARCHITECTURE.md) ——————

/** Heure murale 'HH:MM' ou minutes → '9h00' (utile pour afficher les horaires). */
export function fmtClock(hmOrMinutes) {
  const m = typeof hmOrMinutes === 'number' ? hmOrMinutes : minutesOf(hmOrMinutes);
  return `${Math.floor(m / 60)}h${pad(m % 60)}`;
}

/** 'mardi 7 octobre à 14h30' */
export function fmtDateTime(dateOrIso, tz = DEFAULT_TZ) {
  const p = zonedParts(dateOrIso, tz);
  return `${fmtDayLong(p.ymd)} à ${fmtClock(p.minutes)}`;
}

/** Bornes UTC d'un jour du salon : { from, to } en ISO (to = minuit du lendemain). */
export function dayRangeISO(ymd, tz = DEFAULT_TZ, days = 1) {
  return {
    from: zonedToUtc(ymd, '00:00', tz).toISOString(),
    to: zonedToUtc(addDaysYMD(ymd, days), '00:00', tz).toISOString(),
  };
}
