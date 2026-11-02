/* Now & Love private sessions: the whole back end in one Netlify Function, served at /api/*.

   Public:  GET  /api/public            sessions on offer, Jorge's time zone, where sessions happen
            GET  /api/slots             open start times for one session
            POST /api/book              hold a time and open Stripe Checkout
            GET  /api/booking           booking status after payment (asks Stripe if needed)
            POST /api/booking/release   give a held time back when someone leaves checkout
            GET  /api/booking/ics       calendar invite for a confirmed booking
            POST /api/message           message Jorge directly
            POST /api/stripe-webhook    payment events from Stripe
   Jorge:   /api/admin/*                sign in, bookings, hours, sessions, messages, export

   Booking states: hold (checkout open) -> confirmed, or processing (slow bank payment) -> confirmed, or
   review (paid, but the time overlaps another booking: Jorge decides). cancelled and expired free the time.
   Only the booking's own Stripe checkout, at the right amount, can confirm it, and nothing brings a
   cancelled booking back. */
import { json, readBody, HttpError, clean, cleanText, isEmail, rid, ipOf, money } from '../lib/util.mjs';
import { read, update, NO_CHANGE } from '../lib/store.mjs';
import { DEFAULT_CONFIG, DEFAULT_OFFERINGS, computeSlots, busyOf } from '../lib/slots.mjs';
import * as stripe from '../lib/stripe.mjs';
import * as mail from '../lib/mail.mjs';
import * as tpl from '../lib/emails.mjs';
import { ics, toBase64 } from '../lib/ics.mjs';
import * as auth from '../lib/auth.mjs';
import { env, DEMO } from '../lib/env.mjs';
import { parts, parseDay, validTZ, hm, zoned, fmtWhen, fmtDay, fmtTime } from '../lib/time.mjs';

const HOLD_MINUTES = 33;      // a time stays held while its checkout is open
const CHECKOUT_MINUTES = 31;  // Stripe's shortest allowed checkout lifetime is 30 minutes
const MAX_OPEN_HOLDS = 10;    // unpaid checkouts open at once, across everyone
const BOOKINGS_PER_HOUR = 6;  // checkouts one network can open per hour

export default async function handler(req, context) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const route = ROUTES[req.method + ' ' + path];
  try {
    if (!route) return json({ error: 'Not found' }, 404);
    return await route(req, url, context);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
    console.error('api error', req.method, path, e);
    return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
  }
}

export const config = { path: '/api/*' };

/* ---------- data ---------- */

async function getConfig() {
  const { data } = await read('config', DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...data };
}
async function getOfferings() {
  const { data } = await read('offerings', { list: DEFAULT_OFFERINGS });
  return Array.isArray(data.list) && data.list.length ? data.list : DEFAULT_OFFERINGS;
}
async function getBookings() {
  const { data } = await read('bookings', { list: [] });
  return Array.isArray(data.list) ? data.list : [];
}
const notifyTo = (config) => config.notifyEmail || env('NOTIFY_EMAIL');
const siteOrigin = (url) => (env('SITE_URL') || url.origin).replace(/\/+$/, '');
const withJorge = (name) => (/jorge/i.test(name) ? name : name + ' with Jorge');
const pubOffering = (o) => ({ id: o.id, name: o.name, description: o.description, minutes: o.minutes, priceCents: o.priceCents });
const overlaps = (x, list, now) => busyOf(list, now).some((o) => o.id !== x.id && x.start < o.end && x.end > o.start);

/* Change one booking under the ETag guard. fn(booking, list) may return NO_CHANGE. */
async function changeBooking(id, fn) {
  let found = null;
  await update('bookings', { list: [] }, (d) => {
    found = null;
    const b = d.list.find((x) => x.id === id);
    if (!b) return NO_CHANGE;
    found = b;
    return fn(b, d.list);
  });
  return found;
}
async function changeByIntent(pi, fn) {
  let found = null;
  await update('bookings', { list: [] }, (d) => {
    found = null;
    const b = d.list.find((x) => x.paymentIntent === pi);
    if (!b) return NO_CHANGE;
    found = b;
    return fn(b);
  });
  return found;
}

/* Old abandoned entries are noise. A hold with a Stripe checkout is never dropped until Stripe has settled it. */
function prune(list, now) {
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    const old = (b.createdAt || 0) < now - 2 * 864e5;
    if (old && (b.status === 'expired' || (b.status === 'hold' && !b.stripeSession && b.holdUntil <= now))) list.splice(i, 1);
  }
}

