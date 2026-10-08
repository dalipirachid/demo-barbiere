/**
 * Agenda du jour (#/agenda/<ymd>, aujourd'hui par défaut).
 *
 * En-tête du jour, bande de la semaine (nombre de RDV par jour), chiffres
 * clés, carte géante « Prochain client » (aujourd'hui seulement), puis la
 * frise verticale de la journée : RDV positionnés, pauses, blocages hachurés,
 * ligne « maintenant » mise à jour chaque minute.
 * Toucher un espace libre → nouveau RDV à cette heure ; glisser à gauche ou à
 * droite → jour suivant / précédent. Sur tablette (≥ 900 px), le détail
 * d'un RDV s'affiche dans un panneau à droite au lieu d'une feuille.
 */

import { html, render, fragment, icon, announce } from '../ui/dom.js';
import {
  todayYMD, addDaysYMD, weekdayISO, dayRangeISO, parseYMD, zonedParts, fmtTime, fmtClock,
  fmtDayShort, fmtDayLong, fmtRelativeDay, fmtPrice, fmtDuration,
} from '../core/dates.js';
import { dayIntervals, isDayOpen } from '../core/slots.js';
import { openAppointmentSheet, mountAppointmentDetail } from './appointment.js';
import { openAddChooser, openNewAppointment } from './rdv-form.js';
import { deleteBlockFlow } from './block-form.js';
import {
  clampMinutes, nextGap, isFreshBooking, latestOnlineCreatedAt, nextLastSeen,
} from './calc.js';
import {
  store, loadSalon, tzOf, ymdOf, nav, isValidYMD, goToAgenda, readLS, writeLS, LASTSEEN_KEY,
  fullName, shortName, plural, dayTitle, fmtIn, bool, STATUS_LABELS, telHref, smsHref, reminderText,
  showError,
} from './shared.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PANEL_MQ = '(min-width: 900px)';

/* ==========================================================================
   Calculs (purs : données chargées + heure courante)
   ========================================================================== */

