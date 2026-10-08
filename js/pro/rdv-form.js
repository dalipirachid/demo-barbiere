/**
 * Nouveau rendez-vous (feuille) et choix du bouton « + ».
 *
 *   openAddChooser({ ymd })                         « Rendez-vous » ou « Bloquer un créneau »
 *   openNewAppointment({ ymd, time, client })       formulaire complet
 *
 * Client existant (recherche instantanée) ou nouveau client : seul le prénom
 * est requis (client de passage). Prestation en pastilles, jour + créneau
 * (ou heure libre), note. Enregistrement → toast + agenda du bon jour.
 */

import { html, render, on, icon, openSheet, toast, announce } from '../ui/dom.js';
import { zonedToUtc, fmtClock, fmtDuration, fmtPrice, fmtDayLong } from '../core/dates.js';
import { validateContact } from '../core/validate.js';
import { createSlotPicker } from './slot-picker.js';
import { openBlockForm } from './block-form.js';
import {
  store, loadSalon, tzOf, bool, uid, fullName, initials, plural, phoneText,
  showError, proMessage, setFieldErrors, textField, loaderHtml, debounce, goToAgenda, confirmDiscard,
} from './shared.js';

/* ==========================================================================
   Bouton « + » : que voulez-vous ajouter ?
   ========================================================================== */

export function openAddChooser({ ymd } = {}) {
  const sheet = openSheet({
    title: 'Ajouter',
    className: 'pro-sheet',
    content: html`
      <div class="stack stack--sm">
        <button type="button" class="card card--interactive pro-choice" data-choice="rdv">
          <span class="pro-choice__icon">${icon('calendrier')}</span>
          <span class="pro-choice__text"><span class="card__title">Rendez-vous</span>
            <span class="card__meta">Pour un client existant ou de passage.</span></span>
        </button>
        <button type="button" class="card card--interactive pro-choice" data-choice="block">
          <span class="pro-choice__icon">${icon('cadenas')}</span>
          <span class="pro-choice__text"><span class="card__title">Bloquer un créneau</span>
            <span class="card__meta">Pause, congés, formation… Personne ne pourra réserver.</span></span>
        </button>
      </div>`,
    actions: [],
  });
  on(sheet.body, 'click', '[data-choice]', (e, btn) => {
    const choice = btn.dataset.choice;
    sheet.close();
    if (choice === 'rdv') openNewAppointment({ ymd });
    else openBlockForm({ ymd });
  });
  return sheet;
}

/* ==========================================================================
   Nouveau rendez-vous
   ========================================================================== */