/* Holds whose timer ran out but whose checkout Stripe has not reported on: ask Stripe what happened. */
async function resolveLapsed(list) {
  const now = Date.now();
  const due = list.filter((b) => b.status === 'hold' && b.stripeSession && b.holdUntil <= now && (!b.checkedAt || now - b.checkedAt > 120e3)).slice(0, 4);
  for (const b of due) {
    let s = null;
    try { s = await stripe.getCheckout(b.stripeSession); } catch (e) { /* try again later */ }
    if (s && s.status !== 'open') await applyCheckout(b.id, s);
    else await changeBooking(b.id, (x) => { x.checkedAt = Date.now(); }).catch(() => {});
  }
  return due.length > 0;
}

async function alertJorge(title, lines, b, config) {
  config = config || await getConfig();
  const to = notifyTo(config);
  if (!to) { console.error('alert with no one to tell:', title, lines.join(' ')); return; }
  await mail.send({ to, ...tpl.jorgeAlert(title, lines, b, config), replyTo: (b && b.client && b.client.email) || undefined });
}

/* ---------- public ---------- */

async function getPublic() {
  const [config, offerings] = await Promise.all([getConfig(), getOfferings()]);
  return json({
    timezone: config.timezone, location: config.location, policy: config.policy, maxDaysAhead: config.maxDaysAhead,
    offerings: offerings.filter((o) => o.active).map(pubOffering),
    payments: stripe.mode() !== 'off', email: mail.mailReady(), demo: DEMO
  });
}

async function getSlots(req, url) {
  const [config, offerings] = await Promise.all([getConfig(), getOfferings()]);
  let bookings = await getBookings();
  if (await resolveLapsed(bookings)) bookings = await getBookings();
  const id = url.searchParams.get('offering');
  const offering = offerings.find((o) => o.active && (!id || o.id === id));
  if (!offering) throw new HttpError(404, 'That session is not available right now.');
  const limit = Math.min(2000, Math.max(0, parseInt(url.searchParams.get('limit') || '0', 10) || 0)) || 2000;
  const slots = computeSlots({ config, offering, bookings, now: Date.now(), limit });
  return json({ timezone: config.timezone, offering: offering.id, minutes: offering.minutes, slots });
}

async function postBook(req, url, context) {
  const b = await readBody(req);
  if (b.website) throw new HttpError(400, 'We could not book that time.');
  const name = clean(b.name, 80), email = clean(b.email, 254).toLowerCase(), phone = clean(b.phone, 40), intention = cleanText(b.intention, 1500);
  if (name.length < 2) throw new HttpError(400, 'Please add your name.', { field: 'name' });
  if (!isEmail(email)) throw new HttpError(400, 'Please check your email address.', { field: 'email' });
  const now = Date.now(), start = Number(b.start);
  if (!Number.isFinite(start) || start % 60000 !== 0 || start < now - 864e5 || start > now + 400 * 864e5) throw new HttpError(400, 'Please choose a time.');

  const [config, offerings] = await Promise.all([getConfig(), getOfferings()]);
  const offering = offerings.find((o) => o.active && o.id === b.offering);
  if (!offering) throw new HttpError(404, 'That session is not available right now.');
  const paid = offering.priceCents > 0;
  // Before Stripe is connected, paid sessions are reserved straight away and Jorge arranges payment himself.
  const later = paid && stripe.mode() === 'off';
  if (!(await auth.throttle('book', ipOf(req, context), BOOKINGS_PER_HOUR, 3600e3))) throw new HttpError(429, 'Too many booking attempts from here. Please wait a little and try again.');
  await resolveLapsed(await getBookings());

  const id = rid(15);
  const booking = {
    id, status: paid && !later ? 'hold' : 'confirmed', offeringId: offering.id, offeringName: offering.name, minutes: offering.minutes, priceCents: offering.priceCents,
    start, end: start + offering.minutes * 60e3, createdAt: now, payment: later ? 'later' : paid ? 'stripe' : 'free',
    ...(paid && !later ? { holdUntil: now + HOLD_MINUTES * 60e3 } : { confirmedAt: now, amountPaid: 0 }),
    client: { name, email, phone, intention }
  };
  const prev = parts(config.timezone, start - 864e5);
  await update('bookings', { list: [] }, (d) => {
    prune(d.list, now);
    const open = computeSlots({ config, offering, bookings: d.list, now, from: { y: prev.y, m: prev.m, d: prev.d }, days: 3 });
    if (!open.includes(start)) throw new HttpError(409, 'That time was just taken. Please choose another.', { code: 'taken' });
    if (paid && !later) {
      const waiting = d.list.filter((x) => x.status === 'hold' && x.holdUntil > now);
      if (waiting.length >= MAX_OPEN_HOLDS) throw new HttpError(429, 'Many people are booking right now. Please try again in a few minutes.');
      if (waiting.filter((x) => x.client && x.client.email === email).length >= 2) throw new HttpError(429, 'You already have times waiting for payment. Please finish or release those first.');
    }
    d.list.push(booking);
  });

  if (!paid || later) {
    await sendConfirmations(booking, config);
    return json({ id, confirmed: true });
  }

  const site = siteOrigin(url);
  const when = fmtWhen(config.timezone, booking.start, booking.end);
  let session;
  try {
    session = await stripe.createCheckout({
      mode: 'payment',
      customer_email: email,
      client_reference_id: id,
      expires_at: Math.floor(now / 1000) + CHECKOUT_MINUTES * 60,
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: offering.priceCents, product_data: { name: withJorge(offering.name), description: when } } }],
      metadata: { bookingId: id },
      payment_intent_data: { metadata: { bookingId: id }, description: offering.name + ', ' + when },
      success_url: site + '/book/?b=' + id + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: site + '/book/?released=' + id
    }, 'nl-book-' + id);
  } catch (e) {
    await changeBooking(id, (x) => { if (x.status !== 'hold' || x.stripeSession) return NO_CHANGE; x.status = 'expired'; });
    throw e;
  }
  await changeBooking(id, (x) => { x.stripeSession = session.id; });
  return json({ id, url: session.url });
}