/** Écart en jours entre deux 'YYYY-MM-DD'. */
function daysBetween(a, b) {
  const [y1, m1, d1] = parseYMD(a);
  const [y2, m2, d2] = parseYMD(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

function relativeLabel(day, today) {
  const diff = daysBetween(today, day);
  if (diff === 0) return 'Aujourd’hui';
  if (diff === 1) return 'Demain';
  if (diff === -1) return 'Hier';
  return diff > 1 ? `Dans ${diff} jours` : `Il y a ${-diff} jours`;
}

/** 'du 6 au 12 octobre' / 'du 29 septembre au 5 octobre' */
function weekLabel(start) {
  const end = addDaysYMD(start, 6);
  const noDow = (ymd) => fmtDayLong(ymd).split(' ').slice(1).join(' ');
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return `Semaine du ${sameMonth ? noDow(start).split(' ')[0] : noDow(start)} au ${noDow(end)}`;
}

/** Données dérivées du jour affiché. */
function compute(d, nowMs) {
  const { tz, day } = d;
  const dayAppts = d.week.filter((a) => ymdOf(a.start, tz) === day);
  const active = dayAppts.filter((a) => a.status !== 'cancelled');
  const cancelled = dayAppts.filter((a) => a.status === 'cancelled');
  const isToday = day === d.today;
  const next = isToday
    ? active.find((a) => a.status === 'confirmed' && Date.parse(a.start) > nowMs) || null
    : null;
  return { dayAppts, active, cancelled, isToday, next };
}

// Prochain trou libre (nextGap) et bornage des minutes (clampMinutes) : voir calc.js.

/** Colonnes des RDV qui se chevauchent : ajoute col / cols à chaque élément. */
function layoutColumns(items) {
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const colEnds = [];
    for (const ev of cluster) {
      let col = colEnds.findIndex((end) => end <= ev.s);
      if (col < 0) { col = colEnds.length; colEnds.push(ev.e); } else colEnds[col] = ev.e;
      ev.col = col;
    }
    for (const ev of cluster) ev.cols = colEnds.length;
    out.push(...cluster);
    cluster = [];
    clusterEnd = -Infinity;
  };
  for (const ev of items) {
    if (cluster.length && ev.s >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.e);
  }
  if (cluster.length) flush();
  return out;
}

/** Fenêtre affichée : ouverture → fermeture, élargie aux RDV hors horaires (heures pleines). */
function dayWindow(d, c) {
  const { tz, day } = d;
  const intervals = dayIntervals(d.salon, day);
  let lo = intervals.length ? intervals[0][0] : Infinity;
  let hi = intervals.length ? intervals[intervals.length - 1][1] : -Infinity;
  for (const a of c.active) {
    lo = Math.min(lo, clampMinutes(a.start, day, tz));
    hi = Math.max(hi, clampMinutes(a.end, day, tz));
  }
  // Un blocage court hors horaires élargit aussi la frise (pas un congé de plusieurs jours).
  for (const b of d.blocks) {
    const s = clampMinutes(b.start, day, tz);
    const e = clampMinutes(b.end, day, tz);
    if (e > s && e - s < 12 * 60) { lo = Math.min(lo, s); hi = Math.max(hi, e); }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const start = Math.max(0, Math.floor(lo / 60) * 60);
  const end = Math.min(1440, Math.max(start + 60, Math.ceil(hi / 60) * 60));
  return { start, end, intervals };
}

/* ==========================================================================
   Vue
   ========================================================================== */

export function createAgendaView() {
  let root = null;
  let data = null;
  let wantedDay = null;        // jour demandé par l'adresse (null = aujourd'hui)
  let seq = 0;
  let timer = null;
  let lastMinute = 0;
  let baseline = 0;            // réservations en ligne créées après → « nouvelles »
  let hiddenUpTo = -Infinity;  // bandeau masqué (×) : seules les réservations créées après réapparaissent
  let cancelledOpen = false;
  let selectedId = null;       // RDV affiché dans le panneau (tablette)
  let selectedAppt = null;
  let panelCtrl = null;
  const mq = window.matchMedia(PANEL_MQ);

  const region = (name) => root && root.querySelector(`[data-region="${name}"]`);
  const isNew = (a) => isFreshBooking(a, baseline);

  /* — Gabarits — */

  function headHtml(d) {
    const closed = !isDayOpen(d.salon, d.day);
    return html`
      <button type="button" class="icon-btn" data-nav="-1" aria-label="Jour précédent">${icon('chevron-gauche')}</button>
      <div class="appbar__titles pro-dayhead__titles">
        <h1 class="appbar__title pro-dayhead__title">${dayTitle(d.day)}</h1>
        <p class="appbar__subtitle">${relativeLabel(d.day, d.today)}${closed ? ' · salon fermé' : ''}</p>
      </div>
      <button type="button" class="icon-btn" data-nav="1" aria-label="Jour suivant">${icon('chevron-droite')}</button>`;
  }

  function weekHtml(d) {
    const counts = {};
    for (const a of d.week) {
      if (a.status === 'cancelled') continue;
      const y = ymdOf(a.start, d.tz);
      counts[y] = (counts[y] || 0) + 1;
    }
    const days = Array.from({ length: 7 }, (_, i) => addDaysYMD(d.weekStart, i));
    return html`
      <div class="pro-weekbar">
        <p class="smallcaps muted">${weekLabel(d.weekStart)}</p>
        <button type="button" class="btn btn--sm" data-today ${d.day === d.today ? 'hidden' : ''}>${icon('calendrier')}<span>Aujourd’hui</span></button>
      </div>
      <div class="daystrip pro-week" role="group" aria-label="Jours de la semaine">
        ${days.map((y) => {
          const s = fmtDayShort(y);
          const n = counts[y] || 0;
          const closed = !isDayOpen(d.salon, y);
          const cls = `daystrip__day${y === d.today ? ' daystrip__day--today' : ''}${closed && !n ? ' daystrip__day--closed' : ''}`;
          const what = n ? plural(n, 'rendez-vous', 'rendez-vous') : closed ? 'fermé' : 'aucun rendez-vous';
          return html`<button type="button" class="${cls}" data-day="${y}" aria-pressed="${bool(y === d.day)}"
            aria-label="${dayTitle(y)}${y === d.today ? ' (aujourd’hui)' : ''} : ${what}">
            <span class="daystrip__dow">${s.dow}</span>
            <span class="daystrip__num">${s.day}</span>
            <span class="pro-week__count${n ? '' : ' pro-week__count--zero'}">${n || (closed ? '·' : '0')}</span>
          </button>`;
        })}
      </div>`;
  }

  function newsHtml(d) {
    const since = Math.max(baseline, hiddenUpTo);
    const fresh = d.upcoming.filter((a) => isFreshBooking(a, since)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!fresh.length) return '';
    return html`
      <section class="notice pro-news" aria-labelledby="pro-news-titre">
        ${icon('info')}
        <div class="grow">
          <p class="notice__title" id="pro-news-titre">${plural(fresh.length, 'nouvelle réservation', 'nouvelles réservations')} en ligne</p>
          <ul class="pro-news__list">
            ${fresh.slice(0, 5).map((a) => html`<li><button type="button" class="pro-news__item" data-open="${a.id}">
              <strong>${shortName(a.client)}</strong> · ${fmtRelativeDay(ymdOf(a.start, d.tz), d.tz)} à ${fmtTime(a.start, d.tz)} · ${a.serviceName}
            </button></li>`)}
          </ul>
          ${fresh.length > 5 ? html`<p class="small">… et ${plural(fresh.length - 5, 'autre')}.</p>` : ''}
        </div>
        <button type="button" class="icon-btn icon-btn--sm" data-act="hide-news" aria-label="Masquer ce message">${icon('croix')}</button>
      </section>`;
  }

  function nextHtml(d, c, nowMs) {
    if (!c.isToday) return '';
    const tz = d.tz;
    const current = c.active.find((a) => a.status === 'confirmed'
      && Date.parse(a.start) <= nowMs && Date.parse(a.end) > nowMs);
    const currentLine = current ? html`<p class="pro-next__now">${icon('ciseaux')}<span>En ce moment : <strong>${shortName(current.client)}</strong> · ${current.serviceName}, jusqu’à ${fmtTime(current.end, tz)}</span></p>` : '';
    const a = c.next;
    if (!a) {
      const later = d.upcoming.find((x) => x.status === 'confirmed' && Date.parse(x.start) > nowMs && ymdOf(x.start, tz) !== d.today);
      return html`
        <section class="card pro-next pro-next--empty" aria-label="Prochain client">
          <p class="smallcaps muted">Prochain client</p>
          <p class="pro-next__none">${current ? 'C’est le dernier rendez-vous de la journée.' : 'Plus de rendez-vous aujourd’hui.'}</p>
          ${currentLine}
          ${later ? html`<button type="button" class="btn btn--ghost pro-next__later" data-open="${later.id}">
            Ensuite : ${fmtRelativeDay(ymdOf(later.start, tz), tz)} à ${fmtTime(later.start, tz)} — ${shortName(later.client)}</button>` : ''}
        </section>`;
    }
    const cl = a.client;
    const dur = Math.round((Date.parse(a.end) - Date.parse(a.start)) / 60000);
    return html`
      <section class="card pro-next" aria-labelledby="pro-next-titre">
        <p class="pro-next__kicker" id="pro-next-titre"><span class="smallcaps">Prochain client</span>
          <span class="pro-next__in">${fmtIn(Date.parse(a.start) - nowMs)}</span></p>
        <button type="button" class="pro-next__main" data-open="${a.id}"
          aria-label="${fullName(cl)}, ${fmtTime(a.start, tz)}, ${a.serviceName} : voir le rendez-vous">
          <span class="pro-next__name">${cl ? cl.firstName : 'Client'}</span>
          <span class="pro-next__line"><span class="pro-next__time">${fmtTime(a.start, tz)}</span>
            <span class="pro-next__svc">${a.serviceName} · ${fmtDuration(dur)}</span></span>
        </button>
        ${cl && cl.phone ? html`
          <div class="pro-next__actions">
            <a class="btn btn--primary btn--lg" href="${telHref(cl.phone)}">${icon('telephone')}<span>Appeler</span></a>
            <a class="btn btn--lg" href="${smsHref(cl.phone, reminderText(a, d.salon))}">${icon('sms')}<span>SMS</span></a>
          </div>` : ''}
        ${currentLine}
      </section>`;
  }

  function statsHtml(d, c, nowMs) {
    const online = c.active.filter((a) => a.source === 'online').length;
    const revenue = c.active.filter((a) => a.status !== 'no_show').reduce((sum, a) => sum + (Number(a.priceCents) || 0), 0);
    const gap = nextGap(d, c, nowMs);
    let gapValue = '—';
    let gapHint = '';
    if (gap.past) gapHint = 'journée passée';
    else if (gap.over) gapHint = 'journée terminée';
    else if (gap.closed) gapHint = 'salon fermé';
    else if (gap.full) { gapValue = 'Complet'; gapHint = c.isToday ? 'jusqu’à la fermeture' : 'toute la journée'; }
    else {
      const nowMin = c.isToday ? zonedParts(nowMs, d.tz).minutes : -1;
      gapValue = gap.start <= nowMin ? 'Libre' : fmtClock(gap.start);
      gapHint = `${fmtDuration(gap.len)} libres`;
    }
    return html`
      <div class="stats pro-stats">
        <div class="stat"><span class="stat__value">${c.active.length}</span>
          <span class="stat__label">${c.active.length > 1 ? 'Rendez-vous' : 'Rendez-vous'}</span>
          <span class="stat__hint">${online ? `dont ${online} en ligne` : 'aucun en ligne'}</span></div>
        <div class="stat"><span class="stat__value">${fmtPrice(revenue)}</span>
          <span class="stat__label">Prévu</span>
          <span class="stat__hint">hors annulés et lapins</span></div>
        <div class="stat stat--accent"><span class="stat__value${gapValue.length > 6 ? ' pro-stats__word' : ''}">${gapValue}</span>
          <span class="stat__label">Trou libre</span>
          <span class="stat__hint">${gapHint}</span></div>
      </div>`;
  }

  function eventHtml(ev, win, d, c) {
    const a = ev.a;
    const tz = d.tz;
    const dur = ev.e - ev.s;
    const cls = ['timeline__event'];
    if (a.status === 'done') cls.push('timeline__event--done');
    if (a.status === 'no_show') cls.push('timeline__event--noshow');
    if (a.source === 'online') cls.push('timeline__event--online');
    if (c.next && a.id === c.next.id) cls.push('timeline__event--next');
    if (isNew(a)) cls.push('timeline__event--new');
    if (dur <= 15) cls.push('pro-ev--row');
    else if (dur < 30) cls.push('pro-ev--two');
    if (a.id === selectedId) cls.push('is-selected');
    const label = [
      `${fmtTime(a.start, tz)} à ${fmtTime(a.end, tz)}`, fullName(a.client), a.serviceName,
      a.source === 'online' ? 'réservé en ligne' : '',
      a.status !== 'confirmed' ? STATUS_LABELS[a.status].toLowerCase() : '',
      isNew(a) ? 'nouvelle réservation' : '',
    ].filter(Boolean).join(', ');
    const style = `--top: calc(var(--ppm) * ${ev.s - win.start}); --height: calc(var(--ppm) * ${dur}); --col: ${ev.col}; --cols: ${ev.cols}`;
    const tag = a.status === 'done' ? html`<span class="pro-ev__tag pro-ev__tag--done">honoré</span>`
      : a.status === 'no_show' ? html`<span class="pro-ev__tag pro-ev__tag--noshow">lapin</span>`
        : a.source === 'online' ? html`<span class="pro-ev__tag">en ligne</span>` : '';
    return html`<button type="button" class="${cls.join(' ')}" style="${style}" data-appt="${a.id}" aria-label="${label}">
      <span class="timeline__time">${fmtTime(a.start, tz)}${tag}</span>
      <span class="timeline__name">${shortName(a.client)}</span>
      <span class="timeline__service">${a.serviceName}</span>
    </button>`;
  }

  function nowLineHtml(d, win, nowMs) {
    if (d.day !== d.today) return '';
    const m = zonedParts(nowMs, d.tz).minutes;
    if (m < win.start || m > win.end) return '';
    return html`<div class="timeline__now" style="--top: calc(var(--ppm) * ${m - win.start})"><span class="timeline__now-label">${fmtClock(m)}</span></div>`;
  }

  function timelineHtml(d, c, win, nowMs) {
    const { start, end, intervals } = win;
    const tz = d.tz;
    const marks = [];
    for (let m = start; m <= end; m += 30) {
      marks.push(m % 60
        ? html`<span class="timeline__hour pro-hour--half" style="--top: calc(var(--ppm) * ${m - start})">${fmtClock(m)}</span>`
        : html`<span class="timeline__hour" style="--top: calc(var(--ppm) * ${m - start})">${m / 60}h</span>`);
    }
    // Zones fermées : avant l'ouverture, pauses entre deux plages, après la fermeture.
    const closed = [];
    let cur = start;
    intervals.forEach(([o, cl], i) => {
      if (o > cur) closed.push([cur, Math.min(o, end), i === 0 ? 'Fermé' : 'Pause']);
      cur = Math.max(cur, cl);
    });
    if (!intervals.length) closed.push([start, end, 'Fermé']);
    else if (cur < end) closed.push([cur, end, 'Fermé']);

    const blocks = d.blocks.map((b) => {
      const s0 = clampMinutes(b.start, d.day, tz);
      const e0 = clampMinutes(b.end, d.day, tz);
      const s = Math.max(start, s0);
      const e = Math.min(end, e0);
      // Congé ou journée bloquée : de minuit à minuit, bornée ici à la fenêtre affichée.
      return { b, s, e, when: s0 <= 0 && e0 >= 1440 ? 'toute la journée' : `${fmtClock(s)} – ${fmtClock(e)}` };
    }).filter((x) => x.e > x.s);

    const events = layoutColumns(c.active
      .map((a) => {
        const s = clampMinutes(a.start, d.day, tz);
        return { a, s, e: Math.max(clampMinutes(a.end, d.day, tz), s + 5) };
      })
      .sort((x, y) => x.s - y.s || x.e - y.e));

    return html`
      <div class="timeline" style="--timeline-h: calc(var(--ppm) * ${end - start})">
        <div class="timeline__hours" aria-hidden="true">${marks}</div>
        <div class="timeline__track" data-start="${start}" data-end="${end}">
          ${closed.filter(([s, e]) => e > s).map(([s, e, label]) => html`<div class="timeline__closed" style="--top: calc(var(--ppm) * ${s - start}); --height: calc(var(--ppm) * ${e - s})" aria-hidden="true">${label}${label === 'Pause' ? html` · ${fmtClock(s)} – ${fmtClock(e)}` : ''}</div>`)}
          ${blocks.map(({ b, s, e, when }) => html`<button type="button" class="timeline__block" data-block="${b.id}"
            style="--top: calc(var(--ppm) * ${s - start}); --height: calc(var(--ppm) * ${e - s})"
            aria-label="Blocage ${b.reason || 'Indisponible'}, ${when.replace(' – ', ' à ')} : toucher pour le supprimer">${icon('cadenas')}<span>${b.reason || 'Indisponible'} · ${when}</span></button>`)}
          ${events.map((ev) => eventHtml(ev, { start }, d, c))}
          ${nowLineHtml(d, { start, end }, nowMs)}
        </div>
      </div>`;
  }

  function mainHtml(d, c, nowMs) {
    const win = dayWindow(d, c);
    const closedDay = !isDayOpen(d.salon, d.day);
    return html`
      <div data-region="next">${nextHtml(d, c, nowMs)}</div>
      <div data-region="stats">${statsHtml(d, c, nowMs)}</div>
      ${closedDay && win ? html`<div class="notice notice--warn" role="status">${icon('info')}<p>Le salon est fermé ce jour-là, mais des rendez-vous y sont prévus.</p></div>` : ''}
      ${win ? html`
        <section class="pro-day" aria-label="Planning de la journée">
          <div class="pro-scroller" tabindex="0" aria-label="Planning de ${fmtClock(win.start)} à ${fmtClock(win.end)}">
            ${timelineHtml(d, c, win, nowMs)}
          </div>
          <p class="pro-day__hint">Touchez un espace libre pour ajouter un rendez-vous. Glissez vers la gauche ou la droite pour changer de jour.</p>
        </section>` : html`
        <div class="empty pro-closed">
          <div class="empty__icon">${icon('cadenas')}</div>
          <h2 class="empty__title">Salon fermé ce jour-là</h2>
          <p class="empty__text">Aucun rendez-vous prévu. Vous pouvez quand même en ajouter un.</p>
          <div class="empty__actions"><button type="button" class="btn btn--primary" data-act="add-anyway">${icon('plus')}<span>Ajouter un rendez-vous</span></button></div>
          ${d.blocks.length ? html`<ul class="pro-closed__blocks">${d.blocks.map((b) => {
            // Congé posé aussi sur ce jour de fermeture : visible ici pour pouvoir le supprimer.
            const allDay = clampMinutes(b.start, d.day, d.tz) <= 0 && clampMinutes(b.end, d.day, d.tz) >= 1440;
            const when = allDay ? 'toute la journée' : `${fmtTime(b.start, d.tz)} – ${fmtTime(b.end, d.tz)}`;
            return html`<li><button type="button" class="btn btn--ghost btn--sm" data-block="${b.id}"
              aria-label="Blocage ${b.reason || 'Indisponible'}, ${when} : toucher pour le supprimer">${icon('cadenas')}<span>${b.reason || 'Indisponible'} · ${when}</span></button></li>`;
          })}</ul>` : ''}
        </div>`}
      ${c.cancelled.length ? html`
        <details class="pro-cancelled" ${cancelledOpen ? 'open' : ''}>
          <summary>${plural(c.cancelled.length, 'rendez-vous annulé', 'rendez-vous annulés')} ce jour-là</summary>
          <ul class="list">${c.cancelled.map((a) => html`<li><button type="button" class="list__item" data-open="${a.id}">
            <span class="list__main"><span class="list__title">${fmtTime(a.start, d.tz)} · ${shortName(a.client)}</span>
              <span class="list__meta">${a.serviceName}</span></span>
            <span class="badge badge--cancelled">Annulé</span></button></li>`)}</ul>
        </details>` : ''}`;
  }

  function skeletonHtml() {
    return html`
      <header class="appbar appbar--green appbar--wide pro-dayhead" data-region="head">
        <div class="appbar__titles"><p class="appbar__title">Agenda</p><p class="appbar__subtitle">Chargement…</p></div>
      </header>
      <div class="page page--wide pro-agenda-page">
        <div data-region="week"><span class="skeleton skeleton--block pro-skel-week"></span></div>
        <div data-region="news"></div>
        <div class="pro-agenda">
          <div class="pro-agenda__main" data-region="main" aria-busy="true">
            <div class="stack" aria-hidden="true">
              <span class="skeleton skeleton--block"></span>
              <span class="skeleton skeleton--block"></span>
              <span class="skeleton skeleton--block pro-skel-tall"></span>
            </div>
            <div class="loader" role="status"><span class="spinner" aria-hidden="true"></span>Chargement de l’agenda…</div>
          </div>
          <aside class="pro-agenda__panel" data-region="panel" aria-label="Détail du rendez-vous" tabindex="-1"></aside>
        </div>
      </div>
      <button type="button" class="pro-fab" data-act="add" aria-label="Ajouter un rendez-vous ou bloquer un créneau">${icon('plus')}</button>`;
  }

  /* — Panneau latéral (tablette) — */

  function panelPlaceholder() {
    return html`<div class="empty pro-panel-empty">
      <div class="empty__icon">${icon('calendrier')}</div>
      <p class="empty__title">Détail du rendez-vous</p>
      <p class="empty__text">Touchez un rendez-vous dans l’agenda pour l’afficher ici.</p>
    </div>`;
  }

  function renderPanel() {
    const panel = region('panel');
    if (!panel) return;
    if (panelCtrl) { panelCtrl.destroy(); panelCtrl = null; }
    if (!selectedId || !selectedAppt) {
      render(panel, panelPlaceholder());
      return;
    }
    render(panel, html`
      <div class="pro-panel">
        <div class="pro-panel__bar">
          <p class="smallcaps muted">Rendez-vous</p>
          <button type="button" class="icon-btn icon-btn--sm" data-act="panel-close" aria-label="Fermer le détail">${icon('croix')}</button>
        </div>
        <div class="pro-panel__body"></div>
      </div>`);
    panelCtrl = mountAppointmentDetail(panel.querySelector('.pro-panel__body'), selectedAppt, { inSheet: false });
  }

  function markSelected() {
    if (!root) return;
    for (const el of root.querySelectorAll('.timeline__event')) {
      el.classList.toggle('is-selected', mq.matches && el.dataset.appt === selectedId);
    }
  }

  /** Ouvre un RDV : panneau sur tablette, feuille sur téléphone. */
  function openAppt(appt) {
    if (!appt) return;
    if (mq.matches) {
      selectedId = appt.id;
      selectedAppt = appt;
      renderPanel();
      markSelected();
      announce(`Détail affiché : ${fullName(appt.client)}.`);
    } else {
      openAppointmentSheet(appt);
    }
  }

  function findAppt(id) {
    if (!data) return null;
    return data.week.find((a) => a.id === id) || data.upcoming.find((a) => a.id === id) || null;
  }

  /* — Affichage — */

  function focusKey(el) {
    if (!el || !root || !root.contains(el)) return '';
    for (const attr of ['data-appt', 'data-block', 'data-day', 'data-nav', 'data-open', 'data-act']) {
      if (el.hasAttribute(attr)) return `[${attr}="${CSS.escape(el.getAttribute(attr))}"]`;
    }
    if (el.hasAttribute('data-today')) return '[data-today]';
    if (el.classList.contains('pro-scroller')) return '.pro-scroller';
    return '';
  }

  function draw({ scroll = 'keep' } = {}) {
    if (!root || !data) return;
    const d = data;
    const nowMs = Date.now();
    const c = compute(d, nowMs);
    const oldScroller = root.querySelector('.pro-scroller');
    const prevTop = oldScroller ? oldScroller.scrollTop : 0;
    const key = focusKey(document.activeElement);

    render(region('head'), headHtml(d));
    render(region('week'), weekHtml(d));
    render(region('news'), newsHtml(d));
    const main = region('main');
    render(main, mainHtml(d, c, nowMs));
    main.removeAttribute('aria-busy');
    document.title = `Agenda — ${d.salon.name}`;

    const scroller = root.querySelector('.pro-scroller');
    if (scroller) {
      bindSwipe(scroller);
      if (scroll === 'keep' && oldScroller) scroller.scrollTop = prevTop;
      else autoScroll(scroller, d, c, nowMs);
    }
    const week = root.querySelector('.pro-week [aria-pressed="true"]');
    if (week && week.parentElement.scrollWidth > week.parentElement.clientWidth) {
      week.parentElement.scrollLeft = week.offsetLeft - week.parentElement.clientWidth / 2 + week.offsetWidth / 2;
    }
    markSelected();
    if (key) {
      const again = root.querySelector(key);
      if (again) again.focus({ preventScroll: true });
    }
    lastMinute = Math.floor(nowMs / 60000);
  }

  /** Fait défiler la frise : vers « maintenant » aujourd'hui, sinon vers le premier RDV. */
  function autoScroll(scroller, d, c, nowMs) {
    const track = scroller.querySelector('.timeline__track');
    if (!track) return;
    const start = Number(track.dataset.start);
    const end = Number(track.dataset.end);
    const rect = track.getBoundingClientRect();
    const ppm = rect.height / Math.max(1, end - start);
    let target = start;
    if (c.isToday) target = zonedParts(nowMs, d.tz).minutes - 40;
    else if (c.active.length) target = clampMinutes(c.active[0].start, d.day, d.tz) - 20;
    const trackTop = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, trackTop + (Math.max(start, target) - start) * ppm - 8);
  }

  /** Mise à jour de chaque minute, sans tout redessiner (le focus reste en place). */
  function tick() {
    if (!root || !data) return;
    const nowMs = Date.now();
    const minute = Math.floor(nowMs / 60000);
    if (minute === lastMinute) return;
    lastMinute = minute;
    if (todayYMD(data.tz, new Date(nowMs)) !== data.today) {   // passage à minuit
      load();
      return;
    }
    if (data.day !== data.today) return;
    const c = compute(data, nowMs);
    const nextRegion = region('next');
    if (nextRegion && !nextRegion.contains(document.activeElement)) render(nextRegion, nextHtml(data, c, nowMs));
    const statsRegion = region('stats');
    if (statsRegion) render(statsRegion, statsHtml(data, c, nowMs));
    const track = root.querySelector('.timeline__track');
    if (track) {
      const old = track.querySelector('.timeline__now');
      if (old) old.remove();
      const win = { start: Number(track.dataset.start), end: Number(track.dataset.end) };
      track.append(fragment(nowLineHtml(data, win, nowMs)));
    }
    for (const el of root.querySelectorAll('.timeline__event')) {
      el.classList.toggle('timeline__event--next', Boolean(c.next) && el.dataset.appt === c.next.id);
    }
  }

  /* — Gestes — */

  function bindSwipe(scroller) {
    const tl = scroller.querySelector('.timeline');
    if (!tl) return;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let dy = 0;
    let axis = 'none';
    const reset = () => {
      tl.style.transition = '';
      tl.style.transform = '';
      tl.style.opacity = '';
    };
    scroller.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { axis = 'none'; return; }
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      dx = 0;
      dy = 0;
      axis = '';
    }, { passive: true });
    scroller.addEventListener('touchmove', (e) => {
      if (axis === 'none' || e.touches.length !== 1) return;
      dx = e.touches[0].clientX - x0;
      dy = e.touches[0].clientY - y0;
      if (!axis && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) axis = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'x' : 'y';
      if (axis === 'x') {
        tl.style.transition = 'none';
        tl.style.transform = `translateX(${Math.max(-80, Math.min(80, dx * 0.4))}px)`;
        tl.style.opacity = String(1 - Math.min(Math.abs(dx), 150) / 500);
      }
    }, { passive: true });
    scroller.addEventListener('touchend', () => {
      const wasX = axis === 'x';
      axis = 'none';
      if (!wasX) return;
      reset();
      // Seuil net : 70 px, et nettement plus horizontal que vertical.
      if (Math.abs(dx) >= 70 && Math.abs(dx) > Math.abs(dy) * 1.5) goDay(dx < 0 ? 1 : -1);
    }, { passive: true });
    scroller.addEventListener('touchcancel', () => { axis = 'none'; reset(); }, { passive: true });
  }

  function goDay(delta) {
    if (!data) return;
    goToAgenda(addDaysYMD(data.day, delta));
  }

  /* — Données — */

  async function load({ initial = false } = {}) {
    const mine = ++seq;
    let next;
    try {
      const salon = await loadSalon();
      const tz = tzOf(salon);
      const today = todayYMD(tz);
      const day = wantedDay && isValidYMD(wantedDay) ? wantedDay : today;
      const weekStart = addDaysYMD(day, 1 - weekdayISO(day));
      const week = dayRangeISO(weekStart, tz, 7);
      const dayRange = dayRangeISO(day, tz);
      const ahead = dayRangeISO(today, tz, (Number(salon.maxDaysAhead) || 30) + 2);
      const [weekAppts, blocks, upcoming, services] = await Promise.all([
        store.listAppointments(week.from, week.to),
        store.listBlocks(dayRange.from, dayRange.to),
        store.listAppointments(ahead.from, ahead.to),
        store.listServices(),
      ]);
      next = { salon, tz, today, day, weekStart, week: weekAppts, blocks, upcoming, services };
    } catch (err) {
      if (mine !== seq || !root) return;
      if (initial || !data) {
        render(region('main'), html`<div class="empty">
          <div class="empty__icon">${icon('alerte')}</div>
          <p class="empty__title">Agenda indisponible</p>
          <p class="empty__text">Le chargement a échoué. Vérifiez la connexion puis réessayez.</p>
          <div class="empty__actions"><button type="button" class="btn btn--primary" data-act="retry">Réessayer</button></div></div>`);
        region('main').removeAttribute('aria-busy');
      }
      showError(err);
      return;
    }
    if (mine !== seq || !root) return;
    const dayChanged = !data || data.day !== next.day;
    data = next;
    // L'agenda est vu : les réservations affichées (le bandeau les montre toutes) ne seront
    // plus « nouvelles » au prochain passage. Repère = leur plus récente date de création,
    // donnée par le serveur : ni une réservation arrivée après, ni l'horloge du téléphone.
    const seen = nextLastSeen(Date.parse(readLS(LASTSEEN_KEY) || ''), next.upcoming);
    if (seen !== null) writeLS(LASTSEEN_KEY, new Date(seen).toISOString());
    nav.refreshBadge();
    draw({ scroll: dayChanged ? 'auto' : 'keep' });
    if (dayChanged && !initial) {
      // Changement de jour (flèches, semaine, « Aujourd'hui », glissé) : lu par les lecteurs d'écran.
      const n = compute(data, Date.now()).active.length;
      announce(`${dayTitle(data.day)}${isDayOpen(data.salon, data.day) ? '' : ', salon fermé'} : ${plural(n, 'rendez-vous', 'rendez-vous')}`);
    }

    const pending = nav.pendingOpen;
    if (pending && ymdOf(pending.start, data.tz) === data.day) {
      nav.pendingOpen = null;
      openAppt(findAppt(pending.id) || pending);
    }
    if (selectedId && mq.matches) {
      const fresh = findAppt(selectedId);
      if (fresh) selectedAppt = fresh;
      if (!panelCtrl) renderPanel();
    }
  }

  /* — Interactions — */

  function onClick(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || !data) {
      if (t && t.closest('[data-act="retry"]')) load({ initial: true });
      return;
    }
    const navBtn = t.closest('[data-nav]');
    if (navBtn) return goDay(Number(navBtn.dataset.nav));
    if (t.closest('[data-today]')) return goToAgenda('');
    const dayBtn = t.closest('.pro-week [data-day]');
    if (dayBtn) {
      if (dayBtn.dataset.day !== data.day) goToAgenda(dayBtn.dataset.day);
      return undefined;
    }
    const ev = t.closest('[data-appt]');
    if (ev) return openAppt(findAppt(ev.dataset.appt));
    const opener = t.closest('[data-open]');
    if (opener) {
      const appt = findAppt(opener.dataset.open);
      if (!appt) return undefined;
      const y = ymdOf(appt.start, data.tz);
      if (y === data.day) return openAppt(appt);
      nav.pendingOpen = appt;
      goToAgenda(y);
      return undefined;
    }
    const blockBtn = t.closest('[data-block]');
    if (blockBtn) {
      const block = data.blocks.find((b) => b.id === blockBtn.dataset.block);
      if (block) deleteBlockFlow(block, data.salon);
      return undefined;
    }
    const act = t.closest('[data-act]');
    if (act) {
      const name = act.dataset.act;
      if (name === 'add') openAddChooser({ ymd: data.day });
      else if (name === 'add-anyway') openNewAppointment({ ymd: data.day });
      else if (name === 'retry') load({ initial: true });
      else if (name === 'hide-news') {
        // Masque les réservations affichées ; une réservation créée ensuite fera réapparaître le bandeau.
        const latest = latestOnlineCreatedAt(data.upcoming);
        if (Number.isFinite(latest)) hiddenUpTo = Math.max(hiddenUpTo, latest);
        render(region('news'), '');
      } else if (name === 'panel-close') {
        selectedId = null;
        selectedAppt = null;
        renderPanel();
        markSelected();
      }
      return undefined;
    }
    // Toucher un espace libre de la frise → nouveau RDV à cette heure (arrondie au pas).
    const track = t.closest('.timeline__track');
    if (track) {
      const start = Number(track.dataset.start);
      const end = Number(track.dataset.end);
      const rect = track.getBoundingClientRect();
      if (!rect.height) return undefined;
      const minutes = start + ((e.clientY - rect.top) / rect.height) * (end - start);
      const step = Number(data.salon.slotStep) || 15;
      const rounded = Math.max(0, Math.min(1440 - step, Math.floor(minutes / step) * step));
      const hh = String(Math.floor(rounded / 60)).padStart(2, '0');
      const mm = String(rounded % 60).padStart(2, '0');
      openNewAppointment({ ymd: data.day, time: `${hh}:${mm}` });
    }
    return undefined;
  }

  function onToggle(e) {
    if (e.target instanceof HTMLDetailsElement && e.target.classList.contains('pro-cancelled')) {
      cancelledOpen = e.target.open;
    }
  }

  function onMedia() {
    if (mq.matches) renderPanel();
    markSelected();
  }

  /* — Cycle de vie — */

  return {
    mount(el, params = {}) {
      root = el;
      wantedDay = params.ymd || null;
      const stored = Date.parse(readLS(LASTSEEN_KEY) || '');
      // Premier passage : les réservations en ligne des 12 dernières heures sont « nouvelles ».
      baseline = Number.isFinite(stored) ? stored : Date.now() - 12 * HOUR_MS;
      render(root, skeletonHtml());
      render(region('panel'), panelPlaceholder());
      root.addEventListener('click', onClick);
      root.addEventListener('toggle', onToggle, true);
      mq.addEventListener('change', onMedia);
      timer = setInterval(tick, 5_000);   // ne redessine qu'au changement de minute
      load({ initial: true });
    },
    update(params = {}) {
      wantedDay = params.ymd || null;
      if (selectedId) {
        selectedId = null;
        selectedAppt = null;
        renderPanel();
      }
      const main = region('main');
      if (main) main.setAttribute('aria-busy', 'true');
      load();
    },
    refresh() {
      load();
    },
    unmount() {
      seq++;
      clearInterval(timer);
      mq.removeEventListener('change', onMedia);
      if (panelCtrl) panelCtrl.destroy();
      if (root) {
        root.removeEventListener('click', onClick);
        root.removeEventListener('toggle', onToggle, true);
      }
      root = null;
      data = null;
    },
  };
}
