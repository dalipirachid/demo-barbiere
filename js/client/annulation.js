// Annulation d'un rendez-vous par la cliente ou le client (ticket et
// « Mes rendez-vous ») : confirmation, appel au Store, cas « trop tard ».

import { html, icon, toast, confirmDialog, openSheet } from '../ui/dom.js';
import { fmtDateTime, toMs } from '../core/dates.js';
import { errorMessage } from '../core/errors.js';
import { patchMesRdv, removeMesRdv } from './memoire.js';
import { errorText } from './commun.js';
import { tzOf, cap, telUrl, phoneLabel } from './salon.js';

const HOUR = 3_600_000;

/** Vrai si l'annulation en ligne n'est plus possible (même règle que le serveur). */
export function isTooLate(salon, start, now = Date.now()) {
  const limit = (Number(salon && salon.cancelLimitHours) || 0) * HOUR;
  return toMs(start) - now < limit;
}

/** Texte de la feuille « trop tard » : pas d'invitation à appeler sans numéro du salon. */
export function tooLateText(salon) {
  return telUrl(salon)
    ? errorMessage('TOO_LATE')
    : 'Il est trop tard pour annuler en ligne. Prévenez le salon dès que possible.';
}

/** Feuille « trop tard pour annuler en ligne », avec le bouton d'appel si le numéro est connu. */
export function showTooLate(salon) {
  const tel = telUrl(salon);
  const phone = phoneLabel(salon);
  openSheet({
    title: 'Trop tard pour annuler en ligne',
    role: 'alertdialog',
    content: html`
      <p class="sheet__message">${tooLateText(salon)}</p>
      ${phone ? html`<p class="cancel-phone">${icon('telephone')}<span>${phone}</span></p>` : ''}`,
    actions: tel
      ? [
        { label: 'Fermer', variant: 'ghost' },
        { label: 'Appeler le salon', variant: 'primary', href: tel, icon: 'telephone', autofocus: true },
      ]
      : [{ label: 'J’ai compris', variant: 'primary', autofocus: true }],
  });
}

/**
 * Annule un rendez-vous après confirmation.
 *   booking : { start, serviceName }   button : bouton à passer en [aria-busy]
 * → 'cancelled' | 'kept' | 'too-late' | 'not-found' | 'error'
 */
export async function cancelWithConfirm({ store, salon, token, booking, button = null }) {
  if (isTooLate(salon, booking.start)) {
    showTooLate(salon);
    return 'too-late';
  }
  const when = fmtDateTime(booking.start, tzOf(salon));
  const what = booking.serviceName ? `${booking.serviceName}, ${when}` : cap(when);
  const ok = await confirmDialog({
    title: 'Annuler ce rendez-vous ?',
    message: `${what}. Le créneau sera libéré pour quelqu’un d’autre.`,
    confirmLabel: 'Oui, annuler',
    cancelLabel: 'Non, le garder',
    danger: true,
  });
  if (!ok) return 'kept';

  if (button) button.setAttribute('aria-busy', 'true');
  try {
    await store.cancelBooking(token);
    patchMesRdv(token, { status: 'cancelled' });
    toast('Votre rendez-vous est annulé. Merci d’avoir prévenu le salon.', { type: 'success' });
    return 'cancelled';
  } catch (err) {
    if (err && err.code === 'TOO_LATE') {
      showTooLate(salon);
      return 'too-late';
    }
    if (err && err.code === 'NOT_FOUND') {
      removeMesRdv(token);
      toast(errorMessage(err), { type: 'error' });
      return 'not-found';
    }
    if (!err || !err.code) console.error(err);
    toast(errorText(err), { type: 'error' });
    return 'error';
  } finally {
    if (button) button.removeAttribute('aria-busy');
  }
}
