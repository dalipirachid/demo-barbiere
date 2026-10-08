// Mémoire du téléphone (localStorage) côté client :
//   barbiere-mes-rdv : rendez-vous pris depuis ce téléphone
//     [{ token, start, serviceName }] (contrat §7) + champs facultatifs
//     ajoutés ici : end, serviceId (« Reprendre le même »), status (dernier connu).
//   barbiere-moi : { firstName, lastName, phone, email } pour pré-remplir le formulaire.
// Toute lecture/écriture est protégée (navigation privée, stockage plein) :
// en cas d'échec, la liste reste en mémoire le temps de la visite.

const MES_RDV_KEY = 'barbiere-mes-rdv';
const MOI_KEY = 'barbiere-moi';
const MAX_ENTRIES = 30;

let memoryList = null;     // repli si localStorage est indisponible
let memoryMoi = null;

const str = (v) => (v === null || v === undefined ? '' : String(v));

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return undefined;        // stockage illisible ou bloqué
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// — Mes rendez-vous ——————————————————————————————————————————————

function clean(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const token = str(entry.token).trim();
  const start = str(entry.start);
  if (!token || !Number.isFinite(Date.parse(start))) return null;
  return {
    token,
    start,
    end: Number.isFinite(Date.parse(str(entry.end))) ? str(entry.end) : '',
    serviceName: str(entry.serviceName),
    serviceId: str(entry.serviceId),
    status: str(entry.status),
  };
}

/** Rendez-vous mémorisés, du plus récent au plus ancien. */
export function readMesRdv() {
  const stored = readJSON(MES_RDV_KEY);
  const list = stored === undefined ? memoryList : stored;
  if (!Array.isArray(list)) return [];
  return list.map(clean).filter(Boolean);
}

function writeMesRdv(list) {
  const sorted = list
    .map(clean)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .slice(0, MAX_ENTRIES);
  memoryList = sorted;
  writeJSON(MES_RDV_KEY, sorted);
  return sorted;
}

/** Ajoute ou met à jour un rendez-vous (clé : token). */
export function saveMesRdv(entry) {
  const list = readMesRdv();
  const index = list.findIndex((e) => e.token === entry.token);
  if (index >= 0) {
    const merged = { ...list[index] };
    for (const [k, v] of Object.entries(entry)) if (v !== undefined && v !== '') merged[k] = v;
    list[index] = merged;
  } else {
    list.push(entry);
  }
  return writeMesRdv(list);
}

/** Modifie un rendez-vous déjà mémorisé (sans l'ajouter s'il est absent). */
export function patchMesRdv(token, patch) {
  const list = readMesRdv();
  const entry = list.find((e) => e.token === token);
  if (!entry) return list;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && v !== '') entry[k] = v;
  return writeMesRdv(list);
}

export function removeMesRdv(token) {
  return writeMesRdv(readMesRdv().filter((e) => e.token !== token));
}

/**
 * Reporte dans la mémoire les réponses de getBooking() (Promise.allSettled) :
 * statut et horaires à jour ; jeton inconnu du serveur → retiré de la liste.
 * → { offline } : vrai si au moins une lecture a échoué (réseau).
 */
export function applyBookingResults(entries, results) {
  let offline = false;
  results.forEach((result, i) => {
    const entry = entries[i];
    if (result.status === 'rejected') {
      if (result.reason && result.reason.code === 'NOT_FOUND') removeMesRdv(entry.token);
      else offline = true;
      return;
    }
    const b = result.value;
    if (!b) {
      removeMesRdv(entry.token);
      return;
    }
    patchMesRdv(entry.token, { status: b.status, start: b.start, end: b.end, serviceName: b.serviceName });
  });
  return { offline };
}

// — « Se souvenir de moi » ———————————————————————————————————————

export function readMoi() {
  const stored = readJSON(MOI_KEY);
  const v = stored === undefined ? memoryMoi : stored;
  if (!v || typeof v !== 'object') return null;
  return { firstName: str(v.firstName), lastName: str(v.lastName), phone: str(v.phone), email: str(v.email) };
}

export function saveMoi({ firstName, lastName, phone, email }) {
  const value = { firstName: str(firstName), lastName: str(lastName), phone: str(phone), email: str(email) };
  memoryMoi = value;
  writeJSON(MOI_KEY, value);
}

export function forgetMoi() {
  memoryMoi = null;
  try { localStorage.removeItem(MOI_KEY); } catch { /* rien à effacer */ }
}