function publicBooking(b, config) {
  return {
    id: b.id, status: b.status, offeringName: b.offeringName, minutes: b.minutes, priceCents: b.priceCents,
    amountPaid: b.amountPaid, payment: b.payment, refunded: !!b.refunded, start: b.start, end: b.end, timezone: config.timezone, location: config.location,
    policy: config.policy, firstName: String((b.client && b.client.name) || '').split(/\s+/)[0], email: mail.mailReady()
  };
}

async function getBooking(req, url) {
  const id = clean(url.searchParams.get('id'), 40), sid = clean(url.searchParams.get('session_id'), 200);
  let b = (await getBookings()).find((x) => x.id === id);
  if (!b) throw new HttpError(404, 'We could not find that booking.');
  if (['hold', 'expired', 'processing'].includes(b.status) && sid && sid === b.stripeSession) {
    try { b = (await applyCheckout(id, await stripe.getCheckout(sid))) || b; } catch (e) { /* the webhook settles it */ }
  }
  return json(publicBooking(b, await getConfig()));
}

/* What Stripe says about a checkout, applied to its booking. Only the booking's own checkout counts. */
async function applyCheckout(id, s) {
  const b0 = (await getBookings()).find((x) => x.id === id);
  if (!b0) return null;
  if (!s || !b0.stripeSession || s.id !== b0.stripeSession) return b0;
  const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
  if (paid) {
    if (s.amount_total !== b0.priceCents || String(s.currency || 'usd').toLowerCase() !== 'usd') {
      let first = false;
      await changeBooking(id, (x) => { first = !x.mismatch; if (!first) return NO_CHANGE; x.mismatch = true; });
      if (first) await alertJorge('A payment did not match its booking', ['Stripe reported ' + money(s.amount_total) + ' ' + String(s.currency || '').toUpperCase()
        + ' for a ' + money(b0.priceCents) + ' session, so the booking was not confirmed. Please check this payment in Stripe.'], b0);
      return b0;
    }
    return settlePaid(id, s);
  }
  if (s.status === 'complete') return markProcessing(id, s);
  if (s.status === 'expired') return changeBooking(id, (x) => { if (x.status !== 'hold') return NO_CHANGE; x.status = 'expired'; });
  return b0;
}

async function settlePaid(id, s) {
  let outcome = null;
  const b = await changeBooking(id, (x, list) => {
    outcome = null;
    const now = Date.now();
    if (x.status === 'confirmed' || x.status === 'review') return NO_CHANGE;
    if (x.status === 'cancelled') {
      // A repeat of a payment already handled changes nothing. A first payment for a cancelled booking is refunded,
      // unless Jorge chose to keep it when he cancelled.
      if (x.refunded || x.confirmedAt || x.paidAt || x.paidAfterCancel) return NO_CHANGE;
      x.paidAfterCancel = true; x.paidAt = now; x.paymentIntent = s.payment_intent || x.paymentIntent; x.amountPaid = s.amount_total;
      outcome = x.keepPayment ? 'kept' : 'refund';
      return;
    }
    x.paymentIntent = s.payment_intent || x.paymentIntent;
    x.amountPaid = s.amount_total != null ? s.amount_total : x.priceCents;
    x.paidAt = now; delete x.holdUntil;
    if (overlaps(x, list, now)) { x.status = 'review'; outcome = 'review'; }
    else { x.status = 'confirmed'; x.confirmedAt = now; outcome = 'confirmed'; }
  });
  if (!b || !outcome) return b;
  const config = await getConfig();
  if (outcome === 'confirmed') await sendConfirmations(b, config);
  else if (outcome === 'review') {
    await Promise.all([
      b.client.email ? mail.send({ to: b.client.email, ...tpl.clientPaymentReview(b, config), replyTo: notifyTo(config) || undefined }) : null,
      alertJorge('A paid booking needs your decision', ['This payment arrived for a time that overlaps another booking. In your studio, confirm it anyway or cancel and refund it, and let the client know.'], b, config)
    ]);
  } else if (outcome === 'refund') {
    let refundId = null;
    try { refundId = b.paymentIntent ? (await stripe.refund(b.paymentIntent, 'nl-refund-' + b.id)).id : null; } catch (e) { /* reported below */ }
    if (refundId) {
      await changeBooking(b.id, (x) => { x.refunded = true; x.refundId = refundId; });
      await Promise.all([
        b.client.email ? mail.send({ to: b.client.email, ...tpl.clientRefundedUnavailable(b, config), replyTo: notifyTo(config) || undefined }) : null,
        alertJorge('A late payment was refunded', ['A payment arrived for a booking that was already cancelled, so it was refunded automatically.'], b, config)
      ]);
    } else {
      await changeBooking(b.id, (x) => { x.refundFailed = true; });
      await alertJorge('Please refund this payment', ['A payment arrived for a booking that was already cancelled, and the automatic refund did not go through. Please refund it in Stripe.'], b, config);
    }
  } else if (outcome === 'kept') {
    await alertJorge('A payment arrived for a cancelled booking', ['You chose to keep the payment when you cancelled this booking. Refund it in Stripe if you change your mind.'], b, config);
  }
  return b;
}

