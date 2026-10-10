/**
 * Espace barbière — outils partagés par tous les écrans.
 *
 *   store, loadSalon(), cachedSalon(), tzOf()      données
 *   nav                                             navigation (rempli par main.js)
 *   fullName(), shortName(), initials()             noms des clients
 *   telHref(), smsHref(), waHref()                  liens de contact
 *   reminderText(), excuseText(), movedText()       SMS pré-remplis
 *   showError(), proMessage()                       erreurs en français
 *   textField(), setFieldErrors()                   formulaires
 *   formSnapshot(), confirmDiscard()                saisie non enregistrée
 *   salonName(), copyBookingLink(), shareBookingLink()  nom du salon, lien de réservation
 */

import { getStore } from '../data/store.js';
import { errorMessage, isBookingError } from '../core/errors.js';
import {
  DEFAULT_TZ, zonedParts, fmtTime, fmtDayLong, fmtRelativeDay, fmtDuration, parseYMD,
} from '../core/dates.js';
import { fmtPhone } from '../core/validate.js';
import { displayName } from '../core/setup.js';
import { html, icon, toast, confirmDialog } from '../ui/dom.js';

/* ==========================================================================
   Données
   ========================================================================== */

export const store = getStore();
export const isRemote = store.mode === 'remote';

let salonCache = null;

/** Relit le salon (horaires, nom, réglages) et le garde en mémoire. */
export async function loadSalon() {
  salonCache = await store.getSalon();
  return salonCache;
}

/** Dernier salon lu (peut être null avant le premier chargement). */
export function cachedSalon() {
  return salonCache;
}

/** Fuseau du salon. */
export function tzOf(salon) {
  return (salon && salon.timezone) || DEFAULT_TZ;
}

/** Jour 'YYYY-MM-DD' d'un instant, dans le fuseau du salon. */
export function ymdOf(iso, tz) {
  return zonedParts(iso, tz).ymd;
}

/** Minutes depuis minuit (heure murale du salon) d'un instant. */
export function minutesOfDay(iso, tz) {
  return zonedParts(iso, tz).minutes;
}

