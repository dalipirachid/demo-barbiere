// Écran 0 — Accueil (#/) : l'enseigne (blason sur le marbre, ou nom du salon en
// grand si la barbière a choisi de ne pas afficher le blason), les infos
// pratiques, le prochain créneau libre, « Mes rendez-vous » et le tableau des
// tarifs, dont chaque ligne lance la réservation de la prestation.

import { html, icon, render as paint } from '../ui/dom.js';
import { todayYMD, fmtTime, zonedParts } from '../core/dates.js';
import { firstAvailable } from '../core/slots.js';
import { foldText } from '../core/validate.js';
import { displayName } from '../core/setup.js';
import { isDemo } from '../data/store.js';
import { loadSalon, loadServices, horizonDays, loadBusy } from './donnees.js';
import { readMesRdv, applyBookingResults } from './memoire.js';
import { session } from './etat.js';
import { pricelist, prefersReducedMotion } from './commun.js';
import {
  txt, cap, tzOf, openStatus, addressText, mapsUrl, telUrl, phoneLabel, instagramUrl,
  dayLabel, setDocumentTitle, showsCrest, salonTitle,
} from './salon.js';

const STATUS_TICK_MS = 60_000;
const DAY = 86_400_000;

/** Blason fourni par la cliente (seule image de marque, docs/DESIGN.md) : il porte le nom écrit sur son ruban. */
export const BLASON = Object.freeze({ src: './img/blason.webp', alt: 'Private Barbière', width: 655, height: 742 });

const fold = (value) => foldText(String(value ?? '').trim().replace(/\s+/g, ' '));

/** Vrai si le nom du salon est celui que porte le blason (casse et accents ignorés) : il n'est alors pas répété en texte. */
export function nameOnBlason(name) {
  return fold(name) === fold(BLASON.alt);
}

/** Accroche de l'enseigne ('' si absente ou si elle redit le nom : « Barbière »). */
export function signTagline(salon) {
  const tagline = String((salon && salon.tagline) || '').trim();
  return tagline && !fold(displayName(salon)).includes(fold(tagline)) ? tagline : '';
}

/**
 * Taille du nom écrit sur l'enseigne, pour qu'il tienne sans déborder dès 320 px :
 *   longest : nombre de lettres du mot le plus long (la police est calculée pour
 *             qu'il tienne sur une ligne, voir .home__sign-name dans client.css) ;
 *   max     : taille plafond en rem, plus petite pour un nom long (plusieurs lignes).
 */
export function signNameFit(name, { crest = false } = {}) {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ');
  const longest = Math.max(5, ...text.split(' ').map((word) => [...word].length));
  const length = [...text].length;
  const max = crest
    ? (length <= 18 ? 2.25 : 1.875)                        // sous le blason : nom en second
    : (length <= 14 ? 3 : length <= 28 ? 2.5 : 2);         // sans blason : le nom fait l'enseigne
  return { longest, max };
}

/**
 * Composition de l'enseigne (§8 bis) :
 *   crest  : blason affiché (salon.showCrest absent → oui) ;
 *   title  : texte du <h1>, nom du salon ou marqueur « [À COMPLÉTER] » (démo) ;
 *   todo   : le nom est encore à compléter ;
 *   hidden : <h1> réservé aux lecteurs d'écran, le ruban du blason portant déjà ce nom ;
 *   tagline: accroche à afficher ('' si absente ou redondante).
 */
export function signboardModel(salon) {
  const crest = showsCrest(salon);
  const name = displayName(salon);
  return {
    crest,
    title: salonTitle(salon),
    todo: !name,
    hidden: crest && Boolean(name) && nameOnBlason(name),
    tagline: signTagline(salon),
  };
}

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

/** Variables de taille du nom (signNameFit), posées sur le <h1> de l'enseigne. */
function fitStyle(title, crest) {
  const { longest, max } = signNameFit(title, { crest });
  return `--mot: ${longest}; --nom-max: ${max}rem`;
}