/* A slow payment method (like a bank transfer) finished checkout: the time stays held while it clears. */
async function markProcessing(id, s) {
  let clash = false, changed = false;
  const b = await changeBooking(id, (x, list) => {
    changed = false; clash = false;
    if (x.status !== 'hold' && x.status !== 'expired') return NO_CHANGE;
    x.status = 'processing'; x.paymentIntent = s.payment_intent || x.paymentIntent; x.processingSince = Date.now(); delete x.holdUntil;
    clash = overlaps(x, list, Date.now());
    if (clash) x.clash = true;
    changed = true;
  });
  if (b && changed && clash) await alertJorge('A payment in progress overlaps another booking', ['This bank payment is still clearing, and its time overlaps another booking. It will wait for your decision once it clears.'], b);
  return b;
}

function invite(b, config) {
  const site = env('SITE_URL') || 'https://nowlovelife.com';
  return ics({ uid: b.id + '@nowlovelife.com', start: b.start, end: b.end, summary: withJorge(b.offeringName),
    description: 'Your private session with Jorge, Now & Love.\n' + config.location, location: config.location, url: site + '/book/' });
}
async function sendClientConfirmation(b, config) {
  if (!b.client || !b.client.email) return { ok: false, skipped: true };
  return mail.send({ to: b.client.email, ...tpl.clientConfirmed(b, config), replyTo: notifyTo(config) || undefined,
    attachments: [{ filename: 'now-and-love-session.ics', content: toBase64(invite(b, config)) }] });
}
async function sendConfirmations(b, config) {
  const to = notifyTo(config);
  const [c] = await Promise.all([
    sendClientConfirmation(b, config),
    to ? mail.send({ to, ...tpl.jorgeNewBooking(b, config), replyTo: (b.client && b.client.email) || undefined }) : null
  ]);
  if (c && c.ok === false && !c.skipped) await changeBooking(b.id, (x) => { x.mailFailed = true; }).catch(() => {});
}

/* Someone left Stripe's checkout. Close the checkout first; only a checkout Stripe confirms closed frees the time. */
async function postRelease(req) {
  const { id } = await readBody(req, 2000);
  const b = (await getBookings()).find((x) => x.id === clean(id, 40));
  if (!b || b.status !== 'hold') return json({ ok: true });
  if (b.stripeSession) {
    let s = null;
    try { s = await stripe.expireCheckout(b.stripeSession); } catch (e) { try { s = await stripe.getCheckout(b.stripeSession); } catch (e2) { /* settles later */ } }
    if (s) await applyCheckout(b.id, s);
    return json({ ok: true });
  }
  await changeBooking(b.id, (x) => { if (x.status !== 'hold') return NO_CHANGE; x.status = 'expired'; x.releasedAt = Date.now(); });
  return json({ ok: true });
}

async function getIcs(req, url) {
  const id = clean(url.searchParams.get('id'), 40);
  const b = (await getBookings()).find((x) => x.id === id && x.status === 'confirmed');
  if (!b) throw new HttpError(404, 'We could not find that booking.');
  return new Response(invite(b, await getConfig()), { headers: {
    'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="now-and-love-session.ics"', 'Cache-Control': 'no-store' } });
}

