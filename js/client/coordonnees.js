// Écran 2 — Coordonnées (#/coordonnees) : prénom, nom, téléphone, e-mail
// et précision facultatifs, consentement, « Se souvenir de moi », puis
// « Confirmer le rendez-vous ». Validation à la sortie de chaque champ et à
// l'envoi (mêmes règles que le serveur : validateContact).

import { html, icon, announce, toast, render as paint } from '../ui/dom.js';
import { fmtDayLong, fmtTime, fmtPrice, fmtDuration, zonedParts } from '../core/dates.js';
import { validateContact, normalizePhone, fmtPhone, cleanMultiline } from '../core/validate.js';
import { errorMessage } from '../core/errors.js';
import { loadSalon, loadServices, invalidate } from './donnees.js';
import { draft, session, bookingRequestId } from './etat.js';
import { readMoi, saveMoi, forgetMoi, saveMesRdv } from './memoire.js';
import { appbar, progress, animateProgress, bookingSkeleton, errorText } from './commun.js';
import { tzOf, cap, setDocumentTitle, closedText } from './salon.js';

const TITLE = 'Vos coordonnées';
const NOTE_MAX = 500;
const FIELDS = ['firstName', 'lastName', 'phone', 'email', 'note', 'consent'];
const CONSENT_MSG = 'Cochez cette case pour que le salon puisse enregistrer votre rendez-vous.';
const NOTE_MSG = `Votre précision est trop longue (${NOTE_MAX} caractères maximum).`;
// Erreurs qui signifient « ce créneau n'est plus possible » : retour à l'étape 1.
const SLOT_ERRORS = ['SLOT_TAKEN', 'TOO_SOON', 'TOO_FAR', 'OUT_OF_HOURS'];

/** Jamais de re-rendu automatique : la saisie en cours ne doit pas être perdue. */
export function shouldRefresh() {
  return false;
}

