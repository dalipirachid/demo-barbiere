/**
 * Écran de connexion (mode en ligne seulement).
 *   renderLogin(el, { message, onSuccess })
 */

import { html, render, icon } from '../ui/dom.js';
import { errorMessage } from '../core/errors.js';
import { store, textField, setFieldErrors, uid } from './shared.js';

export function renderLogin(el, { message = '', onSuccess = () => {} } = {}) {
  const errId = uid('connexion-err');
  render(el, html`
    <div class="page pro-login">
      <header class="signboard">
        <p class="signboard__kicker">Espace barbière</p>
        <h1 class="signboard__name" data-salon>Agenda du salon</h1>
      </header>
      <form class="card stack pro-login__form" novalidate>
        <h2 class="h3">Connexion</h2>
        ${message ? html`<div class="notice notice--info" role="status">${icon('info')}<p>${message}</p></div>` : ''}
        ${textField({ name: 'email', label: 'E-mail', type: 'email', inputmode: 'email', autocomplete: 'username', required: true })}
        ${textField({ name: 'password', label: 'Mot de passe', type: 'password', autocomplete: 'current-password', required: true })}
        <p class="field__error" id="${errId}" role="alert"></p>
        <button type="submit" class="btn btn--primary btn--lg btn--block">${icon('cadenas')}<span>Se connecter</span></button>
        <p class="small muted center">Mot de passe oublié ? Contactez DLP Services Informatiques.</p>
      </form>
    </div>`);
  document.title = 'Connexion — Agenda';

  // Nom du salon (lecture publique), pour reconnaître la page.
  store.getSalon().then((salon) => {
    const name = el.querySelector('[data-salon]');
    if (name && salon && salon.name) name.textContent = salon.name;
  }).catch(() => { /* hors connexion : on garde le titre générique */ });

  const form = el.querySelector('form');
  const button = form.querySelector('button[type="submit"]');
  const errEl = form.querySelector(`#${errId}`);
  const email = form.querySelector('[name="email"]');
  const password = form.querySelector('[name="password"]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const errors = {};
    if (!email.value.trim()) errors.email = 'Indiquez votre adresse e-mail.';
    if (!password.value) errors.password = 'Indiquez votre mot de passe.';
    if (setFieldErrors(form, errors)) return;
    button.setAttribute('aria-busy', 'true');
    try {
      await store.login(email.value.trim(), password.value);
    } catch (err) {
      button.removeAttribute('aria-busy');
      errEl.textContent = err && err.code === 'AUTH'
        ? 'E-mail ou mot de passe incorrect. Vérifiez-les puis réessayez.'
        : errorMessage(err);
      password.select();
      return;
    }
    button.removeAttribute('aria-busy');
    onSuccess();
  });

  email.focus({ preventScroll: true });
}