async function postMessage(req, url, context) {
  const b = await readBody(req);
  if (b.website) return json({ ok: true });
  const name = clean(b.name, 80), email = clean(b.email, 254).toLowerCase(), phone = clean(b.phone, 40), topic = clean(b.topic, 80), text = cleanText(b.message, 4000);
  if (name.length < 2) throw new HttpError(400, 'Please add your name.', { field: 'name' });
  if (!isEmail(email)) throw new HttpError(400, 'Please check your email address.', { field: 'email' });
  if (text.length < 2) throw new HttpError(400, 'Please write a few words for Jorge.', { field: 'message' });
  if (!(await auth.throttle('msg', ipOf(req, context), 6, 3600e3))) throw new HttpError(429, 'Too many messages from here. Please wait a little and try again.');
  const msg = { id: rid(9), name, email, phone, topic, text, createdAt: Date.now(), read: false };
  await update('messages', { list: [] }, (d) => { d.list.unshift(msg); if (d.list.length > 500) d.list.length = 500; });
  const config = await getConfig();
  const to = notifyTo(config);
  if (to) await mail.send({ to, ...tpl.jorgeMessage(msg), replyTo: email });
  return json({ ok: true });
}

async function postWebhook(req) {
  const raw = await req.text();
  if (!(await stripe.verifySignature(raw, req.headers.get('stripe-signature'), env('STRIPE_WEBHOOK_SECRET')))) {
    return json({ error: 'Invalid signature' }, 400);
  }
  let ev;
  try { ev = JSON.parse(raw); } catch (e) { return json({ error: 'Invalid payload' }, 400); }
  const o = (ev.data && ev.data.object) || {};
  const type = String(ev.type || '');
  if (type.startsWith('checkout.session.')) {
    const id = o.metadata && o.metadata.bookingId;
    if (!id) return json({ received: true });     // not a booking checkout
    const b = (await getBookings()).find((x) => x.id === id);
    if (!b) {
      if (type === 'checkout.session.completed' && o.payment_status === 'paid') {
        await alertJorge('A payment arrived for a booking that is not on file', ['Stripe checkout ' + o.id + ' paid ' + money(o.amount_total) + ' from '
          + ((o.customer_details && o.customer_details.email) || o.customer_email || 'an unknown email') + '. Please find it in Stripe and refund it or arrange a time.'], null);
      }
      return json({ received: true });
    }
    if (type === 'checkout.session.async_payment_failed') {
      if (o.id === b.stripeSession) {
        await changeBooking(id, (x) => {
          if (!['hold', 'expired', 'processing'].includes(x.status)) return NO_CHANGE;
          x.status = 'cancelled'; x.cancelledAt = Date.now(); x.cancelReason = 'The payment did not go through'; x.paymentFailed = true; delete x.holdUntil;
        });
      }
    } else {
      await applyCheckout(id, o);
    }
  } else if (type === 'charge.refunded' && o.payment_intent) {
    // A refund made in the Stripe dashboard frees the time in the studio too.
    const full = o.refunded === true || (o.amount != null && o.amount_refunded >= o.amount);
    await changeByIntent(o.payment_intent, (x) => {
      if (!full) { if (x.amountRefunded === o.amount_refunded) return NO_CHANGE; x.amountRefunded = o.amount_refunded; return; }
      if (x.refunded && x.status === 'cancelled') return NO_CHANGE;
      x.refunded = true; x.amountRefunded = o.amount_refunded;
      if (x.status !== 'cancelled') { x.status = 'cancelled'; x.cancelledAt = Date.now(); x.cancelReason = 'Refunded in Stripe'; delete x.holdUntil; }
    });
  } else if (type === 'charge.dispute.created' && o.payment_intent) {
    let first = false;
    const b = await changeByIntent(o.payment_intent, (x) => { first = !x.disputed; if (!first) return NO_CHANGE; x.disputed = true; });
    if (b && first) await alertJorge('A client disputed a payment', ['A dispute was opened on this payment. Answer it in Stripe before its deadline.'], b);
  }
  return json({ received: true });
}

/* ---------- Jorge's back end ---------- */

async function adminLogin(req, url, context) {
  if (!auth.adminReady()) throw new HttpError(503, 'Set ADMIN_PASSWORD (12 characters or more) in Netlify to open the back end.');
  const { password } = await readBody(req, 2000);
  if (!(await auth.throttle('login', ipOf(req, context), 8, 15 * 60e3))) throw new HttpError(429, 'Too many tries. Please wait 15 minutes and try again.');
  if (!(await auth.passwordOk(password))) throw new HttpError(401, 'That password is not right.');
  const tok = await auth.makeToken(7);
  return json({ ok: true, ...(DEMO ? { token: tok } : {}) }, 200, { 'Set-Cookie': auth.sessionCookie(req, tok, 7 * 86400) });
}

