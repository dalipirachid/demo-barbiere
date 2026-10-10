/**
 * Espace barbière — point d'entrée (app/pro/index.html).
 *
 * Routes (hash) : #/agenda[/<ymd>] · #/clients · #/clients/<id> · #/reglages
 * · #/bienvenue[/<étape>] (assistant de configuration, sans barre d'onglets).
 * Première ouverture de la session : si le salon reste à configurer (needsSetup),
 * l'assistant s'ouvre, une fois par session (sessionStorage, §8 bis).
 * Le bouton Retour d'Android suit l'historique des routes ; les feuilles
 * ouvertes se ferment d'abord (géré par js/ui/dom.js).
 * Chaque écran est un objet { mount(el, params), update?(params), refresh(), unmount() },
 * avec isDirty?() / discard?() s'il peut contenir une saisie non enregistrée :
 * un onglet ou un lien qui quitterait l'écran demande alors confirmation.
 */

import { registerSW } from '../ui/pwa.js';
import { html, render, icon, toast, confirmDialog } from '../ui/dom.js';
import { todayYMD, dayRangeISO } from '../core/dates.js';
import { createAgendaView } from './agenda.js';
import { createClientsView, createClientView } from './clients.js';
import { createSettingsView } from './settings.js';
import { createAssistantView, ASSISTANT_SEEN_KEY, parseStep } from './assistant.js';
import { renderLogin } from './login.js';
import { needsSetup } from '../core/setup.js';
import {
  store, isRemote, nav, loadSalon, tzOf, readLS, readSS, LASTSEEN_KEY, isValidYMD, showError, loaderHtml,
} from './shared.js';

registerSW('../sw.js');

const root = document.getElementById('app');

const VIEWS = {
  agenda: createAgendaView,
  clients: createClientsView,
  client: createClientView,
  reglages: createSettingsView,
  bienvenue: createAssistantView,
};
const TAB_OF = { agenda: 'agenda', clients: 'clients', client: 'clients', reglages: 'reglages', bienvenue: '' };

let current = null;          // { name, view }
let currentHash = '';
let started = false;
let setupChecked = false;    // ouverture de l'assistant déjà décidée pour cette session de page

/* ==========================================================================
   Barre d'onglets
   ========================================================================== */

function buildTabbar() {
  const bar = document.createElement('nav');
  bar.className = 'tabbar';
  bar.setAttribute('aria-label', 'Sections');
  bar.hidden = true;
  render(bar, html`
    <a class="tabbar__item" href="#/agenda" data-tab="agenda">${icon('calendrier')}<span class="tabbar__label">Agenda</span>
      <span class="tabbar__badge" aria-hidden="true" hidden></span><span class="sr-only" data-badge-sr></span></a>
    <a class="tabbar__item" href="#/clients" data-tab="clients">${icon('utilisateur')}<span class="tabbar__label">Clients</span></a>
    <a class="tabbar__item" href="#/reglages" data-tab="reglages">${icon('reglages')}<span class="tabbar__label">Réglages</span></a>`);
  document.body.insertBefore(bar, document.getElementById('announcer'));

  // Toucher l'onglet déjà ouvert : retour en haut et données fraîches.
  bar.addEventListener('click', (e) => {
    const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!link || link.getAttribute('href') !== location.hash) return;
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    nav.reload();
  });
  return bar;
}

const tabbar = buildTabbar();

