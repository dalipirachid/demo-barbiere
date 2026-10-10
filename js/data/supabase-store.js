// Store « en ligne » : Supabase via son API REST (fetch, sans SDK).
// - En-tête `apikey` toujours ; `Authorization: Bearer` seulement si la
//   barbière est connectée (compatible clés `anon` et `sb_publishable_…`).
// - Côté client : uniquement les fonctions RPC publiques.
// - Côté barbière : tables via REST, protégées par RLS.

import { BookingError, ERROR_CODES } from '../core/errors.js';
import { toMs } from '../core/dates.js';
import {
  validateContact, validateClientPatch, validateService, validateSalonPatch,
  cleanMultiline, cleanText, compareClientNames, parseClientSearch,
} from '../core/validate.js';

export const SESSION_KEY = 'barbiere-session';

const MINUTE = 60_000;
const DAY = 86_400_000;
const STATUSES = ['confirmed', 'done', 'no_show', 'cancelled'];
const CLIENT_EMBED = 'client:clients(id,first_name,last_name,phone,email)';
const APPT_SELECT = `*,${CLIENT_EMBED}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_TTL = 30_000;
// Supabase plafonne chaque réponse (réglage « Max rows », 1000 lignes par défaut)
// sans le signaler : les listes qui peuvent dépasser ce plafond sont lues page par page.
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
// Occupent leur créneau (comme OCCUPYING_STATUSES de core/slots.js et la contrainte SQL).
const OCCUPYING_FILTER = 'in.(confirmed,done)';

// — Correspondance colonnes (snake_case) ↔ modèle JS (camelCase) ——————————

const iso = (v) => (v ? new Date(v).toISOString() : null);
const str = (v) => (v === null || v === undefined ? '' : String(v));

export function salonFromRow(r = {}) {
  return {
    name: str(r.name), tagline: str(r.tagline), address: str(r.address), city: str(r.city),
    phone: str(r.phone), email: str(r.email), instagram: str(r.instagram),
    timezone: r.timezone || 'Europe/Paris',
    hours: r.hours || {},
    slotStep: r.slot_step ?? 15,
    minNoticeMin: r.min_notice_min ?? 60,
    maxDaysAhead: r.max_days_ahead ?? 30,
    cancelLimitHours: r.cancel_limit_hours ?? 2,
    bookingEnabled: r.booking_enabled !== false,
    notice: str(r.notice),
    // §8 bis : absent (ancienne base, ancien cache) → défaut. setup_done n'est pas
    // renvoyé par get_public : getSalon le lit dans la table quand la barbière est connectée.
    showCrest: r.show_crest !== false,
    setupDone: r.setup_done === true,
  };
}

const SALON_COLUMNS = {
  name: 'name', tagline: 'tagline', address: 'address', city: 'city', phone: 'phone',
  email: 'email', instagram: 'instagram', timezone: 'timezone', hours: 'hours',
  slotStep: 'slot_step', minNoticeMin: 'min_notice_min', maxDaysAhead: 'max_days_ahead',
  cancelLimitHours: 'cancel_limit_hours', bookingEnabled: 'booking_enabled', notice: 'notice',
  showCrest: 'show_crest', setupDone: 'setup_done',
};

export function salonToRow(patch = {}) {
  const row = {};
  for (const [k, col] of Object.entries(SALON_COLUMNS)) if (patch[k] !== undefined) row[col] = patch[k];
  return row;
}

export function serviceFromRow(r = {}) {
  return {
    id: r.id, name: str(r.name), description: str(r.description),
    durationMin: r.duration_min, priceCents: r.price_cents, category: str(r.category),
    active: r.active !== false, position: r.position ?? 0,
  };
}

export function serviceToRow(s = {}) {
  const map = { name: 'name', description: 'description', durationMin: 'duration_min', priceCents: 'price_cents', category: 'category', active: 'active', position: 'position' };
  const row = {};
  for (const [k, col] of Object.entries(map)) if (s[k] !== undefined) row[col] = s[k];
  return row;
}

export function clientFromRow(r = {}) {
  return {
    id: r.id, firstName: str(r.first_name), lastName: str(r.last_name), phone: str(r.phone),
    email: str(r.email), notes: str(r.notes), createdAt: iso(r.created_at),
    visits: Number(r.visits ?? 0), noShows: Number(r.no_shows ?? 0),
    lastVisit: iso(r.last_visit), nextVisit: iso(r.next_visit),
  };
}

export function appointmentFromRow(r = {}) {
  const c = r.client;
  return {
    id: r.id, start: iso(r.starts_at), end: iso(r.ends_at), status: r.status, source: r.source,
    serviceId: r.service_id ?? null, serviceName: str(r.service_name), priceCents: r.price_cents ?? 0,
    note: str(r.note), createdAt: iso(r.created_at),
    bookedFirstName: str(r.booked_first_name), bookedLastName: str(r.booked_last_name),
    client: c ? { id: c.id, firstName: str(c.first_name), lastName: str(c.last_name), phone: str(c.phone), email: str(c.email) } : null,
  };
}

export function blockFromRow(r = {}) {
  return { id: r.id, start: iso(r.starts_at), end: iso(r.ends_at), reason: str(r.reason) };
}

// — Erreurs ——————————————————————————————————————————————————————————

/** Serveur joint mais indisponible : maintenance, surcharge, projet en pause, trop de requêtes. */
const isUnavailable = (status) => status >= 500 || status === 429;

/** Réponse PostgREST/GoTrue en échec → BookingError. */
export function errorFromResponse(status, data) {
  const pgCode = data && typeof data === 'object' ? data.code : undefined;
  const message = data && typeof data === 'object' ? String(data.message ?? '').trim() : '';
  if (pgCode === 'P0001') {
    if (ERROR_CODES.includes(message)) return new BookingError(message);
    console.error('[supabase] exception inattendue :', data);
    return new BookingError('INVALID', { status, pgCode, message });
  }
  if (pgCode === '23P01') return new BookingError('SLOT_TAKEN');
  if (status === 401 || status === 403) return new BookingError('AUTH');
  // Rien à corriger dans la saisie : le service ne répond pas (5xx, 429) ou trop lentement (408).
  if (isUnavailable(status)) return new BookingError('UNAVAILABLE', { status, pgCode });
  if (status === 408) return new BookingError('NETWORK', { status });
  console.error('[supabase] requête refusée :', status, data);
  return new BookingError('INVALID', { status, pgCode, message, detail: data });
}

// — Outils ———————————————————————————————————————————————————————————

function defaultStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch { /* navigation privée stricte */ }
  return null;
}

const enc = encodeURIComponent;

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
  return [new Date(from).toISOString(), new Date(to).toISOString()];
}

function durationOrThrow(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 5 || n > 600) throw new BookingError('INVALID', { field: 'durationMin' });
  return n;
}

const hasValue = (v) => v !== undefined && v !== null && v !== '';

/** Identifiant de tentative de réservation (uuid) ; absent → null. */
function requestIdOrThrow(v) {
  if (!hasValue(v)) return null;
  if (!UUID_RE.test(String(v))) throw new BookingError('INVALID', { field: 'requestId' });
  return String(v);
}

/** Total annoncé par PostgREST (« Content-Range: 0-999/1234 ») ; null s'il est inconnu (« 0-999/* »). */
function totalFromRange(res) {
  const range = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-range') : null;
  const m = /\/(\d+)\s*$/.exec(range || '');
  return m ? Number(m[1]) : null;
}

/** Valeur ilike PostgREST : jokers neutralisés, guillemets pour les caractères réservés. */
function ilikeValue(word) {
  const like = String(word).replace(/\*/g, '').replace(/[\\%_]/g, '\\$&');
  return `"*${like.replace(/["\\]/g, '\\$&')}*"`;
}