async function adminLogout(req) {
  try { await auth.endSessions(req); } catch (e) { /* the cookie is cleared either way */ }
  return json({ ok: true }, 200, { 'Set-Cookie': auth.sessionCookie(req, '', 0) });
}

async function adminData(req) {
  await auth.requireAdmin(req);
  let bookings = await getBookings();
  if (await resolveLapsed(bookings)) bookings = await getBookings();
  const [config, offerings, msgs] = await Promise.all([getConfig(), getOfferings(), read('messages', { list: [] })]);
  const now = Date.now();
  return json({
    config, offerings, now,
    bookings: bookings.filter((b) => b.status !== 'expired' && !(b.status === 'hold' && b.holdUntil <= now && !b.stripeSession)).sort((a, b) => a.start - b.start),
    messages: msgs.data.list || [],
    setup: { payments: stripe.mode(), webhook: DEMO || !!env('STRIPE_WEBHOOK_SECRET'), email: mail.mailReady(), from: mail.fromAddress(), notify: notifyTo(config) || '' }
  });
}

const int = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const pick = (v, allowed, def) => (allowed.includes(Number(v)) ? Number(v) : def);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';

function validateConfig(x) {
  if (!validTZ(x.timezone)) throw new HttpError(400, 'Please choose a valid time zone.');
  const c = { timezone: x.timezone, weekly: {} };
  for (let d = 0; d < 7; d++) {
    const ranges = Array.isArray(x.weekly && x.weekly[d]) ? x.weekly[d] : [];
    if (ranges.length > 4) throw new HttpError(400, 'Up to four time ranges per day.');
    c.weekly[d] = ranges.map((r) => {
      const a = hm(r && r[0]), e = hm(r && r[1]);
      if (a == null || e == null || e <= a) throw new HttpError(400, 'Each time range needs a start before its end.');
      return [String(r[0]), String(r[1])];
    });
  }
  c.stepMinutes = pick(x.stepMinutes, [15, 20, 30, 45, 60, 90, 120], 60);
  c.bufferMinutes = int(x.bufferMinutes, 0, 240, 0);
  c.minNoticeHours = int(x.minNoticeHours, 0, 720, 24);
  c.maxDaysAhead = int(x.maxDaysAhead, 1, 365, 60);
  c.maxPerDay = int(x.maxPerDay, 0, 24, 0);
  c.blocked = [...new Set((Array.isArray(x.blocked) ? x.blocked : []).filter((k) => parseDay(k)))].sort().slice(0, 500);
  c.extra = (Array.isArray(x.extra) ? x.extra : []).slice(0, 200).map((e) => {
    const a = hm(e && e.start), z = hm(e && e.end);
    if (!parseDay(e && e.date) || a == null || z == null || z <= a) throw new HttpError(400, 'Each extra opening needs a date and a start before its end.');
    return { date: e.date, start: e.start, end: e.end };
  });
  c.location = cleanText(x.location, 600) || DEFAULT_CONFIG.location;
  c.policy = cleanText(x.policy, 800);
  const ne = clean(x.notifyEmail, 254).toLowerCase();
  if (ne && !isEmail(ne)) throw new HttpError(400, 'Please check the email for booking alerts.');
  c.notifyEmail = ne;
  return c;
}

async function adminConfig(req) {
  await auth.requireAdmin(req, true);
  const c = validateConfig((await readBody(req, 60000)).config || {});
  await update('config', DEFAULT_CONFIG, (d) => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, c); });
  return json({ ok: true, config: c });
}

async function adminOfferings(req) {
  await auth.requireAdmin(req, true);
  const list = (await readBody(req, 40000)).offerings;
  if (!Array.isArray(list) || !list.length || list.length > 12) throw new HttpError(400, 'Keep between 1 and 12 sessions.');
  const seen = new Set();
  const out = list.map((o) => {
    const name = clean(o && o.name, 80);
    if (name.length < 2) throw new HttpError(400, 'Every session needs a name.');
    const minutes = int(o.minutes, 15, 600, 60);
    if (minutes % 5) throw new HttpError(400, 'Session lengths go in steps of 5 minutes.');
    const priceCents = Math.round(Number(o.priceCents));
    if (!Number.isFinite(priceCents) || priceCents < 0 || priceCents > 5000000 || (priceCents > 0 && priceCents < 100)) {
      throw new HttpError(400, 'Each price must be $0 (free) or between $1 and $50,000.');
    }
    let id = clean(o.id, 60).toLowerCase().replace(/[^a-z0-9-]/g, '') || slug(name);
    while (seen.has(id)) id = slug(name) + '-' + Math.random().toString(36).slice(2, 6);
    seen.add(id);
    return { id, name, description: cleanText(o.description, 500), minutes, priceCents, active: o.active !== false };
  });
  if (!out.some((o) => o.active)) throw new HttpError(400, 'Keep at least one session visible.');
  await update('offerings', { list: DEFAULT_OFFERINGS }, (d) => { d.list = out; });
  return json({ ok: true, offerings: out });
}

