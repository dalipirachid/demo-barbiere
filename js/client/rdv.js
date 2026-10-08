// Écran 3 — Confirmation (#/rdv/<token>) : le ticket du rendez-vous.
// Juste après la réservation, il s'affiche sans relire le serveur ; ensuite
// (lien rechargé, « Mes rendez-vous »), getBooking(token) le retrouve.
// Boutons : agenda (.ics), itinéraire, lien à garder, annulation. Invitation
// discrète à installer l'appli (seulement ici).
//
// Le lien du ticket est la seule clé du rendez-vous (pas de compte) : la mémoire
// du navigateur ne suffit pas (iPhone : l'appli installée a un stockage séparé de
// Safari, effacé après 7 jours sans visite). Il est donc proposé à la cliente
// (partage / copie, affiché en clair) et écrit dans le fichier agenda.

import { html, icon, toast } from '../ui/dom.js';
import { fmtDayLong, fmtTime, fmtPrice, fmtDuration, fmtDateTime, zonedParts, toMs } from '../core/dates.js';
import { isBookingError } from '../core/errors.js';
import { setupInstall, isIOS, isInAppBrowser } from '../ui/pwa.js';
import { loadSalon, loadServices } from './donnees.js';
import { session } from './etat.js';
import { readMesRdv, saveMesRdv, removeMesRdv } from './memoire.js';
import { appbar, progress, animateProgress, bookingSkeleton, errorView, TRANSIENT_CODES } from './commun.js';
import { buildICS, downloadICS } from './ics.js';
import { cancelWithConfirm } from './annulation.js';
import { txt, tzOf, addressText, mapsUrl, setDocumentTitle } from './salon.js';

const TITLE = 'Votre rendez-vous';
const NNBSP = ' ';   // espace fine insécable avant « ! »

let install = null;       // invitation à installer (créée une seule fois)

/** Le ticket ne se redessine pas tout seul (il gère lui-même l'annulation). */
export function shouldRefresh() {
  return false;
}

export async function render(ctx) {
  const { store, root } = ctx;
  const token = ctx.params.token;
  ctx.on('click', '[data-action="back"]', () => (ctx.prevPath() === '/' ? ctx.back() : ctx.go('#/')));

  // Juste après la réservation : affichage immédiat, une seule fois (ensuite on relit
  // le serveur, qui connaît une éventuelle annulation).
  const fresh = session.lastBooking && session.lastBooking.token === token ? session.lastBooking : null;
  session.lastBooking = null;
  if (!fresh) ctx.render(bookingSkeleton({ title: TITLE, text: 'Recherche de votre rendez-vous…' }));

  let salon;
  let booking;
  let offline = false;
  try {
    [salon, booking] = await Promise.all([loadSalon(store), fresh ? fresh : store.getBooking(token)]);
  } catch (err) {
    if (!ctx.isCurrent()) return '';
    // Hors connexion : on montre ce que le téléphone a gardé, s'il l'a.
    const kept = readMesRdv().find((e) => e.token === token);
    if (!kept || (isBookingError(err) && !TRANSIENT_CODES.includes(err.code))) {
      ctx.render(errorView(err, { title: 'Rendez-vous indisponible' }));
      return 'Rendez-vous indisponible pour le moment.';
    }
    salon = await loadSalon(store).catch(() => null);
    if (!ctx.isCurrent()) return '';
    if (!salon) {
      ctx.render(errorView(err, { title: 'Rendez-vous indisponible' }));
      return 'Rendez-vous indisponible pour le moment.';
    }
    booking = { start: kept.start, end: kept.end, status: kept.status || 'confirmed', serviceName: kept.serviceName, priceCents: null, firstName: '' };
    offline = true;
  }
  if (!ctx.isCurrent()) return '';

  if (!booking) {
    removeMesRdv(token);
    setDocumentTitle(salon, 'Rendez-vous introuvable');
    ctx.render(notFoundView());
    return 'Rendez-vous introuvable.';
  }
  setDocumentTitle(salon, TITLE);

  // Mémorisé sur ce téléphone (« Mes rendez-vous »).
  if (!offline) {
    const kept = readMesRdv().find((e) => e.token === token);
    saveMesRdv({
      token, start: booking.start, end: booking.end, serviceName: booking.serviceName,
      serviceId: (fresh && fresh.serviceId) || (kept && kept.serviceId) || '', status: booking.status,
    });
  }

  const state = { booking, fresh: Boolean(fresh), offline };
  const draw = () => {
    ctx.render(view(salon, token, state));
    if (state.fresh) animateProgress(root);
    mountInstall(ctx, state);
  };
  draw();

  ctx.on('click', '[data-action="ics"]', () => addToCalendar(salon, token, state.booking));
  ctx.on('click', '[data-action="keep-link"]', () => keepLink(root, salon, token, state.booking));
  ctx.on('click', '[data-action="cancel"]', async (event, btn) => {
    const outcome = await cancelWithConfirm({ store, salon, token, booking: state.booking, button: btn });
    if (!ctx.isCurrent()) return;
    if (outcome === 'cancelled') {
      state.booking = { ...state.booking, status: 'cancelled' };
      state.fresh = false;
      draw();
      const title = root.querySelector('[data-screen-title]');
      if (title) title.focus({ preventScroll: true });
    } else if (outcome === 'not-found') {
      ctx.render(notFoundView());
    }
  });
  ctx.on('click', '[data-action="again"]', async () => {
    const serviceId = await findServiceId(store, token, state.booking);
    ctx.go(serviceId ? `#/creneau/${encodeURIComponent(serviceId)}` : '#/');
  });

  const tz = tzOf(salon);
  const when = `${fmtDayLong(zonedParts(booking.start, tz).ymd)} à ${fmtTime(booking.start, tz)}`;
  if (booking.status === 'cancelled') return `Ce rendez-vous du ${when} est annulé.`;
  return fresh ? `Rendez-vous confirmé pour ${when}.` : `Votre rendez-vous du ${when}.`;
}

