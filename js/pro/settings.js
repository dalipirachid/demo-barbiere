/**
 * Réglages (#/reglages) : salon, horaires, prestations, réservation en ligne,
 * lien à partager, installation, compte / démo.
 * Chaque section s'enregistre séparément (bouton explicite + toast) ; une
 * section en cours de modification n'est pas redessinée par les
 * rafraîchissements automatiques. Quitter l'écran avec des modifications non
 * enregistrées : main.js demande confirmation (onglets, liens) ; après un
 * Retour, la saisie est remise au prochain affichage.
 */

import { html, render, icon, openSheet, confirmDialog, toast } from '../ui/dom.js';
import { fmtDuration, fmtPrice, fmtClock, minutesOf, hhmm } from '../core/dates.js';
import { validateSalonPatch, validateService } from '../core/validate.js';
import { setupInstall } from '../ui/pwa.js';
import {
  store, isRemote, loadSalon, nav, bool, uid, textField, setFieldErrors, showError, loaderHtml,
  phoneText, bookingUrl, parsePrice, priceInput, formSnapshot, confirmDiscard,
} from './shared.js';

const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const DURATIONS = [15, 20, 30, 45, 60, 75, 90];

const NOTICE_OPTIONS = [[0, 'Aucun délai'], [30, '30 min'], [60, '1 h'], [120, '2 h'], [180, '3 h'],
  [360, '6 h'], [720, '12 h'], [1440, '24 h (la veille)'], [2880, '48 h']];
const HORIZON_OPTIONS = [[7, '1 semaine'], [14, '2 semaines'], [21, '3 semaines'], [30, '30 jours'],
  [45, '45 jours'], [60, '2 mois'], [90, '3 mois']];
const STEP_OPTIONS = [[10, 'Toutes les 10 min'], [15, 'Toutes les 15 min'], [20, 'Toutes les 20 min'],
  [30, 'Toutes les 30 min'], [45, 'Toutes les 45 min'], [60, 'Toutes les heures']];
// Sections modifiées et non enregistrées quand l'écran a été quitté sans passer
// par la confirmation (Retour Android…) : remises au prochain affichage.
let draft = null;            // { salon?: { champ: valeur }, hours?: état, booking?: { champ: valeur } }

const CANCEL_OPTIONS = [[0, 'Jusqu’au dernier moment'], [1, 'Jusqu’à 1 h avant'], [2, 'Jusqu’à 2 h avant'],
  [3, 'Jusqu’à 3 h avant'], [6, 'Jusqu’à 6 h avant'], [12, 'Jusqu’à 12 h avant'],
  [24, 'Jusqu’à 24 h avant (la veille)'], [48, 'Jusqu’à 48 h avant']];

/** <select> avec la valeur actuelle garantie parmi les options. */
function selectHtml({ name, label, value, options, hint = '', unit = '' }) {
  const id = uid(name);
  const list = options.some(([v]) => v === Number(value)) ? options.slice() : [...options, [Number(value), `${value}${unit}`]];
  return html`
    <div class="field" data-field="${name}">
      <label class="field__label" for="${id}">${label}</label>
      <select class="field__select" id="${id}" name="${name}">
        ${list.sort((a, b) => a[0] - b[0]).map(([v, text]) => html`<option value="${v}" ${v === Number(value) ? 'selected' : ''}>${text}</option>`)}
      </select>
      ${hint ? html`<p class="field__hint">${hint}</p>` : ''}
      <p class="field__error"></p>
    </div>`;
}

function saveBar(section, label) {
  return html`
    <div class="pro-savebar">
      <span class="pro-savebar__state" data-state="${section}" aria-live="polite"></span>
      <button type="button" class="btn btn--primary" data-act="save-${section}">${icon('coche')}<span>${label}</span></button>
    </div>`;
}

