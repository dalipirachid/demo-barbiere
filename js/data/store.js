// Choix du mode de données : démo (localStorage) ou en ligne (Supabase).
// Lit window.APP_CONFIG, défini par config.js (script classique chargé avant
// les modules). Config vide ou incomplète → démo.

import { createLocalStore } from './local-store.js';
import { createSupabaseStore } from './supabase-store.js';

let instance = null;

/** Configuration lue dans window.APP_CONFIG, nettoyée. */
export function getConfig() {
  let cfg = null;
  try {
    cfg = (typeof window !== 'undefined' && window.APP_CONFIG) || globalThis.APP_CONFIG || null;
  } catch { /* environnement sans window */ }
  return {
    supabaseUrl: String((cfg && cfg.supabaseUrl) || '').trim(),
    supabaseKey: String((cfg && cfg.supabaseKey) || '').trim(),
  };
}

/** Vrai tant que Supabase n'est pas configuré (URL http(s) + clé). */
export function isDemo() {
  const { supabaseUrl, supabaseKey } = getConfig();
  return !(/^https?:\/\/\S+$/i.test(supabaseUrl) && supabaseKey);
}

/** Store unique de l'application (même instance pour tous les écrans). */
export function getStore() {
  if (!instance) {
    if (isDemo()) {
      instance = createLocalStore();
    } else {
      const { supabaseUrl, supabaseKey } = getConfig();
      instance = createSupabaseStore({ url: supabaseUrl, key: supabaseKey });
    }
  }
  return instance;
}

/** Réservé aux tests : oublie l'instance pour relire la configuration. */
export function resetStoreForTests() {
  instance = null;
}
