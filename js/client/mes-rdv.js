// Écran 4 — Mes rendez-vous (#/mes-rdv) : les rendez-vous pris depuis ce
// téléphone (barbiere-mes-rdv), à venir puis passés (5 derniers), avec leur
// statut relu sur le serveur (getBooking), l'annulation et « Reprendre le même ».

import { html, icon } from '../ui/dom.js';
import { fmtDateTime } from '../core/dates.js';
import { loadSalon, loadServices } from './donnees.js';
import { session } from './etat.js';
import { readMesRdv, applyBookingResults } from './memoire.js';
import { appbar, bookingSkeleton } from './commun.js';
import { cancelWithConfirm } from './annulation.js';
import { tzOf, cap, setDocumentTitle } from './salon.js';

const TITLE = 'Mes rendez-vous';
const PAST_SHOWN = 5;

/** Statuts relus si les données changent ailleurs (autre onglet, retour sur la page…). */
export function shouldRefresh(source) {
  return source !== 'local';
}

export async function render(ctx) {
  const { store, root } = ctx;
  ctx.on('click', '[data-action="back"]', () => ctx.back('#/'));
  ctx.on('click', '[data-action="book"]', () => {
    session.focusTarifs = true;
    if (ctx.prevPath() === '/') ctx.back();
    else ctx.go('#/');
  });
  ctx.on('click', '[data-action="again"]', (event, btn) => ctx.go(`#/creneau/${encodeURIComponent(btn.dataset.service)}`));

  if (!ctx.quiet) ctx.render(bookingSkeleton({ title: TITLE, text: 'Mise à jour de vos rendez-vous…' }));
  const [salon, services] = await Promise.all([loadSalon(store), loadServices(store)]);
  if (!ctx.isCurrent()) return '';
  setDocumentTitle(salon, TITLE);

  // Statuts à jour : rendez-vous à venir et derniers passés.
  const now = Date.now();
  const stored = readMesRdv();
  const toCheck = [
    ...stored.filter((e) => Date.parse(e.start) > now),
    ...stored.filter((e) => Date.parse(e.start) <= now).slice(0, PAST_SHOWN),
  ];
  let offline = false;
  if (toCheck.length) {
    const results = await Promise.allSettled(toCheck.map((e) => store.getBooking(e.token)));
    offline = applyBookingResults(toCheck, results).offline;
    if (!ctx.isCurrent()) return '';
  }

  const draw = () => ctx.render(view(salon, services, { offline, quiet: ctx.quiet }));
  draw();

  ctx.on('click', '[data-action="cancel"]', async (event, btn) => {
    const token = btn.dataset.token;
    const entry = readMesRdv().find((e) => e.token === token);
    if (!entry) return;
    const outcome = await cancelWithConfirm({ store, salon, token, booking: entry, button: btn });
    if (!ctx.isCurrent() || outcome === 'kept' || outcome === 'too-late') return;
    draw();
    const title = root.querySelector('[data-screen-title]');
    if (title) title.focus({ preventScroll: true });
  });

  const upcoming = readMesRdv().filter((e) => e.status !== 'cancelled' && Date.parse(e.start) > Date.now()).length;
  return upcoming
    ? `Mes rendez-vous : ${upcoming} à venir.`
    : 'Mes rendez-vous : aucun rendez-vous à venir.';
}

// — Vues ——————————————————————————————————————————————————————————

function view(salon, services, { offline, quiet }) {
  const tz = tzOf(salon);
  const now = Date.now();
  const entries = readMesRdv();
  const upcoming = entries
    .filter((e) => Date.parse(e.start) > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const past = entries
    .filter((e) => Date.parse(e.start) <= now)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .slice(0, PAST_SHOWN);
  let i = 0;

  const card = (entry, isPast) => {
    const cancelled = entry.status === 'cancelled';
    const serviceId = resolveService(entry, services);
    return html`
      <li class="card myrdv${cancelled ? ' myrdv--cancelled' : ''} reveal" style="--i: ${i++}">
        <div class="card__header">
          <h3 class="card__title myrdv__service">${entry.serviceName || 'Rendez-vous'}</h3>
          ${badge(entry.status, isPast)}
        </div>
        <p class="myrdv__when">${cap(fmtDateTime(entry.start, tz))}</p>
        <div class="card__footer">
          ${!isPast ? html`<a class="btn btn--sm${cancelled ? '' : ' btn--primary'}" href="#/rdv/${encodeURIComponent(entry.token)}">Voir le ticket</a>` : ''}
          ${!isPast && !cancelled ? html`<button class="btn btn--sm btn--danger" type="button" data-action="cancel" data-token="${entry.token}">Annuler</button>` : ''}
          ${serviceId ? html`<button class="btn btn--sm btn--ghost" type="button" data-action="again" data-service="${serviceId}">${icon('ciseaux')}<span>Reprendre le même</span></button>` : ''}
        </div>
      </li>`;
  };

  return html`
    ${appbar({ title: TITLE, subtitle: 'Pris depuis ce navigateur' })}
    <div class="page stack myrdv-page${quiet ? ' is-quiet' : ''}">
      ${offline ? html`<div class="notice notice--warn" role="status">${icon('info')}<p>Statuts non actualisés : vérifiez votre connexion.</p></div>` : ''}

      ${!entries.length ? html`
        <div class="empty">
          <div class="empty__icon">${icon('calendrier')}</div>
          <h2 class="empty__title">Aucun rendez-vous sur ce navigateur</h2>
          <p class="empty__text">Les rendez-vous que vous prenez ici s’affichent dans cette page, pour les retrouver ou les annuler.</p>
          <p class="empty__text">Réservé ailleurs (Safari, Instagram, appli installée…)&nbsp;? Ouvrez le lien de votre rendez-vous&nbsp;: il est dans le fichier agenda ou dans le message que vous vous êtes envoyé.</p>
          <div class="empty__actions"><button class="btn btn--primary" type="button" data-action="book">Prendre rendez-vous</button></div>
        </div>` : html`
        <section aria-labelledby="upcoming-title">
          <h2 class="section-title" id="upcoming-title">À venir</h2>
          ${upcoming.length
            ? html`<ul class="stack myrdv-list">${upcoming.map((e) => card(e, false))}</ul>`
            : html`<p class="muted">Aucun rendez-vous à venir.</p>`}
        </section>
        ${past.length ? html`
          <section aria-labelledby="past-title">
            <h2 class="section-title" id="past-title">Passés</h2>
            <ul class="stack myrdv-list">${past.map((e) => card(e, true))}</ul>
          </section>` : ''}
        <button class="btn btn--primary btn--block btn--lg" type="button" data-action="book">${icon('plus')}<span>Prendre un autre rendez-vous</span></button>`}
    </div>`;
}

function badge(status, isPast) {
  if (status === 'cancelled') return html`<span class="badge badge--cancelled">Annulé</span>`;
  if (isPast) return html`<span class="badge">Passé</span>`;
  return html`<span class="badge badge--done">Confirmé</span>`;
}

/** Prestation encore proposée pour « Reprendre le même » ('' sinon). */
function resolveService(entry, services) {
  if (entry.serviceId && services.some((s) => s.id === entry.serviceId)) return entry.serviceId;
  const byName = services.find((s) => s.name === entry.serviceName);
  return byName ? byName.id : '';
}