/** 'YYYY-MM-DD' existant (refuse 2026-02-31). */
export function isValidYMD(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = parseYMD(value);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/* ==========================================================================
   Navigation (les fonctions sont branchées par main.js)
   ========================================================================== */

export const nav = {
  /**
   * Va vers une route ('#/agenda/2026-10-07'). replace : sans nouvelle entrée d'historique.
   *
   * Contournement de js/ui/dom.js : une navigation de fragment (location.hash = …,
   * location.replace, clic sur un lien #/…) déclenche un « popstate » ; si une
   * feuille vient d'être fermée par un bouton, dom.js le prend pour un appui sur
   * Retour et appelle history.back(), ce qui annule la navigation. On change donc
   * l'adresse avec pushState / replaceState (aucun popstate), puis on émet
   * « hashchange » : dom.js ferme les feuilles et oublie l'entrée fermée, le
   * routeur affiche l'écran.
   */
  go(hash, { replace = false } = {}) {
    if (location.hash === hash) {
      nav.reload();
      return;
    }
    const oldURL = location.href;
    try {
      if (replace) history.replaceState(null, '', hash);
      else history.pushState(null, '', hash);
    } catch {
      if (replace) location.replace(hash);
      else location.hash = hash;
      return;
    }
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
  },
  reload() {},
  refreshBadge() {},
  authLost() {},
  /** Ouvre un RDV après le prochain affichage de l'agenda (id). */
  pendingOpen: null,
};

/** Hash de l'agenda d'un jour (« aujourd'hui » si ymd est vide). */
export function agendaHash(ymd) {
  return ymd ? `#/agenda/${ymd}` : '#/agenda';
}

/** Va sur l'agenda d'un jour : sans entrée d'historique si on y est déjà. */
export function goToAgenda(ymd) {
  nav.go(agendaHash(ymd), { replace: location.hash.startsWith('#/agenda') });
}

/* ==========================================================================
   Stockage local (navigation privée : jamais d'exception)
   ========================================================================== */

export const LASTSEEN_KEY = 'barbiere-pro-lastseen';

export function readLS(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeLS(key, value) {
  try { localStorage.setItem(key, value); } catch { /* stockage indisponible */ }
}

/** Lecture de sessionStorage (null si indisponible). */
export function readSS(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

export function writeSS(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* stockage indisponible */ }
}

/* ==========================================================================
   Textes et formats
   ========================================================================== */

export const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

/** 'true' / 'false' pour les attributs ARIA (html`` efface la valeur false). */
export const bool = (v) => (v ? 'true' : 'false');

/** « Karim Benali » (prénom seul pour un client de passage). */
export function fullName(c) {
  if (!c) return 'Client supprimé';
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Client';
}

/** « Karim B. » — lisible dans les petites cases de l'agenda. */
export function shortName(c) {
  if (!c) return 'Client supprimé';
  const last = c.lastName ? ` ${c.lastName.charAt(0).toUpperCase()}.` : '';
  return `${c.firstName || 'Client'}${last}`;
}

/** Initiales pour l'avatar. */
export function initials(c) {
  if (!c) return '?';
  const a = (c.firstName || '?').charAt(0);
  const b = (c.lastName || '').charAt(0);
  return (a + b).toUpperCase();
}

/** 1re, 2e, 3e… */
export function ordinal(n) {
  return n === 1 ? '1re' : `${n}e`;
}

/** « 1 lapin », « 2 lapins » ; « 1 visite », « 3 visites » */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n > 1 ? many : one}`;
}

/** 'mardi 7 octobre' → 'Mardi 7 octobre' */
export function dayTitle(ymd) {
  return capitalize(fmtDayLong(ymd));
}

/** Délai avant un instant : « dans 25 min », « dans 1 h 15 », « maintenant ». */
export function fmtIn(ms) {
  const min = Math.round(ms / 60000);
  if (min <= 0) return 'maintenant';
  if (min < 60) return `dans ${min} min`;
  return `dans ${fmtDuration(min)}`;
}

/** « aujourd'hui », « demain » ou « le mardi 7 octobre » (dans une phrase). */
export function whenPhrase(iso, tz, now = new Date()) {
  const rel = fmtRelativeDay(ymdOf(iso, tz), tz, now);
  return rel === "aujourd'hui" || rel === 'demain' ? rel : `le ${rel}`;
}

/** Libellé d'un statut. */
export const STATUS_LABELS = {
  confirmed: 'Confirmé',
  done: 'Honoré',
  no_show: 'Lapin',
  cancelled: 'Annulé',
};

const STATUS_BADGE = {
  confirmed: 'badge',
  done: 'badge badge--done',
  no_show: 'badge badge--noshow',
  cancelled: 'badge badge--cancelled',
};

export function statusBadge(status) {
  return html`<span class="${STATUS_BADGE[status] || 'badge'}">${STATUS_LABELS[status] || status}</span>`;
}

/* ==========================================================================
   Liens de contact et SMS pré-remplis
   ========================================================================== */

const cleanPhone = (phone) => String(phone || '').replace(/[^\d+]/g, '');

export function telHref(phone) {
  return `tel:${cleanPhone(phone)}`;
}

/** sms:<num>?&body=… — forme acceptée à la fois par iOS et Android. */
export function smsHref(phone, body = '') {
  return `sms:${cleanPhone(phone)}${body ? `?&body=${encodeURIComponent(body)}` : ''}`;
}

/** https://wa.me/<numéro sans +>?text=… */
export function waHref(phone, body = '') {
  const digits = cleanPhone(phone).replace(/\D/g, '');
  return `https://wa.me/${digits}${body ? `?text=${encodeURIComponent(body)}` : ''}`;
}

/**
 * Nom du salon pour un titre ou un message, ou `fallback` tant que la barbière
 * ne l'a pas choisi (jamais le marqueur « [À COMPLÉTER] », §8 bis).
 */
export function salonName(salon, fallback = '') {
  return displayName(salon) || fallback;
}

/** Adresse absolue de la page de réservation des clients. */
export function bookingUrl() {
  return new URL('../', location.href).href;
}

/**
 * Copie le lien de réservation. Presse-papiers indisponible : le texte du champ
 * `input` (lecture seule, facultatif) est sélectionné pour un appui long.
 */
export async function copyBookingLink(input = null) {
  const url = bookingUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast('Lien copié : collez-le où vous voulez.', { type: 'success' });
    return;
  } catch { /* presse-papiers indisponible : repli ci-dessous */ }
  let ok = false;
  if (input) {
    input.focus();
    input.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
  }
  toast(ok ? 'Lien copié.' : 'Le lien est sélectionné : copiez-le avec un appui long.', { type: ok ? 'success' : 'info' });
}