export function createSettingsView() {
  let root = null;
  let salon = null;
  let services = [];
  let seq = 0;
  const dirty = { salon: false, hours: false, booking: false };
  const install = setupInstall({ mode: 'pro' });
  let offInstall = null;

  const region = (name) => root && root.querySelector(`[data-region="${name}"]`);

  /* — Salon — */

  function salonHtml(s) {
    return html`
      <h2 class="card__title">Le salon</h2>
      <p class="card__meta">Ces informations s’affichent sur la page de réservation.</p>
      <form class="stack pro-form pro-section__form" data-section="salon" novalidate>
        ${textField({ name: 'name', label: 'Nom du salon', value: s.name, maxlength: 100, required: true, autocomplete: 'organization' })}
        ${textField({ name: 'tagline', label: 'Accroche', value: s.tagline, optional: true, maxlength: 160, placeholder: 'Ex. : Barbière' })}
        ${textField({ name: 'address', label: 'Adresse', value: s.address, optional: true, maxlength: 200, autocomplete: 'street-address' })}
        ${textField({ name: 'city', label: 'Ville', value: s.city, optional: true, maxlength: 100, autocomplete: 'address-level2' })}
        <div class="field-row">
          ${textField({ name: 'phone', label: 'Téléphone', type: 'tel', inputmode: 'tel', value: phoneText(s.phone), optional: true, autocomplete: 'tel' })}
          ${textField({ name: 'email', label: 'E-mail', type: 'email', inputmode: 'email', value: s.email, optional: true, maxlength: 120, autocomplete: 'email' })}
        </div>
        ${textField({ name: 'instagram', label: 'Instagram', value: s.instagram, optional: true, maxlength: 200, placeholder: '@identifiant ou adresse du profil' })}
        ${textField({
          name: 'notice', label: 'Message d’information aux clients', value: s.notice, optional: true, multiline: true, maxlength: 1000,
          hint: 'Affiché en haut de la page de réservation (congés, fermeture exceptionnelle…). Laissez vide pour ne rien afficher.',
          placeholder: 'Ex. : Le salon sera fermé du 20 au 27 octobre.',
        })}
      </form>
      ${saveBar('salon', 'Enregistrer le salon')}`;
  }

  async function saveSalon(btn) {
    const form = region('salon').querySelector('form');
    const get = (n) => form.querySelector(`[name="${n}"]`).value;
    const patch = {
      name: get('name'), tagline: get('tagline'), address: get('address'), city: get('city'),
      phone: get('phone'), email: get('email'), instagram: get('instagram'), notice: get('notice'),
    };
    const check = validateSalonPatch(patch);
    if (!check.ok) {
      setFieldErrors(form, check.errors);
      return;
    }
    setFieldErrors(form, {}, { focus: false });
    await runSave(btn, 'salon', async () => {
      try {
        await store.updateSalon(patch);
      } catch (err) {
        if (err && err.code === 'INVALID' && err.details && err.details.errors) {
          setFieldErrors(form, err.details.errors);
          return false;
        }
        throw err;
      }
      toast('Informations du salon enregistrées.', { type: 'success' });
      return true;
    });
  }

  /* — Horaires — */

  function hoursFromSalon(s) {
    const out = {};
    for (let d = 1; d <= 7; d++) out[d] = ((s.hours && s.hours[String(d)]) || []).map((r) => [r[0], r[1]]);
    return out;
  }

  /** Lit l'état saisi dans la section (y compris les jours fermés, pour garder les heures). */
  function readHours() {
    const out = {};
    for (const fs of region('hours').querySelectorAll('[data-wd]')) {
      const open = fs.querySelector('[data-open]').checked;
      const ranges = [...fs.querySelectorAll('[data-range]')].map((r) => [
        r.querySelector('[data-from]').value, r.querySelector('[data-to]').value,
      ]);
      out[fs.dataset.wd] = { open, ranges };
    }
    return out;
  }

  function hoursHtml(state) {
    return html`
      <h2 class="card__title">Horaires d’ouverture</h2>
      <p class="card__meta">Les clients ne réservent que dans ces horaires. Depuis l’agenda, vous pouvez toujours ajouter un rendez-vous en dehors.</p>
      <div class="pro-hours" data-section="hours">
        ${DAYS.map((name, i) => {
          const wd = String(i + 1);
          const day = state[wd];
          return html`
            <fieldset class="pro-hours__day" data-wd="${wd}">
              <legend class="sr-only">${name}</legend>
              <label class="switch">
                <span class="switch__label">${name}
                  <span class="switch__hint">${day.open ? day.ranges.map((r) => `${r[0] ? fmtClock(r[0]) : '…'} – ${r[1] ? fmtClock(r[1]) : '…'}`).join(' · ') : 'Fermé'}</span></span>
                <input class="switch__input" type="checkbox" role="switch" data-open ${day.open ? 'checked' : ''} aria-label="${name} : ouvert">
                <span class="switch__track" aria-hidden="true"></span>
              </label>
              <div class="pro-hours__ranges" ${day.open ? '' : 'hidden'}>
                ${day.ranges.map((r, k) => html`
                  <div class="pro-hours__range" data-range="${k}">
                    <input class="field__input" type="time" step="300" data-from value="${r[0]}" aria-label="${name}, plage ${k + 1} : ouverture">
                    <span class="pro-hours__sep" aria-hidden="true">à</span>
                    <input class="field__input" type="time" step="300" data-to value="${r[1]}" aria-label="${name}, plage ${k + 1} : fermeture">
                    ${k > 0 ? html`<button type="button" class="icon-btn icon-btn--sm" data-act="remove-range" aria-label="Retirer la 2e plage du ${name.toLowerCase()}">${icon('croix')}</button>` : html`<span class="pro-hours__spacer" aria-hidden="true"></span>`}
                  </div>`)}
                ${day.ranges.length < 2 ? html`<button type="button" class="btn btn--ghost btn--sm pro-linkbtn" data-act="add-range">${icon('plus')}<span>Ajouter une 2e plage (après une pause)</span></button>` : ''}
              </div>
              <p class="field__error" data-err role="alert"></p>
            </fieldset>`;
        })}
      </div>
      ${saveBar('hours', 'Enregistrer les horaires')}`;
  }

  function renderHours(state) {
    render(region('hours'), hoursHtml(state));
  }

  function stateFromHours(hours) {
    const st = {};
    for (let d = 1; d <= 7; d++) st[d] = { open: hours[d].length > 0, ranges: hours[d].length ? hours[d] : [['09:00', '19:00']] };
    return st;
  }

  /** Contrôle de cohérence ; → { hours } ou null (erreurs affichées jour par jour). */
  function checkHours() {
    const state = readHours();
    const hours = {};
    let firstBad = null;
    for (const fs of region('hours').querySelectorAll('[data-wd]')) {
      const { open, ranges } = state[fs.dataset.wd];
      const errEl = fs.querySelector('[data-err]');
      let msg = '';
      if (open) {
        const mins = ranges.map(([o, c]) => [minutesOf(o), minutesOf(c)]);
        if (mins.some(([o, c]) => !Number.isFinite(o) || !Number.isFinite(c))) msg = 'Indiquez l’heure d’ouverture et de fermeture.';
        else if (mins.some(([o, c]) => c <= o)) msg = 'La fermeture doit être après l’ouverture.';
        else {
          mins.sort((a, b) => a[0] - b[0]);
          if (mins.length === 2 && mins[1][0] < mins[0][1]) msg = 'Les deux plages se chevauchent : la 2e doit commencer après la fin de la 1re.';
          else hours[fs.dataset.wd] = mins.map(([o, c]) => [hhmm(o), hhmm(c)]);
        }
      } else {
        hours[fs.dataset.wd] = [];
      }
      errEl.textContent = msg;
      if (msg && !firstBad) firstBad = fs;
    }
    if (firstBad) {
      const input = firstBad.querySelector('input[type="time"]');
      if (input) input.focus();
      return null;
    }
    return hours;
  }

  async function saveHours(btn) {
    const hours = checkHours();
    if (!hours) return;
    await runSave(btn, 'hours', async () => {
      await store.updateSalon({ hours });
      toast('Horaires enregistrés.', { type: 'success' });
      return true;
    });
  }

  function onHoursAction(act, btn) {
    const state = readHours();
    const fs = btn.closest('[data-wd]');
    const wd = fs.dataset.wd;
    if (act === 'add-range') {
      const last = state[wd].ranges[state[wd].ranges.length - 1];
      const end = minutesOf(last[1]);
      const from = Number.isFinite(end) ? Math.min(end + 60, 23 * 60) : 14 * 60;
      state[wd].ranges.push([hhmm(from), hhmm(Math.min(from + 240, 23 * 60 + 55))]);
    } else if (act === 'remove-range') {
      state[wd].ranges = state[wd].ranges.slice(0, 1);
    }
    renderHours(state);
    markDirty('hours');
    const again = region('hours').querySelector(`[data-wd="${wd}"]`);
    const focusEl = act === 'add-range'
      ? again.querySelector('[data-range="1"] [data-from]')
      : again.querySelector('[data-act="add-range"]');
    if (focusEl) focusEl.focus();
  }

  /* — Prestations — */

  function servicesHtml(list) {
    return html`
      <h2 class="card__title">Prestations</h2>
      <p class="card__meta">L’ordre ci-dessous est celui de la page de réservation. Les tarifs de démonstration sont à confirmer.</p>
      <ul class="list pro-services">
        ${list.map((s, i) => html`
          <li class="pro-svc${s.active ? '' : ' is-inactive'}">
            <button type="button" class="list__item pro-svc__main" data-svc="${s.id}">
              <span class="list__main">
                <span class="list__title">${s.name}</span>
                <span class="list__meta">${s.category ? `${s.category} · ` : ''}${fmtDuration(s.durationMin)} · ${fmtPrice(s.priceCents)}</span>
              </span>
              ${s.active ? '' : html`<span class="badge">Désactivée</span>`}
              ${icon('crayon')}
            </button>
            <div class="pro-svc__order">
              <button type="button" class="icon-btn icon-btn--sm" data-move="-1" data-id="${s.id}" aria-label="Monter « ${s.name} »" ${i === 0 ? 'disabled' : ''}>${icon('chevron-bas', { className: 'pro-flip' })}</button>
              <button type="button" class="icon-btn icon-btn--sm" data-move="1" data-id="${s.id}" aria-label="Descendre « ${s.name} »" ${i === list.length - 1 ? 'disabled' : ''}>${icon('chevron-bas')}</button>
            </div>
          </li>`)}
      </ul>
      <button type="button" class="btn btn--block" data-act="add-service">${icon('plus')}<span>Ajouter une prestation</span></button>`;
  }

  async function moveService(id, dir) {
    const i = services.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= services.length) return;
    const list = services.slice();
    [list[i], list[j]] = [list[j], list[i]];
    services = list;
    render(region('services'), servicesHtml(services));
    const again = region('services').querySelector(`[data-move="${dir}"][data-id="${CSS.escape(id)}"]`);
    const other = region('services').querySelector(`[data-move="${-dir}"][data-id="${CSS.escape(id)}"]`);
    if (again && !again.disabled) again.focus();
    else if (other) other.focus();
    try {
      await store.reorderServices(services.map((s) => s.id));
      toast('Ordre des prestations enregistré.', { type: 'success', duration: 2000 });
    } catch (err) {
      showError(err);
      load();
    }
  }

  function openServiceSheet(svc) {
    const isNew = !svc;
    let duration = svc ? Number(svc.durationMin) : 30;
    let custom = !DURATIONS.includes(duration);
    const dlId = uid('categories');
    const durId = uid('duree');
    const categories = [...new Set(services.map((s) => s.category).filter(Boolean))];
    let initial = null;
    const isDirty = () => initial !== null && formSnapshot(sheet.body.querySelector('form')) !== initial;

    const sheet = openSheet({
      title: isNew ? 'Nouvelle prestation' : 'Modifier la prestation',
      className: 'pro-sheet',
      content: html`
        <form class="stack pro-form" novalidate>
          ${svc && !svc.active ? html`<div class="notice notice--warn" role="status">${icon('info')}<p>Cette prestation est désactivée : elle n’est plus proposée aux clients.</p></div>` : ''}
          ${textField({ name: 'name', label: 'Nom', value: svc ? svc.name : '', maxlength: 80, required: true, placeholder: 'Ex. : Coupe homme' })}
          <div class="field" data-field="category">
            <label class="field__label" for="${dlId}-in">Catégorie <span class="field__optional">(facultatif)</span></label>
            <input class="field__input" id="${dlId}-in" name="category" type="text" list="${dlId}" maxlength="40" value="${svc ? svc.category : ''}" placeholder="Ex. : Coupe, Barbe, Enfant" autocomplete="off">
            <datalist id="${dlId}">${categories.map((c) => html`<option value="${c}"></option>`)}</datalist>
            <p class="field__error"></p>
          </div>
          ${textField({ name: 'description', label: 'Description', value: svc ? svc.description : '', optional: true, multiline: true, maxlength: 300 })}
          <div class="field" data-field="durationMin">
            <p class="field__label" id="${durId}">Durée</p>
            <div class="chips pro-chips-wrap" role="group" aria-labelledby="${durId}">
              ${DURATIONS.map((m) => html`<button type="button" class="chip" data-dur="${m}" aria-pressed="${bool(!custom && m === duration)}">${fmtDuration(m)}</button>`)}
              <button type="button" class="chip" data-dur="autre" aria-pressed="${bool(custom)}">Autre</button>
            </div>
            <div class="pro-durfree" ${custom ? '' : 'hidden'}>
              <label class="field__label" for="${durId}-in">Durée en minutes</label>
              <input class="field__input" id="${durId}-in" name="durationFree" type="number" inputmode="numeric" min="5" max="480" step="5" value="${duration}">
            </div>
            <p class="field__error"></p>
          </div>
          ${textField({ name: 'priceCents', label: 'Prix (en euros)', value: svc ? priceInput(svc.priceCents) : '', inputmode: 'decimal', placeholder: 'Ex. : 22 ou 22,50', hint: 'Virgule acceptée.' })}
        </form>`,
      beforeClose: confirmDiscard(isDirty),
      actions: [
        { label: 'Fermer', variant: 'ghost', onClick: confirmDiscard(isDirty) },
        ...(isNew ? [] : [svc.active
          ? { label: 'Désactiver', variant: 'danger', onClick: () => deactivate(svc) }
          : { label: 'Réactiver', variant: '', onClick: () => reactivate(svc) }]),
        { label: 'Enregistrer', variant: 'primary', onClick: () => save() },
      ],
    });
    const form = sheet.body.querySelector('form');
    form.addEventListener('submit', (e) => e.preventDefault());
    initial = formSnapshot(form);
    form.addEventListener('click', (e) => {
      const chip = e.target instanceof Element ? e.target.closest('[data-dur]') : null;
      if (!chip) return;
      custom = chip.dataset.dur === 'autre';
      if (!custom) duration = Number(chip.dataset.dur);
      for (const c of form.querySelectorAll('[data-dur]')) c.setAttribute('aria-pressed', bool(c === chip));
      const free = form.querySelector('.pro-durfree');
      free.hidden = !custom;
      if (custom) {
        const input = free.querySelector('input');
        input.value = String(duration);
        input.focus();
      }
    });

    async function save() {
      const get = (n) => form.querySelector(`[name="${n}"]`).value;
      const minutes = custom ? Number(get('durationFree')) : duration;
      const cents = parsePrice(get('priceCents'));
      const data = {
        name: get('name'),
        category: get('category'),
        description: get('description'),
        durationMin: minutes,
        priceCents: cents === null ? NaN : cents,
      };
      if (!isNew) data.id = svc.id;
      const check = validateService(data, { partial: false });
      if (!check.ok) {
        setFieldErrors(form, check.errors);
        return false;
      }
      if (!isNew) check.value.active = svc.active;
      try {
        await store.saveService(isNew ? check.value : { ...check.value, id: svc.id });
      } catch (err) {
        if (err && err.code === 'INVALID' && err.details && err.details.errors) {
          setFieldErrors(form, err.details.errors);
          return false;
        }
        showError(err);
        return false;
      }
      toast(isNew ? 'Prestation ajoutée.' : 'Prestation enregistrée.', { type: 'success' });
      return true;
    }
  }

  async function deactivate(svc) {
    const ok = await confirmDialog({
      title: `Désactiver « ${svc.name} » ?`,
      message: 'Elle ne sera plus proposée aux clients ni dans l’agenda. Les rendez-vous déjà pris et l’historique gardent son nom. Vous pourrez la réactiver.',
      confirmLabel: 'Désactiver',
      cancelLabel: 'Garder',
      danger: true,
    });
    if (!ok) return false;
    try {
      await store.deleteService(svc.id);
      toast(`« ${svc.name} » est désactivée.`, { type: 'success' });
      return true;
    } catch (err) {
      showError(err);
      return false;
    }
  }

  async function reactivate(svc) {
    try {
      await store.saveService({ id: svc.id, active: true });
      toast(`« ${svc.name} » est de nouveau proposée.`, { type: 'success' });
      return true;
    } catch (err) {
      showError(err);
      return false;
    }
  }

  /* — Réservation en ligne — */

  function bookingHtml(s) {
    return html`
      <h2 class="card__title">Réservation en ligne</h2>
      <form class="stack pro-form" data-section="booking" novalidate>
        <label class="switch">
          <span class="switch__label">Accepter les réservations en ligne
            <span class="switch__hint">${s.bookingEnabled ? 'Les clients réservent depuis votre lien.' : 'Suspendue : la page invite à appeler le salon.'}</span></span>
          <input class="switch__input" type="checkbox" role="switch" name="bookingEnabled" ${s.bookingEnabled ? 'checked' : ''}>
          <span class="switch__track" aria-hidden="true"></span>
        </label>
        ${selectHtml({ name: 'minNoticeMin', label: 'Délai minimum avant un rendez-vous', value: s.minNoticeMin, options: NOTICE_OPTIONS, unit: ' min', hint: 'Évite les réservations de dernière minute.' })}
        ${selectHtml({ name: 'maxDaysAhead', label: 'Réservation possible jusqu’à', value: s.maxDaysAhead, options: HORIZON_OPTIONS, unit: ' jours', hint: 'Au-delà, les jours ne sont pas encore ouverts.' })}
        ${selectHtml({ name: 'slotStep', label: 'Créneaux proposés', value: s.slotStep, options: STEP_OPTIONS, unit: ' min' })}
        ${selectHtml({ name: 'cancelLimitHours', label: 'Annulation en ligne', value: s.cancelLimitHours, options: CANCEL_OPTIONS, unit: ' h', hint: 'Passé ce délai, le client doit vous appeler.' })}
      </form>
      ${saveBar('booking', 'Enregistrer')}`;
  }

  async function saveBooking(btn) {
    const form = region('booking').querySelector('form');
    const get = (n) => form.querySelector(`[name="${n}"]`);
    const patch = {
      bookingEnabled: get('bookingEnabled').checked,
      minNoticeMin: Number(get('minNoticeMin').value),
      maxDaysAhead: Number(get('maxDaysAhead').value),
      slotStep: Number(get('slotStep').value),
      cancelLimitHours: Number(get('cancelLimitHours').value),
    };
    const check = validateSalonPatch(patch);
    if (!check.ok) {
      setFieldErrors(form, check.errors);
      return;
    }
    await runSave(btn, 'booking', async () => {
      await store.updateSalon(patch);
      toast(patch.bookingEnabled ? 'Réglages de réservation enregistrés.' : 'Réservation en ligne suspendue.', { type: 'success' });
      return true;
    });
  }

  /* — Lien, installation, compte — */

  function shareHtml() {
    const url = bookingUrl();
    const id = uid('lien');
    return html`
      <h2 class="card__title">Partager le lien de réservation</h2>
      <div class="field">
        <label class="field__label" for="${id}">Lien de la page client</label>
        <input class="field__input pro-url" id="${id}" type="url" readonly value="${url}" data-url>
        <p class="field__hint">À mettre dans la bio Instagram, sur la fiche Google, ou à envoyer par SMS.</p>
      </div>
      <div class="pro-actions-row">
        <button type="button" class="btn btn--primary" data-act="copy">${icon('coche')}<span>Copier le lien</span></button>
        ${typeof navigator.share === 'function' ? html`<button type="button" class="btn" data-act="share">${icon('partage')}<span>Partager…</span></button>` : ''}
        <a class="btn btn--ghost" href="${url}" target="_blank" rel="noopener">Voir la page</a>
      </div>`;
  }

  async function copyLink() {
    const url = bookingUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast('Lien copié : collez-le où vous voulez.', { type: 'success' });
      return;
    } catch { /* presse-papiers indisponible : repli ci-dessous */ }
    const input = region('share').querySelector('[data-url]');
    input.focus();
    input.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    toast(ok ? 'Lien copié.' : 'Le lien est sélectionné : copiez-le avec un appui long.', { type: ok ? 'success' : 'info' });
  }

  async function shareLink() {
    try {
      await navigator.share({ title: salon ? salon.name : 'Prendre rendez-vous', text: 'Prenez rendez-vous en ligne :', url: bookingUrl() });
    } catch (err) {
      if (err && err.name !== 'AbortError') toast('Partage impossible sur cet appareil. Copiez plutôt le lien.', { type: 'error' });
    }
  }

  function installHtml() {
    const state = install.state;
    return html`
      <h2 class="card__title">Installer l’agenda</h2>
      ${state === 'installed'
        ? html`<p class="muted">L’agenda est installé sur cet appareil : ouvrez-le depuis l’écran d’accueil.</p>`
        : install.canInstall
          ? html`<p class="muted">Ajoutez l’agenda à l’écran d’accueil : il s’ouvrira d’un geste, comme une appli.</p>
              <button type="button" class="btn btn--primary" data-act="install">${icon('installer')}<span>Installer l’agenda</span></button>`
          : html`<p class="muted">Pour l’installer, ouvrez cette page dans Chrome (Android) ou Safari (iPhone), puis choisissez « Ajouter à l’écran d’accueil ».</p>`}`;
  }

  function accountHtml() {
    if (isRemote) {
      return html`
        <h2 class="card__title">Compte</h2>
        <p class="muted">Vous êtes connectée à l’agenda en ligne.</p>
        <button type="button" class="btn btn--block" data-act="logout">${icon('deconnexion')}<span>Se déconnecter</span></button>`;
    }
    return html`
      <h2 class="card__title">Mode démonstration</h2>
      <p class="muted">Les rendez-vous et les clients sont fictifs et restent seulement sur cet appareil. Rien n’est envoyé sur Internet.</p>
      <button type="button" class="btn btn--danger btn--block" data-act="reset-demo">${icon('poubelle')}<span>Réinitialiser la démo</span></button>`;
  }

  /* — Enregistrement commun — */

  function markDirty(section) {
    if (!(section in dirty)) return;
    dirty[section] = true;
    const state = root.querySelector(`[data-state="${section}"]`);
    if (state && !state.textContent) state.textContent = 'Modifications non enregistrées';
  }

  async function runSave(btn, section, fn) {
    btn.setAttribute('aria-busy', 'true');
    try {
      const ok = await fn();
      if (ok) {
        dirty[section] = false;
        const state = root && root.querySelector(`[data-state="${section}"]`);
        if (state) state.textContent = '';
        load();
      }
    } catch (err) {
      showError(err);
    } finally {
      btn.removeAttribute('aria-busy');
    }
  }

  /** Valeurs saisies des sections modifiées (pour les remettre au prochain affichage). */
  function captureDraft() {
    const out = {};
    const values = (section) => {
      const form = region(section) && region(section).querySelector('form');
      if (!form) return null;
      return Object.fromEntries([...form.querySelectorAll('[name]')]
        .map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.value]));
    };
    if (dirty.salon) out.salon = values('salon');
    if (dirty.hours && region('hours') && region('hours').querySelector('[data-wd]')) out.hours = readHours();
    if (dirty.booking) out.booking = values('booking');
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return Object.keys(out).length ? out : null;
  }

  /* — Chargement — */

  async function load({ initial = false } = {}) {
    const mine = ++seq;
    try {
      const [s, list] = await Promise.all([loadSalon(), store.listServices({ includeInactive: true })]);
      if (mine !== seq || !root) return;
      salon = s;
      services = list;
      // Le focus d'un bouton de la liste des prestations survit au rafraîchissement.
      const active = document.activeElement;
      const svcRegion = region('services');
      const focusSel = active && svcRegion.contains(active)
        ? (active.dataset.move ? `[data-move="${active.dataset.move}"][data-id="${CSS.escape(active.dataset.id)}"]`
          : active.dataset.svc ? `[data-svc="${CSS.escape(active.dataset.svc)}"]` : '')
        : '';
      // Saisie gardée d'un précédent passage : remise telle quelle, toujours « non enregistrée ».
      const kept = draft || {};
      draft = null;
      if (!dirty.salon) {
        render(region('salon'), salonHtml(kept.salon ? { ...s, ...kept.salon } : s));
        if (kept.salon) markDirty('salon');
      }
      if (!dirty.hours) {
        renderHours(kept.hours || stateFromHours(hoursFromSalon(s)));
        if (kept.hours) markDirty('hours');
      }
      render(svcRegion, servicesHtml(services));
      if (focusSel) {
        const again = svcRegion.querySelector(focusSel);
        if (again && !again.disabled) again.focus({ preventScroll: true });
      }
      if (!dirty.booking) {
        const b = kept.booking;
        render(region('booking'), bookingHtml(b ? {
          ...s,
          bookingEnabled: Boolean(b.bookingEnabled),
          minNoticeMin: Number(b.minNoticeMin),
          maxDaysAhead: Number(b.maxDaysAhead),
          slotStep: Number(b.slotStep),
          cancelLimitHours: Number(b.cancelLimitHours),
        } : s));
        if (b) markDirty('booking');
      }
      render(region('share'), shareHtml());
      region('body').removeAttribute('aria-busy');
    } catch (err) {
      if (mine !== seq || !root) return;
      if (initial) render(region('salon'), html`<p class="muted">Chargement impossible. <button type="button" class="btn btn--sm" data-act="retry">Réessayer</button></p>`);
      showError(err);
    }
  }

  /* — Événements — */

  function onClick(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const svcBtn = t.closest('[data-svc]');
    if (svcBtn) {
      openServiceSheet(services.find((s) => s.id === svcBtn.dataset.svc));
      return;
    }
    const mv = t.closest('[data-move]');
    if (mv) {
      moveService(mv.dataset.id, Number(mv.dataset.move));
      return;
    }
    const btn = t.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'retry') load({ initial: true });
    else if (act === 'save-salon') saveSalon(btn);
    else if (act === 'save-hours') saveHours(btn);
    else if (act === 'save-booking') saveBooking(btn);
    else if (act === 'add-range' || act === 'remove-range') onHoursAction(act, btn);
    else if (act === 'add-service') openServiceSheet(null);
    else if (act === 'copy') copyLink();
    else if (act === 'share') shareLink();
    else if (act === 'install') install.prompt();
    else if (act === 'logout') logout();
    else if (act === 'reset-demo') resetDemo();
  }

  function onEdit(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const section = t.closest('[data-section]');
    if (!section) return;
    markDirty(section.dataset.section);
    // Ouvrir / fermer un jour : on affiche ou masque ses plages.
    if (t.matches('[data-open]')) {
      const fs = t.closest('[data-wd]');
      fs.querySelector('.pro-hours__ranges').hidden = !t.checked;
      const hint = fs.querySelector('.switch__hint');
      if (hint) {
        hint.textContent = t.checked
          ? [...fs.querySelectorAll('[data-range]')].map((r) => {
            const o = r.querySelector('[data-from]').value;
            const c = r.querySelector('[data-to]').value;
            return `${o ? fmtClock(o) : '…'} – ${c ? fmtClock(c) : '…'}`;
          }).join(' · ')
          : 'Fermé';
      }
    }
  }

  async function logout() {
    const ok = await confirmDialog({
      title: 'Se déconnecter ?',
      message: 'Il faudra saisir à nouveau l’e-mail et le mot de passe pour revoir l’agenda sur cet appareil.',
      confirmLabel: 'Se déconnecter',
      cancelLabel: 'Rester connectée',
    });
    if (!ok) return;
    try { await store.logout(); } catch { /* session déjà fermée */ }
    nav.loggedOut();
  }

  async function resetDemo() {
    const ok = await confirmDialog({
      title: 'Réinitialiser la démo ?',
      message: 'Tous les rendez-vous, clients et réglages modifiés sur cet appareil seront remplacés par un nouveau jeu de données fictives.',
      confirmLabel: 'Réinitialiser',
      cancelLabel: 'Annuler',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.resetDemo();
    } catch (err) {
      showError(err);
      return;
    }
    dirty.salon = false;
    dirty.hours = false;
    dirty.booking = false;
    toast('Démo réinitialisée : agenda et clients tout neufs.', { type: 'success' });
    nav.go('#/agenda');
  }

  return {
    mount(el) {
      root = el;
      document.title = 'Réglages — Agenda';
      render(root, html`
        <header class="appbar appbar--green">
          <div class="appbar__titles"><h1 class="appbar__title">Réglages</h1><p class="appbar__subtitle">Salon, horaires, prestations</p></div>
        </header>
        <div class="page pro-settings" data-region="body" aria-busy="true">
          <div class="stack stack--lg">
            <section class="card" data-region="salon">${loaderHtml('Chargement des réglages…')}</section>
            <section class="card" data-region="hours"></section>
            <section class="card" data-region="services"></section>
            <section class="card" data-region="booking"></section>
            <section class="card" data-region="share"></section>
            <section class="card" data-region="install">${installHtml()}</section>
            <section class="card" data-region="account">${accountHtml()}</section>
            <p class="center small"><a href="../confidentialite.html">Politique de confidentialité</a></p>
          </div>
        </div>`);
      root.addEventListener('click', onClick);
      root.addEventListener('input', onEdit);
      root.addEventListener('change', onEdit);
      offInstall = install.onChange(() => {
        const r = region('install');
        if (r) render(r, installHtml());
      });
      load({ initial: true });
    },
    refresh() {
      load();
    },
    /** Une section a des modifications non enregistrées (main.js demande avant de quitter). */
    isDirty() {
      return dirty.salon || dirty.hours || dirty.booking;
    },
    /** Quitter sans enregistrer : rien n'est gardé. */
    discard() {
      dirty.salon = false;
      dirty.hours = false;
      dirty.booking = false;
    },
    unmount() {
      seq++;
      if (offInstall) offInstall();
      if (root) {
        draft = captureDraft();
        root.removeEventListener('click', onClick);
        root.removeEventListener('input', onEdit);
        root.removeEventListener('change', onEdit);
      }
      root = null;
    },
  };
}
