// Store « démo » : toute la base vit dans le localStorage du téléphone.
// Mêmes règles que le serveur Supabase (créneaux, préavis, limite de RDV,
// annulation), pour que la démo soit fidèle au mode en ligne.

import { BookingError } from '../core/errors.js';
import { todayYMD, addDaysYMD, toMs } from '../core/dates.js';
import { validateSlot, occupiesSlot } from '../core/slots.js';
import {
  validateContact, validateClientPatch, validateService, validateSalonPatch,
  cleanMultiline, cleanText, compareClientNames, parseClientSearch, clientMatches,
} from '../core/validate.js';
import { buildSeed, DEMO_VERSION } from './seed.js';

export const DEMO_KEY = 'barbiere-demo-v1';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const STATUSES = ['confirmed', 'done', 'no_show', 'cancelled'];
const MAX_RANGE_DAYS = 62;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// — Outils ———————————————————————————————————————————————————————————

/** Stockage en mémoire, même interface que localStorage (repli et tests). */
export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

/** Identifiant aléatoire au format UUID v4 (y compris hors contexte sécurisé). */
export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try { return c.randomUUID(); } catch { /* contexte non sécurisé : repli */ }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function defaultStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch { /* navigation privée stricte */ }
  return null;
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isoOrThrow(v) {
  const ms = toMs(v);
  if (!Number.isFinite(ms)) throw new BookingError('INVALID', { field: 'date' });
  return new Date(ms).toISOString();
}

function rangeOrThrow(fromISO, toISO, maxDays = Infinity) {
  const from = toMs(fromISO);
  const to = toMs(toISO);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > maxDays * DAY) {
    throw new BookingError('INVALID', { field: 'range' });
  }
  return [from, to];
}

function durationOrThrow(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 5 || n > 600) throw new BookingError('INVALID', { field: 'durationMin' });
  return n;
}

/** Identifiant de tentative de réservation (uuid) ; absent → null. */
function requestIdOrThrow(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!UUID_RE.test(String(v))) throw new BookingError('INVALID', { field: 'requestId' });
  return String(v).toLowerCase();
}

// — Fabrique —————————————————————————————————————————————————————————

/**
 * @param {object} [opts]
 * @param {Storage|null} [opts.storage]   localStorage par défaut (repli mémoire si absent)
 * @param {() => Date} [opts.now]          horloge injectable (tests)
 * @param {number} [opts.latency]          latence simulée en ms (0 hors navigateur)
 * @param {number|null} [opts.refreshAfterDays] base jamais modifiée régénérée au-delà
 *        de N jours, pour que l'agenda de démo reste « vivant » (null = jamais)
 * @param {number|null} [opts.maxAgeDays] idem pour une base déjà modifiée (null = jamais)
 */