/** Partage du lien de réservation (feuille de partage du téléphone). */
export async function shareBookingLink(salon) {
  try {
    await navigator.share({ title: salonName(salon, 'Prendre rendez-vous'), text: 'Prenez rendez-vous en ligne :', url: bookingUrl() });
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('Partage impossible sur cet appareil. Copiez plutôt le lien.', { type: 'error' });
  }
}

/** Le téléphone sait-il ouvrir sa feuille de partage ? */
export const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

// Nom du salon encore à choisir : les messages s'en passent plutôt que d'envoyer le marqueur.
const chez = (salon) => (displayName(salon) ? ` chez ${displayName(salon)}` : '');

/** SMS de rappel d'un RDV. */
export function reminderText(appt, salon, now = new Date()) {
  const tz = tzOf(salon);
  const first = (appt.client && appt.client.firstName) || '';
  let text = `Bonjour ${first}, petit rappel : rendez-vous ${whenPhrase(appt.start, tz, now)} à ${fmtTime(appt.start, tz)}${chez(salon)} (${appt.serviceName}).`;
  if (salon.phone) text += ` En cas d'empêchement, merci de prévenir au ${fmtPhone(salon.phone)}.`;
  return `${text} À bientôt !`;
}

/** SMS d'excuse après une annulation par la barbière. */
export function excuseText(appt, salon, now = new Date()) {
  const tz = tzOf(salon);
  const first = (appt.client && appt.client.firstName) || '';
  let text = `Bonjour ${first}, je suis désolée : je dois annuler votre rendez-vous ${whenPhrase(appt.start, tz, now)} à ${fmtTime(appt.start, tz)} (${appt.serviceName}).`;
  text += salon.bookingEnabled
    ? ` Vous pouvez reprendre rendez-vous en ligne (${bookingUrl()}) ou me répondre ici pour trouver un autre créneau.`
    : ' Répondez-moi ici pour trouver un autre créneau.';
  return `${text} Encore pardon, à bientôt !${displayName(salon) ? ` ${displayName(salon)}` : ''}`;
}

/** SMS pour prévenir d'un changement d'horaire. */
export function movedText(appt, salon, now = new Date()) {
  const tz = tzOf(salon);
  const first = (appt.client && appt.client.firstName) || '';
  let text = `Bonjour ${first}, votre rendez-vous${chez(salon)} (${appt.serviceName}) est déplacé ${whenPhrase(appt.start, tz, now)} à ${fmtTime(appt.start, tz)}.`;
  if (salon.phone) text += ` Si cet horaire ne vous convient pas, prévenez-moi au ${fmtPhone(salon.phone)}.`;
  return `${text} À bientôt !`;
}

/** Message simple (fiche client sans RDV à venir). */
export function helloText(client) {
  return `Bonjour ${(client && client.firstName) || ''}, `;
}

/**
 * Rangée de boutons de contact (Appeler / SMS / WhatsApp).
 * Rien si le client n'a pas de téléphone.
 */
export function contactButtons(phone, body, { size = '' } = {}) {
  if (!phone) return '';
  const sz = size ? ` btn--${size}` : '';
  return html`
    <div class="pro-contact">
      <a class="btn btn--primary${sz}" href="${telHref(phone)}">${icon('telephone')}<span>Appeler</span></a>
      <a class="btn${sz}" href="${smsHref(phone, body)}">${icon('sms')}<span>SMS</span></a>
      <a class="btn${sz}" href="${waHref(phone, body)}" target="_blank" rel="noopener">${icon('whatsapp')}<span>WhatsApp</span></a>
    </div>`;
}

/* ==========================================================================
   Erreurs
   ========================================================================== */

/** Message adapté à l'espace barbière (plus précis que celui des clients). */
export function proMessage(err) {
  const code = err && err.code;
  if (code === 'SLOT_TAKEN') return 'Ce créneau chevauche un autre rendez-vous. Choisissez une autre heure.';
  if (code === 'NOT_FOUND') return 'Cet élément n’existe plus : il a peut-être été supprimé entre-temps.';
  if (code === 'INVALID' && err.details && err.details.errors) {
    const first = Object.values(err.details.errors)[0];
    if (first) return first;
  }
  return errorMessage(err);
}

/** Affiche une erreur dans un toast ; session expirée → écran de connexion. */
export function showError(err, fallback) {
  if (err && err.code === 'AUTH' && isRemote) {
    nav.authLost();
    return;
  }
  if (!isBookingError(err)) console.error(err);
  toast(fallback || proMessage(err), { type: 'error' });
}

/* ==========================================================================
   Formulaires
   ========================================================================== */

