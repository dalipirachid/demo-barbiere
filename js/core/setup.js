// Personnalisation du salon par la barbière (contrat §8 bis).
// On n'invente pas l'identité du salon : ce qui n'est pas connu reste « [À COMPLÉTER] »
// et la barbière le renseigne elle-même depuis l'espace pro (assistant de configuration).
// Pur et sans DOM : partagé par l'espace pro et la page de réservation, testé sous node.

/** Marqueur des informations encore à fournir. */
export const PLACEHOLDER = '[À COMPLÉTER]';

/** Champs indispensables du salon, dans l'ordre où l'assistant les demande. */
const REQUIRED = Object.freeze([
  Object.freeze({ key: 'name', label: 'Nom du salon' }),
  Object.freeze({ key: 'address', label: 'Adresse' }),
  Object.freeze({ key: 'city', label: 'Ville' }),
  Object.freeze({ key: 'phone', label: 'Téléphone du salon' }),
]);

/** Vrai si le texte est vide (après suppression des espaces) ou contient encore le marqueur. */
export function isPlaceholder(text) {
  const s = String(text ?? '').trim();
  return !s || s.includes(PLACEHOLDER);
}

/**
 * Champs indispensables encore à remplir.
 * → [{ key, label }] dans l'ordre : nom, adresse, ville, téléphone ([] si tout est renseigné).
 */
export function salonTodo(salon) {
  const s = salon || {};
  return REQUIRED.filter(({ key }) => isPlaceholder(s[key])).map(({ key, label }) => ({ key, label }));
}

/**
 * L'assistant reste à proposer : jamais terminé (setupDone absent se lit false),
 * ou un champ indispensable est encore vide ou marqué.
 */
export function needsSetup(salon) {
  return !(salon && salon.setupDone) || salonTodo(salon).length > 0;
}

/** Nom du salon à afficher, ou '' tant que c'est un marqueur (l'écran prend alors un libellé générique). */
export function displayName(salon) {
  const name = salon ? salon.name : '';
  return isPlaceholder(name) ? '' : String(name).replace(/\s+/g, ' ').trim();
}
