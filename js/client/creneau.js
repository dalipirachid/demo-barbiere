// Écran 1 — Créneau (#/creneau/<serviceId>) : le jour, puis l'heure.
// Les occupations sont lues UNE fois pour toute la plage réservable
// (getBusy, sans donnée personnelle) ; les créneaux de chaque jour sont
// ensuite calculés dans le téléphone (computeDaySlots).

import { html, icon, announce, render as paint } from '../ui/dom.js';
import {
  todayYMD, addDaysYMD, fmtDayShort, fmtDayLong, fmtClock, fmtPrice, fmtDuration, minutesOf,
} from '../core/dates.js';
import { computeDaySlots, isDayOpen } from '../core/slots.js';
import { loadSalon, loadServices, horizonDays, loadBusy } from './donnees.js';
import { draft, selectService, session } from './etat.js';
import { appbar, progress, animateProgress, bookingSkeleton, prefersReducedMotion, flag } from './commun.js';
import { tzOf, cap, dayLabel, telUrl, setDocumentTitle } from './salon.js';

const TITLE = 'Choisir un créneau';
const NOON = 12 * 60;
const EVENING = 17 * 60;
const GROUPS = [
  ['Matin', (m) => m < NOON],
  ['Après-midi', (m) => m >= NOON && m < EVENING],
  ['Soir', (m) => m >= EVENING],
];

/** Créneaux recalculés quand les données changent (réservation ailleurs, réglages…). */
export function shouldRefresh() {
  return true;
}

export async function render(ctx) {
  const { store, root } = ctx;
  const serviceId = ctx.params.serviceId;
  ctx.on('click', '[data-action="back"]', () => ctx.back('#/'));
  ctx.on('click', '[data-action="change-service"]', () => changeService(ctx));

  if (!ctx.quiet) {
    ctx.render(bookingSkeleton({ title: TITLE, step: 1, label: 'jour et heure', text: 'Recherche des créneaux libres…' }));
  }
  const [salon, services] = await Promise.all([loadSalon(store), loadServices(store)]);
  if (!ctx.isCurrent()) return '';
  setDocumentTitle(salon, TITLE);

  const service = services.find((s) => s.id === serviceId);
  if (!service) {
    ctx.render(messageView({
      salon,
      heading: 'Cette prestation n’est plus proposée en ligne',
      text: 'Elle a peut-être été modifiée par le salon. Choisissez parmi les prestations actuelles.',
    }));
    return 'Cette prestation n’est plus proposée en ligne.';
  }
  if (!salon.bookingEnabled) {
    ctx.render(messageView({
      salon,
      heading: 'Réservation en ligne momentanément suspendue',
      // Pas d'appel proposé sans numéro du salon (champ facultatif des Réglages).
      text: telUrl(salon) ? 'Appelez le salon pour prendre rendez-vous.' : 'Revenez un peu plus tard.',
    }));
    return 'La réservation en ligne est momentanément suspendue.';
  }

  selectService(serviceId);
  const tz = tzOf(salon);
  const now = new Date();
  const today = todayYMD(tz, now);
  const count = horizonDays(salon);
  // Toute la plage réservable (« 3 mois » compris), lue par tranches de getBusy.
  const busy = await loadBusy(store, today, tz, count);
  if (!ctx.isCurrent()) return '';

  const days = buildDays({ salon, durationMin: service.durationMin, busy, today, count, now });
  // Jour affiché : celui déjà choisi (retour depuis l'étape 2), sinon le premier qui a de la place.
  const selected = days.find((d) => d.ymd === draft.ymd && d.open)
    || days.find((d) => d.slots.length)
    || days.find((d) => d.open)
    || days[0];
  draft.ymd = selected.ymd;
  if (draft.start && !selected.slots.some((s) => s.start.toISOString() === draft.start)) draft.start = '';

  // Re-rendu silencieux : la bande de jours reste là où le doigt l'a laissée.
  const oldStrip = ctx.quiet ? root.querySelector('[data-daystrip]') : null;
  const stripLeft = oldStrip ? oldStrip.scrollLeft : null;
  ctx.render(view({ salon, service, days, today, selected, quiet: ctx.quiet }));
  animateProgress(root, { instant: ctx.quiet });
  if (stripLeft === null) centerDay(root, selected.ymd, false);
  else root.querySelector('[data-daystrip]').scrollLeft = stripLeft;

  // — Choix du jour —
  const selectDay = (ymd, { focusFirst = false } = {}) => {
    const day = days.find((d) => d.ymd === ymd);
    if (!day || !day.open) return;
    draft.ymd = ymd;
    for (const btn of root.querySelectorAll('[data-ymd]')) btn.setAttribute('aria-pressed', String(btn.dataset.ymd === ymd));
    paint(root.querySelector('[data-day-label]'), cap(fmtDayLong(ymd)));
    paint(root.querySelector('[data-slots]'), slotsView(day, days, salon));
    centerDay(root, ymd, true);
    announce(daySummary(day));
    if (focusFirst) {
      const first = root.querySelector('[data-start]');
      if (first) first.focus();
    }
  };
  ctx.on('click', '[data-ymd]', (event, btn) => {
    if (!btn.disabled) selectDay(btn.dataset.ymd);
  });
  ctx.on('click', '[data-goto]', (event, btn) => selectDay(btn.dataset.goto, { focusFirst: true }));

  // — Choix de l'heure : on montre le créneau choisi (poteau), puis étape 2 —
  let leaving = false;
  ctx.on('click', '[data-start]', (event, btn) => {
    if (leaving) return;
    leaving = true;
    draft.start = btn.dataset.start;
    for (const slot of root.querySelectorAll('[data-start]')) slot.setAttribute('aria-pressed', String(slot === btn));
    const from = location.hash;
    setTimeout(() => {
      // Un re-rendu silencieux entre-temps ne doit pas annuler le choix.
      if (location.hash === from) ctx.go('#/coordonnees');
    }, prefersReducedMotion() ? 0 : 220);
  });

  return days.some((d) => d.slots.length)
    ? `Étape 1 sur 3 : choisissez le jour et l’heure pour ${service.name}. ${daySummary(selected)}`
    : `Aucun créneau disponible en ligne pour ${service.name}.`;
}

