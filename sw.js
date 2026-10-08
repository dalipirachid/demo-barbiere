/* Service worker — Planning Barbière (portée : le dossier app/, client et pro).
 *
 * Une « coquille » d'appli par version :
 * - À l'installation, TOUS les fichiers de l'appli (pages, modules JS, styles,
 *   manifestes, icônes, polices) sont téléchargés dans un cache propre à
 *   VERSION, en une seule fois (Cache.addAll : tout ou rien). S'il en manque
 *   un seul, l'installation échoue et la version en place reste intacte.
 * - Ensuite, pages, modules et styles sont servis depuis CE cache, jamais depuis
 *   le réseau ni depuis le cache d'une autre version : une page et ses modules
 *   sont toujours de la même version, en ligne comme hors connexion.
 * - config.js fait exception : réseau d'abord, SANS délai de repli. La copie
 *   n'est servie que si le réseau échoue vraiment (hors connexion, erreur du
 *   serveur), pour que le passage du mode démo au mode en ligne soit pris en
 *   compte dès le lancement suivant.
 * - JAMAIS de cache pour une autre origine (Supabase : rendez-vous, clients…)
 *   ni pour les requêtes autres que GET.
 *
 * Publier une nouvelle version : changer VERSION ci-dessous, À CHAQUE
 * publication (sinon les appareils gardent l'ancienne). Le nouveau service
 * worker s'installe en arrière-plan, puis les pages ouvertes proposent
 * « Mettre à jour » (js/ui/pwa.js, message SKIP_WAITING).
 * Ajouter un fichier à l'appli : l'ajouter aussi à PRECACHE_PATHS
 * (tests/sw.test.mjs le vérifie). Procédure complète : docs/DEPLOIEMENT.md.
 */

const VERSION = '2026-10-08.1';

const SCOPE_URL = new URL('./', self.location);                // …/app/ (ou la racine du dépôt publié)
const CACHE_PREFIX = `barbiere:${SCOPE_URL.pathname}:`;        // un préfixe par déploiement
const CACHE = CACHE_PREFIX + VERSION;                          // un cache par version

// Tous les fichiers publiés, sauf sw.js lui-même et styleguide.html (catalogue
// des composants, non lié dans l'appli).
const PRECACHE_PATHS = [
  // Pages
  'index.html',
  'pro/index.html',
  'confidentialite.html',
  // Configuration (réseau d'abord : voir configFirst)
  'config.js',
  // Manifestes
  'manifest.webmanifest',
  'pro/manifest.webmanifest',
  // Styles
  'css/app.css',
  'css/client.css',
  'css/pro.css',
  // Modules communs
  'js/core/dates.js',
  'js/core/errors.js',
  'js/core/slots.js',
  'js/core/validate.js',
  'js/data/local-store.js',
  'js/data/seed.js',
  'js/data/store.js',
  'js/data/supabase-store.js',
  'js/ui/dom.js',
  'js/ui/pwa.js',
  // Modules côté client
  'js/client/accueil.js',
  'js/client/annulation.js',
  'js/client/commun.js',
  'js/client/coordonnees.js',
  'js/client/creneau.js',
  'js/client/donnees.js',
  'js/client/etat.js',
  'js/client/ics.js',
  'js/client/main.js',
  'js/client/memoire.js',
  'js/client/mes-rdv.js',
  'js/client/rdv.js',
  'js/client/routeur.js',
  'js/client/salon.js',
  // Modules côté barbière
  'js/pro/agenda.js',
  'js/pro/appointment.js',
  'js/pro/block-form.js',
  'js/pro/calc.js',
  'js/pro/clients.js',
  'js/pro/login.js',
  'js/pro/main.js',
  'js/pro/rdv-form.js',
  'js/pro/settings.js',
  'js/pro/shared.js',
  'js/pro/slot-picker.js',
  // Icônes
  'icons/favicon.svg',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/pro-favicon.svg',
  'icons/pro-favicon-32.png',
  'icons/pro-apple-touch-icon.png',
  'icons/pro-icon-192.png',
  'icons/pro-icon-512.png',
  'icons/pro-icon-maskable-512.png',
  // Polices
  'fonts/young-serif-latin.woff2',
  'fonts/young-serif-latin-ext.woff2',
  'fonts/hanken-grotesk-latin.woff2',
  'fonts/hanken-grotesk-latin-ext.woff2',
];

