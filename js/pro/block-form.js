/**
 * Bloquer du temps (pause, congés, formation…) et supprimer un blocage.
 *
 *   openBlockForm({ ymd })     feuille : motif, journée entière ou de… à…, du… au…
 *   deleteBlockFlow(block)     confirmation puis suppression
 *
 * Sur plusieurs jours, un blocage est créé pour chaque jour, jours de fermeture
 * compris. « Toute la journée » bloque de minuit à minuit : le congé tient même
 * si les horaires changent ensuite (ouverture d'un jour habituellement fermé…).
 */

import { html, render, on, openSheet, confirmDialog, toast } from '../ui/dom.js';
import { addDaysYMD, todayYMD, dayRangeISO, fmtClock, fmtTime, fmtDayLong, minutesOf, hhmm } from '../core/dates.js';
import { dayIntervals } from '../core/slots.js';
import { blockPeriods, isFullDayBlock } from './calc.js';
import {
  store, loadSalon, tzOf, ymdOf, bool, uid, shortName, isValidYMD,
  showError, loaderHtml, goToAgenda, formSnapshot, confirmDiscard,
} from './shared.js';

const REASONS = ['Pause', 'Congés', 'Formation', 'Personnel', 'Autre'];
const MAX_DAYS = 92;

export function openBlockForm({ ymd = '' } = {}) {
  const ids = {
    reason: uid('motif'), other: uid('autre'), allDay: uid('journee'), from: uid('de'), to: uid('a'),
    dayFrom: uid('du'), dayTo: uid('au'), err: uid('err'),
  };
  let salon = null;
  let reason = 'Pause';
  let initial = null;          // état du formulaire à l'ouverture (saisie en cours ?)

  const isDirty = () => initial !== null && formSnapshot(body.querySelector('form')) !== initial;
  const sheet = openSheet({
    title: 'Bloquer un créneau',
    className: 'pro-sheet',
    content: loaderHtml(),
    actions: [
      { label: 'Fermer', variant: 'ghost', onClick: confirmDiscard(isDirty) },
      { label: 'Bloquer', variant: 'primary', icon: 'cadenas', onClick: () => save() },
    ],
    beforeClose: confirmDiscard(isDirty),
  });
  const body = sheet.body;

  function readForm() {
    const q = (id) => body.querySelector(`#${id}`);
    return {
      other: q(ids.other).value.trim(),
      allDay: q(ids.allDay).checked,
      from: q(ids.from).value,
      to: q(ids.to).value,
      dayFrom: q(ids.dayFrom).value,
      dayTo: q(ids.dayTo).value || q(ids.dayFrom).value,
    };
  }

  async function save() {
    if (!salon) return false;
    const tz = tzOf(salon);
    const errEl = body.querySelector(`#${ids.err}`);
    const fail = (msg) => { errEl.textContent = msg; return false; };
    errEl.textContent = '';
    const f = readForm();

    if (!isValidYMD(f.dayFrom) || !isValidYMD(f.dayTo)) return fail('Indiquez les jours concernés.');
    if (f.dayTo < f.dayFrom) return fail('Le dernier jour doit être après le premier.');
    if (f.dayTo > addDaysYMD(f.dayFrom, MAX_DAYS - 1)) return fail(`${MAX_DAYS} jours au maximum en une fois.`);
    if (!f.allDay) {
      if (!f.from || !f.to) return fail('Indiquez l’heure de début et l’heure de fin.');
      if (minutesOf(f.to) <= minutesOf(f.from)) return fail('L’heure de fin doit suivre l’heure de début.');
    }

    // Un blocage par jour de la période, jours de fermeture compris.
    const items = blockPeriods({ dayFrom: f.dayFrom, dayTo: f.dayTo, allDay: f.allDay, from: f.from, to: f.to, tz });
    if (!items.length) return fail('Ces horaires n’existent pas ce jour-là (passage à l’heure d’été).');
    const label = reason === 'Autre' ? (f.other || 'Indisponible') : reason;

    // Des RDV tombent-ils pendant le blocage ? Ils ne sont pas annulés : on prévient.
    try {
      const range = { from: dayRangeISO(items[0].ymd, tz).from, to: dayRangeISO(items[items.length - 1].ymd, tz).to };
      const appts = await store.listAppointments(range.from, range.to);
      const clash = appts.filter((a) => a.status !== 'cancelled'
        && items.some((it) => Date.parse(a.start) < Date.parse(it.end) && Date.parse(a.end) > Date.parse(it.start)));
      if (clash.length) {
        const a = clash[0];
        const ok = await confirmDialog({
          title: clash.length > 1 ? `${clash.length} rendez-vous déjà prévus` : 'Un rendez-vous déjà prévu',
          message: `${clash.length > 1 ? 'Par exemple ' : ''}${shortName(a.client)}, ${fmtDayLong(ymdOf(a.start, tz))} à ${fmtTime(a.start, tz)}. Le blocage ne les annule pas : pensez à les déplacer ou à prévenir. Bloquer quand même ?`,
          confirmLabel: 'Bloquer quand même',
          cancelLabel: 'Revenir',
        });
        if (!ok) return false;
      }
    } catch (err) {
      showError(err);
      return false;
    }

    let done = 0;
    try {
      for (const it of items) {
        await store.createBlock({ start: it.start, end: it.end, reason: label });
        done++;
      }
    } catch (err) {
      showError(err);
      if (!done) return false;
    }
    const first = items[0];
    toast(items.length === 1
      ? `${label} : ${fmtDayLong(first.ymd)}, ${f.allDay ? 'toute la journée' : `${fmtClock(f.from)} – ${fmtClock(f.to)}`}.`
      : `${label} : ${done} jours bloqués.`, { type: 'success' });
    sheet.close();
    goToAgenda(first.ymd);
    return true;
  }

  (async () => {
    try {
      salon = await loadSalon();
    } catch (err) {
      showError(err);
      sheet.close();
      return;
    }
    if (!body.isConnected) return;
    const tz = tzOf(salon);
    const day = isValidYMD(ymd) ? ymd : todayYMD(tz);
    // Par défaut : la dernière plage du jour (souvent « l'après-midi »).
    const iv = dayIntervals(salon, day);
    const [defFrom, defTo] = iv.length ? [hhmm(iv[iv.length - 1][0]), hhmm(iv[iv.length - 1][1])] : ['14:00', '18:00'];

    render(body, html`
      <form class="stack pro-form" novalidate>
        <section aria-labelledby="${ids.reason}">
          <p class="field__label" id="${ids.reason}">Motif</p>
          <div class="chips pro-chips-wrap" role="group" aria-labelledby="${ids.reason}">
            ${REASONS.map((r) => html`<button type="button" class="chip" data-reason="${r}" aria-pressed="${bool(r === reason)}">${r}</button>`)}
          </div>
          <div class="field pro-block__other" hidden>
            <label class="field__label" for="${ids.other}">Précisez</label>
            <input class="field__input" id="${ids.other}" type="text" maxlength="200" placeholder="Ex. : rendez-vous médical">
          </div>
        </section>

        <div class="card card--flat pro-block__card">
          <label class="switch">
            <span class="switch__label">Toute la journée <span class="switch__hint">De minuit à minuit, même si vos horaires changent ensuite.</span></span>
            <input class="switch__input" id="${ids.allDay}" type="checkbox" role="switch">
            <span class="switch__track" aria-hidden="true"></span>
          </label>
          <div class="field-row pro-block__hours">
            <div class="field">
              <label class="field__label" for="${ids.from}">De</label>
              <input class="field__input" id="${ids.from}" type="time" step="300" value="${defFrom}">
            </div>
            <div class="field">
              <label class="field__label" for="${ids.to}">À</label>
              <input class="field__input" id="${ids.to}" type="time" step="300" value="${defTo}">
            </div>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label class="field__label" for="${ids.dayFrom}">Du</label>
            <input class="field__input" id="${ids.dayFrom}" type="date" value="${day}">
          </div>
          <div class="field">
            <label class="field__label" for="${ids.dayTo}">Au</label>
            <input class="field__input" id="${ids.dayTo}" type="date" value="${day}">
          </div>
        </div>
        <p class="field__hint">Sur plusieurs jours, un blocage est créé pour chaque jour, jours de fermeture compris. Les clients ne pourront pas réserver pendant ces blocages.</p>
        <p class="field__error" id="${ids.err}" role="alert"></p>
      </form>`);

    const dayFrom = body.querySelector(`#${ids.dayFrom}`);
    const dayTo = body.querySelector(`#${ids.dayTo}`);
    // Le « au » suit le « du » tant qu'il serait avant.
    dayFrom.addEventListener('change', () => {
      if (!dayTo.value || dayTo.value < dayFrom.value) dayTo.value = dayFrom.value;
    });
    body.querySelector(`#${ids.allDay}`).addEventListener('change', (e) => {
      body.querySelector('.pro-block__hours').hidden = e.target.checked;
    });
    on(body, 'click', '[data-reason]', (e, chip) => {
      reason = chip.dataset.reason;
      for (const c of body.querySelectorAll('[data-reason]')) c.setAttribute('aria-pressed', bool(c === chip));
      const other = body.querySelector('.pro-block__other');
      other.hidden = reason !== 'Autre';
      if (!other.hidden) other.querySelector('input').focus();
      // Congés : le plus souvent la journée entière.
      if (reason === 'Congés') {
        const sw = body.querySelector(`#${ids.allDay}`);
        sw.checked = true;
        body.querySelector('.pro-block__hours').hidden = true;
      }
    });
    body.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
    initial = formSnapshot(body.querySelector('form'));
  })();

  return sheet;
}

/** Toucher un blocage sur l'agenda : confirmation puis suppression. */
export async function deleteBlockFlow(block, salon) {
  const tz = tzOf(salon);
  const when = isFullDayBlock(block, tz) ? 'toute la journée' : `${fmtTime(block.start, tz)} – ${fmtTime(block.end, tz)}`;
  const ok = await confirmDialog({
    title: 'Supprimer ce blocage ?',
    message: `${block.reason || 'Indisponible'} · ${fmtDayLong(ymdOf(block.start, tz))}, ${when}. Le créneau redeviendra réservable.`,
    confirmLabel: 'Supprimer',
    cancelLabel: 'Garder',
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteBlock(block.id);
    toast('Blocage supprimé : le créneau est de nouveau libre.', { type: 'success' });
  } catch (err) {
    showError(err);
  }
}