/**
 * Jours proposés : { ymd, open, slots, over }. `over` : aujourd'hui, plus aucun
 * créneau même salon vide (heure de fermeture ou préavis dépassés) — la journée
 * est terminée, elle n'est pas « complète ».
 */
export function buildDays({ salon, durationMin, busy, today, count, now = new Date() }) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const ymd = addDaysYMD(today, i);
    const open = isDayOpen(salon, ymd);
    const slots = open ? computeDaySlots({ salon, durationMin, ymd, busy, now }) : [];
    const over = open && !slots.length && ymd === today
      && !computeDaySlots({ salon, durationMin, ymd, busy: [], now }).length;
    days.push({ ymd, open, slots, over });
  }
  return days;
}

/** État d'un jour en clair : 'fermé' | 'journée terminée' | 'complet' | 'N créneaux libres'. */
export function dayState(day) {
  if (!day.open) return 'fermé';
  if (day.slots.length) return plural(day.slots.length, 'créneau libre', 'créneaux libres');
  return day.over ? 'journée terminée' : 'complet';
}

// — Vues ——————————————————————————————————————————————————————————

function view({ salon, service, days, today, selected, quiet }) {
  return html`
    ${appbar({ title: TITLE })}
    <div class="page stack booking${quiet ? ' is-quiet' : ''}">
      ${progress(1, 'jour et heure')}

      <section class="card booking-service reveal" style="--i: 0" aria-label="Prestation choisie">
        <div class="booking-service__text">
          <p class="booking-service__name">${service.name}</p>
          <p class="booking-service__meta">${fmtDuration(service.durationMin)} · ${fmtPrice(service.priceCents)}</p>
        </div>
        <button class="btn btn--ghost btn--sm" type="button" data-action="change-service" aria-label="Changer de prestation">Changer</button>
      </section>

      <section class="booking-days reveal" style="--i: 1" aria-labelledby="days-title">
        <h2 class="section-title" id="days-title">Le jour</h2>
        <div class="daystrip" role="group" aria-labelledby="days-title" data-daystrip>
          ${days.map((d) => dayButton(d, selected.ymd, today))}
        </div>
      </section>

      <section class="booking-times reveal" style="--i: 2" aria-labelledby="times-title">
        <h2 class="section-title" id="times-title">L’heure · <span data-day-label>${cap(fmtDayLong(selected.ymd))}</span></h2>
        <div class="slots" data-slots>${slotsView(selected, days, salon)}</div>
      </section>
    </div>`;
}

