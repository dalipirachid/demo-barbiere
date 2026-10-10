/**
 * Assistant de configuration du salon (#/bienvenue[/<étape>], contrat §8 bis).
 *
 * On n'invente pas l'identité du salon : la barbière la renseigne elle-même, en
 * cinq étapes — 1. Votre salon (nom, accroche, blason affiché ou non, avec un
 * aperçu de l'en-tête de sa page) · 2. Coordonnées · 3. Horaires · 4. Prestations
 * et prix · 5. Récapitulatif (voir la page, partager le lien, Terminer).
 *
 * - Chaque étape enregistre ce qui est saisi en passant à la suivante ; chacune peut
 *   être passée. Seul « Terminer » exige un nom de salon (non vide, non marqueur).
 * - Un champ encore « [À COMPLÉTER] » s'affiche vide : le marqueur sert d'indication
 *   (placeholder), il n'y a rien à effacer. Laissé vide, il reste marqué.
 * - Horaires et prestations : mêmes éditeurs que Réglages (settings.js).
 * - Saisie non enregistrée (Précédent, Plus tard, Retour) : gardée en brouillon le
 *   temps de la session de la page, remise au prochain passage sur l'étape.
 * - L'étape est dans l'adresse (#/bienvenue/3, sans nouvelle entrée d'historique) :
 *   un rechargement reprend au même endroit ; Retour quitte l'assistant.
 *
 * Les fonctions pures (exportées) sont testées sous node : tests/assistant.test.mjs.
 */

import { html, render, icon, announce, toast, confirmDialog } from '../ui/dom.js';
import { fmtClock } from '../core/dates.js';
import { validateSalonPatch, cleanText, foldText } from '../core/validate.js';
import { PLACEHOLDER, isPlaceholder, salonTodo, displayName } from '../core/setup.js';
import { demoSalon, demoServices } from '../data/seed.js';
import {
  DAYS, crestSwitchHtml, hoursState, hoursFieldsHtml, readHoursState, checkHoursForm, changeRanges,
  focusAfterRangeChange, toggleHoursDay, createServicesEditor,
} from './settings.js';
import {
  store, loadSalon, nav, textField, setFieldErrors, showError, loaderHtml, phoneText, bookingUrl,
  formSnapshot, writeSS, salonName, copyBookingLink, shareBookingLink, canShare, plural,
} from './shared.js';

/* ==========================================================================
   Logique pure (sans DOM)
   ========================================================================== */

/** L'assistant a déjà été proposé pendant cette session (sessionStorage). */
export const ASSISTANT_SEEN_KEY = 'barbiere-assistant-vu';

/** Les cinq étapes, dans l'ordre. */
export const STEPS = Object.freeze([
  'Votre salon',
  'Coordonnées',
  'Horaires',
  'Prestations et prix',
  'Récapitulatif',
]);

/** Texte inscrit sur le ruban du blason (img/blason.webp). */
export const CREST_TEXT = 'Private Barbière';

/** Numéro d'étape lu dans l'adresse ('3' → 3) ; illisible ou hors bornes → 1. */
export function parseStep(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= STEPS.length ? n : 1;
}

/** Valeur à mettre dans un champ : vide tant que l'information est encore marquée. */
export function fieldValue(value) {
  return isPlaceholder(value) ? '' : String(value ?? '');
}

/**
 * Indication (placeholder) d'un champ : le marqueur enregistré
 * (« [À COMPLÉTER] Adresse »), ou, pour un champ indispensable resté vide,
 * « [À COMPLÉTER] <libellé> ». '' sinon.
 */
export function fieldPlaceholder(value, label = '') {
  const s = cleanText(value);
  if (s.includes(PLACEHOLDER)) return s;
  return !s && label ? `${PLACEHOLDER} ${label}` : '';
}

/**
 * Modifications à enregistrer pour une étape. Un champ laissé vide alors qu'il
 * était encore à compléter n'est pas envoyé (il reste marqué) ; vider un champ
 * déjà renseigné l'efface (le nom, obligatoire, est alors refusé par
 * validateSalonPatch). Les booléens (showCrest) passent tels quels.
 */
