// Morceaux d'interface communs aux écrans client (en-tête, poteau de
// progression, tableau des tarifs, états d'erreur et de chargement).
// Uniquement des composants de css/app.css (catalogue : styleguide.html).

import { html, icon, raw } from '../ui/dom.js';
import { fmtPrice, fmtDuration } from '../core/dates.js';
import { errorMessage } from '../core/errors.js';

export const STEPS = 3;

// Repli tant qu'errors.js ne connaît pas encore le code UNAVAILABLE (serveur indisponible, 5xx/429).
const UNAVAILABLE_TEXT = 'Le service de réservation est momentanément indisponible. Réessayez dans quelques minutes.';

/** Codes d'erreur passagers (réseau, serveur) : réessayer plus tard a un sens. */
export const TRANSIENT_CODES = Object.freeze(['NETWORK', 'UNAVAILABLE']);

/** Phrase à afficher pour une erreur (ou un code), comme errorMessage, avec repli pour UNAVAILABLE. */
export function errorText(codeOrError) {
  const code = typeof codeOrError === 'string' ? codeOrError : codeOrError && codeOrError.code;
  const text = errorMessage(codeOrError);
  return code === 'UNAVAILABLE' && text === errorMessage('') ? UNAVAILABLE_TEXT : text;
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * En-tête collant avec bouton retour. Le titre porte data-screen-title :
 * le routeur y place le focus à l'arrivée sur l'écran.
 * titleTag 'p' : quand le vrai titre de l'écran est ailleurs (ticket).
 */
export function appbar({ title, subtitle = '', backLabel = 'Retour', titleTag = 'h1' }) {
  const titleHtml = titleTag === 'h1'
    ? html`<h1 class="appbar__title" tabindex="-1" data-screen-title>${title}</h1>`
    : html`<p class="appbar__title">${title}</p>`;
  return html`
    <header class="appbar">
      <button class="icon-btn appbar__back" type="button" data-action="back" aria-label="${backLabel}">${icon('chevron-gauche')}</button>
      <div class="appbar__titles">
        ${titleHtml}
        ${subtitle ? html`<p class="appbar__subtitle">${subtitle}</p>` : ''}
      </div>
    </header>`;
}

/**
 * Poteau de barbier : progression de la réservation (étape 1 à 3).
 * Il s'affiche à la valeur de l'étape précédente puis avance (animateProgress).
 */
export function progress(step, label) {
  const from = Math.max(0, step - 1) / STEPS;
  const to = step / STEPS;
  return html`
    <div class="booking-progress">
      <div class="pole" role="progressbar" aria-label="Progression de la réservation"
           aria-valuemin="0" aria-valuemax="${STEPS}" aria-valuenow="${step}"
           aria-valuetext="${`Étape ${step} sur ${STEPS} : ${label}`}"
           style="--progress: ${from.toFixed(4)}" data-progress="${to.toFixed(4)}"><span class="pole__bar"></span></div>
      <p class="booking-progress__label" aria-hidden="true"><span class="booking-progress__step">Étape ${step}/${STEPS}</span> · ${label}</p>
    </div>`;
}

/** Fait avancer le poteau jusqu'à l'étape courante (transition CSS ; instant : sans animation). */
export function animateProgress(root, { instant = false } = {}) {
  const pole = root.querySelector('.pole[data-progress]');
  if (!pole) return;
  const target = pole.dataset.progress;
  if (instant || prefersReducedMotion()) {
    const bar = pole.querySelector('.pole__bar');
    if (bar) bar.style.transition = 'none';
    pole.style.setProperty('--progress', target);
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => pole.style.setProperty('--progress', target)));
}

/** Contenu d'une ligne du tableau des tarifs. */
function priceRow(service) {
  return html`
    <span class="pricelist__row">
      <span class="pricelist__name">${service.name}</span>
      <span class="pricelist__dots" aria-hidden="true"></span>
      <span class="pricelist__price">${fmtPrice(service.priceCents)}</span>
    </span>
    <span class="pricelist__duration">${fmtDuration(service.durationMin)}</span>
    ${service.description ? html`<span class="pricelist__desc">${service.description}</span>` : ''}`;
}

/**
 * Tableau des tarifs groupé par catégorie (ordre des prestations conservé).
 * interactive : chaque ligne est un bouton data-service (lance la réservation) ;
 * sinon ardoise en lecture seule (réservation suspendue).
 */
export function pricelist(services, { interactive = true } = {}) {
  const groups = new Map();
  for (const service of services) {
    const category = String(service.category || '').trim() || 'Prestations';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(service);
  }
  return html`
    <div class="pricelist${interactive ? '' : ' pricelist--board'}">
      ${[...groups].map(([category, list]) => html`
        <h3 class="pricelist__category">${category}</h3>
        <ul class="pricelist__items">
          ${list.map((s) => html`<li>${interactive
            ? html`<button class="pricelist__item" type="button" data-service="${s.id}" data-key="${`svc:${s.id}`}">${priceRow(s)}<span class="sr-only"> — réserver</span></button>`
            : html`<div class="pricelist__item">${priceRow(s)}</div>`}</li>`)}
        </ul>`)}
    </div>`;
}

/** Bloc de chargement : poteau qui tourne + texte (lu par les lecteurs d'écran). */
export function loader(text = 'Chargement…') {
  return html`<div class="loader" role="status"><span class="spinner" aria-hidden="true"></span>${text}</div>`;
}

/** Squelette d'un écran de réservation (en-tête réel, contenu en attente). */
export function bookingSkeleton({ title, subtitle = '', step = 0, label = '', text = 'Chargement…' }) {
  return html`
    ${appbar({ title, subtitle })}
    <div class="page stack booking" aria-busy="true">
      ${step ? progress(step, label) : ''}
      <span class="skeleton skeleton--block booking__skeleton-card" aria-hidden="true"></span>
      ${loader(text)}
    </div>`;
}

/**
 * État d'erreur plein écran (chargement impossible) avec « Réessayer ».
 * withHome : propose aussi le retour à l'accueil.
 */
export function errorView(err, { withHome = true, title = 'Impossible d’afficher cette page' } = {}) {
  return html`
    <div class="page">
      <div class="empty" role="alert">
        <div class="empty__icon">${icon('alerte')}</div>
        <h1 class="empty__title" tabindex="-1" data-screen-title>${title}</h1>
        <p class="empty__text">${errorText(err)}</p>
        <div class="empty__actions">
          <button class="btn btn--primary" type="button" data-action="retry">Réessayer</button>
          ${withHome ? html`<a class="btn btn--ghost" href="#/">Retour à l’accueil</a>` : ''}
        </div>
      </div>
    </div>`;
}

/** Attribut booléen HTML (disabled, hidden…) à interpoler dans html``. */
export function flag(condition, name) {
  return condition ? raw(` ${name}`) : '';
}
