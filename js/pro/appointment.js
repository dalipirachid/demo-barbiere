/**
 * Détail d'un rendez-vous : feuille du bas sur téléphone, panneau latéral
 * sur tablette (l'agenda appelle mountAppointmentDetail dans son panneau).
 *
 *   openAppointmentSheet(appt)                       feuille
 *   mountAppointmentDetail(el, appt, { inSheet })    contenu seul → { destroy() }
 *
 * Actions : appeler, SMS de rappel, WhatsApp, honoré, lapin, déplacer,
 * modifier (prestation, note), annuler (+ SMS d'excuse), fiche client.
 */

import { html, render, on, icon, openSheet, confirmDialog, toast } from '../ui/dom.js';
import { fmtTime, fmtDuration, fmtPrice, fmtDateTime, fmtDayLong, zonedToUtc } from '../core/dates.js';
import { createSlotPicker } from './slot-picker.js';
import {
  store, loadSalon, tzOf, ymdOf, nav, fullName, initials, ordinal, plural, dayTitle, bool,
  statusBadge, contactButtons, reminderText, excuseText, movedText,
  smsHref, waHref, telHref, phoneText, showError, proMessage, loaderHtml, uid, goToAgenda,
  STATUS_LABELS, formSnapshot, confirmDiscard,
} from './shared.js';

/* ==========================================================================
   Chargement
   ========================================================================== */

/** Relit le RDV (par la fiche du client, quel que soit son jour) et le salon. */
async function loadDetail(apptId, clientId) {
  const [client, salon] = await Promise.all([
    clientId ? store.getClient(clientId).catch((err) => (err && err.code === 'NOT_FOUND' ? null : Promise.reject(err))) : null,
    loadSalon(),
  ]);
  const appt = client ? client.appointments.find((a) => a.id === apptId) || null : null;
  return { client, salon, appt };
}

/** Rang de ce RDV parmi les visites du client (honorés ou confirmés). */
function visitRank(client, appt) {
  const start = Date.parse(appt.start);
  return client.appointments.filter((a) => (a.status === 'done' || a.status === 'confirmed') && Date.parse(a.start) <= start).length;
}

/* ==========================================================================
   Gabarit
   ========================================================================== */

/** Réservation en ligne faite sous un autre nom que celui de la fiche (même téléphone). */
function bookedUnderOtherName(appt, client) {
  const fold = (s) => String(s || '').trim().toLocaleLowerCase('fr');
  if (appt.source !== 'online' || !appt.bookedFirstName) return false;
  return fold(appt.bookedFirstName) !== fold(client.firstName)
    || (appt.bookedLastName && fold(appt.bookedLastName) !== fold(client.lastName));
}

