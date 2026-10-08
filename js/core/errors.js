// Erreurs métier partagées par les deux modes de données (démo et en ligne).
// Chaque erreur porte un `code` stable (identique à celui que renvoie le
// serveur SQL) et un message français prêt à afficher.

export const ERROR_CODES = Object.freeze([
  'SLOT_TAKEN', 'OUT_OF_HOURS', 'TOO_SOON', 'TOO_FAR', 'CLOSED',
  'INVALID', 'LIMIT', 'NOT_FOUND', 'TOO_LATE', 'AUTH', 'NETWORK', 'UNAVAILABLE',
]);

const MESSAGES = Object.freeze({
  SLOT_TAKEN: "Ce créneau vient d'être pris. Choisissez-en un autre.",
  OUT_OF_HOURS: "Ce créneau est en dehors des horaires d'ouverture. Choisissez une autre heure.",
  TOO_SOON: 'Ce créneau est trop proche pour être réservé en ligne. Choisissez un horaire un peu plus tard, ou appelez le salon.',
  TOO_FAR: "Ce créneau est trop loin dans le calendrier : les réservations en ligne ne sont pas encore ouvertes pour cette date.",
  CLOSED: 'La réservation en ligne est momentanément suspendue. Appelez le salon pour prendre rendez-vous.',
  INVALID: 'Certaines informations sont incomplètes ou incorrectes. Vérifiez-les puis réessayez.',
  LIMIT: 'Vous avez déjà deux rendez-vous à venir. Pour en prendre un autre, annulez-en un ou appelez le salon.',
  NOT_FOUND: 'Nous ne retrouvons pas cet élément : il a peut-être été annulé ou supprimé entre-temps.',
  TOO_LATE: "Il est trop tard pour annuler en ligne. Appelez directement le salon pour le prévenir.",
  AUTH: 'Identifiants incorrects ou session expirée. Merci de vous reconnecter.',
  NETWORK: 'Connexion impossible pour le moment. Vérifiez votre réseau puis réessayez.',
  // Serveur joint mais indisponible (maintenance, surcharge, projet en pause : HTTP 5xx ou 429).
  UNAVAILABLE: 'Le service de réservation ne répond pas pour le moment. Réessayez dans un instant ou appelez le salon.',
});

const GENERIC = 'Une erreur inattendue est survenue. Réessayez dans un instant.';

export class BookingError extends Error {
  /**
   * @param {string} code    un des ERROR_CODES
   * @param {object} [details] informations complémentaires (ex. { errors: { phone: '…' } })
   */
  constructor(code, details = null) {
    super(MESSAGES[code] || GENERIC);
    this.name = 'BookingError';
    this.code = code;
    this.details = details;
  }
}

/** Vrai pour toute erreur portant un code métier connu. */
export function isBookingError(err) {
  return !!err && typeof err === 'object' && ERROR_CODES.includes(err.code);
}

/**
 * Phrase française à afficher pour un code (ou directement pour une erreur).
 * Code inconnu ou erreur technique → message générique.
 */
export function errorMessage(codeOrError) {
  const code = typeof codeOrError === 'string' ? codeOrError : codeOrError && codeOrError.code;
  return MESSAGES[code] || GENERIC;
}
