/**
 * Choix d'un jour et d'une heure pour la barbière (nouveau RDV, déplacement).
 *
 *   const picker = createSlotPicker(conteneur, { salon, durationMin, ymd, time, excludeId });
 *   picker.setDuration(45);          // recalcule les pastilles
 *   picker.value()                   // → { ymd, time } (time = 'HH:MM' ou '')
 *   picker.destroy();
 *
 * Bande de jours (4 semaines), pastilles de créneaux libres (computeDaySlots
 * forPro : hors horaires et préavis ignorés, blocages évités) et saisie libre
 * d'une heure, qui l'emporte sur les pastilles.
 */

import { html, render, on, announce } from '../ui/dom.js';
import {
  todayYMD, addDaysYMD, fmtDayShort, fmtDayLong, dayRangeISO, minutesOf, fmtClock, zonedParts,
} from '../core/dates.js';
import { computeDaySlots, isDayOpen, occupiesSlot } from '../core/slots.js';
import { store, tzOf, bool, uid, capitalize, isValidYMD, showError, plural } from './shared.js';

const STRIP_DAYS = 28;

export function createSlotPicker(container, {
  salon, durationMin, ymd, time = '', excludeId = null, label = 'Jour',
} = {}) {
  const tz = tzOf(salon);
  const today = todayYMD(tz);
  const step = Number(salon.slotStep) || 15;
  const ids = { date: uid('jour'), time: uid('heure'), slots: uid('creneaux') };

  let day = isValidYMD(ymd) ? ymd : today;
  let duration = Number(durationMin) || 30;
  let selected = '';          // heure choisie dans les pastilles
  let free = '';              // heure saisie librement
  let slots = [];
  let busy = [];
  let loaded = false;         // créneaux occupés du jour connus
  let seq = 0;
  let speak = false;          // annoncer le résultat (changement de jour ou de durée par l'utilisatrice)
  let stripStart = day < today ? day : today;

  // Heure demandée au départ (toucher sur l'agenda, RDV à déplacer) :
  // pastille si elle existe, sinon saisie libre.
  let wanted = /^\d{2}:\d{2}$/.test(time) ? time : '';

  render(container, html`
    <div class="pro-picker">
      <p class="field__label" id="${ids.date}-lbl">${label}</p>
      <div class="daystrip pro-picker__days" role="group" aria-labelledby="${ids.date}-lbl"></div>
      <div class="field pro-picker__date">
        <label class="field__label pro-picker__datelabel" for="${ids.date}">Ou une autre date</label>
        <input class="field__input" id="${ids.date}" type="date" value="${day}">
      </div>
      <div class="pro-picker__slots" id="${ids.slots}"></div>
      <div class="field pro-picker__free">
        <label class="field__label" for="${ids.time}">Autre heure <span class="field__optional">(saisie libre)</span></label>
        <input class="field__input" id="${ids.time}" type="time" step="300" value="">
        <p class="field__hint">Pour un horaire hors des pastilles, même en dehors des heures d’ouverture.</p>
      </div>
    </div>`);

  const stripEl = container.querySelector('.pro-picker__days');
  const dateInput = container.querySelector(`#${ids.date}`);
  const slotsEl = container.querySelector(`#${ids.slots}`);
  const freeInput = container.querySelector(`#${ids.time}`);

  function renderStrip() {
    if (day < stripStart || day >= addDaysYMD(stripStart, STRIP_DAYS)) stripStart = day < today ? day : today;
    if (day >= addDaysYMD(stripStart, STRIP_DAYS)) stripStart = addDaysYMD(day, -3);
    const days = Array.from({ length: STRIP_DAYS }, (_, i) => addDaysYMD(stripStart, i));
    render(stripEl, html`${days.map((d) => {
      const s = fmtDayShort(d);
      const closed = !isDayOpen(salon, d);
      return html`<button type="button" class="daystrip__day${d === today ? ' daystrip__day--today' : ''}${closed ? ' daystrip__day--closed' : ''}"
        data-day="${d}" aria-pressed="${bool(d === day)}" aria-label="${capitalize(fmtDayLong(d))}${closed ? ', fermé' : ''}${d === today ? ", aujourd'hui" : ''}">
        <span class="daystrip__dow">${s.dow}</span><span class="daystrip__num">${s.day}</span><span class="daystrip__month">${s.month}</span>
      </button>`;
    })}`);
    const current = stripEl.querySelector('[aria-pressed="true"]');
    if (current) {
      // Centre le jour choisi sans faire défiler la feuille verticalement.
      stripEl.scrollLeft = current.offsetLeft - (stripEl.clientWidth - current.offsetWidth) / 2;
    }
  }

  function groupName(min) {
    if (min < 12 * 60) return 'Matin';
    if (min < 18 * 60) return 'Après-midi';
    return 'Soir';
  }

  function renderSlots() {
    const nowMs = Date.now();
    const all = computeDaySlots({ salon, durationMin: duration, ymd: day, busy, now: new Date(nowMs), forPro: true });
    // Aujourd'hui : on ne propose pas les créneaux déjà passés (le pas en cours reste proposé).
    const nowMin = day === today ? zonedParts(nowMs, tz).minutes : -1;
    slots = all.filter((s) => minutesOf(s.hhmm) >= Math.floor(nowMin / step) * step);

    if (wanted) {
      if (slots.some((s) => s.hhmm === wanted)) selected = wanted;
      else { free = wanted; freeInput.value = wanted; }
      wanted = '';
    }
    // Lecteurs d'écran : un résumé après un choix de l'utilisatrice, pas toute la liste des heures.
    const said = [];
    if (speak) {
      said.push(`${capitalize(fmtDayLong(day))} : ${!isDayOpen(salon, day) && !slots.length
        ? 'salon fermé'
        : plural(slots.length, 'créneau libre', 'créneaux libres')}.`);
    }
    speak = false;
    if (selected && !slots.some((s) => s.hhmm === selected)) {
      // Plus de pastille pour cette durée : l'heure choisie est gardée en saisie libre
      // (l'enregistrement refusera seulement un chevauchement avec un autre RDV).
      free = selected;
      freeInput.value = selected;
      selected = '';
      said.push(`${fmtClock(free)} n’est plus proposé pour cette durée : l’heure est gardée dans « Autre heure ».`);
    }
    if (said.length) announce(said.join(' '));

    if (!isDayOpen(salon, day) && !slots.length) {
      render(slotsEl, html`<p class="pro-picker__empty">Le salon est fermé ce jour-là. Indiquez une heure ci-dessous pour ajouter quand même.</p>`);
      return;
    }
    if (!slots.length) {
      render(slotsEl, html`<p class="pro-picker__empty">Plus aucun créneau libre de ${duration} min ce jour-là. Indiquez une heure ci-dessous si besoin.</p>`);
      return;
    }
    const groups = [];
    for (const s of slots) {
      const g = groupName(minutesOf(s.hhmm));
      if (!groups.length || groups[groups.length - 1].name !== g) groups.push({ name: g, items: [] });
      groups[groups.length - 1].items.push(s);
    }
    render(slotsEl, html`
      <div class="slots">
        ${groups.map((g) => html`
          <h3 class="slots__title">${g.name}</h3>
          <div class="slots__grid" role="group" aria-label="${g.name}">
            ${g.items.map((s) => html`<button type="button" class="slots__slot" data-time="${s.hhmm}"
              aria-pressed="${bool(!free && s.hhmm === selected)}">${fmtClock(s.hhmm)}</button>`)}
          </div>`)}
      </div>`);
  }

  async function loadDay() {
    const mine = ++seq;
    loaded = false;
    render(slotsEl, html`<div class="loader" role="status"><span class="spinner" aria-hidden="true"></span>Recherche des créneaux libres…</div>`);
    try {
      const { from, to } = dayRangeISO(day, tz);
      const [appts, blocks] = await Promise.all([store.listAppointments(from, to), store.listBlocks(from, to)]);
      if (mine !== seq) return;
      busy = appts
        // Seuls les RDV confirmés ou honorés occupent un créneau : un lapin le libère.
        .filter((a) => occupiesSlot(a.status) && a.id !== excludeId)
        .map((a) => ({ start: a.start, end: a.end }))
        .concat(blocks.map((b) => ({ start: b.start, end: b.end })));
      loaded = true;
      renderSlots();
    } catch (err) {
      if (mine !== seq) return;
      render(slotsEl, html`<p class="pro-picker__empty">Impossible de charger les créneaux. Vous pouvez saisir une heure ci-dessous.</p>`);
      showError(err);
    }
  }

  function setDay(next) {
    if (!isValidYMD(next) || next === day) return;
    day = next;
    dateInput.value = day;
    selected = '';
    speak = true;
    renderStrip();
    loadDay();
  }

  const offs = [
    on(stripEl, 'click', '[data-day]', (e, btn) => setDay(btn.dataset.day)),
    on(slotsEl, 'click', '[data-time]', (e, btn) => {
      selected = btn.dataset.time;
      free = '';
      freeInput.value = '';
      for (const b of slotsEl.querySelectorAll('[data-time]')) b.setAttribute('aria-pressed', bool(b === btn));
    }),
  ];
  const onDate = () => { if (dateInput.value) setDay(dateInput.value); };
  const onFree = () => {
    free = freeInput.value;
    if (free) {
      selected = '';
      for (const b of slotsEl.querySelectorAll('[data-time]')) b.setAttribute('aria-pressed', 'false');
    }
  };
  dateInput.addEventListener('change', onDate);
  freeInput.addEventListener('input', onFree);
  freeInput.addEventListener('change', onFree);

  renderStrip();
  loadDay();

  return {
    value() {
      const t = free || selected;
      return { ymd: day, time: /^\d{2}:\d{2}$/.test(t) ? t : '' };
    },
    setDuration(min) {
      const n = Number(min);
      if (!(n > 0) || n === duration) return;
      duration = n;
      speak = true;
      if (loaded) renderSlots();
    },
    /** Recharge les créneaux (après un refus SLOT_TAKEN par exemple). */
    reload() {
      loadDay();
    },
    get ymd() { return day; },
    destroy() {
      seq++;
      offs.forEach((off) => off());
      dateInput.removeEventListener('change', onDate);
      freeInput.removeEventListener('input', onFree);
      freeInput.removeEventListener('change', onFree);
    },
  };
}