function detailHtml({ appt, client, salon }, { inSheet }) {
  const tz = tzOf(salon);
  const c = appt.client || client;
  const phone = c && c.phone;
  const durationMin = Math.round((Date.parse(appt.end) - Date.parse(appt.start)) / 60000);
  const rank = appt.status === 'done' || appt.status === 'confirmed' ? visitRank(client, appt) : 0;
  const isCancelled = appt.status === 'cancelled';
  const created = appt.createdAt ? fmtDateTime(appt.createdAt, tz) : '';

  return html`
    <div class="pro-detail">
      <div class="pro-detail__who">
        <span class="avatar avatar--lg" aria-hidden="true">${initials(c)}</span>
        <div class="pro-detail__whotext">
          ${inSheet ? '' : html`<h2 class="h3 pro-detail__name">${fullName(c)}</h2>`}
          <p class="pro-detail__phone">${phone ? html`<a href="${telHref(phone)}">${phoneText(phone)}</a>` : html`<span class="muted">Pas de téléphone</span>`}</p>
          <p class="cluster pro-detail__badges">
            ${statusBadge(appt.status)}
            ${rank ? html`<span class="badge">${ordinal(rank)} visite</span>` : ''}
            ${client.noShows > 0 ? html`<span class="badge badge--noshow">${plural(client.noShows, 'lapin')}</span>` : ''}
            ${appt.source === 'online' ? html`<span class="badge badge--online">En ligne</span>` : ''}
          </p>
        </div>
      </div>

      ${client.notes ? html`
        <div class="card card--inset pro-detail__notes">
          <p class="smallcaps muted">Notes client</p>
          <p class="pro-prewrap">${client.notes}</p>
        </div>` : ''}

      <dl class="pro-facts">
        <div class="pro-facts__wide"><dt>Heure</dt><dd><strong class="pro-facts__time">${fmtTime(appt.start, tz)} – ${fmtTime(appt.end, tz)}</strong>
          <span class="pro-facts__day">${dayTitle(ymdOf(appt.start, tz))}</span></dd></div>
        <div><dt>Prestation</dt><dd>${appt.serviceName}</dd></div>
        <div><dt>Durée</dt><dd>${fmtDuration(durationMin)}</dd></div>
        <div><dt>Prix</dt><dd>${fmtPrice(appt.priceCents)}</dd></div>
        ${appt.note ? html`<div class="pro-facts__wide"><dt>Note du rendez-vous</dt><dd class="pro-prewrap">${appt.note}</dd></div>` : ''}
        <div class="pro-facts__wide"><dt>Source</dt><dd>${appt.source === 'online'
          ? `Réservé en ligne${created ? ` le ${created}` : ''}`
          : `Ajouté depuis l’agenda${created ? ` le ${created}` : ''}`}</dd></div>
        ${bookedUnderOtherName(appt, client) ? html`<div class="pro-facts__wide"><dt>Réservé au nom de</dt><dd>${`${appt.bookedFirstName} ${appt.bookedLastName}`.trim()}
          <span class="small muted">(saisi en ligne, différent de la fiche : enfant, proche… ou numéro d’un autre)</span></dd></div>` : ''}
      </dl>

      ${phone && !isCancelled ? html`
        <section class="pro-detail__group" aria-label="Contacter">
          ${contactButtons(phone, reminderText(appt, salon))}
          <p class="field__hint">Le SMS et WhatsApp s’ouvrent avec un rappel déjà rédigé.</p>
        </section>` : ''}

      ${isCancelled ? html`
        <div class="notice notice--warn" role="status">${icon('info')}<p>Ce rendez-vous est annulé : le créneau est libre.</p></div>
        <div class="pro-detail__grid">
          <button type="button" class="btn btn--primary btn--lg" data-act="restore">${icon('coche')}<span>Rétablir</span></button>
          <button type="button" class="btn btn--lg" data-act="client">${icon('utilisateur')}<span>Fiche client</span></button>
        </div>` : html`
        <section class="pro-detail__group" aria-label="Statut">
          <div class="pro-detail__status">
            <button type="button" class="btn btn--lg pro-toggle pro-toggle--done" data-act="done" aria-pressed="${bool(appt.status === 'done')}">${icon('coche')}<span>Honoré</span></button>
            <button type="button" class="btn btn--lg pro-toggle pro-toggle--noshow" data-act="noshow" aria-pressed="${bool(appt.status === 'no_show')}">${icon('alerte')}<span>Lapin</span></button>
          </div>
        </section>
        <div class="pro-detail__grid">
          <button type="button" class="btn btn--lg" data-act="move">${icon('calendrier')}<span>Déplacer</span></button>
          <button type="button" class="btn btn--lg" data-act="edit">${icon('crayon')}<span>Modifier</span></button>
          <button type="button" class="btn btn--lg" data-act="client">${icon('utilisateur')}<span>Fiche client</span></button>
          <button type="button" class="btn btn--danger btn--lg" data-act="cancel">${icon('croix')}<span>Annuler</span></button>
        </div>`}
    </div>`;
}

/* ==========================================================================
   Contenu (feuille ou panneau)
   ========================================================================== */

/**
 * Affiche le détail d'un RDV dans `el` et branche ses actions.
 * opts.inSheet : dans une feuille (le nom est déjà dans le titre) ;
 * opts.close() : ferme la feuille après une action terminée ;
 * opts.onTitle(text) : met à jour le titre de la feuille.
 */