export async function render(ctx) {
  const { store, root } = ctx;

  // Arrivée sans créneau choisi (page rechargée, lien partagé) : on repart de l'accueil.
  if (!draft.serviceId || !draft.start) {
    toast('Choisissez d’abord une prestation et un créneau.');
    ctx.replace('#/');
    return '';
  }
  const slotsHash = `#/creneau/${encodeURIComponent(draft.serviceId)}`;
  ctx.on('click', '[data-action="back"]', () => ctx.back(slotsHash));

  ctx.render(bookingSkeleton({ title: TITLE, step: 2, label: 'vos coordonnées' }));
  const [salon, services] = await Promise.all([loadSalon(store), loadServices(store)]);
  if (!ctx.isCurrent()) return '';

  const service = services.find((s) => s.id === draft.serviceId);
  if (!service || !salon.bookingEnabled) {
    toast(service ? closedText(salon) : 'Cette prestation n’est plus proposée en ligne.', { type: 'error' });
    draft.start = '';
    ctx.replace('#/');
    return '';
  }
  setDocumentTitle(salon, TITLE);

  const tz = tzOf(salon);
  const start = draft.start;
  const when = `${cap(fmtDayLong(zonedParts(start, tz).ymd))} · ${fmtTime(start, tz)}`;
  ctx.render(view({ service, when, values: initialValues() }));
  animateProgress(root);

  const form = root.querySelector('form[data-form]');
  const submitBtn = form.querySelector('[type="submit"]');

  // — Validation champ par champ —
  ctx.on('focusout', '[data-field]', (event, input) => {
    const name = input.name;
    if (name === 'phone') prettifyPhone(input);
    const values = readForm(form);
    draft.contact = values;
    // À la sortie d'un champ vide, on ne gronde pas (sauf après une tentative d'envoi).
    const filled = name === 'consent' ? values.consent : String(values[name] || '').trim() !== '';
    if (filled || form.dataset.submitted) showError(form, name, fieldError(name, values));
  });
  ctx.on('input', '[data-field]', (event, input) => {
    const values = readForm(form);
    draft.contact = values;
    // Une erreur déjà affichée disparaît dès que la saisie devient correcte.
    if (input.getAttribute('aria-invalid') === 'true' && !fieldError(input.name, values)) showError(form, input.name, '');
  });
  ctx.on('change', '[data-field="check"]', (event, input) => {
    const values = readForm(form);
    draft.contact = values;
    if (input.name === 'consent' && (values.consent || form.dataset.submitted)) showError(form, 'consent', fieldError('consent', values));
  });

  // — Envoi —
  let sending = false;
  ctx.on('submit', 'form[data-form]', async (event) => {
    event.preventDefault();
    if (sending) return;
    const values = readForm(form);
    draft.contact = values;
    form.dataset.submitted = '1';
    hideAlert(form);

    const errors = {};
    for (const name of FIELDS) {
      const message = fieldError(name, values);
      if (message) errors[name] = message;
      showError(form, name, message);
    }
    if (Object.keys(errors).length) {
      focusFirstError(form, errors);
      const n = Object.keys(errors).length;
      announce(n > 1 ? `${n} champs sont à corriger.` : 'Un champ est à corriger.', { assertive: true });
      return;
    }

    const contact = validateContact(values).value;
    // Même tentative (prestation, créneau, coordonnées) → même identifiant : un nouvel
    // envoi après une coupure retrouve la réservation déjà enregistrée.
    const requestId = bookingRequestId({ serviceId: service.id, start, ...contact });
    sending = true;
    submitBtn.setAttribute('aria-busy', 'true');
    try {
      const result = await store.book({
        serviceId: service.id,
        start,
        firstName: contact.firstName,
        lastName: contact.lastName,
        phone: contact.phone,
        email: contact.email,
        note: cleanMultiline(values.note),
        requestId,
      });
      if (values.remember) saveMoi(contact);
      else forgetMoi();
      saveMesRdv({
        token: result.token, start: result.start, end: result.end,
        serviceName: result.serviceName, serviceId: service.id, status: 'confirmed',
      });
      session.lastBooking = { ...result, status: 'confirmed', firstName: contact.firstName, serviceId: service.id };
      draft.start = '';
      draft.request = null;
      draft.contact = { ...values, note: '', consent: false };
      ctx.replace(`#/rdv/${encodeURIComponent(result.token)}`);
    } catch (err) {
      await handleBookingError(ctx, form, err, { slotsHash, serviceId: service.id, salon });
    } finally {
      sending = false;
      submitBtn.removeAttribute('aria-busy');
    }
  });

  return `Étape 2 sur 3 : vos coordonnées. ${service.name}, ${when.replace(' · ', ' à ')}.`;
}

// — Vue ——————————————————————————————————————————————————————————

function initialValues() {
  if (draft.contact) return draft.contact;
  const me = readMoi();
  return {
    firstName: me ? me.firstName : '',
    lastName: me ? me.lastName : '',
    phone: me && me.phone ? fmtPhone(me.phone) : '',
    email: me ? me.email : '',
    note: '',
    consent: false,
    // Choix actif (RGPD) : décochée à la première visite, cochée seulement
    // pour qui avait déjà demandé à être mémorisé sur ce téléphone.
    remember: Boolean(me),
  };
}

