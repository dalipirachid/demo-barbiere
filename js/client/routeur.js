// Routeur par hash (#/…) : un écran à la fois dans <main id="app">.
//
// Chaque écran est une entrée de l'historique du navigateur : le bouton
// Retour du téléphone ramène donc à l'étape précédente. Chaque entrée est
// marquée dans history.state (profondeur + clé), ce qui permet :
//   - un retour « intelligent » (history.back() seulement s'il reste un écran
//     de l'appli derrière, sinon remplacement par l'accueil) ;
//   - de retrouver la position de défilement quand on revient sur un écran.
// Les feuilles modales de dom.js ajoutent des entrées à la même adresse
// (sans « hashchange ») : elles recopient notre marque, rien à faire ici.
//
// Un écran est un module qui exporte :
//   render(ctx)          async ; dessine l'écran, renvoie la phrase à annoncer
//   shouldRefresh(src)   facultatif ; vrai → re-rendu silencieux sur store.onChange

import { render as paint, on, announce } from '../ui/dom.js';
import { errorView } from './commun.js';

const STATE_KEY = 'barbiereRoute';

export function createRouter({ root, routes, store }) {
  let depth = 0;            // profondeur de l'entrée courante (0 = arrivée sur le site)
  let keySeq = 0;
  let seq = 0;              // numéro du dernier rendu lancé (les plus anciens sont ignorés)
  let tagged = false;       // la première entrée a-t-elle été marquée ?
  let replacing = false;    // la prochaine entrée remplace la courante (même profondeur)
  let navigated = false;    // au moins une navigation depuis le chargement
  let rendering = false;
  let refreshPending = '';
  let active = null;        // { match, cleanups }
  let currentKey = '';
  const pathAt = new Map(); // profondeur → chemin affiché à cette profondeur
  const scrollMemory = new Map();

  // — Adresses ————————————————————————————————————————————————

  function normalize(hash) {
    let path = String(hash || '').replace(/^#/, '');
    if (!path.startsWith('/')) path = '/' + path;
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return path;
  }

  const currentPath = () => normalize(location.hash);

  function match(path) {
    for (const route of routes) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      const params = {};
      (route.keys || []).forEach((key, i) => {
        try { params[key] = decodeURIComponent(m[i + 1]); } catch { params[key] = m[i + 1]; }
      });
      return { route, params, path };
    }
    return null;
  }

  // — Historique ——————————————————————————————————————————————

  /** Marque l'entrée courante ; → { key, revisit } (revisit : entrée déjà vue). */
  function tagEntry() {
    const state = history.state && typeof history.state === 'object' ? history.state : {};
    const tag = state[STATE_KEY];
    if (tag && typeof tag.key === 'string') {
      depth = Number(tag.depth) || 0;
      tagged = true;
      return { key: tag.key, revisit: true };
    }
    if (tagged && !replacing) depth += 1;
    else if (!tagged) depth = 0;
    tagged = true;
    const key = `r${Date.now().toString(36)}${(++keySeq).toString(36)}`;
    try {
      history.replaceState({ ...state, [STATE_KEY]: { key, depth } }, '');
    } catch { /* historique indisponible : sans conséquence */ }
    return { key, revisit: false };
  }

  /** Va vers un écran (nouvelle entrée d'historique). */
  function go(hash) {
    if (normalize(hash) === currentPath()) { show(); return; }
    location.hash = hash;
  }

  /** Remplace l'écran courant (pas de nouvelle entrée : Retour l'ignore). */
  function replace(hash) {
    if (normalize(hash) === currentPath()) { show(); return; }
    replacing = true;
    location.replace(hash.startsWith('#') ? hash : `#${hash}`);
  }

  /** Retour à l'écran précédent de l'appli, ou à `fallback` si on est arrivé ici directement.
   *  Si une feuille vient de se fermer, dom.js saute son entrée d'historique. */
  function back(fallback = '#/') {
    if (depth > 0) history.back();
    else replace(fallback);
  }

  /** Chemin de l'écran précédent dans cette visite (null si inconnu). */
  function prevPath() {
    return depth > 0 ? pathAt.get(depth - 1) || null : null;
  }

  // — Défilement ——————————————————————————————————————————————

  let scrollTicking = false;
  function onScroll() {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollTicking = false;
      if (currentKey) scrollMemory.set(currentKey, window.scrollY);
    });
  }

  // — Rendu ———————————————————————————————————————————————————

  function teardown() {
    if (!active) return;
    for (const fn of active.cleanups.splice(0)) {
      try { fn(); } catch (err) { console.error(err); }
    }
  }

  function makeContext(id, m, quiet) {
    const cleanups = [];
    const isCurrent = () => id === seq;
    const ctx = {
      root, store, quiet,
      params: m.params,
      path: m.path,
      focusTarget: null,      // élément à focaliser à l'arrivée (sinon le titre)
      scrolled: false,        // l'écran a choisi lui-même sa position de défilement
      isCurrent,
      render(tpl) { if (isCurrent()) paint(root, tpl); },
      on(type, selector, handler) {
        if (isCurrent()) cleanups.push(on(root, type, selector, handler));
      },
      onCleanup(fn) {
        if (isCurrent()) cleanups.push(fn);
        else fn();
      },
      go, replace, back, prevPath,
    };
    return { ctx, cleanups };
  }

  /** Élément focalisé avant un re-rendu silencieux (repéré par data-key). */
  function focusedKey() {
    const el = document.activeElement;
    if (!el || !root.contains(el)) return '';
    const keyed = el.closest('[data-key]');
    return keyed ? keyed.dataset.key : '';
  }

  function refocus(key) {
    if (!key) return;
    const el = [...root.querySelectorAll('[data-key]')].find((n) => n.dataset.key === key);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }

  async function show({ quiet = false } = {}) {
    const m = match(currentPath());
    if (!m) { replace('#/'); return; }

    const id = ++seq;
    let savedY;
    if (!quiet) {
      const tag = tagEntry();
      replacing = false;
      pathAt.set(depth, m.path);
      currentKey = tag.key;
      // Valeur lue AVANT le rendu : le squelette, plus court, ferait défiler la page.
      savedY = tag.revisit ? scrollMemory.get(tag.key) : undefined;
      if (savedY === undefined) window.scrollTo(0, 0);
    }
    const keepFocus = quiet ? focusedKey() : '';

    teardown();
    const { ctx, cleanups } = makeContext(id, m, quiet);
    active = { match: m, cleanups };
    ctx.on('click', '[data-action="retry"]', () => show());

    if (!quiet) rendering = true;
    let message = '';
    try {
      message = (await m.route.screen.render(ctx)) || '';
    } catch (err) {
      console.error(err);
      if (id === seq) {
        paint(root, errorView(err, { withHome: m.path !== '/' }));
        message = 'Impossible d’afficher cette page.';
      }
    } finally {
      if (id === seq) rendering = false;
    }
    if (id !== seq) return;

    if (quiet) {
      refocus(keepFocus);
    } else {
      if (savedY !== undefined && !ctx.scrolled) window.scrollTo(0, savedY);
      // À l'ouverture du site, on laisse la lecture commencer en haut de page ;
      // ensuite, chaque changement d'écran place le focus sur son titre.
      if (navigated) {
        const target = ctx.focusTarget && root.contains(ctx.focusTarget)
          ? ctx.focusTarget
          : root.querySelector('[data-screen-title]') || root;
        target.focus({ preventScroll: true });
        announce(message);
      }
    }
    if (refreshPending) {
      const source = refreshPending;
      refreshPending = '';
      refresh(source);
    }
  }

  /** Données modifiées (store.onChange) : re-rendu silencieux si l'écran le demande. */
  function refresh(source) {
    if (!active) return;
    const screen = active.match.route.screen;
    if (typeof screen.shouldRefresh !== 'function' || !screen.shouldRefresh(source)) return;
    if (rendering) { refreshPending = source; return; }
    show({ quiet: true });
  }

  function start() {
    try { history.scrollRestoration = 'manual'; } catch { /* ancien navigateur */ }
    window.addEventListener('hashchange', () => {
      navigated = true;
      show();
    });
    window.addEventListener('scroll', onScroll, { passive: true });
    show();
  }

  return { start, refresh, go, replace, back };
}