export function mountAppointmentDetail(el, appt, { inSheet = false, close = () => {}, onTitle = () => {} } = {}) {
  let state = null;
  let destroyed = false;
  let seq = 0;
  const clientId = appt.client && appt.client.id;

  async function load({ quiet = false } = {}) {
    const mine = ++seq;
    if (!quiet) render(el, loaderHtml('Chargement du rendez-vous…'));
    try {
      const data = await loadDetail(appt.id, clientId);
      if (destroyed || mine !== seq) return;
      if (!data.appt || !data.client) {
        state = null;
        render(el, html`<div class="empty"><div class="empty__icon">${icon('calendrier')}</div>
          <p class="empty__title">Rendez-vous introuvable</p>
          <p class="empty__text">Il a peut-être été supprimé entre-temps.</p></div>`);
        return;
      }
      state = data;
      onTitle(fullName(data.appt.client || data.client));
      render(el, detailHtml(data, { inSheet }));
    } catch (err) {
      if (destroyed || mine !== seq) return;
      render(el, html`<div class="empty"><p class="empty__title">Chargement impossible</p>
        <p class="empty__text">Vérifiez la connexion puis réessayez.</p>
        <div class="empty__actions"><button type="button" class="btn btn--primary" data-act="retry">Réessayer</button></div></div>`);
      showError(err);
    }
  }

  // Repasser un lapin (ou un RDV annulé) en confirmé échoue si son créneau,
  // libéré entre-temps, a été repris par un autre rendez-vous (RES-12).
  const retakenError = (err) => showError(err, err && err.code === 'SLOT_TAKEN'
    ? 'Ce créneau a été repris par un autre rendez-vous : celui-ci ne peut plus redevenir confirmé à cette heure. Déplacez-le si besoin.'
    : undefined);

  async function setStatus(status, button) {
    const a = state.appt;
    const previous = a.status;
    const next = a.status === status ? 'confirmed' : status;
    button.setAttribute('aria-busy', 'true');
    try {
      await store.updateAppointment(a.id, { status: next });
    } catch (err) {
      button.removeAttribute('aria-busy');
      retakenError(err);
      return;
    }
    const first = (a.client && a.client.firstName) || 'Client';
    const message = next === 'done' ? `${first} : honoré.`
      : next === 'no_show' ? `${first} : noté comme lapin.`
        : `${first} : remis en « confirmé ».`;
    toast(message, {
      type: 'success',
      action: {
        label: 'Défaire',
        // Toujours confirmé à l'écran : un « Défaire » touché par mégarde ne passe pas inaperçu.
        onClick: () => store.updateAppointment(a.id, { status: previous })
          .then(() => toast(`${first} : statut rétabli (« ${STATUS_LABELS[previous] || previous} »).`, { type: 'success' }))
          .catch(retakenError),
      },
    });
    if (inSheet) close();
    else load({ quiet: true });
  }

  async function onAction(event, btn) {
    if (!state && btn.dataset.act !== 'retry') return;
    const act = btn.dataset.act;
    if (act === 'retry') return load();
    const a = state.appt;
    if (act === 'done') return setStatus('done', btn);
    if (act === 'noshow') return setStatus('no_show', btn);
    if (act === 'client') {
      nav.go(`#/clients/${encodeURIComponent(state.client.id)}`);
      return undefined;
    }
    if (act === 'move') {
      openMoveSheet(a, state.salon, {
        onMoved: (moved) => {
          if (inSheet) close();
          goToAgenda(ymdOf(moved.start, tzOf(state.salon)));
        },
      });
      return undefined;
    }
    if (act === 'edit') {
      openEditSheet(a);
      return undefined;
    }
    if (act === 'restore') {
      btn.setAttribute('aria-busy', 'true');
      try {
        await store.updateAppointment(a.id, { status: 'confirmed' });
        toast('Rendez-vous rétabli.', { type: 'success' });
        if (inSheet) close();
        else load({ quiet: true });
      } catch (err) {
        btn.removeAttribute('aria-busy');
        retakenError(err);
      }
      return undefined;
    }
    if (act === 'cancel') {
      const tz = tzOf(state.salon);
      const ok = await confirmDialog({
        title: 'Annuler ce rendez-vous ?',
        message: `${fullName(a.client)}, ${fmtDayLong(ymdOf(a.start, tz))} à ${fmtTime(a.start, tz)} (${a.serviceName}). Le créneau redeviendra libre.`,
        confirmLabel: 'Oui, annuler',
        cancelLabel: 'Non, garder',
        danger: true,
      });
      if (!ok) return undefined;
      try {
        await store.updateAppointment(a.id, { status: 'cancelled' });
      } catch (err) {
        showError(err);
        return undefined;
      }
      const salon = state.salon;
      if (inSheet) close();
      else load({ quiet: true });
      if (a.client && a.client.phone) offerExcuse(a, salon);
      else toast('Rendez-vous annulé.', { type: 'success' });
    }
    return undefined;
  }

  const off = on(el, 'click', '[data-act]', onAction);
  const unsubscribe = store.onChange(() => {
    if (!destroyed && state) load({ quiet: true });
  });

  load();

  return {
    reload: () => load({ quiet: true }),
    get appt() { return state && state.appt; },
    destroy() {
      destroyed = true;
      off();
      unsubscribe();
    },
  };
}

