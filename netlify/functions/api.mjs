/* Now & Love private sessions: the whole back end in one Netlify Function, served at /api/*.

   Public:  GET  /api/public            sessions on offer, Jorge's time zone, where sessions happen
            GET  /api/slots             open start times for one session
            POST /api/book              hold a time and open Stripe Checkout
            GET  /api/booking           booking status after payment (confirms with Stripe if needed)
            POST /api/booking/release   give a held time back when someone leaves checkout
            GET  /api/booking/ics       calendar invite for a confirmed booking
            POST /api/message           message Jorge directly
            POST /api/stripe-webhook    payment confirmations from Stripe
   Jorge:   /api/admin/*                sign in, bookings, hours, sessions, messages, export */
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

/* Abandoned checkouts are noise after a couple of days. */
function prune(list, now) {
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if ((b.status === 'expired' || (b.status === 'hold' && b.holdUntil <= now)) && (b.createdAt || 0) < now - 2 * 864e5) list.splice(i, 1);
  }
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
  const [config, offerings, bookings] = await Promise.all([getConfig(), getOfferings(), getBookings()]);
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
  const start = Number(b.start);
  if (!Number.isFinite(start) || start % 60000 !== 0) throw new HttpError(400, 'Please choose a time.');

  const [config, offerings] = await Promise.all([getConfig(), getOfferings()]);
  const offering = offerings.find((o) => o.active && o.id === b.offering);
  if (!offering) throw new HttpError(404, 'That session is not available right now.');
  const paid = offering.priceCents > 0;
  if (paid && stripe.mode() === 'off') throw new HttpError(503, 'Online booking opens very soon. Please message Jorge and he will book you in.');
  if (!(await auth.throttle('book', ipOf(req, context), 12, 3600e3))) throw new HttpError(429, 'Too many booking attempts from here. Please wait a little and try again.');

  const now = Date.now(), id = rid(15);
  const booking = {
    id, status: 'hold', offeringId: offering.id, offeringName: offering.name, minutes: offering.minutes, priceCents: offering.priceCents,
    start, end: start + offering.minutes * 60e3, holdUntil: now + HOLD_MINUTES * 60e3, createdAt: now, payment: paid ? 'stripe' : 'free',
    client: { name, email, phone, intention }
  };
  const day = parts(config.timezone, start);
  await update('bookings', { list: [] }, (d) => {
    prune(d.list, now);
    const open = computeSlots({ config, offering, bookings: d.list, now, from: { y: day.y, m: day.m, d: day.d }, days: 1 });
    if (!open.includes(start)) throw new HttpError(409, 'That time was just taken. Please choose another.', { code: 'taken' });
    const waiting = d.list.filter((x) => x.status === 'hold' && x.holdUntil > now && x.client && x.client.email === email).length;
    if (waiting >= 3) throw new HttpError(429, 'You already have times waiting for payment. Please finish or release those first.');
    d.list.push(booking);
  });

  if (!paid) {
    await confirmBooking(id, { amount: 0 });
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
    await changeBooking(id, (x) => { if (x.status !== 'hold') return NO_CHANGE; x.status = 'expired'; });
    throw e;
  }
  await changeBooking(id, (x) => { x.stripeSession = session.id; });
  return json({ id, url: session.url });
}