async function adminCancel(req) {
  await auth.requireAdmin(req, true);
  const x = await readBody(req, 2000);
  const id = clean(x.id, 40);
  const before = (await getBookings()).find((b) => b.id === id);
  if (!before) throw new HttpError(404, 'We could not find that booking.');
  if (before.status === 'cancelled' || before.status === 'expired') throw new HttpError(409, 'That booking is already closed.');
  if (before.status === 'hold' && before.stripeSession) {
    // Close the checkout first. If the client already paid, the booking is settled instead of cancelled blindly.
    let s = null;
    try { s = await stripe.expireCheckout(before.stripeSession); } catch (e) { try { s = await stripe.getCheckout(before.stripeSession); } catch (e2) { /* reported below */ } }
    if (!s) throw new HttpError(502, 'Stripe did not answer, so the checkout is still open. Please try again in a moment.');
    if (s.status === 'complete') {
      await applyCheckout(id, s);
      throw new HttpError(409, 'The client finished paying just now, so this booking is now confirmed. Cancel it again if you still want to.', { code: 'paid' });
    }
  }
  const wantsRefund = !!x.refund;
  let refundId = null, pending = false;
  if (wantsRefund && before.payment === 'stripe' && before.paymentIntent && !before.refunded && ['confirmed', 'processing', 'review'].includes(before.status)) {
    try { refundId = (await stripe.refund(before.paymentIntent, 'nl-refund-' + id)).id; }
    catch (e) { if (before.status === 'processing') pending = true; else throw e; }
  }
  const b = await changeBooking(id, (bk) => {
    if (bk.status === 'cancelled' || bk.status === 'expired') return NO_CHANGE;
    const paying = ['confirmed', 'processing', 'review'].includes(bk.status);
    bk.status = 'cancelled'; bk.cancelledAt = Date.now(); bk.cancelledBy = 'jorge'; delete bk.holdUntil;
    if (refundId) { bk.refunded = true; bk.refundId = refundId; }
    if (paying && !wantsRefund) bk.keepPayment = true;
  });
  if (x.notify && b && b.client && b.client.email && before.status !== 'hold') {
    const config = await getConfig();
    await mail.send({ to: b.client.email, ...tpl.clientCancelled(b, config, !!refundId), replyTo: notifyTo(config) || undefined });
  }
  return json({ ok: true, refunded: !!refundId, refundPending: pending, booking: b });
}

/* A paid booking that overlaps another: Jorge keeps both. */
async function adminConfirm(req) {
  await auth.requireAdmin(req, true);
  const id = clean((await readBody(req, 2000)).id, 40);
  let changed = false;
  const b = await changeBooking(id, (x) => { changed = false; if (x.status !== 'review') return NO_CHANGE; x.status = 'confirmed'; x.confirmedAt = Date.now(); changed = true; });
  if (!b) throw new HttpError(404, 'We could not find that booking.');
  if (!changed) throw new HttpError(409, 'Only bookings waiting for your decision can be confirmed here.');
  const r = await sendClientConfirmation(b, await getConfig());
  return json({ ok: true, emailed: !!(r && r.ok) });
}

/* A pay-later booking that Jorge has been paid for outside the site. */
async function adminPaid(req) {
  await auth.requireAdmin(req, true);
  const id = clean((await readBody(req, 2000)).id, 40);
  const b = await changeBooking(id, (x) => { if (x.payment !== 'later') return NO_CHANGE; x.payment = 'manual'; x.amountPaid = x.priceCents; x.paidAt = Date.now(); });
  if (!b) throw new HttpError(404, 'We could not find that booking.');
  return json({ ok: true });
}

async function adminResend(req) {
  await auth.requireAdmin(req, true);
  const id = clean((await readBody(req, 2000)).id, 40);
  const b = (await getBookings()).find((x) => x.id === id && x.status === 'confirmed');
  if (!b) throw new HttpError(404, 'We could not find that confirmed booking.');
  if (!b.client.email) throw new HttpError(400, 'This booking has no email address.');
  const r = await sendClientConfirmation(b, await getConfig());
  if (!r || !r.ok) throw new HttpError(502, r && r.skipped ? 'Email sending is not set up yet.' : 'The email service did not take it. Please try again.');
  await changeBooking(b.id, (x) => { if (!x.mailFailed) return NO_CHANGE; delete x.mailFailed; });
  return json({ ok: true });
}

