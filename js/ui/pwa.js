/**
 * Coquille PWA : service worker et invitation à installer l'appli.
 *
 *   registerSW(path)        enregistre le service worker, propose les mises à jour
 *   setupInstall({ mode })  bouton « Installer l'appli » (Android/Chrome) ou
 *                           aide illustrée (iPhone/iPad, Safari)
 *   isStandalone(), isIOS(), isInAppBrowser(ua)
 *
 * Utilisation (dans js/client/main.js ; pour l'espace pro : '../sw.js', mode 'pro') :
 *   import { registerSW, setupInstall } from '../ui/pwa.js';
 *   registerSW('./sw.js');
 *   const install = setupInstall({ mode: 'client' });
 *   conteneur.append(install.button());   // se montre / se cache tout seul
 */

import { html, icon, openSheet, toast } from './dom.js';

/* ==========================================================================
   Détection
   ========================================================================== */

/** Vrai quand la page tourne en appli installée (écran d'accueil). */
export function isStandalone() {
  try {
    if (window.navigator.standalone === true) return true; // iOS
    return ['standalone', 'fullscreen', 'minimal-ui']
      .some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
  } catch {
    return false;
  }
}

/** Vrai sur iPhone, iPod et iPad (y compris iPad qui se présente comme un Mac). */
export function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Vrai dans le navigateur intégré d'une appli (Instagram, Facebook, Snapchat,
 * TikTok, LINE…) : « Sur l'écran d'accueil » n'y existe pas.
 */
export function isInAppBrowser(ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '') {
  return /Instagram|FBAN|FBAV|FB_IAB|Snapchat|musical_ly|BytedanceWebview|Line\//.test(ua);
}

/* ==========================================================================
   Service worker
   ========================================================================== */

const UPDATE_CHECK_MS = 30 * 60 * 1000; // revérifie au plus toutes les 30 min quand l'appli revient au premier plan
let updateRequested = false;
let updateToastShown = false;

/**
 * Enregistre le service worker (`./sw.js` depuis app/index.html,
 * `../sw.js` depuis app/pro/index.html). La portée est le dossier du fichier
 * sw.js, soit app/ : un seul service worker pour les deux applis.
 * Quand une nouvelle version est prête, un toast propose « Mettre à jour ».
 * Retourne la ServiceWorkerRegistration, ou null (navigateur incompatible,
 * page ouverte en file:// ou en http non local).
 */
export async function registerSW(path = './sw.js') {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  const scriptUrl = new URL(path, document.baseURI);
  const scope = new URL('./', scriptUrl).href;

  let registration;
  try {
    registration = await navigator.serviceWorker.register(scriptUrl.href, { scope, updateViaCache: 'none' });
  } catch (err) {
    console.warn('Service worker non enregistré :', err);
    return null;
  }

  const offerUpdate = (worker) => {
    if (!worker || updateToastShown || !navigator.serviceWorker.controller) return;
    updateToastShown = true;
    toast('Une nouvelle version de l’appli est prête.', {
      duration: 0,
      action: {
        label: 'Mettre à jour',
        onClick: () => {
          updateRequested = true;
          worker.postMessage({ type: 'SKIP_WAITING' });
        },
      },
    });
  };

  // Une version attend déjà (onglet resté ouvert pendant une mise à jour)
  if (registration.waiting) offerUpdate(registration.waiting);

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // « installed » avec un contrôleur existant = mise à jour (et non 1re installation)
      if (worker.state === 'installed') offerUpdate(worker);
    });
  });

  // Le nouveau service worker a pris la main : on recharge, seulement si demandé.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested || reloading) return;
    reloading = true;
    window.location.reload();
  });

  // L'appli pro peut rester ouverte des jours : on revérifie au retour au premier plan.
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < UPDATE_CHECK_MS) return;
    lastCheck = Date.now();
    registration.update().catch(() => {});
  });

  return registration;
}

/* ==========================================================================
   Installation
   ========================================================================== */

const REFUSAL_KEY = 'barbiere-install-refus';     // { client: ISO, pro: ISO }
const REFUSAL_MS = 30 * 24 * 60 * 60 * 1000;      // 30 jours

let deferredPrompt = null;   // événement beforeinstallprompt mis de côté
let installedNow = false;
const changeListeners = new Set();

function notifyChange() {
  changeListeners.forEach((fn) => {
    try { fn(); } catch (err) { console.error(err); }
  });
}

// Écoute dès le chargement du module : l'événement peut arriver très tôt.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();      // pas de mini-barre Chrome : on propose notre bouton
    deferredPrompt = event;
    notifyChange();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installedNow = true;
    notifyChange();
  });
}

