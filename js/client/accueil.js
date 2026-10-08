// Écran 0 — Accueil (#/) : l'enseigne, les infos pratiques, le prochain
// créneau libre, « Mes rendez-vous » et le tableau des tarifs, dont chaque
// ligne lance la réservation de la prestation.

import { html, icon, render as paint } from '../ui/dom.js';
import { todayYMD, fmtTime, zonedParts } from '../core/dates.js';
import { firstAvailable } from '../core/slots.js';
import { isDemo } from '../data/store.js';
import { loadSalon, loadServices, horizonDays, loadBusy } from './donnees.js';
import { readMesRdv, applyBookingResults } from './memoire.js';
import { session } from './etat.js';
import { pricelist, prefersReducedMotion } from './commun.js';
import {
  txt, cap, tzOf, openStatus, addressText, mapsUrl, telUrl, phoneLabel, instagramUrl,
  dayLabel, setDocumentTitle,
} from './salon.js';

const STATUS_TICK_MS = 60_000;
const DAY = 86_400_000;

/** L'accueil se met à jour dès que les données changent (réglages, autre onglet…). */
export function shouldRefresh() {
  return true;
}

export async function render(ctx) {
  const { store } = ctx;
  ctx.on('click', '[data-service]', (event, btn) => {
    ctx.go(`#/creneau/${encodeURIComponent(btn.dataset.service)}`);
  });
  ctx.on('click', '[data-action="tarifs"]', () => showTarifs(ctx.root, { smooth: true, focus: true }));

  if (!ctx.quiet) ctx.render(skeleton());
  const [salon, services] = await Promise.all([loadSalon(store), loadServices(store)]);
  if (!ctx.isCurrent()) return '';

  setDocumentTitle(salon);
  ctx.render(view(salon, services, ctx.quiet));

  // Statut « Ouvert / Fermé » tenu à jour tant que l'écran reste affiché.
  const timer = setInterval(() => updateStatus(ctx.root, salon), STATUS_TICK_MS);
  ctx.onCleanup(() => clearInterval(timer));

  if (canBook(salon, services)) fillNextSlot(ctx, salon, services);
  refreshMine(ctx, salon);

  if (session.focusTarifs) {
    // Arrivée par « Changer » de prestation : on s'ouvre directement sur les tarifs.
    session.focusTarifs = false;
    ctx.focusTarget = showTarifs(ctx.root, { smooth: false, focus: false });
    ctx.scrolled = true;
  }
  if (!salon.bookingEnabled) return 'Accueil. La réservation en ligne est momentanément suspendue.';
  return services.length
    ? 'Accueil. Choisissez une prestation pour prendre rendez-vous.'
    : 'Accueil. Les prestations seront bientôt affichées.';
}

/** Réservation possible : en ligne activée et au moins une prestation proposée. */
export function canBook(salon, services) {
  return Boolean(salon.bookingEnabled) && services.length > 0;
}

/**
 * Durée retenue pour « Prochain créneau libre » : celle de la prestation la plus
 * LONGUE. Un créneau libre pour elle l'est aussi, à la même heure, pour toutes les
 * plus courtes : l'annonce est vraie quelle que soit la prestation choisie.
 * → minutes, ou 0 si aucune durée lisible.
 */
export function nextSlotDuration(services) {
  const durations = services.map((s) => Number(s.durationMin) || 0).filter((n) => n > 0);
  return durations.length ? Math.max(...durations) : 0;
}

// — Vues ——————————————————————————————————————————————————————————

function skeleton() {
  return html`
    <div class="page stack home" aria-busy="true">
      <p class="sr-only" role="status">Chargement…</p>
      <span class="skeleton skeleton--block home__skeleton-sign" aria-hidden="true"></span>
      <div class="card stack stack--sm" aria-hidden="true">
        <span class="skeleton skeleton--text" style="width: 55%"></span>
        <span class="skeleton skeleton--text" style="width: 80%"></span>
      </div>
      <span class="skeleton skeleton--pill" aria-hidden="true"></span>
      <div class="stack stack--sm" aria-hidden="true">
        <span class="skeleton skeleton--title"></span>
        <span class="skeleton skeleton--text"></span>
        <span class="skeleton skeleton--text" style="width: 70%"></span>
        <span class="skeleton skeleton--text"></span>
        <span class="skeleton skeleton--text" style="width: 60%"></span>
      </div>
    </div>`;
}