function view({ service, when, values }) {
  return html`
    ${appbar({ title: TITLE })}
    <div class="page stack booking">
      ${progress(2, 'vos coordonnées')}

      <section class="card card--inset booking-recap reveal" style="--i: 0" aria-label="Votre rendez-vous">
        <div class="booking-recap__text">
          <p class="booking-recap__title">${service.name}</p>
          <p class="booking-recap__meta">${when} · ${fmtPrice(service.priceCents)}</p>
          <p class="booking-recap__meta">${fmtDuration(service.durationMin)}</p>
        </div>
        <button class="btn btn--ghost btn--sm" type="button" data-action="back" aria-label="Modifier le jour ou l’heure">Modifier</button>
      </section>

      <form class="booking-form" data-form novalidate>
        <!-- Seul ce bloc est animé : un ancêtre animé (transform) piégerait la barre collante. -->
        <div class="stack booking-form__fields reveal" style="--i: 1">
          <div class="field-row">
            ${textField({ name: 'firstName', label: 'Prénom', value: values.firstName, autocomplete: 'given-name', max: 60 })}
            ${textField({ name: 'lastName', label: 'Nom', value: values.lastName, autocomplete: 'family-name', max: 60 })}
          </div>
          ${textField({
            name: 'phone', label: 'Téléphone mobile', value: values.phone, type: 'tel', inputmode: 'tel',
            autocomplete: 'tel-national', max: 30, hint: 'Le salon vous appelle seulement en cas d’imprévu.',
          })}
          ${textField({
            name: 'email', label: 'E-mail', optional: true, value: values.email, type: 'email', inputmode: 'email',
            autocomplete: 'email', max: 120,
          })}
          <div class="field" data-field-box>
            <label class="field__label" for="f-note">Une précision ? <span class="field__optional">(facultatif)</span></label>
            <textarea class="field__textarea booking-form__note" id="f-note" name="note" data-field rows="2" maxlength="${NOTE_MAX}"
                      placeholder="Exemple : première visite, cheveux longs…" aria-describedby="f-note-err">${values.note}</textarea>
            <p class="field__error" id="f-note-err" data-error-for="note"></p>
          </div>

          <div class="booking-form__checks">
            <div class="booking-form__consent" data-field-box>
              <label class="check">
                <input class="check__input" type="checkbox" name="consent" data-field="check" aria-describedby="f-consent-err"${values.consent ? html` checked` : ''}>
                <span class="check__box" aria-hidden="true"></span>
                <span class="check__label">J’accepte que le salon enregistre ces informations pour gérer mon rendez-vous.
                  <a href="./confidentialite.html" target="_blank" rel="noopener">Confidentialité</a></span>
              </label>
              <p class="field__error booking-form__check-error" id="f-consent-err" data-error-for="consent"></p>
            </div>
            <label class="check">
              <input class="check__input" type="checkbox" name="remember" data-field="check"${values.remember ? html` checked` : ''}>
              <span class="check__box" aria-hidden="true"></span>
              <span class="check__label">Se souvenir de moi sur ce téléphone
                <span class="check__hint">Vos coordonnées seront pré-remplies la prochaine fois.</span></span>
            </label>
          </div>

          <div class="notice notice--danger booking-form__alert" role="alert" tabindex="-1" data-form-alert hidden></div>
        </div>

        <div class="sticky-cta">
          <button class="btn btn--primary btn--lg" type="submit">${icon('coche')}<span>Confirmer le rendez-vous</span></button>
        </div>
      </form>
    </div>`;
}

function textField({ name, label, value = '', type = 'text', inputmode = '', autocomplete = '', max = 60, hint = '', optional = false }) {
  const id = `f-${name}`;
  const describedBy = [hint ? `${id}-hint` : '', `${id}-err`].filter(Boolean).join(' ');
  return html`
    <div class="field" data-field-box>
      <label class="field__label" for="${id}">${label}${optional ? html` <span class="field__optional">(facultatif)</span>` : ''}</label>
      <input class="field__input" id="${id}" name="${name}" type="${type}" data-field
             ${inputmode ? html`inputmode="${inputmode}"` : ''} autocomplete="${autocomplete}" maxlength="${max}"
             ${optional ? '' : html`required aria-required="true"`} aria-describedby="${describedBy}" value="${value}"
             ${type === 'email' ? html`autocapitalize="off" spellcheck="false"` : ''}>
      ${hint ? html`<p class="field__hint" id="${id}-hint">${hint}</p>` : ''}
      <p class="field__error" id="${id}-err" data-error-for="${name}"></p>
    </div>`;
}

// — Outils du formulaire ——————————————————————————————————————————