let idSeq = 0;
/** Identifiant unique pour relier labels, aides et erreurs. */
export const uid = (prefix = 'pro') => `${prefix}-${++idSeq}`;

/**
 * Champ texte étiqueté (.field) avec zone d'erreur reliée.
 * name sert aussi de clé pour setFieldErrors().
 */
export function textField({
  name, label, value = '', type = 'text', optional = false, hint = '',
  autocomplete = '', inputmode = '', placeholder = '', maxlength = '', multiline = false, required = false,
}) {
  const id = uid(name);
  const describedBy = [hint ? `${id}-aide` : '', `${id}-err`].filter(Boolean).join(' ');
  const attrs = html`${autocomplete ? html` autocomplete="${autocomplete}"` : ''}${inputmode ? html` inputmode="${inputmode}"` : ''}${placeholder ? html` placeholder="${placeholder}"` : ''}${maxlength ? html` maxlength="${maxlength}"` : ''}${required ? html` required` : ''}`;
  return html`
    <div class="field" data-field="${name}">
      <label class="field__label" for="${id}">${label}${optional ? html` <span class="field__optional">(facultatif)</span>` : ''}</label>
      ${multiline
        ? html`<textarea class="field__textarea" id="${id}" name="${name}" aria-describedby="${describedBy}"${attrs}>${value}</textarea>`
        : html`<input class="field__input" id="${id}" name="${name}" type="${type}" value="${value}" aria-describedby="${describedBy}"${attrs}>`}
      ${hint ? html`<p class="field__hint" id="${id}-aide">${hint}</p>` : ''}
      <p class="field__error" id="${id}-err"></p>
    </div>`;
}

/**
 * Affiche les erreurs par champ ({ phone: 'message' }) dans un conteneur.
 * Retourne true s'il y a au moins une erreur (et place le focus dessus).
 */
export function setFieldErrors(root, errors = {}, { focus = true } = {}) {
  let first = null;
  for (const field of root.querySelectorAll('[data-field]')) {
    const msg = errors[field.dataset.field] || '';
    const input = field.querySelector('input, select, textarea');
    const out = field.querySelector('.field__error');
    if (input) {
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    if (out) out.textContent = msg;
    if (msg && !first) first = input;
  }
  if (first && focus) first.focus();
  return Boolean(first);
}

/** Valeur d'un champ nommé dans un conteneur. */
export function fieldValue(root, name) {
  const el = root.querySelector(`[name="${name}"]`);
  if (!el) return '';
  if (el.type === 'checkbox') return el.checked;
  return el.value;
}

/**
 * État d'un formulaire (valeurs des champs et pastilles aria-pressed), à comparer
 * avec celui de l'ouverture pour savoir si quelque chose a été saisi.
 */
export function formSnapshot(root) {
  if (!root) return '';
  const fields = [...root.querySelectorAll('input, textarea, select')]
    .map((el) => (el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value));
  const chips = [...root.querySelectorAll('[aria-pressed]')].map((el) => el.getAttribute('aria-pressed'));
  return JSON.stringify([fields, chips]);
}

/**
 * Garde-fou d'une feuille de saisie (option beforeClose d'openSheet, ou action « Fermer ») :
 * sans saisie, la feuille se ferme ; sinon on demande avant de perdre ce qui a été tapé.
 * → () => true | Promise<boolean>
 */
export function confirmDiscard(isDirty) {
  return () => (isDirty() ? confirmDialog({
    title: 'Abandonner la saisie ?',
    message: 'Ce que vous avez saisi n’est pas enregistré et sera perdu.',
    confirmLabel: 'Abandonner',
    cancelLabel: 'Continuer la saisie',
    danger: true,
  }) : true);
}

/** Bloc de chargement (petit poteau qui tourne). */
export function loaderHtml(text = 'Chargement…') {
  return html`<div class="loader" role="status"><span class="spinner" aria-hidden="true"></span>${text}</div>`;
}

/** Fonction différée (recherche au fil de la frappe). */
export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Prix saisi en euros ('22', '22,50', '22.5 €') → centimes, ou null. */
export function parsePrice(text) {
  const s = String(text ?? '').replace(/[\s €]/g, '').replace(',', '.');
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Centimes → texte modifiable ('22' ou '22,50'). */
export function priceInput(cents) {
  const n = Math.round(Number(cents) || 0);
  return n % 100 ? `${Math.floor(n / 100)},${String(n % 100).padStart(2, '0')}` : String(n / 100);
}

/** Téléphone affichable (vide si absent). */
export const phoneText = (p) => fmtPhone(p || '');