function view(salon, services, quiet) {
  const status = openStatus(salon);
  const address = addressText(salon);
  const maps = mapsUrl(salon);
  const tel = telUrl(salon);
  const insta = instagramUrl(salon);
  const notice = String(salon.notice || '').trim();
  const mine = mineView(salon);
  let i = 0;
  const reveal = () => `--i: ${i++}`;

  return html`
    <div class="page stack home${quiet ? ' is-quiet' : ''}">
      ${notice ? html`
        <div class="notice home__notice reveal" style="${reveal()}" role="note">
          ${icon('info')}<p class="home__notice-text">${notice}</p>
        </div>` : ''}

      <header class="signboard reveal" style="${reveal()}">
        <p class="signboard__kicker">${txt(salon.tagline || 'Barbière')}</p>
        <h1 class="signboard__name" tabindex="-1" data-screen-title>${txt(salon.name)}</h1>
        ${salon.city ? html`<p class="signboard__meta">${txt(salon.city)}</p>` : ''}
      </header>

      <section class="card home__info reveal" style="${reveal()}" aria-label="Infos pratiques">
        <p class="home__status ${status.open ? 'is-open' : 'is-closed'}" data-status>
          <span class="home__status-dot" aria-hidden="true"></span><span data-status-text>${status.text}</span>
        </p>
        ${address ? html`
          <a class="home__address" href="${maps}" target="_blank" rel="noopener">
            ${icon('epingle')}
            <span class="home__address-text">${txt(address)}<span class="home__address-hint">Itinéraire</span></span>
          </a>` : ''}
        ${tel || insta ? html`
          <div class="home__contact">
            ${tel ? html`<a class="btn btn--sm" href="${tel}">${icon('telephone')}<span>Appeler</span></a>` : ''}
            ${insta ? html`<a class="btn btn--sm" href="${insta}" target="_blank" rel="noopener">${icon('instagram')}<span>Instagram</span></a>` : ''}
          </div>` : ''}
      </section>

      ${canBook(salon, services) ? html`
        <section class="home__book reveal" style="${reveal()}" aria-label="Prendre rendez-vous">
          <p class="home__next" data-next-slot>
            ${icon('horloge')}<span class="skeleton skeleton--text home__next-skeleton" aria-hidden="true"></span>
          </p>
          <button class="btn btn--primary btn--lg btn--block" type="button" data-action="tarifs">${icon('ciseaux')}<span>Prendre rendez-vous</span></button>
        </section>` : ''}
      ${!salon.bookingEnabled ? html`
        <div class="notice notice--warn home__suspended reveal" style="${reveal()}" role="status">
          ${icon('alerte')}
          <div class="stack stack--sm">
            <p class="notice__title">Réservation en ligne momentanément suspendue${tel ? ' — appelez le salon.' : '.'}</p>
            ${tel
              ? html`<p><a class="btn btn--primary btn--sm" href="${tel}">${icon('telephone')}<span>Appeler le ${phoneLabel(salon)}</span></a></p>`
              : html`<p>Revenez un peu plus tard.</p>`}
          </div>
        </div>` : ''}

      <section class="home__mine reveal" style="${reveal()}" data-mine aria-labelledby="mine-title"${mine ? '' : html` hidden`}>${mine}</section>

      <section class="home__tarifs reveal" style="${reveal()}" id="tarifs" aria-labelledby="tarifs-title">
        <h2 class="section-title" id="tarifs-title">Prestations et tarifs</h2>
        ${salon.bookingEnabled && services.length
          ? html`<p class="muted small home__tarifs-hint">Touchez une prestation pour choisir votre créneau.</p>` : ''}
        ${services.length
          ? pricelist(services, { interactive: Boolean(salon.bookingEnabled) })
          : html`<p class="muted">Les prestations seront bientôt affichées ici.</p>`}
        ${isDemo() ? html`<p class="muted small home__demo-note">Démonstration : prestations et tarifs donnés à titre d’exemple.</p>` : ''}
      </section>
    </div>`;
}

