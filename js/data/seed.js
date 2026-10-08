// Données de démonstration (mode démo uniquement).
// Salon et prestations : identiques à supabase/schema.sql (§8 du contrat).
// Clients et rendez-vous : fictifs, générés relativement à « maintenant »
// de façon déterministe (même jour → même planning), toujours dans les
// horaires d'ouverture et sans chevauchement.
// Téléphones : tranche 06 39 98 xx xx, réservée par l'Arcep aux œuvres de
// fiction (aucun abonné réel). E-mails : domaine réservé example.com.

import { todayYMD, addDaysYMD, weekdayISO, zonedToUtc, minutesOf, hhmm } from '../core/dates.js';
import { normalizePhone } from '../core/validate.js';

export const DEMO_VERSION = 1;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function demoSalon() {
  return {
    name: '[À COMPLÉTER] Nom du salon',
    tagline: 'Barbière',
    address: '[À COMPLÉTER] Adresse',
    city: '[À COMPLÉTER] Ville',
    phone: '',
    email: '',
    instagram: '',
    timezone: 'Europe/Paris',
    hours: {
      1: [],
      2: [['09:00', '12:00'], ['13:30', '19:00']],
      3: [['09:00', '12:00'], ['13:30', '19:00']],
      4: [['09:00', '12:00'], ['13:30', '19:00']],
      5: [['09:00', '12:00'], ['13:30', '19:30']],
      6: [['09:00', '17:00']],
      7: [],
    },
    slotStep: 15,
    minNoticeMin: 60,
    maxDaysAhead: 30,
    cancelLimitHours: 2,
    bookingEnabled: true,
    notice: '',
  };
}

// Tarifs hypothétiques, à confirmer avec la barbière.
const SERVICES = [
  ['svc-coupe-homme', 'Coupe', 'Coupe homme', 'Shampooing, coupe ciseaux et tondeuse, coiffage', 30, 2200],
  ['svc-degrade', 'Coupe', 'Dégradé', 'Dégradé américain ou à blanc, finitions au rasoir', 45, 2500],
  ['svc-contours', 'Coupe', 'Contours / lignes', 'Retouche des contours entre deux coupes', 15, 1000],
  ['svc-barbe', 'Barbe', 'Taille de barbe', 'Mise en forme, contours au rasoir, serviette chaude', 20, 1500],
  ['svc-coupe-barbe', 'Barbe', 'Coupe + barbe', 'La formule complète', 60, 3500],
  ['svc-rasage', 'Barbe', "Rasage à l'ancienne", 'Rasoir droit, serviette chaude, soin après-rasage', 30, 2500],
  ['svc-enfant', 'Enfant', 'Coupe enfant', "Jusqu'à 12 ans", 30, 1500],
];

export function demoServices() {
  return SERVICES.map(([id, category, name, description, durationMin, priceCents], i) => ({
    id, name, description, durationMin, priceCents, category, active: true, position: i + 1,
  }));
}

// Fréquence relative de chaque prestation (même ordre que SERVICES).
const SERVICE_WEIGHTS = [30, 28, 8, 10, 13, 4, 7];

// Clientèle fictive : [prénom, nom, téléphone, e-mail, prestation habituelle, note]
const CLIENTS = [
  ['Karim', 'Benali', '06 39 98 00 01', 'karim.benali@example.com', 1, 'Dégradé à blanc, dessus aux ciseaux.'],
  ['Mamadou', 'Diallo', '06 39 98 00 02', '', 4, ''],
  ['Lucas', 'Martin', '06 39 98 00 03', 'lucas.martin@example.com', 0, ''],
  ['Yanis', 'Haddad', '06 39 98 00 04', '', 1, 'Contours entre deux coupes.'],
  ['Théo', 'Lefèvre', '06 39 98 00 05', 'theo.lefevre@example.com', 0, ''],
  ['Moussa', 'Traoré', '06 39 98 00 06', '', 3, ''],
  ['Antoine', 'Moreau', '06 39 98 00 07', 'antoine.moreau@example.com', 5, 'Préfère les rendez-vous du samedi matin.'],
  ['Minh', 'Nguyen', '06 39 98 00 08', '', 0, ''],
  ['Samir', 'Bouzid', '06 39 98 00 09', 'samir.bouzid@example.com', 4, ''],
  ['Hugo', 'Petit', '06 39 98 00 10', '', 1, ''],
  ['Ibrahim', 'Koné', '06 39 98 00 11', '', 2, ''],
  ['Rui', 'Pereira', '06 39 98 00 12', 'rui.pereira@example.com', 0, ''],
  ['Kevin', 'Mendy', '06 39 98 00 13', '', 1, ''],
  ['Adam', 'Cohen', '06 39 98 00 14', 'adam.cohen@example.com', 3, ''],
  ['Inès', 'Mansouri', '06 39 98 00 15', 'ines.mansouri@example.com', 6, 'Vient pour son fils Rayan, 8 ans.'],
  ['Enzo', 'Rossi', '06 39 98 00 16', '', 0, ''],
];