export function salonPatch(salon, values) {
  const s = salon || {};
  const patch = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (typeof value === 'boolean') {
      patch[key] = value;
      continue;
    }
    const text = String(value ?? '');
    if (!text.trim() && isPlaceholder(s[key])) continue;
    patch[key] = text;
  }
  return patch;
}

const fold = (value) => foldText(cleanText(value));

/**
 * Composition de l'en-tête de la page de réservation, à l'identique de
 * signboardModel (js/client/accueil.js — l'égalité est vérifiée par les tests) :
 *   crest   : blason affiché (showCrest absent → oui)
 *   title   : nom du salon, ou le marqueur que verront les clients
 *   todo    : le nom est encore à compléter
 *   hidden  : nom non répété sous le blason, dont le ruban le porte déjà
 *   tagline : accroche affichée ('' si absente ou si elle redit le nom)
 */
export function previewModel({ name = '', tagline = '', showCrest = true } = {}) {
  const shown = displayName({ name });
  const crest = showCrest !== false;
  const tag = String(tagline || '').trim();
  return {
    crest,
    title: shown || cleanText(name) || `${PLACEHOLDER} Nom du salon`,
    todo: !shown,
    hidden: crest && Boolean(shown) && fold(shown) === fold(CREST_TEXT),
    tagline: tag && !fold(shown).includes(fold(tag)) ? tag : '',
  };
}

/**
 * Taille du nom sur l'en-tête (même calcul que signNameFit, côté client) :
 * longest = lettres du mot le plus long, max = taille plafond en rem.
 */
export function previewNameFit(title, crest) {
  const text = cleanText(title);
  const longest = Math.max(5, ...text.split(' ').map((word) => [...word].length));
  const length = [...text].length;
  const max = crest
    ? (length <= 18 ? 2.25 : 1.875)
    : (length <= 14 ? 3 : length <= 28 ? 2.5 : 2);
  return { longest, max };
}

const EXAMPLES = demoServices().map((s) => ({ name: fold(s.name), durationMin: s.durationMin, priceCents: s.priceCents }));

/** Prestation de démonstration encore inchangée (même nom, même durée, même prix) : son tarif est un exemple. */
export function isExampleService(svc) {
  if (!svc) return false;
  const name = fold(svc.name);
  return EXAMPLES.some((e) => e.name === name
    && e.durationMin === Number(svc.durationMin) && e.priceCents === Number(svc.priceCents));
}

const hoursKey = (hours) => JSON.stringify(Array.from({ length: 7 }, (_, i) => (hours && hours[String(i + 1)]) || []));

/** Horaires encore identiques à ceux de la démonstration (proposés à titre d'exemple). */
export function isExampleHours(hours) {
  return hoursKey(hours) === hoursKey(demoSalon().hours);
}

/**
 * Résumé des horaires, jours consécutifs identiques regroupés.
 * → [{ days: 'Du mardi au jeudi', text: '9h00 – 12h00 · 13h30 – 19h00' }, { days: 'Lundi', text: 'Fermé' }, …]
 */
export function hoursSummary(hours) {
  const rows = [];
  for (let d = 1; d <= 7; d++) {
    const ranges = (hours && hours[String(d)]) || [];
    const text = ranges.length ? ranges.map(([o, c]) => `${fmtClock(o)} – ${fmtClock(c)}`).join(' · ') : 'Fermé';
    const last = rows[rows.length - 1];
    if (last && last.text === text) last.to = d;
    else rows.push({ from: d, to: d, text });
  }
  return rows.map(({ from, to, text }) => {
    const a = DAYS[from - 1];
    const b = DAYS[to - 1].toLowerCase();
    let days = a;
    if (to === from + 1) days = `${a} et ${b}`;
    else if (to > from + 1) days = `Du ${a.toLowerCase()} au ${b}`;
    return { days, text };
  });
}

/* ==========================================================================
   Écran
   ========================================================================== */

// Saisie non enregistrée, par étape, gardée le temps de la session de la page.
const drafts = {};