function readRefusals() {
  try {
    const value = JSON.parse(localStorage.getItem(REFUSAL_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeRefusal(mode, iso) {
  try {
    const all = readRefusals();
    if (iso) all[mode] = iso;
    else delete all[mode];
    localStorage.setItem(REFUSAL_KEY, JSON.stringify(all));
  } catch { /* navigation privée : on ne mémorise rien */ }
}

function isRefused(mode) {
  const time = Date.parse(readRefusals()[mode] || '');
  return Number.isFinite(time) && Date.now() - time < REFUSAL_MS;
}

/**
 * Prépare l'invitation à installer.
 *   const install = setupInstall({ mode: 'client' });   // ou 'pro'
 *   install.button()      → <button> « Installer l'appli », caché quand inutile
 *   install.available     → faut-il proposer l'installation ? (false si déjà
 *                           installée, impossible, ou refusée il y a < 30 jours)
 *   install.canInstall    → installation possible (même après un refus) — pour un
 *                           lien « Installer » placé dans un menu ou les réglages
 *   install.prompt()      → Android/Chrome : invite système ; iOS : aide illustrée.
 *                           Résout 'accepted' | 'dismissed' | 'ios-help' | 'installed' | 'unavailable'
 *   install.showIOSHelp() → ouvre l'aide « Partager → Sur l'écran d'accueil »
 *   install.dismiss()     → mémorise un refus pendant 30 jours
 *   install.onChange(fn)  → rappel à chaque changement ; retourne le désabonnement
 */
export function setupInstall({ mode = 'client' } = {}) {
  const key = mode === 'pro' ? 'pro' : 'client';

  const state = () => {
    if (installedNow || isStandalone()) return 'installed';
    if (deferredPrompt) return 'prompt';
    // Navigateur intégré (lien de la bio Instagram…) : l'aide Safari y serait une impasse.
    if (isIOS()) return isInAppBrowser() ? 'unavailable' : 'ios';
    return 'unavailable';
  };

  const api = {
    mode: key,
    get state() { return state(); },
    get canInstall() { const s = state(); return s === 'prompt' || s === 'ios'; },
    get available() { return api.canInstall && !isRefused(key); },

    async prompt() {
      const s = state();
      if (s === 'prompt') {
        const event = deferredPrompt;
        deferredPrompt = null;
        try {
          await event.prompt();
          const choice = await event.userChoice;
          if (choice && choice.outcome === 'accepted') writeRefusal(key, null);
          else writeRefusal(key, new Date().toISOString());
          notifyChange();
          return choice ? choice.outcome : 'dismissed';
        } catch (err) {
          console.warn('Invitation d’installation impossible :', err);
          notifyChange();
          return 'unavailable';
        }
      }
      if (s === 'ios') {
        api.showIOSHelp();
        return 'ios-help';
      }
      return s; // 'installed' | 'unavailable'
    },

    showIOSHelp() {
      return openSheet({
        title: 'Ajouter à l’écran d’accueil',
        content: iosHelpContent(key),
        actions: [
          { label: 'Plus tard', variant: 'ghost', onClick: () => api.dismiss() },
          { label: 'J’ai compris', variant: 'primary', autofocus: true },
        ],
      });
    },

    dismiss() {
      writeRefusal(key, new Date().toISOString());
      notifyChange();
    },

    onChange(fn) {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },

    /** Bouton prêt à placer dans un écran ; se masque tout seul quand il ne sert à rien. */
    button({ className = 'btn btn--ghost', label = 'Installer l’appli' } = {}) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      btn.dataset.install = key;
      btn.innerHTML = html`${icon('installer')}<span>${label}</span>`.toString();
      const sync = () => { btn.hidden = !api.available; };
      sync();
      const unsubscribe = api.onChange(() => {
        if (!btn.isConnected && btn.dataset.mounted) { unsubscribe(); return; }
        sync();
      });
      btn.addEventListener('click', () => api.prompt());
      // Repère qu'il a été inséré au moins une fois (pour se désabonner une fois retiré)
      queueMicrotask(() => { if (btn.isConnected) btn.dataset.mounted = '1'; });
      return btn;
    },
  };

  return api;
}

/** Contenu de l'aide iPhone / iPad : petite illustration + trois étapes. */
function iosHelpContent(mode) {
  const iconUrl = new URL(mode === 'pro' ? '../../icons/pro-apple-touch-icon.png' : '../../icons/apple-touch-icon.png', import.meta.url).href;
  const what = mode === 'pro' ? 'l’agenda' : 'l’appli de réservation';
  const ua = navigator.userAgent || '';
  // Chrome sur iPhone : Partager est dans la barre d'adresse, pas dans la barre du bas de Safari.
  const where = /CriOS|EdgiOS/.test(ua)
    ? 'dans la barre d’adresse'
    : /iPad/.test(ua) || navigator.maxTouchPoints > 1 && navigator.platform === 'MacIntel'
      ? 'en haut de l’écran'
      : 'en bas de l’écran';
  return html`
    <div class="install-help">
      <p class="muted">Installez ${what} sur votre écran d’accueil : elle s’ouvrira d’un geste, comme une vraie appli, sans passer par l’App Store.</p>
      <div class="install-help__demo" aria-hidden="true">
        <div class="install-help__screen"><img class="install-help__appicon" src="${iconUrl}" alt="" width="56" height="56"></div>
        <div class="install-help__toolbar">
          <span class="install-help__tool">${icon('chevron-gauche')}</span>
          <span class="install-help__tool">${icon('chevron-droite')}</span>
          <span class="install-help__tool install-help__tool--share">${icon('partage')}</span>
          <span class="install-help__tool">${icon('ecran-accueil')}</span>
        </div>
      </div>
      <ol class="install-help__steps">
        <li class="install-help__step"><span class="install-help__num">1</span>
          <p>Touchez <strong>Partager</strong> ${icon('partage')} ${where}. Vous ne le voyez pas&nbsp;? Touchez d’abord <strong>···</strong>.</p></li>
        <li class="install-help__step"><span class="install-help__num">2</span>
          <p>Faites défiler et choisissez <strong>Sur l’écran d’accueil</strong> ${icon('ecran-accueil')}.</p></li>
        <li class="install-help__step"><span class="install-help__num">3</span>
          <p>Touchez <strong>Ajouter</strong>. L’icône apparaît sur votre écran d’accueil.</p></li>
      </ol>
    </div>`;
}