export function openNewAppointment({ ymd = '', time = '', client = null } = {}) {
  const ids = { form: uid('rdv'), svc: uid('svc'), note: uid('note'), err: uid('err'), search: uid('cherche') };
  let salon = null;
  let services = [];
  let serviceId = '';
  let picker = null;
  let mode = client ? 'picked' : 'search';   // 'search' | 'picked' | 'new'
  let picked = client;
  let found = new Map();
  let searchSeq = 0;
  let offs = [];
  let startDay = '';           // jour du sélecteur à l'ouverture

  const sheet = openSheet({
    title: 'Nouveau rendez-vous',
    className: 'pro-sheet',
    content: loaderHtml(),
    actions: [
      { label: 'Fermer', variant: 'ghost', onClick: confirmDiscard(isDirty) },
      { label: 'Enregistrer', variant: 'primary', icon: 'coche', onClick: () => save() },
    ],
    // Un toucher sur le fond, la croix ou Retour ne perd plus une saisie sans prévenir.
    beforeClose: confirmDiscard(isDirty),
    onClose: () => {
      if (picker) picker.destroy();
      offs.forEach((off) => off());
      search.cancel();
    },
  });
  const body = sheet.body;

  /** Quelque chose a-t-il été saisi ou choisi depuis l'ouverture ? */
  function isDirty() {
    if (!picker) return false;
    const area = clientArea();
    if (mode === 'picked' && picked !== client) return true;
    if (mode !== 'picked' && area && [...area.querySelectorAll('input')].some((i) => i.value.trim())) return true;
    if (services.length && serviceId !== services[0].id) return true;
    const note = body.querySelector(`#${ids.note}`);
    if (note && note.value.trim()) return true;
    const v = picker.value();
    return Boolean(v.time) && (v.time !== time || v.ymd !== startDay);
  }

  /* — Client — */

  function clientArea() {
    return body.querySelector('[data-client]');
  }

  function renderClient() {
    const area = clientArea();
    if (!area) return;
    if (mode === 'picked' && picked) {
      render(area, html`
        <div class="card card--flat pro-picked">
          <span class="avatar" aria-hidden="true">${initials(picked)}</span>
          <span class="pro-picked__text">
            <span class="pro-picked__name">${fullName(picked)}</span>
            <span class="muted small">${picked.phone ? phoneText(picked.phone) : 'Pas de téléphone'}${picked.visits ? ` · ${plural(picked.visits, 'visite')}` : ''}</span>
            ${picked.noShows > 0 ? html`<span class="badge badge--noshow">${plural(picked.noShows, 'lapin')}</span>` : ''}
          </span>
          <button type="button" class="btn btn--ghost btn--sm" data-act="change-client">Changer</button>
        </div>`);
      return;
    }
    if (mode === 'new') {
      const prefill = area.dataset.prefill || '';
      const isDigits = /^[\d\s+().-]+$/.test(prefill);
      render(area, html`
        <div class="stack stack--sm pro-newclient">
          <div class="field-row">
            ${textField({ name: 'firstName', label: 'Prénom', value: isDigits ? '' : prefill, autocomplete: 'off', maxlength: 60, required: true })}
            ${textField({ name: 'lastName', label: 'Nom', optional: true, autocomplete: 'off', maxlength: 60 })}
          </div>
          ${textField({
            name: 'phone', label: 'Téléphone', type: 'tel', inputmode: 'tel', optional: true, autocomplete: 'off',
            value: isDigits ? prefill : '', hint: 'Pour l’appeler ou lui envoyer un rappel.',
          })}
          <button type="button" class="btn btn--ghost btn--sm pro-linkbtn" data-act="back-search">${icon('recherche')}<span>Rechercher plutôt un client existant</span></button>
        </div>`);
      const first = area.querySelector('[name="firstName"]');
      if (first) first.focus();
      return;
    }
    render(area, html`
      <div class="pro-search">
        <span class="pro-search__icon" aria-hidden="true">${icon('recherche')}</span>
        <input class="field__input pro-search__input" id="${ids.search}" type="search" autocomplete="off"
          placeholder="Prénom, nom ou téléphone" aria-label="Rechercher un client : prénom, nom ou téléphone"
          aria-controls="${ids.search}-res" enterkeyhint="search">
      </div>
      <div id="${ids.search}-res" class="pro-results"></div>
      <button type="button" class="btn btn--ghost btn--sm pro-linkbtn" data-act="new-client">${icon('plus')}<span>Nouveau client (de passage)</span></button>`);
    const input = area.querySelector('input');
    input.addEventListener('input', () => search(input.value));
  }

  const search = debounce(async (text) => {
    const mine = ++searchSeq;
    const out = body.querySelector(`#${ids.search}-res`);
    if (!out) return;
    const term = text.trim();
    if (!term) {
      render(out, '');
      return;
    }
    try {
      const list = (await store.listClients({ search: term })).slice(0, 6);
      if (mine !== searchSeq || !body.querySelector(`#${ids.search}-res`)) return;
      found = new Map(list.map((c) => [c.id, c]));
      // Seul le nombre de résultats est lu (pas toute la liste à chaque frappe).
      announce(list.length ? plural(list.length, 'client trouvé', 'clients trouvés') : 'Aucun client trouvé.');
      if (!list.length) {
        render(out, html`
          <p class="pro-results__none">Aucun client ne correspond à « ${term} ».
            <button type="button" class="btn btn--sm" data-act="new-client" data-prefill="${term}">${icon('plus')}<span>Créer ce client</span></button></p>`);
        return;
      }
      render(out, html`<ul class="list pro-results__list">${list.map((c) => html`
        <li><button type="button" class="list__item" data-pick="${c.id}">
          <span class="avatar" aria-hidden="true">${initials(c)}</span>
          <span class="list__main"><span class="list__title">${fullName(c)}</span>
            <span class="list__meta">${c.phone ? phoneText(c.phone) : 'Pas de téléphone'}${c.visits ? ` · ${plural(c.visits, 'visite')}` : ''}</span></span>
          ${c.noShows > 0 ? html`<span class="badge badge--noshow">${plural(c.noShows, 'lapin')}</span>` : ''}
        </button></li>`)}</ul>`);
    } catch (err) {
      if (mine === searchSeq) showError(err);
    }
  }, 160);

  /* — Prestation — */

  function selectService(id) {
    serviceId = id;
    for (const c of body.querySelectorAll('[data-svc]')) c.setAttribute('aria-pressed', bool(c.dataset.svc === id));
    const svc = services.find((s) => s.id === id);
    if (svc && picker) picker.setDuration(svc.durationMin);
  }

  /* — Enregistrement — */

  async function save() {
    if (!salon) return false;
    const errEl = body.querySelector(`#${ids.err}`);
    errEl.textContent = '';
    const area = clientArea();
    setFieldErrors(area, {}, { focus: false });

    const input = { serviceId, note: body.querySelector(`#${ids.note}`).value };
    let firstName = '';
    if (mode === 'picked' && picked) {
      input.clientId = picked.id;
      firstName = picked.firstName;
    } else if (mode === 'new') {
      const contact = {
        firstName: area.querySelector('[name="firstName"]').value,
        lastName: area.querySelector('[name="lastName"]').value,
        phone: area.querySelector('[name="phone"]').value,
        email: '',
      };
      const check = validateContact(contact, { pro: true });
      if (!check.ok) {
        setFieldErrors(area, check.errors);
        return false;
      }
      input.client = check.value;
      firstName = check.value.firstName;
    } else {
      errEl.textContent = 'Choisissez un client dans la recherche, ou créez un nouveau client.';
      const s = area.querySelector('input');
      if (s) s.focus();
      return false;
    }
    if (!serviceId) {
      errEl.textContent = 'Choisissez une prestation.';
      return false;
    }
    const { ymd: day, time: hm } = picker.value();
    if (!hm) {
      errEl.textContent = 'Choisissez un créneau ou indiquez une heure.';
      return false;
    }
    input.start = zonedToUtc(day, hm, tzOf(salon)).toISOString();

    try {
      await store.createAppointment(input);
    } catch (err) {
      if (err && err.code === 'INVALID' && err.details && err.details.errors && mode === 'new') {
        setFieldErrors(area, err.details.errors);
        return false;
      }
      if (err && (err.code === 'SLOT_TAKEN' || err.code === 'INVALID')) {
        errEl.textContent = proMessage(err);
        if (err.code === 'SLOT_TAKEN') picker.reload();
        return false;
      }
      showError(err);
      return false;
    }
    toast(`Rendez-vous enregistré : ${firstName}, ${fmtDayLong(day)} à ${fmtClock(hm)}.`, { type: 'success' });
    sheet.close();
    goToAgenda(day);
    return true;
  }

  /* — Montage — */

  (async () => {
    try {
      [salon, services] = await Promise.all([loadSalon(), store.listServices()]);
    } catch (err) {
      showError(err);
      sheet.close();
      return;
    }
    if (!body.isConnected) return;
    if (!services.length) {
      render(body, html`<div class="empty"><p class="empty__title">Aucune prestation active</p>
        <p class="empty__text">Ajoutez d’abord une prestation dans Réglages.</p></div>`);
      return;
    }
    serviceId = services[0].id;
    render(body, html`
      <form class="stack pro-form" id="${ids.form}" novalidate>
        <section aria-labelledby="${ids.form}-cli">
          <p class="field__label" id="${ids.form}-cli">Client</p>
          <div data-client></div>
        </section>
        <section aria-labelledby="${ids.svc}">
          <p class="field__label" id="${ids.svc}">Prestation</p>
          <div class="pro-svc-chips" role="group" aria-labelledby="${ids.svc}">
            ${services.map((s) => html`<button type="button" class="chip" data-svc="${s.id}" aria-pressed="${bool(s.id === serviceId)}"
              aria-label="${s.name}, ${fmtDuration(s.durationMin)}, ${fmtPrice(s.priceCents)}">${s.name} <span class="chip__count">${fmtDuration(s.durationMin)}</span></button>`)}
          </div>
        </section>
        <div data-picker></div>
        <div class="field">
          <label class="field__label" for="${ids.note}">Note <span class="field__optional">(facultatif)</span></label>
          <textarea class="field__textarea" id="${ids.note}" maxlength="500" rows="2" placeholder="Ex. : vient avec son fils"></textarea>
        </div>
        <p class="field__error" id="${ids.err}" role="alert"></p>
      </form>`);

    renderClient();
    picker = createSlotPicker(body.querySelector('[data-picker]'), {
      salon,
      durationMin: services[0].durationMin,
      ymd,
      time,
    });
    startDay = picker.ymd;

    offs = [
      on(body, 'click', '[data-svc]', (e, chip) => selectService(chip.dataset.svc)),
      on(body, 'click', '[data-pick]', (e, btn) => {
        picked = found.get(btn.dataset.pick) || null;
        if (!picked) return;
        mode = 'picked';
        renderClient();
      }),
      on(body, 'click', '[data-act]', (e, btn) => {
        const act = btn.dataset.act;
        const area = clientArea();
        if (act === 'new-client') {
          const s = area.querySelector('input[type="search"]');
          area.dataset.prefill = btn.dataset.prefill || (s ? s.value.trim() : '');
          mode = 'new';
          renderClient();
        } else if (act === 'back-search' || act === 'change-client') {
          mode = 'search';
          picked = null;
          area.dataset.prefill = '';
          renderClient();
          const s = area.querySelector('input');
          if (s) s.focus();
        }
      }),
    ];
    body.querySelector('form').addEventListener('submit', (e) => e.preventDefault());

    if (mode === 'search') {
      const s = clientArea().querySelector('input');
      if (s) s.focus({ preventScroll: true });
    }
  })();

  return sheet;
}