const PRECACHE = PRECACHE_PATHS.map((path) => new URL(path, SCOPE_URL).href);
const PRECACHED = new Set(PRECACHE);
const CONFIG_URL = new URL('config.js', SCOPE_URL).href;

/* — Installation : précache complet, tout ou rien — */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' : chaque fichier vient du serveur, pas du cache HTTP du
    // navigateur (qui pourrait encore contenir un fichier de la version précédente).
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
  })());
});

/* — Activation : ménage des anciennes versions de CE déploiement — */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map((key) => caches.delete(key)));
    // Les pages viennent du cache : le préchargement des navigations (activé par
    // une version précédente) ne servirait qu'à doubler chaque requête.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch { /* facultatif */ }
    }
    await self.clients.claim();
  })());
});

/* — La page demande d'activer la nouvelle version (bouton « Mettre à jour ») — */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* — Requêtes — */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;                       // POST/PATCH… : jamais interceptés
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;            // Supabase et tout tiers : jamais en cache
  if (!url.href.startsWith(SCOPE_URL.href)) return;           // hors du dossier de l'appli
  if (request.headers.has('range')) return;                   // lecture partielle (médias)

  const isPage = request.mode === 'navigate';
  const key = cacheKey(url, isPage);
  if (key === CONFIG_URL) event.respondWith(configFirst(request));
  else if (PRECACHED.has(key)) event.respondWith(fromVersionCache(request, key));
  else if (isPage) event.respondWith(networkOrOffline(request));
  // Autre fichier du dossier (styleguide.html…) : comportement normal du navigateur.
});

/**
 * Adresse sous laquelle le fichier est rangé dans le cache : sans paramètres
 * (?…) ni ancre ; un dossier demandé en navigation désigne son index.html.
 */
function cacheKey(url, isPage) {
  const clean = new URL(url.href);
  clean.search = '';
  clean.hash = '';
  if (isPage && clean.pathname.endsWith('/')) clean.pathname += 'index.html';
  return clean.href;
}

/** Fichier de l'appli : copie de CETTE version, jamais celle d'une autre. */
async function fromVersionCache(request, key) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  // Copie absente (stockage vidé par le système) : réseau, sans rien écrire
  // dans le cache de cette version (le fichier publié peut être plus récent).
  return networkOrOffline(request);
}

/** config.js : réseau d'abord, sans délai ; la copie seulement si le réseau échoue. */
async function configFirst(request) {
  const cache = await caches.open(CACHE);
  let response;
  try {
    // no-cache : le cache HTTP du navigateur est revalidé auprès du serveur.
    response = await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
  } catch {
    return (await cache.match(CONFIG_URL)) || offlineResponse(request);
  }
  if (response.ok) {
    await cache.put(CONFIG_URL, response.clone()).catch(() => {});
    return response;
  }
  // Erreur du serveur : la dernière copie reçue vaut mieux qu'un config.js
  // absent, qui ferait démarrer l'appli en mode démo.
  return (await cache.match(CONFIG_URL)) || response;
}

async function networkOrOffline(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineResponse(request);
  }
}

function offlineResponse(request) {
  if (request.mode !== 'navigate') {
    return new Response('', { status: 503, statusText: 'Hors connexion' });
  }
  const page = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Hors connexion</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4EEE4;color:#1C2925;
font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}h1{font:400 1.6rem Georgia,serif;margin:0 0 8px}
button{margin-top:16px;min-height:48px;padding:0 24px;border:0;border-radius:999px;background:#23413A;color:#FFFCF7;font:inherit;font-weight:600}</style>
</head><body><main><h1>Pas de connexion</h1><p>Vérifiez le réseau, puis réessayez.</p>
<button type="button" onclick="location.reload()">Réessayer</button></main></body></html>`;
  return new Response(page, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