async function adminManual(req) {
  await auth.requireAdmin(req, true);
  const x = await readBody(req, 8000);
  const [config, offerings] = await Promise.all([getConfig(), getOfferings()]);
  const offering = offerings.find((o) => o.id === x.offering);
  if (!offering) throw new HttpError(400, 'Choose a session.');
  const day = parseDay(x.date), t = hm(x.time);
  if (!day || t == null || t >= 1440) throw new HttpError(400, 'Choose a date and a time.');
  const email = clean(x.email, 254).toLowerCase();
  if (email && !isEmail(email)) throw new HttpError(400, 'Please check the email address.');
  const start = zoned(config.timezone, day.y, day.m, day.d, Math.floor(t / 60), t % 60);
  const minutes = offering.minutes;
  const amount = x.amountCents === '' || x.amountCents == null ? offering.priceCents : int(x.amountCents, 0, 5000000, offering.priceCents);
  const now = Date.now();
  const booking = {
    id: rid(15), status: 'confirmed', offeringId: offering.id, offeringName: offering.name, minutes, priceCents: offering.priceCents, amountPaid: amount,
    start, end: start + minutes * 60e3, createdAt: now, confirmedAt: now, payment: 'manual',
    client: { name: clean(x.name, 80) || 'Private time', email, phone: clean(x.phone, 40), intention: '' }, note: cleanText(x.note, 1000)
  };
  await update('bookings', { list: [] }, (d) => {
    if (overlaps(booking, d.list, Date.now()) && !x.force) throw new HttpError(409, 'That time overlaps another booking. Pick another time, or choose to book it anyway.', { code: 'overlap' });
    d.list.push(booking);
  });
  if (x.notify && email) await sendClientConfirmation(booking, config);
  return json({ ok: true, booking });
}

async function adminNote(req) {
  await auth.requireAdmin(req, true);
  const x = await readBody(req, 4000);
  const b = await changeBooking(clean(x.id, 40), (bk) => { bk.note = cleanText(x.note, 1000); });
  if (!b) throw new HttpError(404, 'We could not find that booking.');
  return json({ ok: true });
}

async function adminMessages(req) {
  await auth.requireAdmin(req, true);
  const x = await readBody(req, 2000);
  const id = clean(x.id, 40);
  await update('messages', { list: [] }, (d) => {
    const i = d.list.findIndex((m) => m.id === id);
    if (i < 0) return NO_CHANGE;
    if (x.action === 'delete') d.list.splice(i, 1);
    else d.list[i].read = x.action !== 'unread';
  });
  return json({ ok: true });
}

async function adminExport(req) {
  await auth.requireAdmin(req);
  const [config, bookings] = await Promise.all([getConfig(), getBookings()]);
  const tz = config.timezone;
  const cell = (v) => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [['Date', 'Start', 'End', 'Session', 'Client', 'Email', 'Phone', 'Status', 'Paid', 'How paid', 'Refunded', 'Booked on']];
  for (const b of bookings.filter((x) => ['confirmed', 'processing', 'review', 'cancelled'].includes(x.status)).sort((a, z) => a.start - z.start)) {
    rows.push([fmtDay(tz, b.start), fmtTime(tz, b.start), fmtTime(tz, b.end, true), b.offeringName, b.client.name, b.client.email, b.client.phone,
      b.status, money(b.amountPaid != null ? b.amountPaid : 0), b.payment, b.refunded ? 'yes' : '', new Date(b.createdAt).toISOString().slice(0, 10)]);
  }
  return new Response(rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n', { headers: {
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="now-and-love-bookings.csv"', 'Cache-Control': 'no-store' } });
}

/* The preview's pretend checkout. Unreachable on Netlify: DEMO is only ever true in the browser preview. */
async function demoPay(req) {
  if (!DEMO) throw new HttpError(404, 'Not found');
  const { session } = await readBody(req, 2000);
  const s = stripe.demoMarkPaid(clean(session, 80));
  if (!s) throw new HttpError(404, 'That demo checkout has closed. Please choose your time again.');
  const b = await applyCheckout(s.metadata.bookingId, s);
  return json({ ok: true, id: b && b.id });
}

const ROUTES = {
  'GET public': getPublic,
  'GET slots': getSlots,
  'POST book': postBook,
  'GET booking': getBooking,
  'POST booking/release': postRelease,
  'GET booking/ics': getIcs,
  'POST message': postMessage,
  'POST stripe-webhook': postWebhook,
  'POST admin/login': adminLogin,
  'POST admin/logout': adminLogout,
  'GET admin/data': adminData,
  'POST admin/config': adminConfig,
  'POST admin/offerings': adminOfferings,
  'POST admin/cancel': adminCancel,
  'POST admin/confirm': adminConfirm,
  'POST admin/resend': adminResend,
  'POST admin/paid': adminPaid,
  'POST admin/manual': adminManual,
  'POST admin/note': adminNote,
  'POST admin/messages': adminMessages,
  'GET admin/export': adminExport,
  'POST demo/pay': demoPay
};
