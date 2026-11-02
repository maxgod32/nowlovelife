/* Email through Resend's REST API. If no key is set, sending is skipped quietly: bookings still work and
   Stripe still emails its own receipt. */
import { env, DEMO } from './env.mjs';

export const mailReady = () => DEMO || !!env('RESEND_API_KEY');
export const fromAddress = () => env('MAIL_FROM') || 'Now & Love <bookings@nowlovelife.com>';

export async function send({ to, subject, html, text, replyTo, attachments }) {
  if (!to) return { ok: false, skipped: true };
  if (DEMO) {
    (globalThis.NL_DEMO_MAIL || (globalThis.NL_DEMO_MAIL = [])).push({ to, subject });
    return { ok: true, demo: true };
  }
  const key = env('RESEND_API_KEY');
  if (!key) return { ok: false, skipped: true };
  const post = (reply) => fetch((env('RESEND_API_BASE') || 'https://api.resend.com') + '/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromAddress(), to: [].concat(to), subject, html, text, reply_to: reply || undefined, attachments }),
    signal: AbortSignal.timeout(8000)
  });
  try {
    let res = await post(replyTo);
    if (res.status === 422 && replyTo) res = await post(null);   // never lose an alert over the reply-to address
    if (!res.ok) { console.error('mail failed', res.status, await res.text()); return { ok: false }; }
    return { ok: true };
  } catch (e) {
    console.error('mail failed', e);
    return { ok: false };
  }
}