/** Filtre de recherche client pour l'URL (même logique que la démo). */
export function clientSearchQuery(search) {
  const q = parseClientSearch(search);
  if (!q) return '';
  if (q.kind === 'phone') return `&phone=ilike.${enc(`*${q.digits}*`)}`;
  const groups = q.words.map((w) => `first_name.ilike.${ilikeValue(w)},last_name.ilike.${ilikeValue(w)}`);
  if (groups.length === 1) return `&or=${enc(`(${groups[0]})`)}`;
  return `&and=${enc(`(${groups.map((g) => `or(${g})`).join(',')})`)}`;
}

// — Fabrique —————————————————————————————————————————————————————————

/**
 * @param {object} opts
 * @param {string} opts.url   URL du projet Supabase (https://xxxx.supabase.co)
 * @param {string} opts.key   clé publique (anon ou sb_publishable_…)
 * @param {Function} [opts.fetch]  fetch injectable (tests)
 * @param {Storage|null} [opts.storage] pour la session (localStorage par défaut)
 * @param {() => Date} [opts.now]
 * @param {number} [opts.pollMs]     rafraîchissement de onChange (60 s)
 * @param {number} [opts.timeoutMs]  délai max d'une requête
 */
export function createSupabaseStore({
  url,
  key,
  fetch: fetchImpl = globalThis.fetch,
  storage = defaultStorage(),
  now = () => new Date(),
  pollMs = 60_000,
  timeoutMs = 15_000,
} = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  const listeners = new Set();
  let memorySession = null;     // repli si le stockage est indisponible
  let refreshing = null;        // rafraîchissement en cours (partagé)
  let publicCache = null;       // { at, promise } pour get_public
  let setupCache = null;        // { at, promise } pour salon.setup_done (barbière connectée)

  const nowMs = () => {
    const n = now();
    return n instanceof Date ? n.getTime() : Number(n);
  };

  // Appel de fetch sans « this » parasite (sinon « Illegal invocation » dans le navigateur).
  const callFetch = (input, init) => (fetchImpl === globalThis.fetch
    ? globalThis.fetch(input, init)
    : fetchImpl(input, init));

  // — Session ————————————————————————————————————————————————————

  function readSession() {
    if (storage) {
      try {
        const raw = storage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { /* stockage illisible : repli mémoire */ }
    }
    return memorySession;
  }

  function saveSession(s) {
    memorySession = s;
    if (!storage) return;
    try {
      if (s) storage.setItem(SESSION_KEY, JSON.stringify(s));
      else storage.removeItem(SESSION_KEY);
    } catch { /* navigation privée : session gardée en mémoire */ }
  }

  function toSession(json, previous = null) {
    const nowSec = Math.floor(nowMs() / 1000);
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token || (previous && previous.refresh_token),
      expires_at: Number(json.expires_at) || nowSec + (Number(json.expires_in) || 3600),
      user_id: (json.user && json.user.id) || (previous && previous.user_id) || null,
      email: (json.user && json.user.email) || (previous && previous.email) || '',
    };
  }

  async function authFetch(path, body, accessToken = null) {
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    try {
      return await callFetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
      throw new BookingError('NETWORK', { cause: String((err && err.message) || err) });
    }
  }

  /** Échange le refresh_token contre une nouvelle session (une seule requête à la fois). */
  function refreshSession() {
    if (refreshing) return refreshing;
    const current = readSession();
    if (!current || !current.refresh_token) return Promise.reject(new BookingError('AUTH'));
    refreshing = (async () => {
      const res = await authFetch('/auth/v1/token?grant_type=refresh_token', { refresh_token: current.refresh_token });
      if (!res.ok) {
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          saveSession(null);
          throw new BookingError('AUTH');
        }
        throw new BookingError(isUnavailable(res.status) ? 'UNAVAILABLE' : 'NETWORK', { status: res.status });
      }
      const next = toSession(await res.json(), current);
      saveSession(next);
      return next;
    })();
    refreshing.then(() => { refreshing = null; }, () => { refreshing = null; });
    return refreshing;
  }

  /** Session valide encore au moins 60 s (rafraîchie sinon). */
  async function freshSession() {
    const s = readSession();
    if (!s || !s.access_token) return null;
    if (Number(s.expires_at) * 1000 - nowMs() < 60_000) return refreshSession();
    return s;
  }

  // — Requêtes ——————————————————————————————————————————————————

  async function send(path, { method, body, prefer }, session) {
    const headers = { apikey: key, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    if (session) headers.Authorization = `Bearer ${session.access_token}`;
    const ctrl = typeof AbortController !== 'undefined' && timeoutMs ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      return await callFetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch (err) {
      throw new BookingError('NETWORK', { cause: String((err && err.message) || err) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function parse(res) {
    let text = '';
    try { text = await res.text(); } catch { /* corps absent */ }
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (res.ok) return data;
    throw errorFromResponse(res.status, data);
  }

  /**
   * Requête REST.
   * auth 'required' : connexion obligatoire (AUTH sinon) ;
   * auth 'optional' : jeton joint seulement si connecté (fonctions publiques).
   * Après un 401, un seul rafraîchissement du jeton puis un seul rejeu.
   * withTotal : renvoie { data, total } (total lu dans Content-Range, ou null).
   */
  async function request(path, { method = 'GET', body, prefer, auth = 'required', withTotal = false } = {}) {
    let session = null;
    try {
      session = await freshSession();
    } catch (err) {
      if (auth === 'required' || err.code !== 'AUTH') throw err;
      session = null;
    }
    if (auth === 'required' && !session) throw new BookingError('AUTH');

    let res = await send(path, { method, body, prefer }, session);
    if (res.status === 401 && session) {
      try {
        session = await refreshSession();
      } catch (err) {
        if (auth === 'required' || err.code !== 'AUTH') throw err;
        session = null;
      }
      res = await send(path, { method, body, prefer }, session);
    }
    const data = await parse(res);
    return withTotal ? { data, total: totalFromRange(res) } : data;
  }

  /**
   * Liste complète, lue page par page (limit + offset) jusqu'à épuisement.
   * `path` doit trier sur une clé unique, sinon deux pages peuvent se recouvrir.
   * count : demande le total (Prefer: count=exact) pour s'arrêter juste, même si
   * le plafond du serveur est plus bas que PAGE_SIZE ; sans total, une page
   * incomplète marque la fin.
   */
  async function requestAll(path, { method = 'GET', body, auth = 'required', count = true } = {}) {
    const rows = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 0; page < MAX_PAGES; page++) {
      let res;
      try {
        res = await request(`${path}${sep}limit=${PAGE_SIZE}&offset=${rows.length}`, {
          method, body, auth, prefer: count ? 'count=exact' : undefined, withTotal: true,
        });
      } catch (err) {
        // Liste raccourcie entre deux pages (ligne supprimée entre-temps) : PostgREST répond 416.
        if (rows.length && err.details && err.details.status === 416) break;
        throw err;
      }
      const list = Array.isArray(res.data) ? res.data : [];
      rows.push(...list);
      if (!list.length) break;
      if (res.total !== null ? rows.length >= res.total : list.length < PAGE_SIZE) break;
    }
    return rows;
  }

  const rpc = (name, params = {}, auth = 'optional') =>
    request(`/rest/v1/rpc/${name}`, { method: 'POST', body: params, auth });

  function loadPublic() {
    const t = nowMs();
    if (publicCache && t - publicCache.at < PUBLIC_TTL) return publicCache.promise;
    const promise = rpc('get_public').then((data) => ({
      salon: salonFromRow((data && data.salon) || {}),
      services: ((data && data.services) || []).map(serviceFromRow),
    }));
    const entry = { at: t, promise };
    publicCache = entry;
    promise.catch(() => { if (publicCache === entry) publicCache = null; });
    return promise;
  }

  /**
   * setup_done (§8 bis) : réservé à la barbière, absent de get_public. Lu dans la
   * table (RLS) quand une session existe, mis en cache comme get_public. Session
   * refusée ou compte non pro (aucune ligne visible) → false ; panne → erreur.
   */
  function loadSetupDone() {
    const t = nowMs();
    if (setupCache && t - setupCache.at < PUBLIC_TTL) return setupCache.promise;
    const promise = request('/rest/v1/salon?select=setup_done&id=eq.1')
      .then((rows) => !!(Array.isArray(rows) && rows[0] && rows[0].setup_done === true))
      .catch((err) => {
        if (err && err.code === 'AUTH') return false;
        throw err;
      });
    const entry = { at: t, promise };
    setupCache = entry;
    promise.catch(() => { if (setupCache === entry) setupCache = null; });
    return promise;
  }

  /** Oublie les lectures mises en cache (après une écriture, à chaque rafraîchissement). */
  function forgetCache() {
    publicCache = null;
    setupCache = null;
  }

  function notify(source) {
    for (const cb of [...listeners]) {
      try { cb({ source }); } catch (err) { console.error(err); }
    }
  }

  function changed() {
    forgetCache();
    notify('local');
  }

  async function serviceById(id) {
    if (!id) throw new BookingError('INVALID', { field: 'serviceId' });
    const rows = await request(`/rest/v1/services?select=*&id=eq.${enc(id)}`);
    if (!rows || !rows.length) throw new BookingError('INVALID', { field: 'serviceId' });
    return serviceFromRow(rows[0]);
  }

  // — Store ——————————————————————————————————————————————————————

  const store = {
    mode: 'remote',

    // — Public —

    async getSalon() {
      const salon = JSON.parse(JSON.stringify((await loadPublic()).salon));
      if (store.isLoggedIn()) salon.setupDone = await loadSetupDone();
      return salon;
    },

    async listServices({ includeInactive = false } = {}) {
      if (includeInactive) {
        const rows = await request('/rest/v1/services?select=*&order=position.asc');
        return (rows || []).map(serviceFromRow);
      }
      const { services } = await loadPublic();
      return services.filter((s) => s.active).sort((a, b) => a.position - b.position).map((s) => ({ ...s }));
    },

    async getBusy(fromISO, toISO) {
      const [from, to] = rangeOrThrow(fromISO, toISO, 62);
      // Jusqu'à 62 jours d'occupations : peut dépasser le plafond de 1000 lignes.
      const rows = await requestAll('/rest/v1/rpc/get_busy?order=starts_at,ends_at', {
        method: 'POST', body: { p_from: from, p_to: to }, auth: 'optional', count: false,
      });
      return rows.map((r) => ({ start: iso(r.starts_at), end: iso(r.ends_at) }));
    },

    async book(input = {}) {
      const check = validateContact(input);
      if (!check.ok) throw new BookingError('INVALID', { errors: check.errors });
      if (!input.serviceId) throw new BookingError('INVALID', { field: 'serviceId' });
      const v = check.value;
      const note = cleanMultiline(input.note).slice(0, 500);
      const requestId = requestIdOrThrow(input.requestId);
      const params = {
        p_service_id: input.serviceId,
        p_start: isoOrThrow(input.start),
        p_first_name: v.firstName,
        p_last_name: v.lastName,
        p_phone: v.phone,
        p_email: v.email || null,
        p_note: note || null,
      };
      // Même identifiant à chaque essai d'une même tentative : si la réponse s'est
      // perdue, le serveur rend le RDV déjà créé au lieu de répondre SLOT_TAKEN.
      if (requestId) params.p_request_id = requestId;
      const r = await rpc('book_appointment', params);
      notify('local');
      return {
        id: r.id, token: r.token, start: iso(r.starts_at), end: iso(r.ends_at),
        serviceName: str(r.service_name), priceCents: r.price_cents,
      };
    },

    async getBooking(token) {
      if (!UUID_RE.test(String(token || ''))) return null;
      const r = await rpc('get_booking', { p_token: token });
      if (!r) return null;
      return {
        id: r.id, start: iso(r.starts_at), end: iso(r.ends_at), status: r.status,
        serviceName: str(r.service_name), priceCents: r.price_cents, firstName: str(r.first_name),
      };
    },

    async cancelBooking(token) {
      if (!UUID_RE.test(String(token || ''))) throw new BookingError('NOT_FOUND');
      await rpc('cancel_booking', { p_token: token });
      notify('local');
      return { ok: true };
    },

    // — Barbière —

    isLoggedIn() {
      const s = readSession();
      return !!(s && s.access_token);
    },

    async login(email, password) {
      const em = cleanText(email);
      if (!em || !password) throw new BookingError('AUTH');
      const res = await authFetch('/auth/v1/token?grant_type=password', { email: em, password });
      if (!res.ok) throw new BookingError(isUnavailable(res.status) ? 'UNAVAILABLE' : 'AUTH');
      const session = toSession(await res.json());
      saveSession(session);
      setupCache = null;            // setup_done relu pour ce compte
      // Contrôle facultatif : si la fonction is_pro() est exposée et répond
      // « non », ce compte n'est pas celui de la barbière.
      try {
        const check = await send('/rest/v1/rpc/is_pro', { method: 'POST', body: {} }, session);
        if (check.ok && (await check.json().catch(() => null)) === false) {
          saveSession(null);
          throw new BookingError('AUTH');
        }
      } catch (err) {
        if (err instanceof BookingError && err.code === 'AUTH') throw err;
      }
      return { email: session.email || em };
    },

    async logout() {
      const s = readSession();
      saveSession(null);
      setupCache = null;
      if (s && s.access_token) {
        try { await authFetch('/auth/v1/logout', {}, s.access_token); } catch { /* déjà déconnecté */ }
      }
    },

    async listAppointments(fromISO, toISO) {
      const [from, to] = rangeOrThrow(fromISO, toISO);
      const rows = await requestAll(`/rest/v1/appointments?select=${APPT_SELECT}&starts_at=gte.${enc(from)}&starts_at=lt.${enc(to)}&order=starts_at,id`);
      return rows.map(appointmentFromRow);
    },

    async createAppointment(input = {}) {
      const svc = await serviceById(input.serviceId);
      const dur = hasValue(input.durationMin) ? durationOrThrow(input.durationMin) : svc.durationMin;
      const startsAt = isoOrThrow(input.start);
      const endsAt = new Date(Date.parse(startsAt) + dur * MINUTE).toISOString();

      // Vérification préalable du chevauchement (évite de créer une fiche orpheline) ;
      // la contrainte d'exclusion du serveur reste la garantie finale.
      const clash = await request(`/rest/v1/appointments?select=id&status=${OCCUPYING_FILTER}&starts_at=lt.${enc(endsAt)}&ends_at=gt.${enc(startsAt)}&limit=1`);
      if (clash && clash.length) throw new BookingError('SLOT_TAKEN');

      let clientId = input.clientId || null;
      if (!clientId) {
        const check = validateContact(input.client || {}, { pro: true });
        if (!check.ok) throw new BookingError('INVALID', { errors: check.errors });
        const v = check.value;
        if (v.phone) {
          const found = await request(`/rest/v1/clients?select=id&phone=eq.${enc(v.phone)}`);
          if (found && found.length) clientId = found[0].id;
        }
        if (!clientId) {
          const created = await request('/rest/v1/clients?select=id', {
            method: 'POST',
            prefer: 'return=representation',
            body: { first_name: v.firstName, last_name: v.lastName, phone: v.phone || null, email: v.email || null },
          });
          clientId = created[0].id;
        }
      }

      const rows = await request(`/rest/v1/appointments?select=${APPT_SELECT}`, {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          client_id: clientId,
          service_id: svc.id,
          service_name: svc.name,
          price_cents: svc.priceCents,
          starts_at: startsAt,
          ends_at: endsAt,
          status: 'confirmed',
          source: 'pro',
          note: cleanMultiline(input.note).slice(0, 500),
        },
      });
      changed();
      return appointmentFromRow(rows[0]);
    },

    async updateAppointment(id, patch = {}) {
      const body = {};
      const timeChange = patch.start !== undefined || hasValue(patch.durationMin) || patch.serviceId !== undefined;
      if (timeChange) {
        const cur = await request(`/rest/v1/appointments?select=starts_at,ends_at,service_id&id=eq.${enc(id)}`);
        if (!cur || !cur.length) throw new BookingError('NOT_FOUND');
        let startMs = Date.parse(cur[0].starts_at);
        let dur = (Date.parse(cur[0].ends_at) - startMs) / MINUTE;
        if (patch.serviceId !== undefined && patch.serviceId !== cur[0].service_id) {
          const svc = await serviceById(patch.serviceId);
          body.service_id = svc.id;
          body.service_name = svc.name;
          body.price_cents = svc.priceCents;
          dur = svc.durationMin;
        }
        if (hasValue(patch.durationMin)) dur = durationOrThrow(patch.durationMin);
        if (patch.start !== undefined) startMs = Date.parse(isoOrThrow(patch.start));
        body.starts_at = new Date(startMs).toISOString();
        body.ends_at = new Date(startMs + dur * MINUTE).toISOString();
      }
      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) throw new BookingError('INVALID', { field: 'status' });
        body.status = patch.status;
        body.cancelled_at = patch.status === 'cancelled' ? new Date(nowMs()).toISOString() : null;
      }
      if (patch.note !== undefined) body.note = cleanMultiline(patch.note).slice(0, 500);

      const path = `/rest/v1/appointments?id=eq.${enc(id)}&select=${APPT_SELECT}`;
      const rows = Object.keys(body).length
        ? await request(path, { method: 'PATCH', body, prefer: 'return=representation' })
        : await request(path);
      if (!rows || !rows.length) throw new BookingError('NOT_FOUND');
      changed();
      return appointmentFromRow(rows[0]);
    },

    async listBlocks(fromISO, toISO) {
      const [from, to] = rangeOrThrow(fromISO, toISO);
      const rows = await request(`/rest/v1/blocks?select=*&starts_at=lt.${enc(to)}&ends_at=gt.${enc(from)}&order=starts_at`);
      return (rows || []).map(blockFromRow);
    },

    async createBlock({ start, end, reason = '' } = {}) {
      const s = isoOrThrow(start);
      const e = isoOrThrow(end);
      if (Date.parse(e) <= Date.parse(s)) throw new BookingError('INVALID', { field: 'end' });
      const rows = await request('/rest/v1/blocks', {
        method: 'POST',
        prefer: 'return=representation',
        body: { starts_at: s, ends_at: e, reason: cleanText(reason).slice(0, 200) },
      });
      changed();
      return blockFromRow(rows[0]);
    },

    async deleteBlock(id) {
      await request(`/rest/v1/blocks?id=eq.${enc(id)}`, { method: 'DELETE' });
      changed();
    },

    async listClients({ search = '' } = {}) {
      // Plusieurs années de fiches peuvent dépasser le plafond de 1000 lignes : lecture par pages.
      const rows = await requestAll(`/rest/v1/clients_with_stats?select=*${clientSearchQuery(search)}&order=last_name.asc,first_name.asc,id.asc`);
      return rows.map(clientFromRow).sort(compareClientNames);
    },

    async getClient(id) {
      const [rows, appts] = await Promise.all([
        request(`/rest/v1/clients_with_stats?select=*&id=eq.${enc(id)}`),
        request(`/rest/v1/appointments?select=${APPT_SELECT}&client_id=eq.${enc(id)}&order=starts_at`),
      ]);
      if (!rows || !rows.length) throw new BookingError('NOT_FOUND');
      return { ...clientFromRow(rows[0]), appointments: (appts || []).map(appointmentFromRow) };
    },

    async updateClient(id, patch = {}) {
      const check = validateClientPatch(patch);
      if (!check.ok) throw new BookingError('INVALID', { errors: check.errors });
      const v = check.value;
      const body = {};
      if (v.firstName !== undefined) body.first_name = v.firstName;
      if (v.lastName !== undefined) body.last_name = v.lastName;
      if (v.phone !== undefined) body.phone = v.phone || null;
      if (v.email !== undefined) body.email = v.email || null;
      if (v.notes !== undefined) body.notes = v.notes;
      if (Object.keys(body).length) {
        try {
          await request(`/rest/v1/clients?id=eq.${enc(id)}`, { method: 'PATCH', body, prefer: 'return=minimal' });
        } catch (err) {
          if (err.details && err.details.pgCode === '23505') {
            throw new BookingError('INVALID', { errors: { phone: 'Ce numéro est déjà utilisé par une autre fiche client.' } });
          }
          throw err;
        }
      }
      const rows = await request(`/rest/v1/clients_with_stats?select=*&id=eq.${enc(id)}`);
      if (!rows || !rows.length) throw new BookingError('NOT_FOUND');
      changed();
      return clientFromRow(rows[0]);
    },

    async deleteClient(id) {
      // Effacement RGPD : RDV à venir annulés, puis fiche supprimée (ses RDV suivent en cascade).
      const nowIso = new Date(nowMs()).toISOString();
      await request(`/rest/v1/appointments?client_id=eq.${enc(id)}&status=eq.confirmed&starts_at=gte.${enc(nowIso)}`, {
        method: 'PATCH',
        body: { status: 'cancelled', cancelled_at: nowIso },
        prefer: 'return=minimal',
      });
      await request(`/rest/v1/clients?id=eq.${enc(id)}`, { method: 'DELETE' });
      changed();
    },

    async updateSalon(patch = {}) {
      const check = validateSalonPatch(patch);
      if (!check.ok) throw new BookingError('INVALID', { errors: check.errors });
      const body = { ...salonToRow(check.value), updated_at: new Date(nowMs()).toISOString() };
      const rows = await request('/rest/v1/salon?id=eq.1', { method: 'PATCH', body, prefer: 'return=representation' });
      if (!rows || !rows.length) throw new BookingError('NOT_FOUND');
      changed();
      return salonFromRow(rows[0]);
    },

    async saveService(service = {}) {
      const isUpdate = !!service.id;
      const check = validateService(service, { partial: isUpdate });
      if (!check.ok) throw new BookingError('INVALID', { errors: check.errors });
      let rows;
      if (isUpdate) {
        rows = await request(`/rest/v1/services?id=eq.${enc(service.id)}`, {
          method: 'PATCH', body: serviceToRow(check.value), prefer: 'return=representation',
        });
        if (!rows || !rows.length) throw new BookingError('NOT_FOUND');
      } else {
        const value = { ...check.value };
        if (value.position === undefined) {
          const last = await request('/rest/v1/services?select=position&order=position.desc&limit=1');
          value.position = ((last && last[0] && last[0].position) || 0) + 1;
        }
        rows = await request('/rest/v1/services', { method: 'POST', body: serviceToRow(value), prefer: 'return=representation' });
      }
      changed();
      return serviceFromRow(rows[0]);
    },

    async deleteService(id) {
      const rows = await request(`/rest/v1/services?id=eq.${enc(id)}`, {
        method: 'PATCH', body: { active: false }, prefer: 'return=representation',
      });
      if (!rows || !rows.length) throw new BookingError('NOT_FOUND');
      changed();
    },

    async reorderServices(ids = []) {
      await Promise.all(ids.map((id, i) => request(`/rest/v1/services?id=eq.${enc(id)}`, {
        method: 'PATCH', body: { position: i + 1 }, prefer: 'return=minimal',
      })));
      changed();
    },

    /**
     * Rafraîchissement : toutes les `pollMs` quand la page est visible,
     * au retour sur la page (visibilitychange / focus) et après chaque écriture.
     */
    onChange(callback) {
      listeners.add(callback);
      const hasDoc = typeof document !== 'undefined';
      const visible = () => !hasDoc || document.visibilityState === 'visible';

      const tick = () => {
        if (!visible()) return;
        forgetCache();
        callback({ source: 'poll' });
      };
      let lastVisible = 0;
      const onVisible = () => {
        // focus et visibilitychange arrivent souvent ensemble : un seul rafraîchissement
        if (!visible() || nowMs() - lastVisible < 2000) return;
        lastVisible = nowMs();
        forgetCache();
        callback({ source: 'visible' });
      };

      const timer = setInterval(tick, pollMs);
      if (timer && typeof timer.unref === 'function') timer.unref(); // ne retient pas node
      if (hasDoc && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('focus', onVisible);

      return () => {
        listeners.delete(callback);
        clearInterval(timer);
        if (hasDoc && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisible);
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('focus', onVisible);
      };
    },
  };

  return store;
}
