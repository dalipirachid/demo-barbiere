/**
 * Boîte à outils d'interface — sans dépendance.
 *
 *   html``            gabarit qui ÉCHAPPE toute valeur interpolée (sécurité XSS)
 *   raw(str)          HTML de confiance, explicitement non échappé
 *   render(el, tpl)   remplace le contenu d'un élément
 *   $ / $$            querySelector / querySelectorAll (→ tableau)
 *   on(...)           délégation d'événements
 *   toast(...)        message bref en bas d'écran
 *   openSheet(...)    feuille modale du bas (focus piégé, Échap, fond, bouton Retour Android)
 *   confirmDialog()   confirmation oui / non → Promise<boolean>
 *   announce(msg)     lecture par les lecteurs d'écran (aria-live)
 *   icon(name)        pictogramme SVG en trait
 *
 * Classes CSS correspondantes : css/app.css (catalogue : styleguide.html).
 */

/* ==========================================================================
   Gabarits HTML sûrs
   ========================================================================== */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
const ESCAPE_RE = /[&<>"'`]/g;

/** Échappe une valeur pour du texte HTML ou un attribut entre guillemets. */
export function escapeHtml(value) {
  return String(value).replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

/** Fragment de HTML de confiance (produit par html`` ou raw()). */
class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

/** Vrai si la valeur a été produite par html`` ou raw(). */
export function isSafeHtml(value) {
  return value instanceof SafeHtml;
}

/** Convertit une valeur interpolée en HTML : échappée sauf si déjà sûre. */
function toHtml(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(toHtml).join('');
  if (typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
    return Array.from(value, toHtml).join('');
  }
  return escapeHtml(value);
}

/**
 * Gabarit HTML. Toute interpolation est échappée par défaut ; les tableaux
 * sont aplatis ; un résultat de html`` ou raw() n'est pas ré-échappé ;
 * null / undefined / false donnent ''.
 *   html`<p class="nom">${client.firstName}</p>`
 *   html`<ul>${items.map((i) => html`<li>${i.name}</li>`)}</ul>`
 * Attention : toujours mettre les attributs entre guillemets (title="${x}"),
 * et ne jamais placer une donnée saisie dans un href sans la vérifier.
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += toHtml(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** HTML de confiance, inséré tel quel. À réserver à du contenu écrit dans le code. */
export function raw(str) {
  return new SafeHtml(str === null || str === undefined ? '' : String(str));
}

/**
 * Remplace le contenu de `el` (élément ou sélecteur) par `tpl` :
 * résultat de html``, nœud DOM, ou chaîne (alors échappée, affichée comme texte).
 */
export function render(el, tpl) {
  const target = typeof el === 'string' ? document.querySelector(el) : el;
  if (!target) return null;
  if (tpl instanceof Node) target.replaceChildren(tpl);
  else target.innerHTML = toHtml(tpl);
  return target;
}

/** Construit un DocumentFragment à partir d'un gabarit. */
export function fragment(tpl) {
  const t = document.createElement('template');
  t.innerHTML = toHtml(tpl);
  return t.content;
}

/* ==========================================================================
   Sélection et événements
   ========================================================================== */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * Délégation : `handler(event, el)` est appelé quand l'événement part d'un
 * élément correspondant à `selector` (ou d'un de ses descendants) dans `root`.
 * `this` vaut aussi l'élément trouvé. Retourne la fonction de désabonnement.
 *   on(app, 'click', '[data-action="annuler"]', (e, btn) => …)
 * Pour le focus, utiliser 'focusin' / 'focusout' (qui remontent).
 */
export function on(root, type, selector, handler, options) {
  const host = typeof root === 'string' ? document.querySelector(root) : root;
  if (!host) return () => {};
  const listener = (event) => {
    const start = event.target instanceof Element ? event.target : event.target && event.target.parentElement;
    const match = start ? start.closest(selector) : null;
    if (match && (host === document || host.contains(match))) handler.call(match, event, match);
  };
  host.addEventListener(type, listener, options);
  return () => host.removeEventListener(type, listener, options);
}

/* ==========================================================================
   Annonces pour lecteurs d'écran
   ========================================================================== */

function liveRegion(id, politeness) {
  let region = document.getElementById(id);
  if (!region) {
    region = document.createElement('div');
    region.id = id;
    region.className = 'sr-only';
    region.setAttribute('aria-live', politeness);
    region.setAttribute('aria-atomic', 'true');
    document.body.append(region);
  }
  return region;
}

const announceTimers = new Map();

/**
 * Fait lire `message` par les lecteurs d'écran (région #announcer, polie).
 * `{ assertive: true }` pour une erreur qui doit interrompre.
 */
export function announce(message, { assertive = false } = {}) {
  if (!message) return;
  const region = assertive ? liveRegion('announcer-urgent', 'assertive') : liveRegion('announcer', 'polite');
  region.textContent = '';
  clearTimeout(announceTimers.get(region));
  // Petit délai : un message identique au précédent est quand même relu.
  announceTimers.set(region, setTimeout(() => { region.textContent = String(message); }, 80));
}

/* ==========================================================================
   Pictogrammes (24 × 24, trait 1,75, bouts arrondis — même famille partout)
   ========================================================================== */

const ICONS = {
  ciseaux:
    '<circle cx="6.5" cy="6.5" r="2.75"/><circle cx="6.5" cy="17.5" r="2.75"/>' +
    '<path d="M8.6 8.3 20 17.2M8.6 15.7 20 6.8"/>',
  horloge: '<circle cx="12" cy="12" r="8.75"/><path d="M12 7.25V12l3.25 2"/>',
  telephone:
    '<path d="M5.4 3.75h2.9l1.55 4.1-2.05 1.35a10.9 10.9 0 0 0 5 5l1.35-2.05 4.1 1.55v2.9a1.9 1.9 0 0 1-2.05 1.9A15.2 15.2 0 0 1 3.5 5.8a1.9 1.9 0 0 1 1.9-2.05z"/>',
  sms:
    '<path d="M4 6.25A2.25 2.25 0 0 1 6.25 4h11.5A2.25 2.25 0 0 1 20 6.25v8a2.25 2.25 0 0 1-2.25 2.25H10.5L6 20.25V16.5h0A2 2 0 0 1 4 14.5z"/>' +
    '<path d="M8 8.75h8M8 12h5"/>',
  whatsapp:
    '<path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.85L3.6 20.4l4.15-1.08A8.5 8.5 0 1 0 12 3.5z"/>' +
    '<path d="M9.3 8.4c.25-.45.7-.55 1-.3l.95 1.5c.15.3.1.6-.15.85l-.5.5a5.4 5.4 0 0 0 2.45 2.45l.5-.5c.25-.25.55-.3.85-.15l1.5.95c.25.3.15.75-.3 1l-.5.3c-.6.35-1.35.4-2 .1a7.6 7.6 0 0 1-4.15-4.15c-.3-.65-.25-1.4.1-2z"/>',
  epingle: '<path d="M12 21.25s-6.75-6.1-6.75-11.25a6.75 6.75 0 0 1 13.5 0c0 5.15-6.75 11.25-6.75 11.25z"/><circle cx="12" cy="10" r="2.4"/>',
  calendrier:
    '<rect x="3.75" y="5" width="16.5" height="15.25" rx="2.25"/>' +
    '<path d="M3.75 9.75h16.5M8.25 3v3.75M15.75 3v3.75"/><path d="M8 13.5h.01M12 13.5h.01M16 13.5h.01M8 17h.01M12 17h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'chevron-gauche': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  'chevron-droite': '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  'chevron-bas': '<path d="M5.5 9.5 12 16l6.5-6.5"/>',
  croix: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  coche: '<path d="M5 12.75l4.5 4.5L19 7.75"/>',
  utilisateur: '<circle cx="12" cy="8.25" r="3.75"/><path d="M4.75 20.25a7.25 7.25 0 0 1 14.5 0"/>',
  reglages:
    '<path d="M4 7.5h8.5M16.75 7.5H20M4 16.5h3.25M11.5 16.5H20"/>' +
    '<circle cx="14.5" cy="7.5" r="2.1"/><circle cx="9.5" cy="16.5" r="2.1"/>',
  partage:
    '<path d="M12 3.75v10.5M8.25 7.25 12 3.5l3.75 3.75"/>' +
    '<path d="M8 10.25H6.75a1.75 1.75 0 0 0-1.75 1.75v6.5a1.75 1.75 0 0 0 1.75 1.75h10.5A1.75 1.75 0 0 0 19 18.5V12a1.75 1.75 0 0 0-1.75-1.75H16"/>',
  recherche: '<circle cx="10.75" cy="10.75" r="6.25"/><path d="M15.4 15.4 20 20"/>',
  poubelle:
    '<path d="M4.5 7h15M9.5 7V4.75h5V7"/>' +
    '<path d="M6.5 7l.95 12.1a1.6 1.6 0 0 0 1.6 1.4h5.9a1.6 1.6 0 0 0 1.6-1.4L17.5 7M10.25 11v5.5M13.75 11v5.5"/>',
  cadenas: '<rect x="5" y="10.5" width="14" height="10" rx="2.25"/><path d="M8.25 10.5V7.75a3.75 3.75 0 0 1 7.5 0v2.75M12 14.5v2.25"/>',
  info: '<circle cx="12" cy="12" r="8.75"/><path d="M12 11v5.25M12 7.75h.01"/>',
  alerte:
    '<path d="M10.3 4.6a1.95 1.95 0 0 1 3.4 0l7.15 12.55a1.95 1.95 0 0 1-1.7 2.9H4.85a1.95 1.95 0 0 1-1.7-2.9z"/>' +
    '<path d="M12 9.5v4.25M12 16.75h.01"/>',
  crayon: '<path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0 0-3l-1-1a2.1 2.1 0 0 0-3 0L4.5 15.5z"/><path d="M13.5 6.5l4 4"/>',
  deconnexion: '<path d="M10 4.5H6.75A1.75 1.75 0 0 0 5 6.25v11.5a1.75 1.75 0 0 0 1.75 1.75H10M15 8l4 4-4 4M19 12h-9"/>',
  installer: '<rect x="6.5" y="2.75" width="11" height="18.5" rx="2.25"/><path d="M12 7v6.5M9.25 11 12 13.75 14.75 11M10.5 18h3"/>',
  'ecran-accueil': '<rect x="4" y="4" width="16" height="16" rx="3.25"/><path d="M12 8.5v7M8.5 12h7"/>',
  instagram: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><circle cx="12" cy="12" r="3.6"/><path d="M16.6 7.4h.01"/>',
};

/** Noms des pictogrammes disponibles. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * Pictogramme SVG en trait, décoratif (aria-hidden) par défaut.
 *   icon('telephone')                       → décoratif
 *   icon('poubelle', { label: 'Supprimer' }) → role="img" + aria-label
 * Retourne un fragment sûr, à interpoler dans html``.
 */
export function icon(name, { label = '', className = '' } = {}) {
  const body = ICONS[name];
  if (!body) {
    console.warn(`icon() : pictogramme inconnu « ${name} »`);
    return raw('');
  }
  const cls = `icon icon--${name}${className ? ' ' + escapeHtml(className) : ''}`;
  const a11y = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true"';
  return raw(
    `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false" ${a11y}>${body}</svg>`,
  );
}

/* ==========================================================================
   Toasts
   ========================================================================== */

const MAX_TOASTS = 3;

function toastHost() {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.className = 'toasts';
    document.body.append(host);
  }
  host.classList.add('toasts');
  return host;
}

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Affiche un message bref en bas d'écran (lu par les lecteurs d'écran).
 *   toast('Rendez-vous annulé.', { type: 'success' })
 *   toast('Créneau supprimé.', { action: { label: 'Annuler', onClick: restaurer } })
 * Options : type 'info' | 'success' | 'error' ; action { label, onClick } ;
 * duration en ms (0 = reste affiché, avec une croix de fermeture).
 * Retourne { close, el }.
 */
export function toast(message, { type = 'info', action = null, duration } = {}) {
  const host = toastHost();
  const ms = duration ?? (action ? 8000 : type === 'error' ? 6500 : 4000);
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = toHtml(html`
    <p class="toast__msg">${message}</p>
    ${action ? html`<button type="button" class="toast__action">${action.label}</button>` : ''}
    ${ms === 0 ? html`<button type="button" class="icon-btn icon-btn--sm toast__close" aria-label="Fermer le message">${icon('croix')}</button>` : ''}
  `);
  host.append(el);
  while (host.children.length > MAX_TOASTS) host.firstElementChild.remove();

  announce(String(message), { assertive: type === 'error' });

  let timer = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (prefersReducedMotion()) { el.remove(); return; }
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  const arm = () => {
    clearTimeout(timer);
    if (ms > 0 && !closed) timer = setTimeout(close, ms);
  };
  const pause = () => clearTimeout(timer);

  arm();
  // Pas de disparition pendant que le doigt, la souris ou le focus sont dessus.
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', arm);

  if (action) {
    el.querySelector('.toast__action').addEventListener('click', () => {
      try { if (typeof action.onClick === 'function') action.onClick(); } finally { close(); }
    });
  }
  const closeBtn = el.querySelector('.toast__close');
  if (closeBtn) closeBtn.addEventListener('click', close);

  return { close, el };
}

/* ==========================================================================
   Feuilles modales (bottom sheets)
   --------------------------------------------------------------------------
   Bouton Retour Android : à l'ouverture, une entrée d'historique est ajoutée
   (history.pushState, MÊME URL, donc aucun « hashchange »). Un appui sur
   Retour la consomme et ferme la feuille. Une fermeture par bouton / Échap /
   fond ne recule pas dans l'historique (ce qui pourrait annuler une navigation
   lancée juste après) : l'entrée est marquée « morte » et le prochain appui
   sur Retour la saute. Les événements popstate liés aux feuilles sont arrêtés
   ici (écouteur en capture posé au chargement du module) : le routeur, qui
   écoute « hashchange », n'en voit rien. Une navigation par hash pendant
   qu'une feuille est ouverte la ferme (sans consulter beforeClose).
   Une feuille ouverte alors que l'entrée courante est morte la réutilise
   (replaceState) : les entrées mortes ne s'empilent pas. S'il en reste
   plusieurs (confirmation par-dessus une feuille), un Retour depuis l'écran
   les saute toutes et quitte bien l'écran, en un seul appui.
   ========================================================================== */

const SHEET_KEY = 'barbiereSheet';
const DEAD_KEY = 'barbiereSheetClosed';
const sheetStack = [];
let sheetSeq = 0;

function isDeadState(state) {
  if (!state || typeof state !== 'object') return false;
  if (state[DEAD_KEY]) return true;
  return Boolean(state[SHEET_KEY]) && !sheetStack.some((s) => s.id === state[SHEET_KEY]);
}

function baseState() {
  const state = history.state && typeof history.state === 'object' ? { ...history.state } : {};
  delete state[SHEET_KEY];
  delete state[DEAD_KEY];
  return state;
}

// Vrai quand l'entrée d'historique courante appartient à une feuille déjà fermée.
let deadIsCurrent = typeof history !== 'undefined' ? isDeadState(history.state) : false;
// Adresse de cette entrée morte : une feuille partage l'adresse de son écran.
let deadHref = deadIsCurrent ? location.href : '';
// Saut en cours (history.back() lancé ici) : { leave, at }. leave = adresse de
// l'écran à quitter (Retour depuis cet écran) ; '' = sauter seulement les entrées mortes.
let skipping = null;
const SKIP_MS = 1500;        // au-delà, un saut sans réponse (début d'historique) est oublié

function skipBack(event, leave = '') {
  event.stopImmediatePropagation();
  skipping = { leave, at: Date.now() };
  history.back();
}

/** Entrée d'historique d'une feuille : réutilise l'entrée courante si elle est morte. */
function pushSheetEntry(id) {
  const state = { ...baseState(), [SHEET_KEY]: id };
  if (deadIsCurrent && isDeadState(history.state)) history.replaceState(state, '');
  else history.pushState(state, '');
  deadIsCurrent = false;
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (event) => {
    const state = event.state && typeof event.state === 'object' ? event.state : {};
    const wasDead = deadIsCurrent;
    const leftHref = deadHref;
    deadIsCurrent = isDeadState(state);
    if (deadIsCurrent) deadHref = location.href;
    const top = sheetStack[sheetStack.length - 1];
    const skip = skipping && Date.now() - skipping.at < SKIP_MS ? skipping : null;
    skipping = null;

    if (top) {
      event.stopImmediatePropagation();
      if (location.href !== top.href) {
        // Adresse différente : navigation par hash (Chrome émet aussi popstate), pas un
        // Retour. On ferme tout sans demander ; « hashchange » suit et affiche l'écran.
        for (let i = sheetStack.length - 1; i >= 0; i--) sheetStack[i].close({ fromHistory: true, reason: 'navigation' });
        return;
      }
      if (state[SHEET_KEY] !== top.id) top.request('back', { fromHistory: true });
      else if (wasDead) top.request('back'); // on quitte une entrée morte : ce Retour ferme la feuille
      return;
    }
    if (skip) {
      // Fin d'un saut lancé ici : on continue tant qu'on est sur une entrée morte,
      // ou encore sur l'écran qu'on voulait quitter.
      if (deadIsCurrent || (skip.leave && location.href === skip.leave)) skipBack(event, skip.leave);
      else event.stopImmediatePropagation();
      return;
    }
    // Retour depuis l'entrée morte courante : l'adresse n'a pas changé, donc
    // l'écran non plus → on recule jusqu'à quitter cet écran. Une adresse différente
    // signale au contraire une navigation par hash (Chrome émet aussi popstate) : on la laisse.
    if (wasDead && location.href === leftHref) { skipBack(event, leftHref); return; }
    // Retour depuis un autre écran qui ARRIVE sur l'entrée d'une feuille fermée :
    // on la saute (la navigation « avant », rare sur téléphone, n'est pas distinguée).
    if (deadIsCurrent) skipBack(event);
  }, true);

  window.addEventListener('hashchange', () => {
    deadIsCurrent = isDeadState(history.state);
    if (deadIsCurrent) deadHref = location.href;
    // Navigation pendant qu'une feuille est ouverte : on ferme tout.
    for (let i = sheetStack.length - 1; i >= 0; i--) sheetStack[i].close({ fromHistory: true, reason: 'navigation' });
  });
}

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'summary',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusablesIn(container) {
  return $$(FOCUSABLE, container).filter((el) => !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
}

/** Rend inertes les autres enfants de <body> (sauf toasts et régions live). */
function makeBackgroundInert(layer) {
  const changed = [];
  for (const child of document.body.children) {
    if (child === layer || child.id === 'toasts' || child.id === 'announcer' || child.id === 'announcer-urgent'
        || child.hasAttribute('aria-live') || child.tagName === 'SCRIPT' || child.tagName === 'TEMPLATE') continue;
    if (!child.inert) {
      child.inert = true;
      changed.push(child);
    }
  }
  return () => changed.forEach((el) => { el.inert = false; });
}

function appendContent(container, content) {
  if (content === null || content === undefined || content === false) return;
  if (content instanceof Node) container.append(content);
  else container.innerHTML = toHtml(content);
}

/**
 * Ouvre une feuille modale du bas.
 *   const { close, el } = openSheet({
 *     title: 'Rendez-vous',
 *     content: html`<p>…</p>`,             // html``, nœud DOM ou texte
 *     actions: [
 *       { label: 'Fermer', variant: 'ghost' },
 *       { label: 'Annuler le RDV', variant: 'danger', onClick: async () => { await …; } },
 *       { label: 'Appeler', variant: 'primary', href: 'tel:+33…', icon: 'telephone' },
 *     ],
 *     onClose: (reason) => {},               // 'action' | 'dismiss' | 'escape' | 'back' | 'navigation' | 'close'
 *   });
 * Action : { label, variant = 'primary' ('primary'|'accent'|'ghost'|'danger'|''),
 *   onClick(event, sheet), href, icon, autofocus, close = true }.
 * onClick peut renvoyer false (la feuille reste ouverte) ou une promesse :
 * le bouton passe en [aria-busy] jusqu'à sa résolution ; si elle échoue ou
 * renvoie false, la feuille reste ouverte.
 * `actions` peut aussi être un fragment html`` libre.
 * Autres options : role ('dialog' par défaut, 'alertdialog'), className, dismissible (true),
 * beforeClose(reason) (facultatif) : consulté avant une fermeture demandée par
 * l'utilisatrice ('dismiss' : fond ou croix, 'escape', 'back') ; renvoyer false, ou une
 * promesse de false (ex. confirmDialog), garde la feuille ouverte (après un Retour, son
 * entrée d'historique est remise). Les fermetures par action, par programme (close())
 * ou par navigation ne le consultent pas.
 * Retourne { close, el (le panneau), body, root }.
 */
export function openSheet({
  title = '', content = '', actions = [], onClose, role = 'dialog', className = '', dismissible = true,
  beforeClose = null,
} = {}) {
  const id = `f${Date.now().toString(36)}${(++sheetSeq).toString(36)}`;
  const titleId = `${id}-titre`;
  const previousFocus = document.activeElement;

  const root = document.createElement('div');
  root.className = `sheet${className ? ' ' + className : ''}`;
  root.innerHTML = toHtml(html`
    <div class="sheet__backdrop" ${dismissible ? raw('data-sheet-dismiss') : ''}></div>
    <section class="sheet__panel" role="${role}" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1">
      <div class="sheet__handle" aria-hidden="true"></div>
      <header class="sheet__header">
        <h2 class="sheet__title" id="${titleId}">${title}</h2>
        ${dismissible ? html`<button type="button" class="icon-btn sheet__close" data-sheet-dismiss aria-label="Fermer">${icon('croix')}</button>` : ''}
      </header>
      <div class="sheet__body"></div>
      <footer class="sheet__actions"></footer>
    </section>
  `);
  const panel = root.querySelector('.sheet__panel');
  const body = root.querySelector('.sheet__body');
  const footer = root.querySelector('.sheet__actions');
  appendContent(body, content);

  let closed = false;
  let restoreInert = () => {};

  const api = { close: (reason) => close({ reason: reason || 'close' }), el: panel, body, root };
  const entry = { id, href: location.href, close, request: requestClose };

  // — Boutons d'action —
  let autofocusEl = null;
  if (Array.isArray(actions) && actions.length) {
    for (const action of actions) {
      const variant = action.variant === undefined ? 'primary' : action.variant;
      const el = document.createElement(action.href ? 'a' : 'button');
      el.className = `btn${variant ? ' btn--' + variant : ''}`;
      if (action.href) el.href = action.href;
      else el.type = 'button';
      el.innerHTML = toHtml(html`${action.icon ? icon(action.icon) : ''}<span>${action.label}</span>`);
      if (action.autofocus) autofocusEl = el;
      el.addEventListener('click', (event) => runAction(event, action, el));
      footer.append(el);
    }
  } else if (actions && !Array.isArray(actions)) {
    appendContent(footer, actions);
  } else {
    footer.hidden = true;
  }

  async function runAction(event, action, button) {
    let result;
    try {
      result = typeof action.onClick === 'function' ? action.onClick(event, api) : undefined;
    } catch (err) {
      console.error(err);
      return;
    }
    if (result && typeof result.then === 'function') {
      const buttons = $$('.btn', footer);
      button.setAttribute('aria-busy', 'true');
      buttons.forEach((b) => b.setAttribute('aria-disabled', 'true'));
      try {
        result = await result;
      } catch (err) {
        console.error(err);
        result = false;
      } finally {
        button.removeAttribute('aria-busy');
        buttons.forEach((b) => b.removeAttribute('aria-disabled'));
      }
    }
    if (result !== false && action.close !== false && !action.href) close({ reason: 'action' });
  }

  // — Fermeture —
  function close({ fromHistory = false, reason = 'close' } = {}) {
    if (closed) return;
    closed = true;
    const index = sheetStack.indexOf(entry);
    if (index >= 0) sheetStack.splice(index, 1);

    // L'entrée d'historique de cette feuille est-elle la courante ? → on la marque morte.
    if (!fromHistory && history.state && history.state[SHEET_KEY] === id) {
      try {
        history.replaceState({ ...baseState(), [DEAD_KEY]: true }, '');
        deadIsCurrent = true;
        deadHref = location.href;
      } catch { /* historique indisponible : sans conséquence */ }
    }

    restoreInert();
    if (!sheetStack.length) document.documentElement.classList.remove('has-sheet');
    document.removeEventListener('keydown', onKeydown, true);

    const remove = () => root.remove();
    if (prefersReducedMotion()) remove();
    else {
      root.classList.add('is-closing');
      setTimeout(remove, 240);
    }

    if (previousFocus && typeof previousFocus.focus === 'function' && document.contains(previousFocus)) {
      previousFocus.focus({ preventScroll: true });
    }
    if (typeof onClose === 'function') {
      try { onClose(reason); } catch (err) { console.error(err); }
    }
  }

  // — Fermeture demandée par l'utilisatrice : beforeClose peut la refuser —
  let asking = false;        // réponse de beforeClose attendue (confirmation ouverte…)
  let entryGone = false;     // un Retour a déjà consommé l'entrée d'historique de la feuille

  function requestClose(reason, { fromHistory = false } = {}) {
    if (closed) return;
    if (typeof beforeClose !== 'function') {
      close({ fromHistory, reason });
      return;
    }
    if (fromHistory) entryGone = true;
    if (asking) return;
    const settle = (ok) => {
      asking = false;
      if (closed) return;
      if (ok !== false) {
        close({ fromHistory: entryGone, reason });
        return;
      }
      // La feuille reste ouverte : on lui rend son entrée d'historique (Retour la refermera).
      if (entryGone) {
        try {
          pushSheetEntry(id);
        } catch { /* historique indisponible */ }
        entryGone = false;
      }
    };
    let verdict;
    try {
      verdict = beforeClose(reason);
    } catch (err) {
      console.error(err);
      verdict = true;
    }
    if (verdict && typeof verdict.then === 'function') {
      asking = true;
      verdict.then(settle, (err) => { console.error(err); settle(false); });
    } else {
      settle(verdict);
    }
  }

  // — Clavier : Échap et piège à focus (uniquement pour la feuille du dessus) —
  function onKeydown(event) {
    if (sheetStack[sheetStack.length - 1] !== entry) return;
    if (event.key === 'Escape' && dismissible) {
      event.preventDefault();
      requestClose('escape');
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusablesIn(panel);
    if (!items.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-sheet-dismiss]') : null;
    if (target && root.contains(target)) requestClose('dismiss');
  });

  // — Ouverture —
  document.body.append(root);
  restoreInert = makeBackgroundInert(root);
  document.documentElement.classList.add('has-sheet');
  document.addEventListener('keydown', onKeydown, true);
  sheetStack.push(entry);
  try {
    pushSheetEntry(id);
  } catch { /* historique indisponible : le bouton Retour ne fermera pas la feuille */ }

  const firstField = panel.querySelector('[autofocus]');
  // Le titre est lu à la prise de focus (role="dialog" + aria-labelledby).
  (autofocusEl || firstField || panel).focus({ preventScroll: true });

  return api;
}

/**
 * Demande de confirmation dans une feuille. Résout true (confirmé) ou false.
 *   if (await confirmDialog({ title: 'Annuler ce rendez-vous ?', danger: true,
 *                             confirmLabel: 'Oui, annuler', cancelLabel: 'Non, garder' })) …
 */
export function confirmDialog({
  title = 'Confirmer', message = '', confirmLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false,
} = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };
    openSheet({
      title,
      role: 'alertdialog',
      className: 'sheet--confirm',
      content: message ? html`<p class="sheet__message">${message}</p>` : '',
      actions: [
        { label: cancelLabel, variant: 'ghost', autofocus: danger, onClick: () => answer(false) },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', autofocus: !danger, onClick: () => answer(true) },
      ],
      onClose: () => answer(false),
    });
  });
}