// — Vues ——————————————————————————————————————————————————————————

function kind(booking) {
  if (booking.status === 'cancelled') return 'cancelled';
  if (booking.status !== 'confirmed' || toMs(booking.end || booking.start) < Date.now()) return 'past';
  return 'upcoming';
}

function view(salon, token, { booking, fresh, offline }) {
  const tz = tzOf(salon);
  const k = kind(booking);
  const name = String(booking.firstName || '').trim();
  const ymd = zonedParts(booking.start, tz).ymd;
  const duration = booking.end ? Math.round((toMs(booking.end) - toMs(booking.start)) / 60_000) : 0;
  const address = addressText(salon);
  const maps = mapsUrl(salon);
  const cancelHours = Number(salon.cancelLimitHours) || 0;

  const kicker = { upcoming: 'Rendez-vous confirmé', cancelled: 'Rendez-vous annulé', past: 'Rendez-vous passé' }[k];
  const title = {
    upcoming: name ? `C’est noté, ${name}${NNBSP}!` : `C’est noté${NNBSP}!`,
    cancelled: name ? `${name}, ce rendez-vous est annulé` : 'Ce rendez-vous est annulé',
    past: name ? `À bientôt, ${name}${NNBSP}!` : `À bientôt${NNBSP}!`,
  }[k];
  const stamp = { upcoming: 'Confirmé', cancelled: 'Annulé', past: '' }[k];

  return html`
    ${appbar({ title: TITLE, titleTag: 'p', backLabel: 'Retour à l’accueil' })}
    <div class="page stack rdv${fresh ? ' rdv--fresh' : ''}">
      ${fresh ? progress(3, 'c’est réservé') : ''}
      ${offline ? html`<div class="notice notice--warn" role="status">${icon('info')}<p>Hors connexion : voici les informations gardées sur ce téléphone.</p></div>` : ''}

      <article class="ticket rdv__ticket rdv__ticket--${k} reveal" style="--i: 0" aria-labelledby="rdv-title">
        <div class="ticket__main">
          <p class="ticket__kicker">${kicker}</p>
          <h1 class="ticket__title" id="rdv-title" tabindex="-1" data-screen-title>${title}</h1>
          <p class="ticket__when">${fmtDayLong(ymd)} · ${fmtTime(booking.start, tz)}</p>
          <dl class="ticket__details">
            <div><dt>Prestation</dt><dd>${booking.serviceName || '—'}</dd></div>
            ${duration > 0 ? html`<div><dt>Durée</dt><dd>${fmtDuration(duration)}</dd></div>` : ''}
            ${Number.isFinite(booking.priceCents) ? html`<div><dt>Prix</dt><dd>${fmtPrice(booking.priceCents)}</dd></div>` : ''}
          </dl>
          ${stamp ? html`<span class="ticket__stamp" aria-hidden="true">${stamp}</span>` : ''}
        </div>
        <div class="ticket__stub">
          <div class="stack stack--sm">
            ${address ? html`<p class="rdv__address">${icon('epingle')}<span><span class="rdv__salon">${txt(salon.name)}</span>${txt(address)}</span></p>` : ''}
            ${k === 'upcoming' && cancelHours > 0
              ? html`<p class="muted small">Annulation en ligne possible jusqu’à ${cancelHours}${NNBSP}h avant le rendez-vous.</p>` : ''}
            <div class="rdv__actions">
              ${k === 'upcoming' ? html`
                <button class="btn btn--primary btn--block" type="button" data-action="ics">${icon('calendrier')}<span>Ajouter à mon agenda</span></button>` : ''}
              ${k === 'upcoming' && maps ? html`
                <a class="btn btn--block" href="${maps}" target="_blank" rel="noopener">${icon('epingle')}<span>Itinéraire</span></a>` : ''}
              ${k !== 'upcoming' ? html`
                <button class="btn btn--primary btn--block" type="button" data-action="again">${icon('ciseaux')}<span>Reprendre le même rendez-vous</span></button>` : ''}
            </div>
            <p class="ticket__ref">Réf. ${token.slice(0, 8).toUpperCase()}</p>
          </div>
        </div>
      </article>

      ${k === 'upcoming' ? html`
        <section class="card card--flat rdv__keep reveal" style="--i: 1" aria-labelledby="keep-title">
          <h2 class="rdv__keep-title" id="keep-title">Gardez le lien de ce rendez-vous</h2>
          <p class="rdv__keep-text">Il permet de le revoir ou de l’annuler depuis n’importe quel appareil, même si ce navigateur l’oublie. Envoyez-le-vous (notes, message)&nbsp;: il est aussi dans le fichier agenda.</p>
          ${isInAppBrowser() ? html`
            <p class="rdv__keep-text">Vous êtes dans le navigateur d’une appli (Instagram, Facebook…)&nbsp;: ce rendez-vous ne sera pas visible dans Safari ou Chrome sans ce lien. Pour installer l’appli, ouvrez le site dans votre navigateur (menu ··· → Ouvrir dans le navigateur).</p>` : ''}
          <p class="rdv__link" data-ticket-link>${ticketLink(token)}</p>
          <button class="btn btn--block" type="button" data-action="keep-link">${icon('partage')}<span>${canShare() ? 'Partager le lien de mon rendez-vous' : 'Copier le lien de mon rendez-vous'}</span></button>
        </section>

        <button class="btn btn--danger btn--block reveal" style="--i: 2" type="button" data-action="cancel">Annuler ce rendez-vous</button>` : ''}

      <p class="rdv__mine muted small center reveal" style="--i: 3">
        Retrouvez ce RDV dans <a href="#/mes-rdv">Mes rendez-vous</a> sur ce navigateur.
      </p>

      ${k === 'upcoming' ? html`
        <aside class="card card--flat rdv__install reveal" style="--i: 4" data-install hidden aria-label="Installer l’appli">
          <p class="rdv__install-text">${icon('installer')}<span>${isIOS()
            ? 'Pour vos prochaines réservations, ajoutez l’appli à votre écran d’accueil. Elle ne verra pas ce rendez-vous-ci : gardez son lien.'
            : 'Ajoutez l’appli à votre écran d’accueil pour reprendre rendez-vous en un geste.'}</span></p>
          <div class="cluster" data-install-slot>
            <button class="btn btn--ghost btn--sm" type="button" data-action="install-later">Plus tard</button>
          </div>
        </aside>` : ''}

      <a class="btn btn--ghost btn--block" href="#/">Retour à l’accueil</a>
    </div>`;
}