/**
 * L'enseigne de l'accueil (.signboard : marbre voilé, double filet d'or).
 * Blason affiché : le blason en premier, puis le nom du salon, titre de l'écran.
 * Quand le blason porte déjà ce nom (ruban « PRIVATE BARBIÈRE »), le titre reste
 * lu par les lecteurs d'écran mais n'est pas répété à l'œil ; sinon il s'affiche
 * en Cinzel sous le blason. Dimensions de l'image posées : rien ne bouge en arrivant.
 * Blason masqué (choix de la barbière) : le nom en grand, en Cinzel or, filet orné
 * et accroche dessous, dans une enseigne de même hauteur.
 */
function signboard(salon, reveal) {
  const sign = signboardModel(salon);
  const titleClass = sign.todo ? ' home__sign-name--todo' : '';
  if (!sign.crest) {
    return html`
      <header class="signboard home__sign home__sign--nom reveal" style="${reveal()}">
        <h1 class="signboard__name home__sign-name${titleClass}" style="${fitStyle(sign.title, false)}" tabindex="-1" data-screen-title>${txt(sign.title)}</h1>
        <div class="filet-orne home__sign-filet" aria-hidden="true"></div>
        ${sign.tagline ? html`<p class="signboard__kicker home__sign-tagline">${txt(sign.tagline)}</p>` : ''}
      </header>`;
  }
  return html`
    <header class="signboard home__sign${sign.hidden && !sign.tagline ? ' home__sign--solo' : ''} reveal" style="${reveal()}">
      <span class="blason home__blason"><img src="${BLASON.src}" alt="${BLASON.alt}" width="${BLASON.width}" height="${BLASON.height}" fetchpriority="high"></span>
      ${sign.tagline ? html`<p class="signboard__kicker">${txt(sign.tagline)}</p>` : ''}
      ${sign.hidden
        ? html`<h1 class="sr-only" tabindex="-1" data-screen-title>${sign.title}</h1>`
        : html`<h1 class="signboard__name home__sign-name${titleClass}" style="${fitStyle(sign.title, true)}" tabindex="-1" data-screen-title>${txt(sign.title)}</h1>`}
    </header>`;
}

function skeleton() {
  return html`
    <div class="page stack home" aria-busy="true">
      <p class="sr-only" role="status">Chargement…</p>
      <div class="signboard home__sign home__sign--solo" aria-hidden="true">
        <span class="home__blason home__blason--wait"></span>
      </div>
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
      ${signboard(salon, reveal)}
      ${notice ? html`
        <div class="notice home__notice reveal" style="${reveal()}" role="note">
          ${icon('info')}<p class="home__notice-text">${notice}</p>
        </div>` : ''}

      <section class="card home__info reveal" style="${reveal()}" aria-label="Infos pratiques">
        <p class="home__status ${status.open ? 'is-open' : 'is-closed'}" data-status>
          <span class="home__status-dot" aria-hidden="true"></span><span data-status-text>${status.text}</span>
        </p>
        ${address && maps ? html`
          <a class="home__address" href="${maps}" target="_blank" rel="noopener">
            ${icon('epingle')}
            <span class="home__address-text">${txt(address)}<span class="home__address-hint">Itinéraire</span></span>
          </a>` : ''}
        ${address && !maps ? html`
          <p class="home__address">
            ${icon('epingle')}
            <span class="home__address-text">${txt(address)}</span>
          </p>` : ''}
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
        <div class="filet-orne home__tarifs-filet" aria-hidden="true"></div>
        <h2 class="home__tarifs-title" id="tarifs-title">Prestations et tarifs</h2>
        ${salon.bookingEnabled && services.length
          ? html`<p class="muted small home__tarifs-hint">Touchez une prestation pour choisir votre créneau.</p>` : ''}
        ${services.length
          ? pricelist(services, { interactive: Boolean(salon.bookingEnabled) })
          : html`<p class="muted home__tarifs-hint">Les prestations seront bientôt affichées ici.</p>`}
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