/** Ouvre le détail d'un RDV dans une feuille du bas. */
export function openAppointmentSheet(appt) {
  let ctrl = null;
  const sheet = openSheet({
    title: fullName(appt.client),
    content: loaderHtml('Chargement du rendez-vous…'),
    actions: [],
    className: 'pro-sheet',
    onClose: () => { if (ctrl) ctrl.destroy(); },
  });
  const titleEl = sheet.el.querySelector('.sheet__title');
  ctrl = mountAppointmentDetail(sheet.body, appt, {
    inSheet: true,
    close: () => sheet.close(),
    onTitle: (text) => { if (titleEl) titleEl.textContent = text; },
  });
  return sheet;
}

/* ==========================================================================
   Après une annulation : proposer un SMS d'excuse
   ========================================================================== */

function offerExcuse(appt, salon) {
  const text = excuseText(appt, salon);
  const first = (appt.client && appt.client.firstName) || 'le client';
  const sheet = openSheet({
    title: `Prévenir ${first} ?`,
    className: 'pro-sheet',
    content: html`
      <div class="stack">
        <p class="sheet__message">Le rendez-vous est annulé. Vous pouvez envoyer ce message d’excuse, déjà rédigé :</p>
        <blockquote class="card card--inset pro-quote">${text}</blockquote>
        <div class="pro-contact">
          <a class="btn btn--primary btn--lg" href="${smsHref(appt.client.phone, text)}" data-close>${icon('sms')}<span>SMS</span></a>
          <a class="btn btn--lg" href="${waHref(appt.client.phone, text)}" target="_blank" rel="noopener" data-close>${icon('whatsapp')}<span>WhatsApp</span></a>
        </div>
      </div>`,
    actions: [{ label: 'Non merci', variant: 'ghost' }],
  });
  on(sheet.body, 'click', '[data-close]', () => setTimeout(() => sheet.close(), 400));
}

/* ==========================================================================
   Déplacer
   ========================================================================== */

export function openMoveSheet(appt, salon, { onMoved = () => {} } = {}) {
  const tz = tzOf(salon);
  const durationMin = Math.round((Date.parse(appt.end) - Date.parse(appt.start)) / 60000);
  const errId = uid('err');
  let picker = null;

  const sheet = openSheet({
    title: 'Déplacer le rendez-vous',
    className: 'pro-sheet',
    content: html`
      <div class="stack">
        <p class="muted">${fullName(appt.client)} · ${appt.serviceName} (${fmtDuration(durationMin)}) — actuellement le ${fmtDayLong(ymdOf(appt.start, tz))} à ${fmtTime(appt.start, tz)}.</p>
        <div data-picker></div>
        <p class="field__error" id="${errId}" role="alert"></p>
      </div>`,
    actions: [
      { label: 'Fermer', variant: 'ghost' },
      {
        label: 'Déplacer ici',
        variant: 'primary',
        icon: 'calendrier',
        onClick: async () => {
          const errEl = sheet.body.querySelector(`#${errId}`);
          const { ymd, time } = picker.value();
          if (!time) {
            errEl.textContent = 'Choisissez un créneau ou indiquez une heure.';
            return false;
          }
          errEl.textContent = '';
          try {
            const moved = await store.updateAppointment(appt.id, { start: zonedToUtc(ymd, time, tz).toISOString() });
            const phone = appt.client && appt.client.phone;
            toast(`Rendez-vous déplacé au ${fmtDayLong(ymd)} à ${fmtTime(moved.start, tz)}.`, {
              type: 'success',
              action: phone ? {
                label: 'Prévenir par SMS',
                onClick: () => { location.href = smsHref(phone, movedText(moved, salon)); },
              } : null,
            });
            onMoved(moved);
            return true;
          } catch (err) {
            if (err && (err.code === 'SLOT_TAKEN' || err.code === 'INVALID')) {
              errEl.textContent = proMessage(err);
              picker.reload();
              return false;
            }
            showError(err);
            return false;
          }
        },
      },
    ],
    onClose: () => { if (picker) picker.destroy(); },
  });

  picker = createSlotPicker(sheet.body.querySelector('[data-picker]'), {
    salon,
    durationMin,
    ymd: ymdOf(appt.start, tz),
    time: '',
    excludeId: appt.id,
    label: 'Nouveau jour',
  });
  return sheet;
}

