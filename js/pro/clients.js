/**
 * Clients : liste avec recherche (#/clients) et fiche (#/clients/<id>).
 *
 * Fiche : chiffres, notes modifiables, prochains RDV, historique, contact,
 * « Nouveau RDV pour ce client », coordonnées, suppression RGPD.
 */

import { html, render, on, icon, openSheet, confirmDialog, toast, announce } from '../ui/dom.js';
import { fmtDayShort, fmtTime, fmtPrice, fmtDayLong } from '../core/dates.js';
import { validateClientPatch } from '../core/validate.js';
import { openAppointmentSheet } from './appointment.js';
import { openNewAppointment } from './rdv-form.js';
import {
  store, loadSalon, tzOf, ymdOf, nav, fullName, initials, plural, capitalize, phoneText, statusBadge,
  contactButtons, reminderText, helloText, showError, textField, setFieldErrors, debounce, loaderHtml,
  formSnapshot, confirmDiscard,
} from './shared.js';

/** '3 oct.' (année ajoutée si ce n'est pas l'année en cours). */
function shortDate(iso, tz) {
  const ymd = ymdOf(iso, tz);
  const s = fmtDayShort(ymd);
  const thisYear = new Date().getFullYear().toString();
  return `${s.day} ${s.month}${ymd.slice(0, 4) === thisYear ? '' : ` ${ymd.slice(0, 4)}`}`;
}

/* ==========================================================================
   Liste
   ========================================================================== */

// Recherche et défilement gardés quand on revient de la fiche.
let lastTerm = '';
let lastScroll = 0;
// Notes non enregistrées d'une fiche quittée par Retour : remises au prochain affichage.
let notesDraft = null;       // { id, text }

export function createClientsView() {
  let root = null;
  let seq = 0;
  let firstLoad = true;

  function listHtml(list, salon, term) {
    const tz = tzOf(salon);
    if (!list.length) {
      return term
        ? html`<div class="empty"><div class="empty__icon">${icon('recherche')}</div>
            <p class="empty__title">Aucun résultat</p>
            <p class="empty__text">Aucun client ne correspond à « ${term} ». Essayez le prénom seul ou les derniers chiffres du téléphone.</p></div>`
        : html`<div class="empty"><div class="empty__icon">${icon('utilisateur')}</div>
            <p class="empty__title">Aucun client pour l’instant</p>
            <p class="empty__text">Les fiches se créent toutes seules à chaque rendez-vous, en ligne ou depuis l’agenda.</p></div>`;
    }
    return html`<ul class="list pro-clients">${list.map((c) => html`
      <li><a class="list__item" href="#/clients/${encodeURIComponent(c.id)}">
        <span class="avatar${c.noShows > 0 ? ' avatar--accent' : ''}" aria-hidden="true">${initials(c)}</span>
        <span class="list__main">
          <span class="list__title">${fullName(c)}</span>
          <span class="list__meta">${c.phone ? phoneText(c.phone) : 'Pas de téléphone'}</span>
          <span class="list__meta">${c.visits ? plural(c.visits, 'visite') : 'Aucune visite'}${c.lastVisit ? ` · dernière le ${shortDate(c.lastVisit, tz)}` : ''}</span>
        </span>
        ${c.noShows > 0 ? html`<span class="badge badge--noshow">${plural(c.noShows, 'lapin')}</span>` : ''}
        ${icon('chevron-droite')}
      </a></li>`)}</ul>`;
  }

  async function load({ speak = false } = {}) {
    const mine = ++seq;
    const term = lastTerm.trim();
    try {
      const [list, salon] = await Promise.all([store.listClients({ search: term }), loadSalon()]);
      if (mine !== seq || !root) return;
      const out = root.querySelector('[data-results]');
      render(out, listHtml(list, salon, term));
      out.removeAttribute('aria-busy');
      const count = term ? plural(list.length, 'résultat') : plural(list.length, 'client');
      root.querySelector('[data-count]').textContent = count;
      // Après une frappe : seul le nombre est lu (la liste n'est plus une région live).
      if (speak) announce(count);
      if (firstLoad) {
        firstLoad = false;
        if (lastScroll) window.scrollTo(0, lastScroll);
      }
    } catch (err) {
      if (mine !== seq || !root) return;
      render(root.querySelector('[data-results]'), html`<div class="empty"><p class="empty__title">Chargement impossible</p>
        <div class="empty__actions"><button type="button" class="btn btn--primary" data-retry>Réessayer</button></div></div>`);
      showError(err);
    }
  }

  const search = debounce(() => load({ speak: true }), 160);

  return {
    mount(el) {
      root = el;
      document.title = 'Clients — Agenda';
      render(root, html`
        <header class="appbar appbar--green">
          <div class="appbar__titles"><h1 class="appbar__title">Clients</h1><p class="appbar__subtitle" data-count>Chargement…</p></div>
        </header>
        <div class="page">
          <div class="pro-search pro-search--page">
            <span class="pro-search__icon" aria-hidden="true">${icon('recherche')}</span>
            <label class="sr-only" for="pro-client-search">Rechercher un client</label>
            <input class="field__input pro-search__input" id="pro-client-search" type="search" value="${lastTerm}"
              placeholder="Prénom, nom ou téléphone" autocomplete="off" enterkeyhint="search">
          </div>
          <div data-results aria-busy="true">
            <div class="stack stack--sm" aria-hidden="true">
              <span class="skeleton skeleton--block"></span><span class="skeleton skeleton--block"></span><span class="skeleton skeleton--block"></span>
            </div>
          </div>
        </div>`);
      const input = root.querySelector('#pro-client-search');
      input.addEventListener('input', () => {
        lastTerm = input.value;
        search();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();   // ferme le clavier
      });
      on(root, 'click', '[data-retry]', () => load());
      load();
    },
    refresh() {
      load();
    },
    unmount() {
      seq++;
      search.cancel();
      lastScroll = window.scrollY;
      root = null;
    },
  };
}

