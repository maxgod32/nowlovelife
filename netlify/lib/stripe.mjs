/* Stripe through its REST API (no SDK), so nothing needs installing. Checkout Sessions take the payment on
   Stripe's own secure page; webhooks are verified with the signing secret. */
import { env, DEMO } from './env.mjs';
import { HttpError, hmac, safeEqual, rid } from './util.mjs';

export function mode() {
  if (DEMO) return 'demo';
  const k = env('STRIPE_SECRET_KEY');
  if (!k) return 'off';
  return /^(sk|rk)_live_/.test(k) ? 'live' : 'test';
}

function encode(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out;
}

/* The preview has no Stripe: it pretends, and the page shows a clearly marked demo checkout. */
const demoSessions = new Map();
function demo(method, path, params) {
  if (path === '/v1/checkout/sessions') {
    const s = { id: 'cs_demo_' + rid(9), url: '#demo-pay', status: 'open', payment_status: 'unpaid', amount_total: params.line_items[0].price_data.unit_amount, metadata: params.metadata };
    s.url = '#demo-pay=' + s.id;
    demoSessions.set(s.id, s);
    return s;
  }
  if (path.startsWith('/v1/checkout/sessions/')) {
    const id = decodeURIComponent(path.split('/')[4]);
    const s = demoSessions.get(id) || { id, status: 'expired', payment_status: 'unpaid' };
    if (path.endsWith('/expire')) s.status = 'expired';
    return s;
  }
  if (path === '/v1/refunds') return { id: 're_demo_' + rid(6), status: 'succeeded' };
  throw new HttpError(500, 'Unknown demo call');
}
export function demoMarkPaid(id) {
  const s = demoSessions.get(id);
  if (s) { s.status = 'complete'; s.payment_status = 'paid'; s.payment_intent = 'pi_demo_' + rid(6); }
  return s;
}

async function call(method, path, params, idem) {
  if (DEMO) return demo(method, path, params);
  const key = env('STRIPE_SECRET_KEY');
  if (!key) throw new HttpError(503, 'Online payments are not switched on yet. Please message Jorge to book.');
  const headers = { Authorization: 'Bearer ' + key };
  let body;
  if (method !== 'GET') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = encode(params || {}, '', []).join('&'); }
  if (idem) headers['Idempotency-Key'] = idem;
  let res, data = {};
  try {
    res = await fetch((env('STRIPE_API_BASE') || 'https://api.stripe.com') + path, { method, headers, body });
    data = await res.json();
  } catch (e) {
    console.error('stripe unreachable', e);
    throw new HttpError(502, 'The payment service did not answer. Please try again in a moment.');
  }
  if (!res.ok) {
    console.error('stripe error', res.status, data && data.error && data.error.message);
    const err = new HttpError(502, 'The payment service could not complete that. Please try again in a moment.');
    err.stripe = data && data.error;
    throw err;
  }
  return data;
}

export const createCheckout = (params, idem) => call('POST', '/v1/checkout/sessions', params, idem);
export const getCheckout = (id) => call('GET', '/v1/checkout/sessions/' + encodeURIComponent(id));
export const expireCheckout = (id) => call('POST', '/v1/checkout/sessions/' + encodeURIComponent(id) + '/expire', {});
export const refund = (paymentIntent, idem) => call('POST', '/v1/refunds', { payment_intent: paymentIntent, reason: 'requested_by_customer' }, idem);

/* Stripe-Signature: t=<unix>,v1=<hex hmac of "t.payload">. */
export async function verifySignature(raw, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  let t = null; const sigs = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  }
  if (!t || !sigs.length || !/^\d+$/.test(t) || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = await hmac(secret, t + '.' + raw, true);
  return sigs.some((s) => safeEqual(s, expected));
}