function readForm(form) {
  const f = form.elements;
  return {
    firstName: f.namedItem('firstName').value,
    lastName: f.namedItem('lastName').value,
    phone: f.namedItem('phone').value,
    email: f.namedItem('email').value,
    note: f.namedItem('note').value,
    consent: f.namedItem('consent').checked,
    remember: f.namedItem('remember').checked,
  };
}

/** Message d'erreur d'un champ ('' si correct). */
function fieldError(name, values) {
  if (name === 'consent') return values.consent ? '' : CONSENT_MSG;
  if (name === 'note') return cleanMultiline(values.note).length > NOTE_MAX ? NOTE_MSG : '';
  return validateContact(values).errors[name] || '';
}

function showError(form, name, message) {
  const input = form.elements.namedItem(name);
  const slot = form.querySelector(`[data-error-for="${name}"]`);
  if (slot) slot.textContent = message || '';
  if (!input) return;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function focusFirstError(form, errors) {
  const name = FIELDS.find((n) => errors[n]);
  const input = name && form.elements.namedItem(name);
  if (!input) return;
  input.focus({ preventScroll: true });
  reveal(input.closest('[data-field-box]') || input);
}

/** Fait défiler jusqu'au bloc entier (champ + message d'erreur), hors de la barre
 *  collante : sa hauteur est réservée par scroll-padding-bottom (css/app.css).
 *  Saut immédiat, comme le défilement natif au focus (une animation peut être interrompue). */
function reveal(el) {
  el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

/** Téléphone valide → affiché au format « 06 12 34 56 78 ». */
function prettifyPhone(input) {
  const e164 = normalizePhone(input.value);
  if (e164) input.value = fmtPhone(e164);
}

function showAlert(form, content) {
  const box = form.querySelector('[data-form-alert]');
  paint(box, content);
  box.hidden = false;
  box.focus({ preventScroll: true });
  reveal(box);
}

function hideAlert(form) {
  const box = form.querySelector('[data-form-alert]');
  box.hidden = true;
  box.replaceChildren();
}

async function handleBookingError(ctx, form, err, { slotsHash, serviceId, salon }) {
  const code = err && err.code;
  // Horaires, horizon ou ouverture ont pu changer : le salon gardé en cache ne vaut plus.
  if (SLOT_ERRORS.includes(code) || code === 'CLOSED') invalidate();
  if (SLOT_ERRORS.includes(code)) {
    // Créneau devenu impossible : retour à l'étape 1, créneaux relus.
    toast(errorMessage(code), { type: 'error' });
    draft.start = '';
    if (ctx.prevPath() === slotsHash.slice(1)) ctx.back(slotsHash);
    else ctx.replace(slotsHash);
    return;
  }
  if (code === 'INVALID' && err.details && err.details.errors) {
    const errors = err.details.errors;
    for (const name of Object.keys(errors)) showError(form, name, errors[name]);
    focusFirstError(form, errors);
    announce(errorMessage(code), { assertive: true });
    return;
  }
  if (code === 'INVALID') {
    // Sans détail par champ : la prestation a peut-être été retirée entre-temps.
    invalidate();
    const services = await loadServices(ctx.store).catch(() => null);
    if (!ctx.isCurrent()) return;
    if (services && !services.some((s) => s.id === serviceId)) {
      toast('Cette prestation n’est plus proposée en ligne.', { type: 'error' });
      draft.start = '';
      ctx.replace('#/');
      return;
    }
  }
  if (code === 'CLOSED') {
    toast(closedText(salon), { type: 'error' });
    draft.start = '';
    ctx.replace('#/');
    return;
  }
  if (code === 'LIMIT') {
    showAlert(form, html`${icon('alerte')}<div><p>${errorMessage(code)}</p>
      <p><a href="#/mes-rdv">Voir mes rendez-vous</a></p></div>`);
    return;
  }
  if (!code) console.error(err);
  // NETWORK, UNAVAILABLE… : la saisie reste en place ; un nouvel envoi réutilise le même requestId.
  toast(errorText(err), { type: 'error' });
}
