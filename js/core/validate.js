// Validation et normalisation des saisies (téléphone, e-mail, formulaires).
// Partagé par les écrans et par les deux implémentations du Store.

// — Texte ————————————————————————————————————————————————————————

/** Texte sur une ligne : espaces superflus retirés. */
export function cleanText(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

/** Texte sur plusieurs lignes (notes) : retours à la ligne conservés. */
export function cleanMultiline(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Minuscules sans accents, pour les recherches. */
export function foldText(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// — Téléphone et e-mail ———————————————————————————————————————————

/**
 * '06 12 34 56 78' → '+33612345678' ; '+32 470 12 34 56' gardé tel quel (chiffres) ;
 * '0033 6…' → '+336…' ; '+33 (0)6…' → '+336…'.
 * Invalide (national ≠ 10 chiffres commençant par 0, international hors 8–15 chiffres) → null.
 */
export function normalizePhone(str) {
  if (str === null || str === undefined) return null;
  let s = String(str).trim();
  if (!s) return null;
  s = s.replace(/\(0\)/g, '');
  s = s.replace(/[\s.\-/()  ]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('+')) {
    let digits = s.slice(1);
    if (!/^\d+$/.test(digits)) return null;
    // « +33 06 … » : le 0 national ne doit pas suivre l'indicatif
    if (digits.length === 12 && digits.startsWith('330')) digits = '33' + digits.slice(3);
    if (digits.length < 8 || digits.length > 15) return null;
    return '+' + digits;
  }
  if (/^0\d{9}$/.test(s)) return '+33' + s.slice(1);
  return null;
}

/** '+33612345678' → '06 12 34 56 78' ; autre format → tel quel ; vide → ''. */
export function fmtPhone(e164) {
  if (!e164) return '';
  const m = /^\+33(\d{9})$/.exec(String(e164));
  if (!m) return String(e164);
  return ('0' + m[1]).replace(/(\d{2})(?=\d)/g, '$1 ');
}

/** Adresse e-mail plausible (pas de vérification d'existence). */
export function isEmail(str) {
  const s = String(str ?? '').trim();
  return s.length <= 254 && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(s);
}

// — Formulaires ——————————————————————————————————————————————————

const MSG = {
  firstName: 'Indiquez votre prénom.',
  firstNamePro: 'Indiquez au moins le prénom.',
  firstNameLong: 'Le prénom est trop long (60 caractères maximum).',
  lastName: 'Indiquez votre nom.',
  lastNameLong: 'Le nom est trop long (60 caractères maximum).',
  phone: 'Indiquez votre numéro de mobile, pour que le salon puisse vous joindre.',
  phoneInvalid: 'Ce numéro semble incomplet ou incorrect. Exemple : 06 12 34 56 78.',
  email: 'Cette adresse e-mail semble incorrecte. Exemple : prenom@exemple.fr.',
  emailLong: 'Cette adresse e-mail est trop longue (120 caractères maximum).',
  notesLong: 'Les notes sont trop longues (2 000 caractères maximum).',
};

/** Message d'erreur pour un e-mail facultatif ('' si correct ou vide). */
function emailError(v) {
  if (!v) return '';
  if (v.length > 120) return MSG.emailLong;
  return isEmail(v) ? '' : MSG.email;
}

/**
 * Coordonnées d'une cliente ou d'un client.
 * Réservation en ligne : prénom, nom et téléphone requis, e-mail facultatif.
 * { pro: true } (saisie par la barbière) : seul le prénom est requis.
 * → { ok, errors: { champ: 'message' }, value: { firstName, lastName, phone (E.164 ou ''), email } }
 */
export function validateContact(contact = {}, { pro = false } = {}) {
  const c = contact || {};
  const firstName = cleanText(c.firstName);
  const lastName = cleanText(c.lastName);
  const phoneRaw = cleanText(c.phone);
  const email = cleanText(c.email).toLowerCase();
  const errors = {};

  if (!firstName) errors.firstName = pro ? MSG.firstNamePro : MSG.firstName;
  else if (firstName.length > 60) errors.firstName = MSG.firstNameLong;

  if (!lastName) { if (!pro) errors.lastName = MSG.lastName; }
  else if (lastName.length > 60) errors.lastName = MSG.lastNameLong;

  let phone = '';
  if (!phoneRaw) { if (!pro) errors.phone = MSG.phone; }
  else {
    phone = normalizePhone(phoneRaw) || '';
    if (!phone) errors.phone = MSG.phoneInvalid;
  }

  if (emailError(email)) errors.email = emailError(email);

  return { ok: Object.keys(errors).length === 0, errors, value: { firstName, lastName, phone, email } };
}

/**
 * Modification d'une fiche client par la barbière : seuls les champs fournis
 * sont contrôlés (le prénom ne peut pas être vidé).
 * → { ok, errors, value } (value ne contient que les champs fournis, normalisés)
 */
export function validateClientPatch(patch = {}) {
  const p = patch || {};
  const errors = {};
  const value = {};
  if (p.firstName !== undefined) {
    const v = cleanText(p.firstName);
    if (!v) errors.firstName = MSG.firstNamePro;
    else if (v.length > 60) errors.firstName = MSG.firstNameLong;
    else value.firstName = v;
  }
  if (p.lastName !== undefined) {
    const v = cleanText(p.lastName);
    if (v.length > 60) errors.lastName = MSG.lastNameLong;
    else value.lastName = v;
  }
  if (p.phone !== undefined) {
    const v = cleanText(p.phone);
    if (!v) value.phone = '';
    else {
      const n = normalizePhone(v);
      if (!n) errors.phone = MSG.phoneInvalid;
      else value.phone = n;
    }
  }
  if (p.email !== undefined) {
    const v = cleanText(p.email).toLowerCase();
    if (emailError(v)) errors.email = emailError(v);
    else value.email = v;
  }
  if (p.notes !== undefined) {
    const v = cleanMultiline(p.notes);
    if (v.length > 2000) errors.notes = MSG.notesLong;
    else value.notes = v;
  }
  return { ok: Object.keys(errors).length === 0, errors, value };
}

/**
 * Prestation (création ou modification).
 * { partial: true } : seuls les champs fournis sont contrôlés (modification).
 * → { ok, errors, value }
 */
export function validateService(service = {}, { partial = false } = {}) {
  const s = service || {};
  const errors = {};
  const value = {};
  const has = (k) => s[k] !== undefined && s[k] !== null;

  if (has('name') || !partial) {
    const v = cleanText(s.name);
    if (!v) errors.name = 'Indiquez le nom de la prestation.';
    else if (v.length > 80) errors.name = 'Nom trop long (80 caractères maximum).';
    else value.name = v;
  }
  if (has('description') || !partial) {
    const v = cleanMultiline(s.description);
    if (v.length > 300) errors.description = 'Description trop longue (300 caractères maximum).';
    else value.description = v;
  }
  if (has('category') || !partial) {
    const v = cleanText(s.category);
    if (v.length > 40) errors.category = 'Catégorie trop longue (40 caractères maximum).';
    else value.category = v;
  }
  if (has('durationMin') || !partial) {
    const v = Number(s.durationMin);
    if (!Number.isInteger(v) || v < 5 || v > 480) errors.durationMin = 'Indiquez une durée entre 5 min et 8 h.';
    else value.durationMin = v;
  }
  if (has('priceCents') || !partial) {
    const v = Number(s.priceCents);
    if (!Number.isInteger(v) || v < 0 || v > 100_000) errors.priceCents = 'Indiquez un prix valide (en euros).';
    else value.priceCents = v;
  }
  if (has('active') || !partial) value.active = has('active') ? Boolean(s.active) : true;
  if (has('position')) {
    const v = Number(s.position);
    if (!Number.isInteger(v) || v < 0) errors.position = 'Position invalide.';
    else value.position = v;
  }
  return { ok: Object.keys(errors).length === 0, errors, value };
}

/** Horaires { '1': [['09:00','12:00'], …], … '7': [] } → version normalisée ou null. */
export function normalizeHours(hours) {
  if (!hours || typeof hours !== 'object') return null;
  const out = {};
  for (let d = 1; d <= 7; d++) {
    const list = hours[String(d)] ?? hours[d] ?? [];
    if (!Array.isArray(list)) return null;
    const ranges = [];
    for (const r of list) {
      if (!Array.isArray(r) || r.length !== 2) return null;
      const [o, c] = r.map((x) => /^(\d{1,2}):(\d{2})$/.exec(String(x).trim()));
      if (!o || !c) return null;
      const om = Number(o[1]) * 60 + Number(o[2]);
      const cm = Number(c[1]) * 60 + Number(c[2]);
      if (Number(o[2]) > 59 || Number(c[2]) > 59 || om >= cm || cm > 24 * 60) return null;
      ranges.push([om, cm]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) return null;
    const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    out[String(d)] = ranges.map(([om, cm]) => [hm(om), hm(cm)]);
  }
  return out;
}

/**
 * Réglages du salon (patch partiel). Champs inconnus ignorés.
 * → { ok, errors, value }
 */
export function validateSalonPatch(patch = {}) {
  const p = patch || {};
  const errors = {};
  const value = {};
  const text = (k, max, { required = false, multiline = false } = {}) => {
    if (p[k] === undefined) return;
    const v = multiline ? cleanMultiline(p[k]) : cleanText(p[k]);
    if (required && !v) errors[k] = 'Ce champ est obligatoire.';
    else if (v.length > max) errors[k] = `${max} caractères maximum.`;
    else value[k] = v;
  };
  const int = (k, min, max, msg) => {
    if (p[k] === undefined) return;
    const v = Number(p[k]);
    if (!Number.isInteger(v) || v < min || v > max) errors[k] = msg;
    else value[k] = v;
  };

  // Longueurs maximales identiques aux contraintes de supabase/schema.sql.
  text('name', 100, { required: true });
  text('tagline', 160);
  text('address', 200);
  text('city', 100);
  text('instagram', 200);
  text('notice', 1000, { multiline: true });

  if (p.phone !== undefined) {
    const v = cleanText(p.phone);
    if (!v) value.phone = '';
    else {
      const n = normalizePhone(v);
      if (!n) errors.phone = MSG.phoneInvalid;
      else value.phone = n;
    }
  }
  if (p.email !== undefined) {
    const v = cleanText(p.email).toLowerCase();
    if (emailError(v)) errors.email = emailError(v);
    else value.email = v;
  }
  if (p.timezone !== undefined) {
    const v = cleanText(p.timezone);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: v });
      value.timezone = v;
    } catch {
      errors.timezone = 'Fuseau horaire inconnu.';
    }
  }
  if (p.hours !== undefined) {
    const h = normalizeHours(p.hours);
    if (!h) errors.hours = 'Horaires incohérents : vérifiez que chaque fermeture suit son ouverture, sans chevauchement.';
    else value.hours = h;
  }
  int('slotStep', 5, 120, 'Pas des créneaux entre 5 et 120 minutes.');
  int('minNoticeMin', 0, 10_080, 'Délai minimum entre 0 et 7 jours.');
  int('maxDaysAhead', 1, 365, 'Horizon de réservation entre 1 et 365 jours.');
  int('cancelLimitHours', 0, 168, "Délai d'annulation entre 0 et 168 heures.");
  if (p.bookingEnabled !== undefined) value.bookingEnabled = Boolean(p.bookingEnabled);
  // Personnalisation (§8 bis) : blason affiché ou non, assistant de configuration terminé.
  if (p.showCrest !== undefined) value.showCrest = Boolean(p.showCrest);
  if (p.setupDone !== undefined) value.setupDone = Boolean(p.setupDone);

  return { ok: Object.keys(errors).length === 0, errors, value };
}

// — Clients : tri et recherche (mêmes règles en démo et en ligne) ——————————

let collator = null;
function frCompare(a, b) {
  if (!collator) collator = new Intl.Collator('fr', { sensitivity: 'base' });
  return collator.compare(a, b);
}

/** Tri « par nom » : nom de famille (ou prénom à défaut), puis prénom. */
export function compareClientNames(a, b) {
  const ka = a.lastName || a.firstName || '';
  const kb = b.lastName || b.firstName || '';
  return frCompare(ka, kb) || frCompare(a.firstName || '', b.firstName || '') || String(a.id).localeCompare(String(b.id));
}

/**
 * Analyse une recherche de client.
 * → null (pas de filtre) | { kind: 'phone', digits } | { kind: 'words', words: [...] }
 * Recherche « téléphone » si la saisie ne contient que chiffres et séparateurs ;
 * le 0 initial est retiré pour retrouver '+33612…' à partir de '06 12'.
 */
export function parseClientSearch(search) {
  const term = cleanText(search).slice(0, 60);
  if (!term) return null;
  if (/^[\d\s+().-]+$/.test(term)) {
    let digits = term.replace(/\D/g, '');
    if (digits.startsWith('0')) digits = digits.slice(1);
    return digits ? { kind: 'phone', digits } : null;
  }
  const words = term.split(' ').map((w) => w.replace(/\*/g, '')).filter(Boolean).slice(0, 4);
  return words.length ? { kind: 'words', words } : null;
}

/** Le client correspond-il à la recherche ? (chaque mot dans le prénom ou le nom) */
export function clientMatches(client, search) {
  const q = typeof search === 'object' && search !== null ? search : parseClientSearch(search);
  if (!q) return true;
  if (q.kind === 'phone') return String(client.phone || '').replace(/\D/g, '').includes(q.digits);
  const first = foldText(client.firstName);
  const last = foldText(client.lastName);
  return q.words.every((w) => {
    const f = foldText(w);
    return first.includes(f) || last.includes(f);
  });
}
