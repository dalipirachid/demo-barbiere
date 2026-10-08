// État de la réservation en cours, partagé entre les écrans (en mémoire
// seulement : un rechargement de page repart de l'accueil, c'est voulu).

/** Brouillon de réservation : prestation, jour et créneau choisis, saisie du formulaire. */
export const draft = {
  serviceId: '',   // prestation choisie
  ymd: '',         // jour affiché à l'étape 1 ('YYYY-MM-DD')
  start: '',       // créneau choisi (ISO UTC)
  contact: null,   // dernière saisie du formulaire { firstName, lastName, phone, email, note, consent, remember }
  request: null,   // tentative de réservation en cours { key, id } (voir bookingRequestId)
};

/** Change de prestation : le jour et le créneau choisis ne valent plus. */
export function selectService(serviceId) {
  if (draft.serviceId === serviceId) return;
  draft.serviceId = serviceId;
  draft.ymd = '';
  draft.start = '';
}

/** Identifiant unique (uuid v4) ; repli si crypto.randomUUID est absent (ancien navigateur, http). */
export function newRequestId(cryptoApi = globalThis.crypto) {
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;   // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // variante RFC 4122
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Identifiant de la tentative de réservation, envoyé à store.book (requestId).
 * Le même tant que la prestation, le créneau et les coordonnées ne changent pas :
 * un nouvel envoi après une coupure renvoie alors la réservation déjà faite au
 * lieu de « créneau pris ». Autre créneau ou autres coordonnées : nouvel identifiant.
 */
export function bookingRequestId({ serviceId, start, firstName, lastName, phone, email }, make = newRequestId) {
  const key = JSON.stringify([serviceId, start, firstName, lastName, phone, email || '']);
  if (!draft.request || draft.request.key !== key) draft.request = { key, id: make() };
  return draft.request.id;
}

/** Informations de passage d'un écran à l'autre. */
export const session = {
  lastBooking: null,    // résultat de book() + prénom, pour afficher le ticket sans relire le serveur
  focusTarifs: false,   // l'accueil doit s'ouvrir sur le tableau des tarifs (« Changer » de prestation)
};