function notFoundView() {
  return html`
    ${appbar({ title: TITLE, backLabel: 'Retour à l’accueil' })}
    <div class="page">
      <div class="empty">
        <div class="empty__icon">${icon('calendrier')}</div>
        <h2 class="empty__title">Rendez-vous introuvable</h2>
        <p class="empty__text">Ce lien ne correspond à aucun rendez-vous. Il a peut-être été supprimé par le salon.</p>
        <div class="empty__actions"><a class="btn btn--primary" href="#/">Retour à l’accueil</a></div>
      </div>
    </div>`;
}

// — Actions ———————————————————————————————————————————————————————

/** Adresse du ticket (#/rdv/<jeton>) : ouvre le rendez-vous sur n'importe quel appareil. */
export function ticketLink(token, base = location.href) {
  return new URL(`#/rdv/${encodeURIComponent(token)}`, base).href;
}

/** Contenu du fichier agenda : le lien du ticket est dans DESCRIPTION et dans URL. */
export function ticketICS(salon, token, booking, { base, now = new Date() } = {}) {
  const tz = tzOf(salon);
  const end = booking.end || new Date(toMs(booking.start) + 30 * 60_000).toISOString();
  const link = ticketLink(token, base);
  const salonName = String(salon.name || '').trim();
  return buildICS({
    uid: `${token}@barbiere`,
    start: booking.start,
    end,
    summary: salonName ? `${booking.serviceName} — ${salonName}` : booking.serviceName,
    location: addressText(salon),
    description: `${booking.serviceName}${Number.isFinite(booking.priceCents) ? ` (${fmtPrice(booking.priceCents)})` : ''}.\n`
      + `Voir ou annuler le rendez-vous : ${link}`,
    url: link,
    alarmMinutes: 120,
    alarmText: `Rendez-vous ${booking.serviceName} à ${fmtTime(booking.start, tz)}`,
    now,
  });
}