function setTab(name) {
  for (const link of tabbar.querySelectorAll('[data-tab]')) {
    if (link.dataset.tab === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function setBadge(n) {
  const badge = tabbar.querySelector('.tabbar__badge');
  const sr = tabbar.querySelector('[data-badge-sr]');
  badge.hidden = !n;
  badge.textContent = n > 9 ? '9+' : String(n || '');
  sr.textContent = n ? ` (${n} nouvelle${n > 1 ? 's' : ''} réservation${n > 1 ? 's' : ''} en ligne)` : '';
}

/** Réservations en ligne créées depuis le dernier passage sur l'agenda. */
async function refreshBadge() {
  if (needsLogin()) return;
  if (current && current.name === 'agenda') {
    setBadge(0);
    return;
  }
  try {
    const salon = await loadSalon();
    const tz = tzOf(salon);
    const { from, to } = dayRangeISO(todayYMD(tz), tz, (Number(salon.maxDaysAhead) || 30) + 2);
    const list = await store.listAppointments(from, to);
    const seen = Date.parse(readLS(LASTSEEN_KEY) || '');
    const since = Number.isFinite(seen) ? seen : Date.now() - 12 * 3_600_000;
    const n = list.filter((a) => a.source === 'online' && a.status !== 'cancelled' && Date.parse(a.createdAt) > since).length;
    setBadge(current && current.name === 'agenda' ? 0 : n);
  } catch { /* le badge est un plus : pas d'erreur affichée */ }
}

/* ==========================================================================
   Routes
   ========================================================================== */

function parseRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (parts[0] === 'agenda') {
    if (parts[1] && !isValidYMD(parts[1])) return null;
    return { name: 'agenda', params: { ymd: parts[1] || null } };
  }
  if (parts[0] === 'clients') return parts[1] ? { name: 'client', params: { id: parts[1] } } : { name: 'clients', params: {} };
  if (parts[0] === 'reglages') return { name: 'reglages', params: {} };
  if (parts[0] === 'bienvenue') return { name: 'bienvenue', params: { step: parseStep(parts[1] || 1) } };
  return null;
}

function needsLogin() {
  return isRemote && !store.isLoggedIn();
}

function route() {
  if (needsLogin()) {
    showLogin();
    return;
  }
  if (!setupChecked) {
    setupChecked = true;
    openAssistantIfNeeded();
    return;
  }
  const r = parseRoute(location.hash);
  if (!r) {
    nav.go('#/agenda', { replace: true });
    return;
  }
  nav.previousHash = currentHash;
  currentHash = location.hash;
  // L'assistant est un parcours à part : ni onglets, ni badge ; il se quitte par « Plus tard ».
  tabbar.hidden = r.name === 'bienvenue';
  setTab(TAB_OF[r.name]);

  // Même écran (changement de jour de l'agenda) : mise à jour sans tout reconstruire.
  if (current && current.name === r.name && typeof current.view.update === 'function') {
    current.view.update(r.params);
    return;
  }
  if (current) current.view.unmount();
  const el = document.createElement('div');
  el.className = 'pro-view';
  root.replaceChildren(el);
  window.scrollTo(0, 0);
  const view = VIEWS[r.name]();
  current = { name: r.name, view };
  view.mount(el, r.params);
  if (started) root.focus({ preventScroll: true });
  started = true;
  refreshBadge();
}

/* ==========================================================================
   Assistant de configuration : ouvert d'office une fois par session
   ========================================================================== */

/**
 * Premier affichage (après connexion en ligne) : si le salon reste à configurer et
 * que l'assistant n'a pas encore été proposé pendant cette session, il remplace
 * l'écran demandé (sans nouvelle entrée d'historique). « Plus tard » ramène à l'agenda.
 */
async function openAssistantIfNeeded() {
  let open = false;
  if (!readSS(ASSISTANT_SEEN_KEY) && !location.hash.startsWith('#/bienvenue')) {
    render(root, html`<div class="page">${loaderHtml('Chargement…')}</div>`);
    try {
      open = needsSetup(await loadSalon());
    } catch {
      open = false;   // hors connexion : l'agenda affichera lui-même l'erreur
    }
  }
  if (open) {
    try { history.replaceState(null, '', '#/bienvenue'); } catch { /* adresse inchangée : écran demandé */ }
  }
  route();
}

/* ==========================================================================
   Connexion (mode en ligne)
   ========================================================================== */

function showLogin(message = '') {
  if (current) {
    current.view.unmount();
    current = null;
  }
  tabbar.hidden = true;
  const el = document.createElement('div');
  el.className = 'pro-view';
  root.replaceChildren(el);
  renderLogin(el, {
    message,
    onSuccess: () => {
      if (!parseRoute(location.hash)) nav.go('#/agenda', { replace: true });
      else route();
    },
  });
}

/* ==========================================================================
   Navigation partagée avec les écrans
   ========================================================================== */

nav.reload = () => {
  if (current && typeof current.view.refresh === 'function') current.view.refresh();
};
nav.refreshBadge = refreshBadge;
nav.previousHash = '';
nav.authLost = () => {
  Promise.resolve(store.logout()).catch(() => {}).finally(() => {
    showLogin('Votre session a expiré. Merci de vous reconnecter.');
  });
};
nav.loggedOut = () => {
  if (current && typeof current.view.discard === 'function') current.view.discard();
  toast('Vous êtes déconnectée.', { type: 'success' });
  showLogin();
};

/* ==========================================================================
   Saisie non enregistrée : confirmation avant de quitter l'écran
   ========================================================================== */

/** Aller vers `hash` ferait-il perdre une saisie non enregistrée de l'écran courant ? */
function losesInput(hash) {
  if (!current || hash === location.hash) return false;
  const view = current.view;
  if (typeof view.isDirty !== 'function' || !view.isDirty()) return false;
  const r = parseRoute(hash);
  // Même écran mis à jour sur place (autre jour de l'agenda) : rien n'est perdu.
  return !(r && r.name === current.name && typeof view.update === 'function');
}

let leaving = false;

async function confirmLeave(hash) {
  if (leaving) return;
  leaving = true;
  const ok = await confirmDialog({
    title: 'Quitter sans enregistrer ?',
    message: 'Des modifications de cet écran ne sont pas enregistrées. Elles seront perdues si vous le quittez.',
    confirmLabel: 'Quitter sans enregistrer',
    cancelLabel: 'Rester',
    danger: true,
  });
  leaving = false;
  if (!ok) return;
  if (current && typeof current.view.discard === 'function') current.view.discard();
  nav.go(hash);
}

/* ==========================================================================
   Rafraîchissement : écriture locale, autre onglet, ou relevé toutes les 60 s
   ========================================================================== */

let refreshTimer = null;
store.onChange(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (needsLogin()) return;
    nav.reload();
    refreshBadge();
  }, 80);
});

window.addEventListener('hashchange', route);

// Liens internes (#/…) : même chemin que nav.go (voir le contournement dans shared.js).
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = e.target instanceof Element ? e.target.closest('a[href^="#/"]') : null;
  if (!link || link.target) return;
  e.preventDefault();
  const href = link.getAttribute('href');
  if (losesInput(href)) confirmLeave(href);
  else nav.go(href);
});
window.addEventListener('unhandledrejection', (event) => {
  // Filet de sécurité : une erreur métier oubliée s'affiche en français.
  if (event.reason && event.reason.code) {
    event.preventDefault();
    showError(event.reason);
  }
});

route();