const ONLINE_NOTES = [
  'Première visite.',
  'Un peu plus court que la dernière fois, merci.',
  'Contours de barbe aussi si possible.',
];

// — Hasard déterministe ——————————————————————————————————————————————

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeUuid(rand) {
  let h = '';
  for (let i = 0; i < 32; i++) h += Math.floor(rand() * 16).toString(16);
  const variant = '89ab'[Math.floor(rand() * 4)];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function weightedIndex(rand, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

// — Planification d'une journée ———————————————————————————————————————

/** Probabilité de poser un RDV à chaque pas de 15 min, selon l'écart au jour courant. */
function fillRate(d) {
  if (d < 0) return 0.32;
  if (d === 0) return 0.48;
  if (d === 1) return 0.3;
  if (d === 2) return 0.24;
  if (d <= 6) return 0.17;
  return 0.1;
}

function pickClient(rand, usedToday, lastVisit, d) {
  const free = [];
  const rested = [];
  for (let i = 0; i < CLIENTS.length; i++) {
    if (usedToday.has(i)) continue;
    free.push(i);
    const last = lastVisit.get(i);
    if (last === undefined || d - last >= 7) rested.push(i);
  }
  const pool = rested.length ? rested : free;
  return pool.length ? pool[Math.floor(rand() * pool.length)] : -1;
}

function pickService(rand, services, fav, maxDur) {
  const fits = services.map((s, i) => (s.durationMin <= maxDur ? i : -1)).filter((i) => i >= 0);
  if (!fits.length) return -1;
  if (fits.includes(fav) && rand() < 0.75) return fav;
  return fits[weightedIndex(rand, fits.map((i) => SERVICE_WEIGHTS[i]))];
}

/** Planning d'un jour : [{ startMin, svcIndex, clientIndex }] sans chevauchement. */
function planDay(rand, services, intervals, rate, d, lastVisit) {
  const used = new Set();
  const items = [];
  for (const [open, close] of intervals) {
    let cursor = open;
    while (close - cursor >= 15) {
      if (rand() >= rate) {
        cursor += 15;
        continue;
      }
      const ci = pickClient(rand, used, lastVisit, d);
      if (ci < 0) break;
      const si = pickService(rand, services, CLIENTS[ci][4], close - cursor);
      if (si < 0) break;
      items.push({ startMin: cursor, svcIndex: si, clientIndex: ci });
      used.add(ci);
      lastVisit.set(ci, d);
      cursor += Math.ceil(services[si].durationMin / 15) * 15;
    }
  }
  return items;
}

function occupancy(items, services, intervals) {
  const open = intervals.reduce((sum, [o, c]) => sum + (c - o), 0);
  const busy = items.reduce((sum, it) => sum + services[it.svcIndex].durationMin, 0);
  return open ? busy / open : 0;
}

// — Construction de la base ——————————————————————————————————————————

/**
 * Base de démonstration complète, relative à `now`.
 * → { version, seedDay, seededAt, salon, services, clients, appointments, blocks }
 * Rendez-vous stockés « à plat » : { id, token, clientId, serviceId, serviceName,
 * priceCents, start, end, status, source, note, createdAt, cancelledAt }.
 */
export function buildSeed(now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const salon = demoSalon();
  const tz = salon.timezone;
  const services = demoServices();
  const today = todayYMD(tz, nowDate);
  const rand = mulberry32(hashString(`barbiere-demo-${today}`));
  const iso = (ms) => new Date(ms).toISOString();

  const clients = CLIENTS.map(([firstName, lastName, phone, email, , notes]) => {
    const createdAt = iso(nowMs - (30 + Math.floor(rand() * 400)) * DAY);
    return {
      id: fakeUuid(rand), firstName, lastName, phone: normalizePhone(phone), email, notes,
      createdAt, consentAt: createdAt,
    };
  });

  const intervalsOf = (ymd) => (salon.hours[String(weekdayISO(ymd))] || [])
    .map(([o, c]) => [minutesOf(o), minutesOf(c)]);

  // Blocage « Formation » : l'après-midi du premier jour à deux plages, dans 6 jours ou plus.
  let block = null;
  for (let d = 6; d <= 13 && !block; d++) {
    const ymd = addDaysYMD(today, d);
    const iv = intervalsOf(ymd);
    if (iv.length >= 2) {
      const [o, c] = iv[iv.length - 1];
      block = {
        id: fakeUuid(rand),
        start: zonedToUtc(ymd, hhmm(o), tz).toISOString(),
        end: zonedToUtc(ymd, hhmm(c), tz).toISOString(),
        reason: 'Formation',
        createdAt: iso(nowMs - 5 * DAY),
        ymd,
      };
    }
  }

  const appointments = [];
  const lastVisit = new Map();
  const upcomingOnline = new Map(); // client → nombre de RDV en ligne à venir (règle LIMIT)

  for (let d = -14; d <= 13; d++) {
    const ymd = addDaysYMD(today, d);
    let intervals = intervalsOf(ymd);
    if (!intervals.length) continue;
    if (block && block.ymd === ymd) intervals = intervals.slice(0, -1);

    let items;
    if (d === 0) {
      // Aujourd'hui : on garde le tirage le plus proche des deux tiers de remplissage.
      let best = null;
      for (let attempt = 0; attempt < 24; attempt++) {
        const lv = new Map(lastVisit);
        const plan = planDay(rand, services, intervals, fillRate(0), d, lv);
        const gap = Math.abs(occupancy(plan, services, intervals) - 2 / 3);
        if (!best || gap < best.gap) best = { plan, lv, gap };
      }
      items = best.plan;
      for (const [k, v] of best.lv) lastVisit.set(k, v);
    } else {
      items = planDay(rand, services, intervals, fillRate(d), d, lastVisit);
    }

    for (const it of items) {
      const svc = services[it.svcIndex];
      const client = clients[it.clientIndex];
      const startMs = zonedToUtc(ymd, hhmm(it.startMin), tz).getTime();
      const endMs = startMs + svc.durationMin * MINUTE;
      const future = startMs > nowMs;

      let source = rand() < 0.6 ? 'online' : 'pro';
      if (source === 'online' && future) {
        const n = upcomingOnline.get(client.id) || 0;
        if (n >= 2) source = 'pro';
        else upcomingOnline.set(client.id, n + 1);
      }
      // Réservé entre 1 et 9 jours avant, jamais après « maintenant » ni moins d'1 h avant.
      let createdMs = startMs - (1 + Math.floor(rand() * 8)) * DAY - Math.floor(rand() * 10) * HOUR;
      createdMs = Math.min(createdMs, nowMs - 2 * HOUR, startMs - 2 * HOUR);

      appointments.push({
        id: fakeUuid(rand),
        token: fakeUuid(rand),
        clientId: client.id,
        serviceId: svc.id,
        serviceName: svc.name,
        priceCents: svc.priceCents,
        start: iso(startMs),
        end: iso(endMs),
        status: endMs <= nowMs ? 'done' : 'confirmed',
        source,
        note: source === 'online' && rand() < 0.12 ? ONLINE_NOTES[Math.floor(rand() * ONLINE_NOTES.length)] : '',
        createdAt: iso(createdMs),
        cancelledAt: null,
      });
    }
  }

  appointments.sort((a, b) => a.start.localeCompare(b.start));

  // Deux lapins dans le passé, sur deux jours différents.
  const past = appointments.filter((a) => a.status === 'done' && Date.parse(a.start) < nowMs - DAY);
  const noShowDays = new Set();
  for (let tries = 0; tries < 50 && noShowDays.size < 2 && past.length; tries++) {
    const a = past[Math.floor(rand() * past.length)];
    const day = a.start.slice(0, 10);
    if (a.status === 'done' && !noShowDays.has(day)) {
      a.status = 'no_show';
      noShowDays.add(day);
    }
  }

  // Une annulation passée et une à venir (le créneau redevient libre).
  const pastDone = past.filter((a) => a.status === 'done');
  if (pastDone.length) {
    const a = pastDone[Math.floor(rand() * pastDone.length)];
    a.status = 'cancelled';
    a.cancelledAt = iso(Math.max(Date.parse(a.createdAt) + HOUR, Date.parse(a.start) - DAY));
  }
  const later = appointments.filter((a) => a.status === 'confirmed' && Date.parse(a.start) > nowMs + 2 * DAY);
  if (later.length) {
    const a = later[Math.floor(rand() * later.length)];
    a.status = 'cancelled';
    a.createdAt = iso(Math.min(Date.parse(a.createdAt), nowMs - 3 * DAY));
    a.cancelledAt = iso(nowMs - DAY);
  }

  // Quelques réservations en ligne toutes récentes (badge « nouvelles réservations »).
  const fresh = appointments.filter((a) => a.status === 'confirmed' && a.source === 'online'
    && Date.parse(a.start) > nowMs + 3 * HOUR);
  const freshCount = Math.min(3, fresh.length);
  for (let i = 0; i < freshCount; i++) {
    fresh[Math.floor((i * fresh.length) / freshCount)].createdAt = iso(nowMs - (20 + i * 55) * MINUTE);
  }

  const blocks = block ? [{ id: block.id, start: block.start, end: block.end, reason: block.reason, createdAt: block.createdAt }] : [];

  return {
    version: DEMO_VERSION,
    seedDay: today,
    seededAt: iso(nowMs),
    salon,
    services,
    clients,
    appointments,
    blocks,
  };
}