function publicBooking(b, config) {
  return {
    id: b.id, status: b.status, offeringName: b.offeringName, minutes: b.minutes, priceCents: b.priceCents,
    amountPaid: b.amountPaid, start: b.start, end: b.end, timezone: config.timezone, location: config.location,
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

async function applyCheckout(id, s) {
  if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') {
    return confirmBooking(id, { paymentIntent: s.payment_intent, amount: s.amount_total });
  }
  if (s.status === 'complete') {   // a delayed payment method: keep the time while it clears
    return changeBooking(id, (x) => {
      if (x.status !== 'hold' && x.status !== 'expired') return NO_CHANGE;
      x.status = 'processing'; delete x.holdUntil;
    });
  }
  if (s.status === 'expired') return changeBooking(id, (x) => { if (x.status !== 'hold') return NO_CHANGE; x.status = 'expired'; });
  return null;
}

async function confirmBooking(id, pay) {
  let changed = false, conflict = false;
  const b = await changeBooking(id, (x, list) => {
    changed = false; conflict = false;
    if (x.status === 'confirmed') return NO_CHANGE;
    const now = Date.now();
    conflict = busyOf(list, now).some((o) => o.id !== x.id && x.start < o.end && x.end > o.start);
    x.status = 'confirmed'; x.confirmedAt = now; delete x.holdUntil;
    if (pay.paymentIntent) x.paymentIntent = pay.paymentIntent;
    x.amountPaid = pay.amount != null ? pay.amount : x.priceCents;
    if (conflict) x.conflict = true;
    changed = true;
  });
  if (b && changed) {
    const config = await getConfig();
    await Promise.all([sendClientConfirmation(b, config), sendJorgeAlert(b, config, conflict)]);
  }
  return b;
}

function invite(b, config) {
  const site = env('SITE_URL') || 'https://nowlovelife.com';
  return ics({ uid: b.id + '@nowlovelife.com', start: b.start, end: b.end, summary: withJorge(b.offeringName),
    description: 'Your private session with Jorge, Now & Love.\n' + config.location, location: config.location, url: site + '/book/' });
}
async function sendClientConfirmation(b, config) {
  if (!b.client || !b.client.email) return;
  const m = tpl.clientConfirmed(b, config);
  await mail.send({ to: b.client.email, ...m, replyTo: notifyTo(config) || undefined,
    attachments: [{ filename: 'now-and-love-session.ics', content: toBase64(invite(b, config)) }] });
}
async function sendJorgeAlert(b, config, conflict) {
  const to = notifyTo(config);
  if (!to) return;
  const m = tpl.jorgeNewBooking(b, config, conflict);
  await mail.send({ to, ...m, replyTo: (b.client && b.client.email) || undefined });
}

async function postRelease(req) {
  const { id } = await readBody(req, 2000);
  let sid = null;
  await changeBooking(clean(id, 40), (x) => {
    sid = null;
    if (x.status !== 'hold') return NO_CHANGE;
    x.status = 'expired'; x.releasedAt = Date.now(); sid = x.stripeSession || null;
  });
  if (sid) { try { await stripe.expireCheckout(sid); } catch (e) { /* already finished: the webhook settles it */ } }
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
  const j = tpl.jorgeMessage(msg), c = tpl.clientMessageReceived(msg);
  await Promise.all([
    to ? mail.send({ to, ...j, replyTo: email }) : null,
    mail.send({ to: email, ...c, replyTo: to || undefined })
  ]);
  return json({ ok: true });
}

async function postWebhook(req) {
  const raw = await req.text();
  if (!(await stripe.verifySignature(raw, req.headers.get('stripe-signature'), env('STRIPE_WEBHOOK_SECRET')))) {
    return json({ error: 'Invalid signature' }, 400);
  }
  let ev;
  try { ev = JSON.parse(raw); } catch (e) { return json({ error: 'Invalid payload' }, 400); }
  const s = (ev.data && ev.data.object) || {};
  const id = (s.metadata && s.metadata.bookingId) || s.client_reference_id;
  if (!id) return json({ received: true });
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') await applyCheckout(id, s);
  else if (ev.type === 'checkout.session.expired') await changeBooking(id, (x) => { if (x.status !== 'hold') return NO_CHANGE; x.status = 'expired'; });
  else if (ev.type === 'checkout.session.async_payment_failed') {
    await changeBooking(id, (x) => {
      if (x.status !== 'processing') return NO_CHANGE;
      x.status = 'cancelled'; x.cancelledAt = Date.now(); x.cancelReason = 'The payment did not go through';
    });
  }
  return json({ received: true });
}

/* ---------- Jorge's back end ---------- */

async function adminLogin(req, url, context) {
  if (!auth.adminReady()) throw new HttpError(503, 'Set ADMIN_PASSWORD (8 characters or more) in Netlify to open the back end.');
  const { password } = await readBody(req, 2000);
  if (!(await auth.throttle('login', ipOf(req, context), 8, 15 * 60e3))) throw new HttpError(429, 'Too many tries. Please wait 15 minutes and try again.');
  if (!(await auth.passwordOk(password))) throw new HttpError(401, 'That password is not right.');
  const tok = await auth.makeToken(7);
  return json({ ok: true, ...(DEMO ? { token: tok } : {}) }, 200, { 'Set-Cookie': auth.sessionCookie(req, tok, 7 * 86400) });
}

async function adminLogout(req) {
  return json({ ok: true }, 200, { 'Set-Cookie': auth.sessionCookie(req, '', 0) });
}

async function adminData(req) {
  await auth.requireAdmin(req);
  const [config, offerings, bookings, msgs] = await Promise.all([getConfig(), getOfferings(), getBookings(), read('messages', { list: [] })]);
  const now = Date.now();
  return json({
    config, offerings, now,
    bookings: bookings.filter((b) => b.status !== 'expired' && !(b.status === 'hold' && b.holdUntil <= now)).sort((a, b) => a.start - b.start),
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
  if (before.status === 'cancelled') throw new HttpError(409, 'That booking is already cancelled.');
  let refundId = null;
  if (x.refund && before.payment === 'stripe' && before.paymentIntent && !before.refunded && ['confirmed', 'processing'].includes(before.status)) {
    refundId = (await stripe.refund(before.paymentIntent, 'nl-refund-' + id)).id;
  }
  let sid = null;
  const b = await changeBooking(id, (bk) => {
    sid = null;
    if (bk.status === 'cancelled') return NO_CHANGE;
    if (bk.status === 'hold') sid = bk.stripeSession || null;
    bk.status = 'cancelled'; bk.cancelledAt = Date.now(); bk.cancelledBy = 'jorge'; delete bk.holdUntil;
    if (refundId) { bk.refunded = true; bk.refundId = refundId; }
  });
  if (sid) { try { await stripe.expireCheckout(sid); } catch (e) { /* already closed */ } }
  if (x.notify && b && b.client && b.client.email && before.status !== 'hold') {
    const config = await getConfig();
    await mail.send({ to: b.client.email, ...tpl.clientCancelled(b, config, !!refundId), replyTo: notifyTo(config) || undefined });
  }
  return json({ ok: true, refunded: !!refundId, booking: b });
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
    const clash = busyOf(d.list, Date.now()).some((o) => booking.start < o.end && booking.end > o.start);
    if (clash && !x.force) throw new HttpError(409, 'That time overlaps another booking. Pick another time, or choose to book it anyway.', { code: 'overlap' });
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
  for (const b of bookings.filter((x) => ['confirmed', 'processing', 'cancelled'].includes(x.status)).sort((a, z) => a.start - z.start)) {
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
  const b = await confirmBooking(s.metadata.bookingId, { paymentIntent: s.payment_intent, amount: s.amount_total });
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
  'POST admin/manual': adminManual,
  'POST admin/note': adminNote,
  'POST admin/messages': adminMessages,
  'GET admin/export': adminExport,
  'POST demo/pay': demoPay
};