/* ==========================================================================
   Modifier la prestation ou la note
   ========================================================================== */

export async function openEditSheet(appt) {
  const noteId = uid('note');
  const errId = uid('err');
  let serviceId = appt.serviceId;
  let initial = null;
  const isDirty = () => initial !== null && formSnapshot(sheet.body) !== initial;

  const sheet = openSheet({
    title: 'Modifier le rendez-vous',
    className: 'pro-sheet',
    content: loaderHtml(),
    beforeClose: confirmDiscard(isDirty),
    actions: [
      { label: 'Fermer', variant: 'ghost', onClick: confirmDiscard(isDirty) },
      {
        label: 'Enregistrer',
        variant: 'primary',
        onClick: async () => {
          const errEl = sheet.body.querySelector(`#${errId}`);
          const note = sheet.body.querySelector(`#${noteId}`);
          if (!note) return false;
          const patch = { note: note.value };
          if (serviceId && serviceId !== appt.serviceId) patch.serviceId = serviceId;
          try {
            await store.updateAppointment(appt.id, patch);
            toast('Rendez-vous modifié.', { type: 'success' });
            return true;
          } catch (err) {
            if (err && (err.code === 'SLOT_TAKEN' || err.code === 'INVALID')) {
              errEl.textContent = err.code === 'SLOT_TAKEN'
                ? 'Avec cette prestation, le rendez-vous chevaucherait le suivant. Déplacez-le d’abord ou choisissez une prestation plus courte.'
                : proMessage(err);
              return false;
            }
            showError(err);
            return false;
          }
        },
      },
    ],
  });

  let services;
  try {
    services = await store.listServices({ includeInactive: true });
  } catch (err) {
    showError(err);
    sheet.close();
    return;
  }
  // Prestations actives, plus l'actuelle même si elle a été désactivée.
  const choices = services.filter((s) => s.active || s.id === appt.serviceId);
  if (!choices.some((s) => s.id === appt.serviceId)) serviceId = choices.length ? '' : serviceId;

  render(sheet.body, html`
    <div class="stack">
      <div>
        <p class="field__label" id="${noteId}-svc">Prestation</p>
        <div class="pro-svc-chips" role="group" aria-labelledby="${noteId}-svc">
          ${choices.map((s) => html`<button type="button" class="chip" data-svc="${s.id}" aria-pressed="${bool(s.id === serviceId)}">${s.name} <span class="chip__count">${fmtDuration(s.durationMin)}</span></button>`)}
        </div>
        ${choices.some((s) => s.id === appt.serviceId) ? '' : html`<p class="field__hint">Prestation actuelle : ${appt.serviceName} (plus proposée).</p>`}
        <p class="field__hint">Changer de prestation met à jour la durée et le prix.</p>
      </div>
      <div class="field">
        <label class="field__label" for="${noteId}">Note du rendez-vous <span class="field__optional">(facultatif)</span></label>
        <textarea class="field__textarea" id="${noteId}" maxlength="500" placeholder="Ex. : apporter la photo de la coupe">${appt.note || ''}</textarea>
      </div>
      <p class="field__error" id="${errId}" role="alert"></p>
    </div>`);

  on(sheet.body, 'click', '[data-svc]', (e, chip) => {
    serviceId = chip.dataset.svc;
    for (const c of sheet.body.querySelectorAll('[data-svc]')) c.setAttribute('aria-pressed', bool(c === chip));
  });
  initial = formSnapshot(sheet.body);
}