export function createLocalStore({
  storage = defaultStorage(),
  now = () => new Date(),
  latency = typeof window === 'undefined' ? 0 : 150,
  refreshAfterDays = 3,
  maxAgeDays = 14,
  key = DEMO_KEY,
} = {}) {
  let cache = null;                 // dernière base connue (repli si le stockage échoue)
  let storageOk = !!storage;
  const listeners = new Set();

  const nowDate = () => {
    const n = now();
    return n instanceof Date ? n : new Date(n);
  };

  function isUsable(db) {
    if (!db || db.version !== DEMO_VERSION || !db.salon || !Array.isArray(db.appointments)) return false;
    const limit = db.touched ? maxAgeDays : refreshAfterDays;
    if (limit === null || limit === undefined || !db.seedDay) return true;
    const today = todayYMD(db.salon.timezone, nowDate());
    return addDaysYMD(db.seedDay, limit) >= today;
  }

  function persist(db) {
    cache = db;
    if (!storageOk) return;
    try {
      storage.setItem(key, JSON.stringify(db));
    } catch {
      storageOk = false; // quota dépassé ou stockage bloqué : on continue en mémoire
    }
  }

  /** Lit la base (copie fraîche) ; la crée au premier accès ou si elle est périmée. */
  function load() {
    if (storageOk) {
      let raw = null;
      let readable = true;
      try { raw = storage.getItem(key); } catch { readable = false; storageOk = false; }
      if (readable) {
        if (raw) {
          try {
            const db = JSON.parse(raw);
            if (isUsable(db)) { cache = db; return clone(db); }
          } catch { /* base illisible : régénérée ci-dessous */ }
        }
        const db = buildSeed(nowDate());
        persist(db);
        return clone(db);
      }
    }
    if (cache && isUsable(cache)) return clone(cache);
    const db = buildSeed(nowDate());
    persist(db);
    return clone(db);
  }

  function notify(source) {
    for (const cb of [...listeners]) {
      try { cb({ source }); } catch (err) { console.error(err); }
    }
  }

  async function read(fn) {
    if (latency > 0) await sleep(latency);
    return fn(load());              // load() rend déjà une copie : aucun partage avec le cache
  }

  async function write(fn) {
    if (latency > 0) await sleep(latency);
    const db = load();
    const result = fn(db);          // une exception annule tout : rien n'est enregistré
    db.touched = true;              // base modifiée : régénérée moins vite (maxAgeDays)
    persist(db);
    notify('local');
    return clone(result);
  }

  // — Représentations publiques ————————————————————————————————

  const findService = (db, id) => db.services.find((s) => s.id === id);
  const findClient = (db, id) => db.clients.find((c) => c.id === id);

  function toAppointment(db, a) {
    const c = findClient(db, a.clientId);
    return {
      id: a.id, start: a.start, end: a.end, status: a.status, source: a.source,
      serviceId: a.serviceId, serviceName: a.serviceName, priceCents: a.priceCents,
      note: a.note || '', createdAt: a.createdAt,
      bookedFirstName: a.bookedFirstName || '', bookedLastName: a.bookedLastName || '',
      client: c ? { id: c.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone || '', email: c.email || '' } : null,
    };
  }

  /** Réponse de book() (identique au premier envoi et à ses répétitions). */
  function toBookingResult(a) {
    return {
      id: a.id, token: a.token, start: a.start, end: a.end,
      serviceName: a.serviceName, priceCents: a.priceCents,
    };
  }

  function toBlock(b) {
    return { id: b.id, start: b.start, end: b.end, reason: b.reason || '' };
  }

  function toClient(db, c, nowMs) {
    let visits = 0;
    let noShows = 0;
    let lastVisit = null;
    let nextVisit = null;
    for (const a of db.appointments) {
      if (a.clientId !== c.id) continue;
      const s = Date.parse(a.start);
      if (a.status === 'no_show') noShows++;
      // Comme la vue SQL clients_with_stats : honoré, ou confirmé déjà commencé.
      if (a.status === 'done' || (a.status === 'confirmed' && s < nowMs)) {
        visits++;
        if (!lastVisit || a.start > lastVisit) lastVisit = a.start;
      }
      if (a.status === 'confirmed' && s >= nowMs && (!nextVisit || a.start < nextVisit)) nextVisit = a.start;
    }
    return {
      id: c.id, firstName: c.firstName, lastName: c.lastName || '', phone: c.phone || '',
      email: c.email || '', notes: c.notes || '', createdAt: c.createdAt,
      visits, noShows, lastVisit, nextVisit,
    };
  }

  /** Créneaux occupés : RDV confirmés ou honorés (+ blocages si demandé). Un lapin libère le sien. */
  function busyOf(db, { withBlocks = true, exceptId = null } = {}) {
    const busy = db.appointments
      .filter((a) => occupiesSlot(a.status) && a.id !== exceptId)
      .map((a) => ({ start: a.start, end: a.end }));
    if (withBlocks) for (const b of db.blocks) busy.push({ start: b.start, end: b.end });
    return busy;
  }

  // — Store ——————————————————————————————————————————————————————

  const store = {
    mode: 'demo',

    // — Public —

    getSalon() {
      return read((db) => db.salon);
    },

    listServices({ includeInactive = false } = {}) {
      return read((db) => db.services
        .filter((s) => includeInactive || s.active)
        .sort((a, b) => a.position - b.position));
    },

    getBusy(fromISO, toISO) {
      return read((db) => {
        const [askedFrom, to] = rangeOrThrow(fromISO, toISO, MAX_RANGE_DAYS);
        // Comme le serveur : le passé (au-delà de la veille) n'est pas exposé.
        const from = Math.max(askedFrom, nowDate().getTime() - DAY);
        if (to <= from) return [];
        return busyOf(db)
          .filter((b) => Date.parse(b.start) < to && Date.parse(b.end) > from)
          .sort((a, b) => a.start.localeCompare(b.start));
      });
    },

    book(input = {}) {
      return write((db) => {
        // Même tentative renvoyée (réponse perdue, nouvel essai) : on rend le RDV
        // déjà créé, sans rien recréer ni revérifier (comme book_appointment).
        const requestId = requestIdOrThrow(input.requestId);
        const already = requestId && db.appointments.find((a) => a.requestId === requestId);
        if (already) return toBookingResult(already);

        const n = nowDate();
        const nowMs = n.getTime();
        const salon = db.salon;
        if (!salon.bookingEnabled) throw new BookingError('CLOSED');

        const svc = findService(db, input.serviceId);
        if (!svc || !svc.active) throw new BookingError('INVALID', { field: 'serviceId' });

        const check = validateContact(input);
        if (!check.ok) throw new BookingError('INVALID', { errors: check.errors });

        const code = validateSlot({ salon, durationMin: svc.durationMin, start: input.start, busy: busyOf(db), now: n });
        if (code) throw new BookingError(code);
        const startMs = toMs(input.start);

        // Limites : 2 RDV en ligne à venir par téléphone (LIMIT) ; 30 réservations
        // en ligne par heure au total, annulées comprises (protection contre les
        // robots, comme le serveur) : CLOSED, car ce n'est pas la faute du client.
        const v = check.value;
        let client = db.clients.find((c) => c.phone && c.phone === v.phone);
        if (client) {
          const upcoming = db.appointments.filter((a) => a.clientId === client.id && a.source === 'online'
            && a.status !== 'cancelled' && Date.parse(a.start) > nowMs).length;
          if (upcoming >= 2) throw new BookingError('LIMIT');
        }
        const lastHour = db.appointments.filter((a) => a.source === 'online' && Date.parse(a.createdAt) > nowMs - HOUR).length;
        if (lastHour >= 30) throw new BookingError('CLOSED');

        // Fiche connue : réutilisée telle quelle. Une réservation anonyme ne modifie
        // jamais une fiche existante (le numéro peut être celui de quelqu'un d'autre).
        if (!client) {
          client = {
            id: uuid(), firstName: v.firstName, lastName: v.lastName, phone: v.phone, email: v.email,
            notes: '', createdAt: n.toISOString(), consentAt: n.toISOString(),
          };
          db.clients.push(client);
        }

        const appt = {
          id: uuid(), token: uuid(), clientId: client.id,
          serviceId: svc.id, serviceName: svc.name, priceCents: svc.priceCents,
          start: new Date(startMs).toISOString(),
          end: new Date(startMs + svc.durationMin * MINUTE).toISOString(),
          status: 'confirmed', source: 'online',
          note: cleanMultiline(input.note).slice(0, 500),
          bookedFirstName: v.firstName, bookedLastName: v.lastName, requestId,
          createdAt: n.toISOString(), cancelledAt: null,
        };
        db.appointments.push(appt);
        return toBookingResult(appt);
      });
    },

    getBooking(token) {
      return read((db) => {
        const a = token ? db.appointments.find((x) => x.token === token) : null;
        if (!a) return null;
        // Prénom SAISI à la réservation, jamais celui de la fiche (comme le serveur).
        return {
          id: a.id, start: a.start, end: a.end, status: a.status,
          serviceName: a.serviceName, priceCents: a.priceCents, firstName: a.bookedFirstName || '',
        };
      });
    },

    cancelBooking(token) {
      return write((db) => {
        const a = token ? db.appointments.find((x) => x.token === token) : null;
        if (!a) throw new BookingError('NOT_FOUND');
        if (a.status === 'cancelled') return { ok: true };
        const nowMs = nowDate().getTime();
        const limit = (Number(db.salon.cancelLimitHours) || 0) * HOUR;
        if (a.status !== 'confirmed' || Date.parse(a.start) - nowMs < limit) throw new BookingError('TOO_LATE');
        a.status = 'cancelled';
        a.cancelledAt = new Date(nowMs).toISOString();
        return { ok: true };
      });
    },

    // — Barbière (en démo : accès direct) —

    isLoggedIn() {
      return true;
    },

    async login(email) {
      if (latency > 0) await sleep(latency);
      return { email: cleanText(email) || 'demo' };
    },

    async logout() {},

    listAppointments(fromISO, toISO) {
      return read((db) => {
        const [from, to] = rangeOrThrow(fromISO, toISO);
        return db.appointments
          .filter((a) => { const s = Date.parse(a.start); return s >= from && s < to; })
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((a) => toAppointment(db, a));
      });
    },

    createAppointment(input = {}) {
      return write((db) => {
        const n = nowDate();
        const svc = findService(db, input.serviceId);
        if (!svc) throw new BookingError('INVALID', { field: 'serviceId' });
        const dur = input.durationMin === undefined || input.durationMin === null || input.durationMin === ''
          ? svc.durationMin : durationOrThrow(input.durationMin);
        const startIso = isoOrThrow(input.start);
        const startMs = Date.parse(startIso);

        let client = null;
        let newClient = null;
        if (input.clientId) {
          client = findClient(db, input.clientId);
          if (!client) throw new BookingError('NOT_FOUND');
        } else {
          const check = validateContact(input.client || {}, { pro: true });
          if (!check.ok) throw new BookingError('INVALID', { errors: check.errors });
          const v = check.value;
          // Téléphone déjà connu : on réutilise la fiche telle quelle.
          client = v.phone ? db.clients.find((c) => c.phone === v.phone) : null;
          if (!client) {
            newClient = {
              id: uuid(), firstName: v.firstName, lastName: v.lastName, phone: v.phone, email: v.email,
              notes: '', createdAt: n.toISOString(), consentAt: null,
            };
            client = newClient;
          }
        }

        // Hors horaires autorisé ; seul le chevauchement d'un autre RDV est interdit.
        const code = validateSlot({ salon: db.salon, durationMin: dur, start: startMs, busy: busyOf(db, { withBlocks: false }), now: n, forPro: true });
        if (code) throw new BookingError(code);
        if (newClient) db.clients.push(newClient);

        const appt = {
          id: uuid(), token: uuid(), clientId: client.id,
          serviceId: svc.id, serviceName: svc.name, priceCents: svc.priceCents,
          start: startIso, end: new Date(startMs + dur * MINUTE).toISOString(),
          status: 'confirmed', source: 'pro',
          note: cleanMultiline(input.note).slice(0, 500),
          createdAt: n.toISOString(), cancelledAt: null,
        };
        db.appointments.push(appt);
        return toAppointment(db, appt);
      });
    },

    updateAppointment(id, patch = {}) {
      return write((db) => {
        const a = db.appointments.find((x) => x.id === id);
        if (!a) throw new BookingError('NOT_FOUND');
        const n = nowDate();
        let startMs = Date.parse(a.start);
        let dur = (Date.parse(a.end) - startMs) / MINUTE;

        if (patch.serviceId !== undefined && patch.serviceId !== a.serviceId) {
          const svc = findService(db, patch.serviceId);
          if (!svc) throw new BookingError('INVALID', { field: 'serviceId' });
          a.serviceId = svc.id;
          a.serviceName = svc.name;
          a.priceCents = svc.priceCents;
          dur = svc.durationMin;
        }
        if (patch.durationMin !== undefined && patch.durationMin !== null && patch.durationMin !== '') {
          dur = durationOrThrow(patch.durationMin);
        }
        if (patch.start !== undefined) startMs = Date.parse(isoOrThrow(patch.start));
        if (patch.status !== undefined) {
          if (!STATUSES.includes(patch.status)) throw new BookingError('INVALID', { field: 'status' });
          if (patch.status !== a.status) {
            a.cancelledAt = patch.status === 'cancelled' ? n.toISOString() : null;
            a.status = patch.status;
          }
        }
        if (patch.note !== undefined) a.note = cleanMultiline(patch.note).slice(0, 500);

        a.start = new Date(startMs).toISOString();
        a.end = new Date(startMs + dur * MINUTE).toISOString();
        if (occupiesSlot(a.status)) {
          const code = validateSlot({ salon: db.salon, durationMin: dur, start: startMs, busy: busyOf(db, { withBlocks: false, exceptId: a.id }), now: n, forPro: true });
          if (code) throw new BookingError(code);
        }
        return toAppointment(db, a);
      });
    },

    listBlocks(fromISO, toISO) {
      return read((db) => {
        const [from, to] = rangeOrThrow(fromISO, toISO);
        return db.blocks
          .filter((b) => Date.parse(b.start) < to && Date.parse(b.end) > from)
          .sort((a, b) => a.start.localeCompare(b.start))
          .map(toBlock);
      });
    },

    createBlock({ start, end, reason = '' } = {}) {
      return write((db) => {
        const s = isoOrThrow(start);
        const e = isoOrThrow(end);
        if (Date.parse(e) <= Date.parse(s)) throw new BookingError('INVALID', { field: 'end' });
        const block = { id: uuid(), start: s, end: e, reason: cleanText(reason).slice(0, 200), createdAt: nowDate().toISOString() };
        db.blocks.push(block);
        return toBlock(block);
      });
    },

    deleteBlock(id) {
      return write((db) => {
        db.blocks = db.blocks.filter((b) => b.id !== id);
      });
    },

    listClients({ search = '' } = {}) {
      return read((db) => {
        const nowMs = nowDate().getTime();
        const q = parseClientSearch(search);
        return db.clients
          .filter((c) => clientMatches(c, q))
          .map((c) => toClient(db, c, nowMs))
          .sort(compareClientNames);
      });
    },

    getClient(id) {
      return read((db) => {
        const c = findClient(db, id);
        if (!c) throw new BookingError('NOT_FOUND');
        const appointments = db.appointments
          .filter((a) => a.clientId === id)
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((a) => toAppointment(db, a));
        return { ...toClient(db, c, nowDate().getTime()), appointments };
      });
    },

    updateClient(id, patch = {}) {
      return write((db) => {
        const c = findClient(db, id);
        if (!c) throw new BookingError('NOT_FOUND');
        const check = validateClientPatch(patch);
        if (!check.ok) throw new BookingError('INVALID', { errors: check.errors });
        const v = check.value;
        if (v.phone && db.clients.some((o) => o.id !== id && o.phone === v.phone)) {
          throw new BookingError('INVALID', { errors: { phone: 'Ce numéro est déjà utilisé par une autre fiche client.' } });
        }
        Object.assign(c, v);
        return toClient(db, c, nowDate().getTime());
      });
    },

    deleteClient(id) {
      return write((db) => {
        // Effacement RGPD : RDV à venir annulés puis tout l'historique supprimé avec la fiche.
        const nowIso = nowDate().toISOString();
        for (const a of db.appointments) {
          if (a.clientId === id && a.status === 'confirmed' && a.start >= nowIso) {
            a.status = 'cancelled';
            a.cancelledAt = nowIso;
          }
        }
        db.appointments = db.appointments.filter((a) => a.clientId !== id);
        db.clients = db.clients.filter((c) => c.id !== id);
      });
    },

    updateSalon(patch = {}) {
      return write((db) => {
        const check = validateSalonPatch(patch);
        if (!check.ok) throw new BookingError('INVALID', { errors: check.errors });
        Object.assign(db.salon, check.value);
        return db.salon;
      });
    },

    saveService(service = {}) {
      return write((db) => {
        const isUpdate = !!service.id;
        const check = validateService(service, { partial: isUpdate });
        if (!check.ok) throw new BookingError('INVALID', { errors: check.errors });
        if (isUpdate) {
          const s = findService(db, service.id);
          if (!s) throw new BookingError('NOT_FOUND');
          Object.assign(s, check.value);
          return s;
        }
        const position = check.value.position ?? db.services.reduce((m, s) => Math.max(m, s.position), 0) + 1;
        const s = { id: uuid(), ...check.value, position };
        db.services.push(s);
        return s;
      });
    },

    deleteService(id) {
      return write((db) => {
        const s = findService(db, id);
        if (!s) throw new BookingError('NOT_FOUND');
        s.active = false;
      });
    },

    reorderServices(ids = []) {
      return write((db) => {
        const order = [...ids, ...db.services
          .slice().sort((a, b) => a.position - b.position)
          .map((s) => s.id)
          .filter((id) => !ids.includes(id))];
        order.forEach((id, i) => {
          const s = findService(db, id);
          if (s) s.position = i + 1;
        });
      });
    },

    onChange(callback) {
      listeners.add(callback);
      let onStorage = null;
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        onStorage = (e) => {
          if (e.key === key || e.key === null) callback({ source: 'storage' });
        };
        window.addEventListener('storage', onStorage);
      }
      return () => {
        listeners.delete(callback);
        if (onStorage) window.removeEventListener('storage', onStorage);
      };
    },

    // — Spécifique à la démo —

    /** Réinitialise la base de démonstration (relative à maintenant). */
    resetDemo() {
      return (async () => {
        if (latency > 0) await sleep(latency);
        persist(buildSeed(nowDate()));
        notify('local');
      })();
    },
  };

  return store;
}