const BLASON_IMG = { src: '../img/blason.webp', width: 655, height: 742 };

/** Aperçu de l'en-tête de la page de réservation (classes de la page client : .signboard, .blason). */
function previewHtml(values) {
  const m = previewModel(values);
  const fit = previewNameFit(m.title, m.crest);
  const style = `--mot: ${fit.longest}; --nom-max: ${fit.max}rem`;
  const name = html`<p class="signboard__name pro-preview__name${m.todo ? ' pro-preview__name--todo' : ''}" style="${style}">${m.todo ? html`<span class="todo">${m.title}</span>` : m.title}</p>`;
  const label = `Aperçu : ${m.crest ? 'blason affiché' : 'sans blason'}, nom ${m.todo ? 'encore à compléter' : `« ${m.title} »`}${m.hidden ? ' (déjà écrit sur le ruban du blason)' : ''}${m.tagline ? `, accroche « ${m.tagline} »` : ''}.`;
  if (!m.crest) {
    return html`
      <div class="signboard pro-preview__sign pro-preview__sign--nom" role="img" aria-label="${label}">
        ${name}
        <div class="filet-orne pro-preview__filet"></div>
        ${m.tagline ? html`<p class="signboard__kicker pro-preview__tagline">${m.tagline}</p>` : ''}
      </div>`;
  }
  return html`
    <div class="signboard pro-preview__sign${m.hidden && !m.tagline ? ' pro-preview__sign--solo' : ''}" role="img" aria-label="${label}">
      <span class="blason pro-preview__blason"><img src="${BLASON_IMG.src}" alt="" width="${BLASON_IMG.width}" height="${BLASON_IMG.height}" decoding="async"></span>
      ${m.tagline ? html`<p class="signboard__kicker pro-preview__tagline">${m.tagline}</p>` : ''}
      ${m.hidden ? '' : name}
    </div>`;
}