/** Rendez-vous à venir pris depuis ce téléphone ('' si aucun n'est mémorisé). */
function mineView(salon) {
  const entries = readMesRdv();
  if (!entries.length) return '';
  const tz = tzOf(salon);
  const now = Date.now();
  const upcoming = entries
    .filter((e) => e.status !== 'cancelled' && Date.parse(e.start) > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, 3);
  return html`
    <h2 class="section-title" id="mine-title">Mes rendez-vous</h2>
    ${upcoming.length ? html`
      <ul class="list">
        ${upcoming.map((e) => html`<li>
          <a class="list__item" href="#/rdv/${encodeURIComponent(e.token)}" data-key="${`rdv:${e.token}`}">
            <span class="avatar home__mine-icon" aria-hidden="true">${icon('calendrier')}</span>
            <span class="list__main">
              <span class="list__title">${cap(dayLabel(zonedParts(e.start, tz).ymd, tz))} à ${fmtTime(e.start, tz)}</span>
              <span class="list__meta">${e.serviceName}</span>
            </span>
            ${icon('chevron-droite')}
          </a></li>`)}
      </ul>` : html`<p class="muted small">Aucun rendez-vous à venir sur ce navigateur.</p>`}
    <a class="btn btn--ghost btn--sm home__mine-all" href="#/mes-rdv">Tous mes rendez-vous ${icon('chevron-droite')}</a>`;
}

// — Mises à jour après le premier affichage ————————————————————————

function updateStatus(root, salon) {
  const el = root.querySelector('[data-status]');
  if (!el) return;
  const status = openStatus(salon);
  el.classList.toggle('is-open', status.open);
  el.classList.toggle('is-closed', !status.open);
  el.querySelector('[data-status-text]').textContent = status.text;
}

/** « Prochain créneau libre : demain à 10h15 » (vrai pour toutes les prestations : nextSlotDuration). */
async function fillNextSlot(ctx, salon, services) {
  const tz = tzOf(salon);
  const days = horizonDays(salon);
  const durationMin = nextSlotDuration(services);
  let found = null;
  try {
    const busy = await loadBusy(ctx.store, todayYMD(tz), tz, days);
    found = durationMin ? firstAvailable({ salon, durationMin, busy, now: new Date(), days }) : null;
  } catch {
    found = undefined;     // hors connexion : on n'affiche rien plutôt qu'une information fausse
  }
  if (!ctx.isCurrent()) return;
  const box = ctx.root.querySelector('[data-next-slot]');
  if (!box) return;
  if (found === undefined) { box.hidden = true; return; }
  paint(box, found
    ? html`${icon('horloge')}<span>Prochain créneau libre : <strong>${dayLabel(found.ymd, tz)} à ${fmtTime(found.slot.start, tz)}</strong></span>`
    : html`${icon('horloge')}<span>Plus de créneau libre en ligne pour le moment.</span>`);
}

/**
 * Rendez-vous mémorisés dont le statut est relu à l'ouverture de l'accueil : ceux
 * d'hier et à venir, TOUS statuts (un RDV annulé puis rétabli par le salon doit réapparaître).
 */
export function mineToRefresh(entries, now = Date.now()) {
  return entries.filter((e) => Date.parse(e.start) > now - DAY);
}

/** Rafraîchit le statut des rendez-vous à venir mémorisés (annulés par le salon, etc.). */
async function refreshMine(ctx, salon) {
  const entries = mineToRefresh(readMesRdv());
  if (!entries.length) return;
  const results = await Promise.allSettled(entries.map((e) => ctx.store.getBooking(e.token)));
  applyBookingResults(entries, results);
  if (!ctx.isCurrent()) return;
  const box = ctx.root.querySelector('[data-mine]');
  if (!box) return;
  const mine = mineView(salon);
  paint(box, mine);
  box.hidden = !mine;
}

/** Fait défiler jusqu'au tableau des tarifs ; → première prestation (bouton) ou null. */
function showTarifs(root, { smooth = true, focus = true } = {}) {
  const section = root.querySelector('#tarifs');
  if (!section) return null;
  section.scrollIntoView({ behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto', block: 'start' });
  const first = section.querySelector('button.pricelist__item');
  if (focus && first) first.focus({ preventScroll: true });
  return first;
}