/* ==========================================================================
   Fiche client
   ========================================================================== */

export function createClientView() {
  let root = null;
  let clientId = '';
  let client = null;
  let salon = null;
  let seq = 0;
  let notesDirty = false;
  let showAllHistory = false;

  const region = (name) => root && root.querySelector(`[data-region="${name}"]`);

  function split(c) {
    const now = Date.now();
    const upcoming = c.appointments
      .filter((a) => a.status === 'confirmed' && Date.parse(a.end) > now)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const history = c.appointments
      .filter((a) => !upcoming.includes(a))
      .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
    return { upcoming, history };
  }

  function apptRow(a, tz) {
    return html`<li><button type="button" class="list__item" data-appt="${a.id}">
      <span class="list__main">
        <span class="list__title">${capitalize(fmtDayLong(ymdOf(a.start, tz)))} · ${fmtTime(a.start, tz)}</span>
        <span class="list__meta">${a.serviceName} · ${fmtPrice(a.priceCents)}${a.source === 'online' ? ' · en ligne' : ''}</span>
      </span>
      ${statusBadge(a.status)}
    </button></li>`;
  }

  function headHtml(c) {
    return html`
      <button type="button" class="icon-btn appbar__back" data-act="back" aria-label="Retour à la liste des clients">${icon('chevron-gauche')}</button>
      <div class="appbar__titles"><h1 class="appbar__title">${fullName(c)}</h1>
        <p class="appbar__subtitle">${c.createdAt ? `Fiche créée le ${shortDate(c.createdAt, tzOf(salon))}` : 'Fiche client'}</p></div>
      <div class="appbar__actions"><button type="button" class="icon-btn" data-act="edit" aria-label="Modifier les coordonnées">${icon('crayon')}</button></div>`;
  }

  function cardHtml(c, upcoming) {
    const body = upcoming.length ? reminderText(upcoming[0], salon) : helloText(c);
    return html`
      <section class="card pro-client-card">
        <div class="pro-client-card__who">
          <span class="avatar avatar--lg${c.noShows > 0 ? ' avatar--accent' : ''}" aria-hidden="true">${initials(c)}</span>
          <div class="grow">
            <p class="h3">${fullName(c)}</p>
            <p class="muted">${c.phone ? phoneText(c.phone) : 'Pas de téléphone'}${c.email ? html`<br>${c.email}` : ''}</p>
          </div>
        </div>
        ${contactButtons(c.phone, body)}
        <button type="button" class="btn btn--accent btn--lg btn--block" data-act="new-rdv">${icon('plus')}<span>Nouveau RDV pour ce client</span></button>
      </section>`;
  }

  function statsHtml(c, upcoming) {
    const tz = tzOf(salon);
    return html`
      <div class="stats pro-client-stats">
        <div class="stat"><span class="stat__value">${c.visits}</span><span class="stat__label">${c.visits > 1 ? 'Visites' : 'Visite'}</span></div>
        <div class="stat${c.noShows > 0 ? ' pro-stat--noshow' : ''}"><span class="stat__value">${c.noShows}</span><span class="stat__label">${c.noShows > 1 ? 'Lapins' : 'Lapin'}</span></div>
        <div class="stat"><span class="stat__value pro-stat-date">${c.lastVisit ? shortDate(c.lastVisit, tz) : '—'}</span><span class="stat__label">Dernière visite</span></div>
        <div class="stat"><span class="stat__value pro-stat-date">${upcoming.length ? shortDate(upcoming[0].start, tz) : '—'}</span><span class="stat__label">Prochain RDV</span>
          ${upcoming.length ? html`<span class="stat__hint">à ${fmtTime(upcoming[0].start, tz)}</span>` : ''}</div>
      </div>`;
  }

  function notesHtml(c) {
    return html`
      <h2 class="section-title">Notes</h2>
      <div class="field">
        <label class="sr-only" for="pro-client-notes">Notes sur ${fullName(c)}</label>
        <textarea class="field__textarea" id="pro-client-notes" data-notes maxlength="2000" rows="4"
          placeholder="Ex. : coupe habituelle : dégradé 1,5 sur les côtés, dessus aux ciseaux">${c.notes || ''}</textarea>
        <p class="field__hint">Visibles seulement par vous, dans le détail de chaque rendez-vous.</p>
      </div>
      <div class="pro-savebar">
        <span class="pro-savebar__state" data-notes-state aria-live="polite"></span>
        <button type="button" class="btn btn--primary" data-act="save-notes">${icon('coche')}<span>Enregistrer les notes</span></button>
      </div>`;
  }

  function listsHtml(upcoming, history) {
    const tz = tzOf(salon);
    const shown = showAllHistory ? history : history.slice(0, 8);
    return html`
      <h2 class="section-title">Prochains rendez-vous</h2>
      ${upcoming.length ? html`<ul class="list">${upcoming.map((a) => apptRow(a, tz))}</ul>`
        : html`<p class="muted">Aucun rendez-vous à venir.</p>`}
      <h2 class="section-title">Historique</h2>
      ${history.length ? html`<ul class="list">${shown.map((a) => apptRow(a, tz))}</ul>
        ${history.length > shown.length ? html`<button type="button" class="btn btn--ghost btn--block" data-act="all-history">Voir les ${history.length} rendez-vous</button>` : ''}`
        : html`<p class="muted">Pas encore de rendez-vous passé.</p>`}`;
  }

  function dangerHtml() {
    return html`
      <h2 class="section-title">Données personnelles</h2>
      <div class="stack stack--sm">
        <button type="button" class="btn btn--block" data-act="edit">${icon('crayon')}<span>Modifier les coordonnées</span></button>
        <button type="button" class="btn btn--danger btn--block" data-act="delete">${icon('poubelle')}<span>Supprimer ce client (RGPD)</span></button>
        <p class="field__hint">La suppression efface la fiche, les notes et tout l’historique. Les rendez-vous à venir sont annulés.</p>
      </div>`;
  }

  function draw() {
    const c = client;
    const { upcoming, history } = split(c);
    render(region('head'), headHtml(c));
    render(region('card'), cardHtml(c, upcoming));
    render(region('stats'), statsHtml(c, upcoming));
    if (!notesDirty) {
      render(region('notes'), notesHtml(c));
      if (notesDraft && notesDraft.id === clientId) {
        root.querySelector('[data-notes]').value = notesDraft.text;
        notesDraft = null;
        markNotesDirty();
      }
    }
    render(region('lists'), listsHtml(upcoming, history));
    render(region('danger'), dangerHtml());
    document.title = `${fullName(c)} — Clients`;
  }

  async function load({ initial = false } = {}) {
    const mine = ++seq;
    try {
      const [c, s] = await Promise.all([store.getClient(clientId), loadSalon()]);
      if (mine !== seq || !root) return;
      client = c;
      salon = s;
      region('body').removeAttribute('aria-busy');
      draw();
    } catch (err) {
      if (mine !== seq || !root) return;
      if (err && err.code === 'NOT_FOUND') {
        client = null;
        render(region('body'), html`<div class="empty">
          <div class="empty__icon">${icon('utilisateur')}</div>
          <p class="empty__title">Ce client n’existe plus</p>
          <p class="empty__text">La fiche a peut-être été supprimée.</p>
          <div class="empty__actions"><a class="btn btn--primary" href="#/clients">Retour aux clients</a></div></div>`);
        region('body').removeAttribute('aria-busy');
        return;
      }
      if (initial) {
        render(region('body'), html`<div class="empty"><p class="empty__title">Chargement impossible</p>
          <div class="empty__actions"><button type="button" class="btn btn--primary" data-act="retry">Réessayer</button></div></div>`);
      }
      showError(err);
    }
  }

  async function saveNotes(btn) {
    const area = root.querySelector('[data-notes]');
    btn.setAttribute('aria-busy', 'true');
    try {
      await store.updateClient(clientId, { notes: area.value });
      notesDirty = false;
      const state = root.querySelector('[data-notes-state]');
      if (state) state.textContent = '';
      toast('Notes enregistrées.', { type: 'success' });
    } catch (err) {
      showError(err);
    } finally {
      btn.removeAttribute('aria-busy');
    }
  }

  function editCoordinates() {
    const c = client;
    let sheet = null;
    let initial = null;
    const isDirty = () => initial !== null && formSnapshot(sheet.body.querySelector('form')) !== initial;
    sheet = openSheet({
      title: 'Coordonnées',
      className: 'pro-sheet',
      content: html`
        <form class="stack pro-form" novalidate>
          <div class="field-row">
            ${textField({ name: 'firstName', label: 'Prénom', value: c.firstName, autocomplete: 'off', maxlength: 60, required: true })}
            ${textField({ name: 'lastName', label: 'Nom', value: c.lastName, optional: true, autocomplete: 'off', maxlength: 60 })}
          </div>
          ${textField({ name: 'phone', label: 'Téléphone', type: 'tel', inputmode: 'tel', value: phoneText(c.phone), optional: true, autocomplete: 'off' })}
          ${textField({ name: 'email', label: 'E-mail', type: 'email', inputmode: 'email', value: c.email, optional: true, autocomplete: 'off', maxlength: 120 })}
        </form>`,
      beforeClose: confirmDiscard(isDirty),
      actions: [
        { label: 'Fermer', variant: 'ghost', onClick: confirmDiscard(isDirty) },
        {
          label: 'Enregistrer',
          variant: 'primary',
          onClick: async () => {
            const f = sheet.body;
            const patch = {
              firstName: f.querySelector('[name="firstName"]').value,
              lastName: f.querySelector('[name="lastName"]').value,
              phone: f.querySelector('[name="phone"]').value,
              email: f.querySelector('[name="email"]').value,
            };
            const check = validateClientPatch(patch);
            if (!check.ok) {
              setFieldErrors(f, check.errors);
              return false;
            }
            try {
              await store.updateClient(clientId, patch);
            } catch (err) {
              if (err && err.code === 'INVALID' && err.details && err.details.errors) {
                setFieldErrors(f, err.details.errors);
                return false;
              }
              showError(err);
              return false;
            }
            toast('Coordonnées enregistrées.', { type: 'success' });
            return true;
          },
        },
      ],
    });
    sheet.body.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
    initial = formSnapshot(sheet.body.querySelector('form'));
  }

  async function deleteClient() {
    const c = client;
    const ok = await confirmDialog({
      title: `Supprimer ${fullName(c)} ?`,
      message: 'La fiche, les notes et tout l’historique seront effacés définitivement. Les rendez-vous à venir seront annulés. Cette action ne peut pas être annulée.',
      confirmLabel: 'Supprimer définitivement',
      cancelLabel: 'Garder la fiche',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.deleteClient(clientId);
    } catch (err) {
      showError(err);
      return;
    }
    toast(`Fiche de ${fullName(c)} supprimée.`, { type: 'success' });
    notesDirty = false;
    lastScroll = 0;
    lastTerm = '';
    nav.go('#/clients', { replace: true });
  }

  function onClick(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const btn = t.closest('[data-act], [data-appt]');
    if (!btn || !root.contains(btn)) return;
    if (btn.dataset.appt) {
      const a = client && client.appointments.find((x) => x.id === btn.dataset.appt);
      if (a) openAppointmentSheet(a);
      return;
    }
    const act = btn.dataset.act;
    if (act === 'retry') { load({ initial: true }); return; }
    if (act === 'back') {
      if (nav.previousHash === '#/clients') history.back();
      else nav.go('#/clients');
      return;
    }
    if (!client) return;
    if (act === 'new-rdv') openNewAppointment({ client });
    else if (act === 'edit') editCoordinates();
    else if (act === 'delete') deleteClient();
    else if (act === 'save-notes') saveNotes(btn);
    else if (act === 'all-history') {
      showAllHistory = true;
      draw();
    }
  }

  function markNotesDirty() {
    notesDirty = true;
    const state = root.querySelector('[data-notes-state]');
    if (state && !state.textContent) state.textContent = 'Modifications non enregistrées';
  }

  function onInput(e) {
    if (e.target instanceof Element && e.target.matches('[data-notes]')) markNotesDirty();
  }

  return {
    mount(el, params = {}) {
      root = el;
      clientId = params.id;
      render(root, html`
        <header class="appbar appbar--green" data-region="head">
          <a class="icon-btn appbar__back" href="#/clients" aria-label="Retour à la liste des clients">${icon('chevron-gauche')}</a>
          <div class="appbar__titles"><p class="appbar__title">Fiche client</p></div>
        </header>
        <div class="page" data-region="body" aria-busy="true">
          <div class="stack stack--lg">
            <div data-region="card">${loaderHtml('Chargement de la fiche…')}</div>
            <div data-region="stats"></div>
            <section data-region="notes"></section>
            <section data-region="lists"></section>
            <section data-region="danger"></section>
          </div>
        </div>`);
      root.addEventListener('click', onClick);
      root.addEventListener('input', onInput);
      load({ initial: true });
    },
    refresh() {
      load();
    },
    /** Notes modifiées et non enregistrées (main.js demande avant de quitter l'écran). */
    isDirty() {
      return notesDirty;
    },
    /** Quitter sans enregistrer : rien n'est gardé. */
    discard() {
      notesDirty = false;
    },
    unmount() {
      seq++;
      if (root) {
        const area = root.querySelector('[data-notes]');
        if (notesDirty && area) notesDraft = { id: clientId, text: area.value };
        root.removeEventListener('click', onClick);
        root.removeEventListener('input', onInput);
      }
      root = null;
    },
  };
}
