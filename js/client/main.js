// Point d'entrée du côté client (app/index.html) : réservation en ligne.
//
// Écrans (routage par hash, bouton Retour = étape précédente) :
//   #/                 accueil : enseigne, infos pratiques, tarifs
//   #/creneau/<id>     étape 1 : jour et heure pour une prestation
//   #/coordonnees      étape 2 : coordonnées et confirmation
//   #/rdv/<jeton>      étape 3 : ticket du rendez-vous (lien rechargeable)
//   #/mes-rdv          rendez-vous pris depuis ce téléphone

import { registerSW } from '../ui/pwa.js';
import { getStore, isDemo } from '../data/store.js';
import { createRouter } from './routeur.js';
import { invalidate } from './donnees.js';
import * as accueil from './accueil.js';
import * as creneau from './creneau.js';
import * as coordonnees from './coordonnees.js';
import * as rdv from './rdv.js';
import * as mesRdv from './mes-rdv.js';

registerSW('./sw.js');

const store = getStore();

// Mode démo : accès direct à l'espace barbière depuis le bandeau (démonstration commerciale).
if (isDemo()) {
  const text = document.querySelector('#demo-banner .demo-banner__text');
  if (text && !text.querySelector('.demo-banner__link')) {
    const link = document.createElement('a');
    link.className = 'demo-banner__link';
    link.href = './pro/';
    link.textContent = 'Espace barbière';
    text.append(' ', link);
  }
}

const router = createRouter({
  root: document.getElementById('app'),
  store,
  routes: [
    { pattern: /^\/$/, screen: accueil },
    { pattern: /^\/creneau\/([^/]+)$/, keys: ['serviceId'], screen: creneau },
    { pattern: /^\/coordonnees$/, screen: coordonnees },
    { pattern: /^\/rdv\/([^/]+)$/, keys: ['token'], screen: rdv },
    { pattern: /^\/mes-rdv$/, screen: mesRdv },
  ],
});

// Données modifiées (réservation, réglages du salon, autre onglet, rafraîchissement
// en ligne) : le cache est vidé et l'écran courant se met à jour s'il le souhaite.
store.onChange(({ source } = {}) => {
  invalidate();
  router.refresh(source);
});

router.start();