export function createAssistantView() {
  let root = null;
  let step = 1;
  let salon = null;
  let services = [];
  let seq = 0;
  let initial = '';         // instantané de la saisie de l'étape à son affichage
  let shownKey = '';        // données affichées par l'étape (pas de redessin inutile)
  let busy = false;
  let focusField = '';      // champ à focaliser à l'arrivée sur l'étape (« Indiquer le nom »)

  const region = (name) => root && root.querySelector(`[data-region="${name}"]`);
  const servicesEditor = createServicesEditor({
    host: () => region('services'),
    reload: () => load(),
    heading: false,
    isExample: isExampleService,
  });

  /* — Saisie de l'étape — */

  /** Conteneur de la saisie de l'étape (formulaire, ou éditeur des horaires). */
  function inputHost() {
    if (!root) return null;
    if (step === 1 || step === 2) return root.querySelector('[data-form]');
    if (step === 3) return region('hours');
    return null;
  }

  function readValues() {
    if (step === 3) return readHoursState(region('hours'));
    const form = inputHost();
    if (!form) return null;
    return Object.fromEntries([...form.querySelectorAll('[name]')]
      .map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.value]));
  }

  function isDirty() {
    const host = inputHost();
    return Boolean(host) && formSnapshot(host) !== initial;
  }

  function captureDraft() {
    if (step > 3) return;
    if (isDirty()) drafts[step] = readValues();
    else delete drafts[step];
  }

  function applyDraft(values) {
    if (step === 3) {
      render(region('hours'), hoursFieldsHtml(values));
      return;
    }
    const form = inputHost();
    for (const [name, value] of Object.entries(values)) {
      const el = form.querySelector(`[name="${name}"]`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(value);
      else el.value = value;
    }
    if (step === 1) renderPreview();
  }

  /* — Gabarits — */

  function shellHtml() {
    return html`
      <header class="appbar appbar--green pro-wizard__head">
        <div class="appbar__titles">
          <h1 class="appbar__title">Bienvenue</h1>
          <p class="appbar__subtitle" data-region="subtitle">Configuration de votre salon</p>
        </div>
        <div class="appbar__actions">
          <button type="button" class="btn btn--ghost btn--sm pro-wizard__later" data-act="later">Plus tard</button>
        </div>
      </header>
      <div class="page pro-wizard">
        <div class="pro-wizard__progress">
          <div class="pole" role="progressbar" aria-label="Progression de la configuration" aria-valuemin="0"
               aria-valuemax="${STEPS.length}" aria-valuenow="0" style="--progress: 0" data-region="pole"><span class="pole__bar"></span></div>
          <p class="pro-wizard__steplabel" aria-hidden="true" data-region="steplabel"></p>
        </div>
        <section class="pro-wizard__step" data-region="step" aria-labelledby="pro-wizard-titre">${loaderHtml('Chargement…')}</section>
      </div>
      <div class="sticky-cta pro-wizard__bar" data-region="bar"></div>`;
  }

  function titleHtml(lead) {
    return html`
      <h2 class="pro-wizard__title" id="pro-wizard-titre" tabindex="-1" data-step-title>${STEPS[step - 1]}</h2>
      ${lead ? html`<p class="pro-wizard__lead">${lead}</p>` : ''}`;
  }

  function stepSalonHtml(s) {
    return html`
      ${titleHtml(s.setupDone
        ? 'Le nom et l’accroche ouvrent votre page de réservation.'
        : 'Bienvenue ! En cinq étapes, préparez la page où vos clients prennent rendez-vous. Tout reste modifiable ensuite dans Réglages.')}
      <form class="stack pro-wizard__salon" data-form novalidate>
        <div class="card stack pro-form">
          ${textField({
            name: 'name', label: 'Nom du salon', value: fieldValue(s.name), placeholder: fieldPlaceholder(s.name, 'Nom du salon'),
            maxlength: 100, autocomplete: 'organization', hint: 'Tel que vos clients le connaissent. Indispensable pour terminer.',
          })}
          ${textField({
            name: 'tagline', label: 'Accroche', value: fieldValue(s.tagline), placeholder: fieldPlaceholder(s.tagline) || 'Ex. : Barbière',
            optional: true, maxlength: 160, hint: 'Une courte ligne avec le nom.',
          })}
        </div>
        <figure class="pro-preview">
          <figcaption class="smallcaps pro-preview__caption">Aperçu de l’en-tête de votre page</figcaption>
          <div data-region="preview"></div>
        </figure>
        <div class="card pro-wizard__crest">
          ${crestSwitchHtml(s.showCrest !== false, 'Afficher le blason sur ma page')}
        </div>
      </form>`;
  }

  function stepContactHtml(s) {
    return html`
      ${titleHtml('Elles s’affichent sur votre page : vos clients vous trouvent et vous appellent d’un geste. Adresse, ville et téléphone sont indispensables ; l’e-mail et Instagram sont facultatifs.')}
      <form class="card stack pro-form pro-wizard__form" data-form novalidate>
        ${textField({
          name: 'address', label: 'Adresse', value: fieldValue(s.address), placeholder: fieldPlaceholder(s.address, 'Adresse'),
          maxlength: 200, autocomplete: 'street-address', hint: 'Numéro et rue.',
        })}
        ${textField({
          name: 'city', label: 'Ville', value: fieldValue(s.city), placeholder: fieldPlaceholder(s.city, 'Ville'),
          maxlength: 100, autocomplete: 'address-level2',
        })}
        ${textField({
          name: 'phone', label: 'Téléphone du salon', type: 'tel', inputmode: 'tel', value: phoneText(fieldValue(s.phone)),
          placeholder: fieldPlaceholder(s.phone, 'Téléphone'), autocomplete: 'tel', hint: 'Ex. : 06 12 34 56 78',
        })}
        ${textField({
          name: 'email', label: 'E-mail', type: 'email', inputmode: 'email', value: fieldValue(s.email),
          placeholder: fieldPlaceholder(s.email), optional: true, maxlength: 120, autocomplete: 'email',
        })}
        ${textField({
          name: 'instagram', label: 'Instagram', value: fieldValue(s.instagram),
          placeholder: fieldPlaceholder(s.instagram) || '@identifiant ou adresse du profil', optional: true, maxlength: 200,
        })}
      </form>`;
  }

  function stepHoursHtml(s) {
    return html`
      ${titleHtml('Vos clients ne réservent que pendant ces horaires. Depuis l’agenda, vous pourrez toujours ajouter un rendez-vous en dehors.')}
      ${isExampleHours(s.hours) ? html`<div class="notice notice--warn pro-wizard__notice" role="note">${icon('info')}<p>Ces horaires sont des exemples : ajustez-les à ceux de votre salon.</p></div>` : ''}
      <div class="card pro-wizard__hours" data-region="hours">${hoursFieldsHtml(hoursState(s))}</div>`;
  }

  function servicesNoticeHtml() {
    const n = services.filter((x) => x.active && isExampleService(x)).length;
    if (!n) return '';
    return html`<div class="notice notice--warn pro-wizard__notice" role="note">${icon('info')}
      <p>${n > 1 ? `${n} prestations sont marquées « Exemple »` : 'Une prestation est marquée « Exemple »'} : ce sont des tarifs fictifs.
        Touchez-les pour corriger le prix et la durée, ou désactivez celles que vous ne proposez pas.</p></div>`;
  }

  function stepServicesHtml() {
    return html`
      ${titleHtml('Touchez une prestation pour modifier son nom, sa durée ou son prix. Les flèches règlent l’ordre sur votre page. Chaque changement est enregistré aussitôt.')}
      <div data-region="svcnotice">${servicesNoticeHtml()}</div>
      <div class="card pro-wizard__services" data-region="services">${servicesEditor.html()}</div>`;
  }

  function recapRow(label, value, goto) {
    return html`
      <div class="pro-recap__row">
        <dt class="pro-recap__label">${label}</dt>
        <dd class="pro-recap__value">${value}</dd>
        <dd class="pro-recap__edit"><button type="button" class="btn btn--ghost btn--sm" data-goto="${goto}" aria-label="Modifier : ${label.toLowerCase()}">Modifier</button></dd>
      </div>`;
  }

  function stepRecapHtml(s) {
    const todo = html`<span class="todo">À compléter</span>`;
    const none = html`<span class="pro-recap__none">Non renseigné</span>`;
    const val = (v, required) => (isPlaceholder(v) ? (required ? todo : none) : v);
    const active = services.filter((x) => x.active);
    const examples = active.filter(isExampleService).length;
    const url = bookingUrl();
    return html`
      ${titleHtml('Vérifiez une dernière fois. Tout reste modifiable ensuite dans Réglages.')}
      <div data-region="finish-error"></div>
      <dl class="card pro-recap">
        ${recapRow('Nom du salon', displayName(s) || todo, 1)}
        ${recapRow('Accroche', val(s.tagline, false), 1)}
        ${recapRow('Blason', s.showCrest !== false ? 'Affiché sur votre page' : 'Masqué : votre nom s’affiche en grand', 1)}
        ${recapRow('Adresse', val(s.address, true), 2)}
        ${recapRow('Ville', val(s.city, true), 2)}
        ${recapRow('Téléphone', isPlaceholder(s.phone) ? todo : phoneText(s.phone), 2)}
        ${recapRow('E-mail', val(s.email, false), 2)}
        ${recapRow('Instagram', val(s.instagram, false), 2)}
        ${recapRow('Horaires', html`<span class="pro-recap__hours">${hoursSummary(s.hours).map((r) => html`
          <span class="pro-recap__hour"><span class="pro-recap__days">${r.days}</span>
            <span class="pro-recap__times">${r.text.split(' · ').map((t, i) => html`${i ? ' · ' : ''}<span class="nowrap">${t}</span>`)}</span></span>`)}</span>`, 3)}
        ${recapRow('Prestations', html`${active.length ? plural(active.length, 'prestation proposée', 'prestations proposées') : 'Aucune prestation proposée'}
          ${examples ? html`<span class="pro-recap__warn">dont ${examples} au tarif d’exemple, à vérifier</span>` : ''}`, 4)}
      </dl>
      <section class="card pro-recap__share" aria-labelledby="pro-recap-lien">
        <h3 class="card__title" id="pro-recap-lien">Votre page de réservation</h3>
        <p class="card__meta">À mettre dans la bio Instagram, sur la fiche Google, ou à envoyer par SMS.</p>
        <input class="field__input pro-url" type="url" readonly value="${url}" aria-label="Lien de votre page de réservation" data-url>
        <div class="pro-actions-row">
          <a class="btn btn--accent" href="../" target="_blank" rel="noopener">${icon('ecran-accueil')}<span>Voir ma page de réservation</span></a>
          <button type="button" class="btn" data-act="share-link">${icon('partage')}<span>Partager le lien</span></button>
        </div>
      </section>`;
  }

  function barHtml() {
    const prev = step > 1
      ? html`<button type="button" class="btn btn--ghost pro-wizard__prev" data-act="prev">${icon('chevron-gauche')}<span class="pro-wizard__prevtext">Précédent</span></button>`
      : '';
    if (step === STEPS.length) {
      return html`${prev}<button type="button" class="btn btn--primary btn--lg pro-wizard__next" data-act="finish">${icon('coche')}<span>Terminer</span></button>`;
    }
    return html`${prev}
      <button type="button" class="btn btn--ghost pro-wizard__skip" data-act="skip">Passer</button>
      <button type="button" class="btn btn--primary btn--lg pro-wizard__next" data-act="next"><span>Suivant</span>${icon('chevron-droite')}</button>`;
  }

  /* — Affichage — */

  function renderPreview() {
    const el = region('preview');
    const form = root && root.querySelector('[data-form]');
    if (!el || !form) return;
    const get = (n) => form.querySelector(`[name="${n}"]`);
    // Nom laissé vide : la page affichera ce qui est enregistré (le marqueur, tant qu'il n'est pas choisi).
    const typed = get('name').value;
    render(el, previewHtml({
      name: typed.trim() ? typed : salon.name,
      tagline: get('tagline').value,
      showCrest: get('showCrest').checked,
    }));
  }

  function renderSubtitle() {
    const el = region('subtitle');
    const name = salonName(salon);
    if (el) el.textContent = name ? `Configuration de ${name}` : 'Configuration de votre salon';
  }

  /** Données dont dépend l'affichage de l'étape. */
  function stepKey() {
    const s = salon || {};
    if (step === 1) return JSON.stringify([s.name, s.tagline, s.showCrest]);
    if (step === 2) return JSON.stringify([s.address, s.city, s.phone, s.email, s.instagram]);
    if (step === 3) return JSON.stringify(s.hours);
    return JSON.stringify([s, services]);
  }

  /** Dessine l'étape à partir des données enregistrées, puis remet le brouillon éventuel. */
  function renderStep() {
    const host = region('step');
    if (!host || !salon) return;
    const views = [stepSalonHtml, stepContactHtml, stepHoursHtml, stepServicesHtml, stepRecapHtml];
    render(host, views[step - 1](salon));
    if (step === 1) renderPreview();
    const ih = inputHost();
    initial = ih ? formSnapshot(ih) : '';
    if (drafts[step]) applyDraft(drafts[step]);
    shownKey = stepKey();
  }

  function renderChrome() {
    const pole = region('pole');
    if (pole) {
      pole.style.setProperty('--progress', (step / STEPS.length).toFixed(4));
      pole.setAttribute('aria-valuenow', String(step));
      pole.setAttribute('aria-valuetext', `Étape ${step} sur ${STEPS.length} : ${STEPS[step - 1]}`);
    }
    const label = region('steplabel');
    if (label) render(label, html`<span class="pro-wizard__stepnum">Étape ${step}/${STEPS.length}</span> · ${STEPS[step - 1]}`);
    render(region('bar'), barHtml());
  }

  function showStep({ focus = false } = {}) {
    renderChrome();
    renderStep();
    if (focus) {
      window.scrollTo(0, 0);
      const field = focusField && root.querySelector(`[name="${focusField}"]`);
      const title = root.querySelector('[data-step-title]');
      if (field) field.focus();
      else if (title) title.focus({ preventScroll: true });
      announce(`Étape ${step} sur ${STEPS.length} : ${STEPS[step - 1]}`);
    }
    focusField = '';
  }

  /** Données relues (enregistrement, autre onglet…) : l'étape suit, sauf saisie en cours. */
  function refreshStep() {
    if (!salon || isDirty()) return;
    if (step === 4) {
      servicesEditor.render();
      render(region('svcnotice'), servicesNoticeHtml());
      shownKey = stepKey();
      return;
    }
    if (stepKey() === shownKey) return;
    const active = document.activeElement;
    const goto = active && root.contains(active) && active.dataset ? active.dataset.goto : '';
    renderStep();
    if (goto) {
      const again = root.querySelector(`[data-goto="${goto}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  async function load({ initial: first = false } = {}) {
    const mine = ++seq;
    try {
      const [s, list] = await Promise.all([loadSalon(), store.listServices({ includeInactive: true })]);
      if (mine !== seq || !root) return;
      salon = s;
      services = list;
      servicesEditor.setList(list);
      renderSubtitle();
      if (first) showStep();
      else refreshStep();
    } catch (err) {
      if (mine !== seq || !root) return;
      if (first) {
        render(region('step'), html`<div class="empty">
          <div class="empty__icon">${icon('alerte')}</div>
          <p class="empty__title">Chargement impossible</p>
          <p class="empty__text">Vérifiez la connexion puis réessayez.</p>
          <div class="empty__actions"><button type="button" class="btn btn--primary" data-act="retry">Réessayer</button></div></div>`);
      }
      showError(err);
    }
  }

  /* — Navigation entre les étapes — */

  function goStep(n) {
    nav.go(`#/bienvenue/${parseStep(n)}`, { replace: true });
  }

  /** Enregistre (bouton occupé pendant l'écriture) ; → vrai si c'est fait. quiet : sans message (Terminer a le sien). */
  async function save(btn, patch, form, { quiet = false } = {}) {
    busy = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      salon = await store.updateSalon(patch);
      renderSubtitle();
      if (!quiet) toast('Enregistré.', { type: 'success', duration: 1800 });
      return true;
    } catch (err) {
      if (form && err && err.code === 'INVALID' && err.details && err.details.errors) setFieldErrors(form, err.details.errors);
      else showError(err);
      return false;
    } finally {
      busy = false;
      btn.removeAttribute('aria-busy');
    }
  }

  /** Suivant : enregistre l'étape si elle a changé (validation des champs), puis avance. */
  async function next(btn) {
    if (busy || !salon) return;
    if (step === 1 || step === 2) {
      const form = inputHost();
      if (isDirty()) {
        const patch = salonPatch(salon, readValues());
        const check = validateSalonPatch(patch);
        if (!check.ok) {
          setFieldErrors(form, check.errors);
          return;
        }
        setFieldErrors(form, {}, { focus: false });
        if (Object.keys(patch).length && !(await save(btn, patch, form))) return;
      }
    } else if (step === 3 && isDirty()) {
      const hours = checkHoursForm(region('hours'));
      if (!hours || !(await save(btn, { hours }, null))) return;
    }
    delete drafts[step];
    initial = inputHost() ? formSnapshot(inputHost()) : '';
    goStep(step + 1);
  }

  /** Passer : l'étape n'est pas enregistrée (confirmation si quelque chose a été saisi). */
  async function skip() {
    if (busy) return;
    if (isDirty()) {
      const ok = await confirmDialog({
        title: 'Passer cette étape ?',
        message: 'Ce que vous venez de saisir à cette étape ne sera pas enregistré.',
        confirmLabel: 'Passer sans enregistrer',
        cancelLabel: 'Rester',
        danger: true,
      });
      if (!ok || !root) return;
    }
    delete drafts[step];
    initial = inputHost() ? formSnapshot(inputHost()) : '';
    goStep(step + 1);
  }

  /** Terminer : exige un nom de salon, enregistre setupDone, revient à l'agenda. */
  async function finish(btn) {
    if (busy || !salon) return;
    if (!displayName(salon)) {
      render(region('finish-error'), html`
        <div class="notice notice--danger pro-wizard__notice" role="alert">${icon('alerte')}
          <div class="stack stack--sm">
            <p><strong class="notice__title">Il manque le nom de votre salon.</strong>
              Il s’affiche en haut de votre page de réservation : indiquez-le pour terminer.</p>
            <button type="button" class="btn btn--sm pro-wizard__fix" data-goto="1" data-focus="name">Indiquer le nom</button>
          </div>
        </div>`);
      const fix = root.querySelector('.pro-wizard__fix');
      if (fix) {
        fix.scrollIntoView({ block: 'center', behavior: 'smooth' });
        fix.focus({ preventScroll: true });
      }
      return;
    }
    if (!(await save(btn, { setupDone: true }, null, { quiet: true }))) return;
    for (const k of Object.keys(drafts)) delete drafts[k];
    const left = salonTodo(salon);
    toast(left.length
      ? `C’est noté. Reste à compléter : ${left.map((t) => t.label.toLowerCase()).join(', ')}.`
      : 'Votre salon est configuré : votre page de réservation est à jour.', { type: 'success' });
    nav.go('#/agenda', { replace: true });
  }

  function later() {
    captureDraft();
    nav.go('#/agenda', { replace: true });
  }

  /* — Événements — */

  function onClick(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || !root) return;
    if (step === 4 && servicesEditor.handleClick(t)) return;
    const go = t.closest('[data-goto]');
    if (go) {
      focusField = go.dataset.focus || '';
      goStep(Number(go.dataset.goto));
      return;
    }
    const btn = t.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'next') next(btn);
    else if (act === 'skip') skip();
    else if (act === 'prev') goStep(step - 1);
    else if (act === 'finish') finish(btn);
    else if (act === 'later') later();
    else if (act === 'retry') load({ initial: true });
    else if (act === 'share-link') {
      if (canShare()) shareBookingLink(salon);
      else copyBookingLink(root.querySelector('[data-url]'));
    } else if (act === 'add-range' || act === 'remove-range') {
      const wd = btn.closest('[data-wd]').dataset.wd;
      const host = region('hours');
      render(host, hoursFieldsHtml(changeRanges(readHoursState(host), wd, act)));
      focusAfterRangeChange(host, wd, act);
    }
  }

  function onEdit(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.matches('[data-open]')) toggleHoursDay(t);
    if (step === 1 && t.closest('[data-form]')) renderPreview();
  }

  function onSubmit(e) {
    e.preventDefault();
    const btn = root && root.querySelector('[data-act="next"]');
    if (btn) next(btn);
  }

  /* — Cycle de vie — */

  return {
    mount(el, params = {}) {
      root = el;
      step = parseStep(params.step);
      writeSS(ASSISTANT_SEEN_KEY, '1');
      document.title = 'Configuration du salon — Agenda';
      render(root, shellHtml());
      renderChrome();
      root.addEventListener('click', onClick);
      root.addEventListener('input', onEdit);
      root.addEventListener('change', onEdit);
      root.addEventListener('submit', onSubmit);
      load({ initial: true });
    },
    update(params = {}) {
      const n = parseStep(params.step);
      if (n === step) return;
      captureDraft();
      step = n;
      showStep({ focus: true });
    },
    refresh() {
      load();
    },
    /** Saisie non enregistrée dans l'étape (main.js demande avant de quitter par un lien). */
    isDirty() {
      return isDirty();
    },
    /** Quitter sans enregistrer : le brouillon de l'étape est abandonné. */
    discard() {
      delete drafts[step];
      const host = inputHost();
      initial = host ? formSnapshot(host) : '';
    },
    unmount() {
      seq++;
      if (root) {
        captureDraft();
        root.removeEventListener('click', onClick);
        root.removeEventListener('input', onEdit);
        root.removeEventListener('change', onEdit);
        root.removeEventListener('submit', onSubmit);
      }
      root = null;
    },
  };
}