function dayButton(day, selectedYmd, today) {
  const short = fmtDayShort(day.ymd);
  const isToday = day.ymd === today;
  const full = day.open && !day.slots.length;
  const classes = ['daystrip__day'];
  if (isToday) classes.push('daystrip__day--today');
  if (!day.open) classes.push('daystrip__day--closed');
  if (full) classes.push('daystrip__day--full');
  const label = `${cap(fmtDayLong(day.ymd))}${isToday ? ' (aujourd’hui)' : ''}, ${dayState(day)}`;
  return html`
    <button class="${classes.join(' ')}" type="button" data-ymd="${day.ymd}" data-key="${`day:${day.ymd}`}"
            aria-pressed="${day.open && day.ymd === selectedYmd ? 'true' : 'false'}" aria-label="${label}"${flag(!day.open, 'disabled')}>
      <span class="daystrip__dow">${isToday ? 'auj.' : short.dow}</span>
      <span class="daystrip__num">${short.day}</span>
      <span class="daystrip__month">${!day.open ? 'fermé' : full ? (day.over ? 'terminé' : 'complet') : short.month}</span>
    </button>`;
}

function slotsView(day, days, salon) {
  if (day.slots.length) {
    return GROUPS.map(([label, test]) => {
      const list = day.slots.filter((s) => test(minutesOf(s.hhmm)));
      if (!list.length) return '';
      return html`
        <h3 class="slots__title">${label}</h3>
        <div class="slots__grid">
          ${list.map((s) => {
            const iso = s.start.toISOString();
            return html`<button class="slots__slot" type="button" data-start="${iso}" data-key="${`slot:${iso}`}" aria-pressed="${iso === draft.start ? 'true' : 'false'}">${fmtClock(s.hhmm)}</button>`;
          })}
        </div>`;
    });
  }

  // Jour complet (ou fermé) : on propose directement le prochain créneau libre.
  const tz = tzOf(salon);
  const next = days.find((d) => d.ymd > day.ymd && d.slots.length);
  const first = next || days.find((d) => d.slots.length);
  const tel = telUrl(salon);
  return html`
    <div class="empty booking-empty">
      <div class="empty__icon">${icon('calendrier')}</div>
      <h3 class="empty__title">${!day.open ? 'Le salon est fermé ce jour-là' : day.over ? 'La journée est terminée' : 'Plus de place ce jour-là'}</h3>
      ${first ? html`
        <div class="empty__actions">
          <button class="btn btn--primary" type="button" data-goto="${first.ymd}" data-key="${`goto:${first.ymd}`}">
            ${next ? 'Prochain créneau' : 'Premier créneau libre'} : ${dayLabel(first.ymd, tz)} à ${fmtClock(first.slots[0].hhmm)}
          </button>
        </div>` : html`
        <p class="empty__text">Aucun créneau n’est ouvert en ligne pour le moment.${tel ? ' Appelez le salon : il trouvera peut-être une solution.' : ''}</p>
        ${tel ? html`<div class="empty__actions"><a class="btn btn--primary" href="${tel}">${icon('telephone')}<span>Appeler le salon</span></a></div>` : ''}`}
    </div>`;
}

/** Écran sans choix possible (prestation retirée, réservation suspendue). */
function messageView({ salon, heading, text }) {
  const tel = telUrl(salon);
  return html`
    ${appbar({ title: TITLE })}
    <div class="page">
      <div class="empty">
        <div class="empty__icon">${icon('info')}</div>
        <h2 class="empty__title">${heading}</h2>
        <p class="empty__text">${text}</p>
        <div class="empty__actions">
          ${tel ? html`<a class="btn btn--primary" href="${tel}">${icon('telephone')}<span>Appeler le salon</span></a>` : ''}
          <a class="btn btn--ghost" href="#/">Voir les prestations</a>
        </div>
      </div>
    </div>`;
}

// — Outils ————————————————————————————————————————————————————————

function plural(n, one, many) {
  return `${n} ${n > 1 ? many : one}`;
}

function daySummary(day) {
  const name = cap(fmtDayLong(day.ymd));
  if (!day.open) return `${name} : le salon est fermé.`;
  return `${name} : ${dayState(day)}.`;
}

/** Centre le jour choisi dans la bande de jours (sans faire défiler la page). */
function centerDay(root, ymd, smooth) {
  const strip = root.querySelector('[data-daystrip]');
  const btn = strip && strip.querySelector(`[data-ymd="${ymd}"]`);
  if (!btn) return;
  const s = strip.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  strip.scrollBy({ left: b.left - s.left - (s.width - b.width) / 2, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
}

/** « Changer » : retour au tableau des tarifs de l'accueil. */
function changeService(ctx) {
  session.focusTarifs = true;
  if (ctx.prevPath() === '/') ctx.back();
  else ctx.replace('#/');
}