function addToCalendar(salon, token, booking) {
  const tz = tzOf(salon);
  downloadICS(`rendez-vous-${zonedParts(booking.start, tz).ymd}.ics`, ticketICS(salon, token, booking));
  toast('Fichier agenda prêt : ouvrez-le pour ajouter le rendez-vous à votre agenda.', { type: 'success' });
}

function canShare() {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** « Partager / Copier le lien de mon rendez-vous » : partage du système, sinon presse-papiers. */
async function keepLink(root, salon, token, booking) {
  const link = ticketLink(token);
  if (canShare()) {
    const name = String(salon.name || '').trim();
    const when = fmtDateTime(booking.start, tzOf(salon));
    try {
      await navigator.share({
        title: 'Mon rendez-vous',
        text: `${booking.serviceName || 'Rendez-vous'}${name ? ` chez ${name}` : ''}, ${when}. Pour le revoir ou l’annuler :`,
        url: link,
      });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // partage refermé par la cliente
    }
  }
  try {
    await navigator.clipboard.writeText(link);
    toast('Lien copié : collez-le dans vos notes ou envoyez-le-vous par message.', { type: 'success' });
  } catch {
    // Copie refusée : le lien affiché est sélectionné, à copier à la main.
    const el = root.querySelector('[data-ticket-link]');
    const selection = el && window.getSelection ? window.getSelection() : null;
    if (selection) selection.selectAllChildren(el);
    toast('Copie impossible : le lien est sélectionné ci-dessus, copiez-le avec le menu du téléphone.');
  }
}

/** Prestation à reprendre : celle mémorisée, sinon retrouvée par son nom. */
async function findServiceId(store, token, booking) {
  const kept = readMesRdv().find((e) => e.token === token);
  try {
    const services = await loadServices(store);
    if (kept && kept.serviceId && services.some((s) => s.id === kept.serviceId)) return kept.serviceId;
    const byName = services.find((s) => s.name === booking.serviceName);
    return byName ? byName.id : '';
  } catch {
    return kept ? kept.serviceId : '';
  }
}

/** Invitation discrète à installer l'appli (masquée si impossible, faite ou refusée). */
function mountInstall(ctx, state) {
  const box = ctx.root.querySelector('[data-install]');
  if (!box) return;
  if (!install) install = setupInstall({ mode: 'client' });
  const button = install.button({ className: 'btn btn--primary btn--sm', label: 'Installer l’appli' });
  box.querySelector('[data-install-slot]').prepend(button);
  const sync = () => { box.hidden = !install.available || state.booking.status === 'cancelled'; };
  sync();
  ctx.onCleanup(install.onChange(sync));
  ctx.on('click', '[data-action="install-later"]', () => install.dismiss());
}
