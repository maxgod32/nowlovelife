/* Now & Love members: The Circle. Accounts, Stripe subscriptions, the community, the classroom, the calendar
   and the leaderboard, all behind /api/portal/* (members) and /api/admin/portal/* (Jorge's studio).

   Storage is its own Netlify Blobs store, a handful of JSON documents, every change a read-modify-write guarded
   by the document's ETag so two members can never overwrite each other:
     config            tiers, prices, categories, level names (Jorge edits them; defaults below until he does)
     m/<id>            one member: profile, password hash, plan, progress
     e/<sha(email)>    email -> member id (created only-if-new, so one email is one member)
     c/<customer>      Stripe customer -> member id
     members           the member index Jorge's studio lists
     feed, p/<id>      community post summaries, and each post with its comments and likes
     courses           the classroom: courses -> modules -> lessons
     events            live gatherings
     board             points per member, total and per day (the leaderboard and levels)
     stripe            Stripe product and billing-portal ids, kept apart for test and live keys

   Locked content never leaves the server: a lesson's video and text, and an event's link, are only sent to
   members whose tier (and level) opens them. */
import { getStore } from '@netlify/blobs';
import { env } from './env.mjs';
import { HttpError, json, readBody, clean, cleanText, isEmail, rid, sha256, hmac, safeEqual, b64url, b64urlDecode, ipOf, sleep } from './util.mjs';
import * as stripe from './stripe.mjs';
import { throttle, requireAdmin } from './auth.mjs';
import { ics } from './ics.mjs';
import * as mail from './mail.mjs';
import * as mtpl from './member-emails.mjs';
import { read as readBooking } from './store.mjs';

/* ---------- storage ---------- */

const NO_CHANGE = Symbol('no-change');
let S = null;
const db = () => S || (S = getStore({ name: 'nowlove-members', consistency: 'strong' }));
const clone = (v) => JSON.parse(JSON.stringify(v));

async function get(key, fallback) {
  const r = await db().getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (!r || r.data == null) return { data: fallback === undefined ? null : clone(fallback), etag: null };
  return { data: r.data, etag: r.etag };
}
async function upd(key, fallback, fn) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data, etag } = await get(key, fallback);
    const out = await fn(data);
    if (out === NO_CHANGE) return { data, out, written: false };
    const res = await db().setJSON(key, data, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (!res || typeof res.modified !== 'boolean') throw new Error('Netlify Blobs conditional writes are unavailable: update @netlify/blobs');
    if (res.modified) return { data, out, written: true };
    await sleep(20 + Math.random() * 50 * (attempt + 1));
  }
  throw new HttpError(503, 'The Circle is busy right now. Please try again in a moment.');
}

/* ---------- defaults Jorge can change ---------- */

export const DEFAULT_TIERS = [
  { id: 'circle', name: 'The Circle', tag: 'Base membership', monthly: 3300, yearly: 33000, color: '#4df2a4',
    blurb: 'The community, the live gatherings, the daily practice and the foundational teachings.',
    perks: ['The Circle community', 'Weekly live gatherings', 'The daily practice', 'Foundational teachings', 'The Enlighten Method and Infinite Peace journeys'] },
  { id: 'path', name: 'The Sacred Path', tag: 'Deeper', monthly: 7700, yearly: 77000, color: '#c58cff', featured: true,
    blurb: 'Everything in the Circle, plus every sacred journey and the Path teachings.',
    perks: ['Everything in The Circle', 'All six sacred journeys', 'The Sacred Path teachings', 'Replays of every gathering'] },
  { id: 'temple', name: 'The Inner Temple', tag: 'Advanced', monthly: 14400, yearly: 144000, color: '#ff6ad5',
    blurb: 'The advanced vault. The deepest teachings of the Method, and every masterclass.',
    perks: ['Everything in The Sacred Path', 'The advanced Inner Temple vault', 'Every masterclass included', 'Monthly live temple transmission'] },
  { id: 'guided', name: 'The Guided Path', tag: 'One-on-one', monthly: 33300, yearly: 333000, color: '#4dc8ff',
    blurb: 'Everything in the Inner Temple, plus two private tutoring sessions with a Now & Love guide every month.',
    perks: ['Everything in The Inner Temple', 'Two 1:1 tutoring sessions a month', 'A personal practice plan', 'Two entries in the monthly giveaway'] },
  { id: 'inner', name: 'The Inner Circle', tag: 'Closest to Jorge', monthly: 77700, yearly: 777000, color: '#ffd84d',
    blurb: 'Everything in the Guided Path, plus the monthly gathering in person and a small monthly circle with Jorge.',
    perks: ['Everything in The Guided Path', 'The monthly gathering, in person', 'A small monthly circle with Jorge', 'Three giveaway entries and first access to getaways and retreats'] }
];
export const DEFAULT_CATEGORIES = [
  { id: 'announcements', name: 'Announcements', color: '#ffd84d', hostOnly: true },
  { id: 'practice', name: 'Daily practice', color: '#c58cff' },
  { id: 'wins', name: 'Wins & gratitude', color: '#4df2a4' },
  { id: 'creators', name: 'Creators', color: '#7a6bff' },
  { id: 'union', name: 'Sacred union', color: '#ff6ad5' },
  { id: 'questions', name: 'Questions', color: '#4dc8ff' }
];
export const LEVELS = [0, 5, 20, 65, 155, 515, 2015, 8015, 33015];
export const DEFAULT_LEVEL_NAMES = ['Seed', 'Spark', 'Flame', 'Light', 'Radiance', 'Luminary', 'Sage', 'Master', 'Ascended'];
const DEFAULT_CONFIG = { tiers: DEFAULT_TIERS, categories: DEFAULT_CATEGORIES, levelNames: DEFAULT_LEVEL_NAMES, host: { name: 'Jorge Ramirez', title: 'Founder, The Enlighten Method' } };

const L = (t) => t.split('|').map((title, i) => ({ id: 'l' + (i + 1), title, minutes: 0, video: '', body: '', resources: [] }));
const course = (id, title, subtitle, desc, color, minTier, lessons, extra = {}) =>
  ({ id, title, subtitle, desc, color, minTier, minLevel: 0, published: true, modules: [{ id: 'm1', title: 'The journey', lessons: L(lessons) }], ...extra });
export const DEFAULT_COURSES = [
  course('enlighten', 'The Enlighten Method', '21 days · 15 min a day', 'Twenty-one days to learn the four sacred movements and make them part of you. Where every soul begins.', '#c58cff', 'circle',
    'Arrive in the Now|The sacred silence|Breath as prayer|The peace within|Opening the heart|Love is simultaneous|Integration: Now & Love|Your soul is a God clone|Divine nature anatomy|Seeing the loop|Breaking the loop|Healing the past|The gift of forgiveness|Integration: freedom|Create the feeling|Living from the end|Gratitude as frequency|Speaking it true|As above, so below|Your perfect world within|Evolve: the daily return'),
  course('peace', 'Infinite Peace', '7 days · 20 min a day', 'Seven mornings in the sacred silence. Breath, meditation and release, guided with love.', '#4dc8ff', 'circle',
    'Arriving|The breath|Releasing the day|The sacred silence|Stillness is instantaneous|Peace in motion|Living in peace'),
  course('creator', 'Creator of Reality', '6 weeks · weekly live', 'Learn to create from the feeling of it already done, one sacred choice at a time.', '#7a6bff', 'path',
    'You are the creator|Create the feeling|Energy before action|The field answers|Holding the frequency|Living it now'),
  course('happiness', 'Infinite Happiness', '4 weeks · 10 min a day', 'Remember that you are the source of happiness and love.', '#ffd84d', 'path',
    'The source is you|Gratitude|Lightness|Play|Joy without reason|Happiness as who you are'),
  course('union', 'Sacred Union', '6 weeks · small circle', 'Heal the old patterns, honor your worth and open to enlightened love.', '#4df2a4', 'path',
    'Love begins within|Healing old patterns|Honoring your worth|Calling in|Enlightened love|Sacred union'),
  course('chakra', 'Chakra Activation', '7 weeks · weekly live', 'One center each week, from root to crown. Clear, open and align your whole being of light.', '#ff5a6e', 'path',
    'Root: I am|Sacral: I feel|Solar plexus: I do|Heart: I love|Throat: I speak|Third eye: I see|Crown: I understand'),
  course('temple', 'The Inner Temple Vault', 'Advanced transmissions', 'The deepest teachings of the Method: the 4D Now, the 5D Love and the divine nature anatomy.', '#ff6ad5', 'temple',
    'The 4D Now: stillness beyond time|The 5D Love: simultaneous connection|Divine nature anatomy, advanced|Your perfect world within'),
  course('masterclasses', 'Masterclasses', 'Included in the Inner Temple', 'Long-form masterclasses with Jorge.', '#ffd84d', 'temple',
    'Opening Your Akashic Records|Merkaba: Activating the Light Body|5D Love: Sacred Union Mastery')
];
const WELCOME = {
  id: 'welcome', cat: 'announcements', title: 'Welcome home to The Circle',
  body: 'Beloved soul, welcome. This is our sacred space: share your practice, your wins and your questions, and lift each other up.\n\nStart with The Enlighten Method in the Classroom, check the Calendar for this week\'s live gathering, and introduce yourself below.\n\nWith love,\nJorge',
  author: { id: 'host', name: 'Jorge Ramirez', color: '#ffd84d', host: true }, created: Date.UTC(2026, 10, 18, 15), pinned: true, likes: [], comments: []
};
const summaryOf = (p) => ({ id: p.id, cat: p.cat, title: p.title, excerpt: p.body.slice(0, 280), author: p.author, created: p.created, edited: p.edited || 0,
  pinned: !!p.pinned, likes: p.likes.length, comments: p.comments.length, last: p.last || p.created });
const DEFAULT_FEED = { list: [summaryOf(WELCOME)] };

async function config() {
  const { data } = await get('config', DEFAULT_CONFIG);
  return { ...clone(DEFAULT_CONFIG), ...data };
}
const tierIndex = (cfg, id) => cfg.tiers.findIndex((t) => t.id === id);
export const levelOf = (pts) => { let l = 1; for (let i = 0; i < LEVELS.length; i++) if ((pts || 0) >= LEVELS[i]) l = i + 1; return l; };
const ACTIVE = new Set(['active', 'trialing', 'past_due', 'comp']);
const isActive = (m) => !!m && !m.banned && ACTIVE.has(m.status);
function opens(cfg, m, minTier, minLevel, pts) {
  if (!isActive(m)) return false;
  if (minTier && tierIndex(cfg, m.tier) < tierIndex(cfg, minTier)) return false;
  if (minLevel && levelOf(pts) < minLevel) return false;
  return true;
}

/* ---------- passwords and sessions ---------- */

const te = new TextEncoder(), td = new TextDecoder();
const COOKIE = 'nl_member';
const ITER = 150000;
async function pbkdf2(pw, salt, iter) {
  const key = await crypto.subtle.importKey('raw', te.encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(salt), iterations: iter }, key, 256);
  return b64url(new Uint8Array(bits));
}
async function hashPassword(pw) { const salt = rid(16); return { salt, iter: ITER, hash: await pbkdf2(pw, salt, ITER) }; }
async function checkPassword(pw, rec) { return !!rec && safeEqual(await pbkdf2(pw, rec.salt, rec.iter || ITER), rec.hash); }
function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Please choose a password of at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return '';
}

async function secret() {
  if (env('SESSION_SECRET')) return 'm:' + env('SESSION_SECRET');
  let { data } = await get('auth', {});
  if (!data.secret) data = (await upd('auth', {}, (d) => { if (d.secret) return NO_CHANGE; d.secret = rid(32); })).data;
  return data.secret;
}
async function token(m, days = 30) {
  const payload = b64url(te.encode(JSON.stringify({ id: m.id, v: m.ver || 1, exp: Date.now() + days * 86400e3 })));
  return payload + '.' + await hmac(await secret(), payload);
}
function cookieOf(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return ''; } }
  }
  return '';
}
function setCookie(req, tok, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return COOKIE + '=' + (tok || '') + '; Path=/api/portal; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secure;
}
async function sessionMember(req) {
  const tok = cookieOf(req, COOKIE);
  if (!tok) return null;
  const [p, s] = tok.split('.');
  if (!p || !s || !safeEqual(s, await hmac(await secret(), p))) return null;
  let t; try { t = JSON.parse(td.decode(b64urlDecode(p))); } catch (e) { return null; }
  if (!t || t.exp < Date.now() || !/^[A-Za-z0-9_-]{6,40}$/.test(t.id || '')) return null;
  const { data: m } = await get('m/' + t.id);
  if (!m || (m.ver || 1) !== t.v || m.banned) return null;
  return m;
}
/* Changes must come from our own pages: a header other sites cannot send, and a matching Origin. */
function guard(req) {
  if (req.method === 'GET') return;
  if (req.headers.get('x-nl-portal') !== '1') throw new HttpError(403, 'That request was blocked.');
  const origin = req.headers.get('origin');
  if (origin && origin !== 'null' && origin !== new URL(req.url).origin) throw new HttpError(403, 'That request was blocked.');
}
async function need(req, { active = true } = {}) {
  const m = await sessionMember(req);
  if (!m) throw new HttpError(401, 'Please sign in.');
  if (active && !isActive(m)) throw new HttpError(402, 'Your membership is not active. Choose a membership to step back inside.');
  return m;
}

/* ---------- members ---------- */

const emailKey = async (email) => 'e/' + (await sha256('email:' + email.toLowerCase())).slice(0, 32);
const COLORS = ['#c58cff', '#4df2a4', '#ff6ad5', '#4dc8ff', '#ffd84d', '#7a6bff', '#ff9a4d'];
function indexRow(m) {
  return { id: m.id, name: m.name, email: m.email, tier: m.tier || '', interval: m.interval || '', status: m.status, created: m.created,
    periodEnd: m.periodEnd || 0, cancelAt: m.cancelAt || 0, banned: !!m.banned, comp: m.status === 'comp' };
}
async function saveIndex(m) {
  await upd('members', { list: [] }, (d) => {
    const row = indexRow(m), i = d.list.findIndex((x) => x.id === m.id);
    if (i >= 0) { if (JSON.stringify(d.list[i]) === JSON.stringify(row)) return NO_CHANGE; d.list[i] = row; } else d.list.push(row);
  });
}
async function changeMember(id, fn) {
  const r = await upd('m/' + id, null, (m) => { if (!m) return NO_CHANGE; return fn(m); });
  if (r.written) { await saveIndex(r.data); await syncBoardName(r.data); }
  return r.data;
}
function publicMember(m, cfg, board) {
  const b = (board && board.m && board.m[m.id]) || { t: 0 };
  const tier = cfg.tiers.find((t) => t.id === m.tier);
  return { id: m.id, name: m.name, email: m.email, bio: m.bio || '', color: m.color, joined: m.created,
    status: m.status, active: isActive(m), tier: m.tier || '', tierName: tier ? tier.name : '', interval: m.interval || '',
    periodEnd: m.periodEnd || 0, cancelAt: m.cancelAt || 0, billing: !!m.customer,
    points: b.t || 0, level: levelOf(b.t), progress: m.progress || {} };
}

/* ---------- points ---------- */

const today = () => new Date().toISOString().slice(0, 10);
async function addPoints(m, n) {
  if (!m || m.id === 'host' || !n) return;
  await upd('board', { m: {} }, (d) => {
    const r = d.m[m.id] || (d.m[m.id] = { n: m.name, c: m.color, t: 0, d: {} });
    r.t = Math.max(0, (r.t || 0) + n);
    const k = today(); r.d[k] = Math.max(0, (r.d[k] || 0) + n);
    const cut = new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10);
    for (const day of Object.keys(r.d)) if (day < cut) delete r.d[day];
  });
}
async function syncBoardName(m) {
  await upd('board', { m: {} }, (d) => {
    const r = d.m[m.id];
    if (!r || (r.n === m.name && r.c === m.color && !!r.x === !isActive(m))) return NO_CHANGE;
    r.n = m.name; r.c = m.color; r.x = !isActive(m);
  });
}

/* ---------- email ---------- */

const memberFrom = () => env('MEMBER_MAIL_FROM') || 'Now & Love <circle@nowlovelife.com>';
const siteUrl = () => (env('SITE_URL') || 'https://nowlovelife.com').replace(/\/+$/, '');
async function jorgeEmail() {
  try { const { data } = await readBooking('config', {}); return (data && data.notifyEmail) || env('NOTIFY_EMAIL'); } catch (e) { return env('NOTIFY_EMAIL'); }
}
/* The first time a member's access opens (paid or gifted), they get a welcome and Jorge gets a note. Only the request
   that marks the member as welcomed sends, so a webhook and a page load arriving together cannot send twice. */
async function welcomeOnce(m, origin) {
  if (!m || !isActive(m) || m.welcomed) return;
  const r = await upd('m/' + m.id, null, (x) => { if (!x || x.welcomed || !isActive(x)) return NO_CHANGE; x.welcomed = Date.now(); });
  if (!r.written) return;
  const cfg = await config();
  const tier = cfg.tiers.find((t) => t.id === r.data.tier);
  if (!tier) return;
  const gift = r.data.status === 'comp', jorge = await jorgeEmail();
  await mail.send({ to: r.data.email, from: memberFrom(), replyTo: jorge || undefined, ...mtpl.welcome(r.data, tier, origin || siteUrl(), gift) });
  if (jorge) await mail.send({ to: jorge, from: memberFrom(), replyTo: r.data.email, ...mtpl.jorgeNewMember(r.data, tier, r.data.interval, gift) });
}

/* ---------- Stripe: products, checkout, plan changes, billing ---------- */

const policyText = (site) => 'Memberships renew automatically until cancelled. All purchases are final. By joining you agree to the Now & Love Refund & Cancellation Policy: ' + site + '/refund-policy/';
async function stripeIds() { return (await get('stripe', {})).data; }
async function productFor(tier) {
  const mode = stripe.mode(), key = mode + ':' + tier.id;
  const ids = await stripeIds();
  if (ids[key]) return ids[key];
  const p = await stripe.api('POST', '/v1/products', { name: 'Now & Love · ' + tier.name, description: tier.blurb || undefined, metadata: { tier: tier.id, app: 'nowlove-members' } }, 'nl-prod-' + key);
  await upd('stripe', {}, (d) => { if (d[key]) return NO_CHANGE; d[key] = p.id; });
  return (await stripeIds())[key];
}
const priceOf = (tier, interval) => interval === 'year' ? tier.yearly : tier.monthly;

async function checkoutFor(m, tier, interval, origin) {
  const product = await productFor(tier);
  const s = await stripe.api('POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    customer: m.customer || undefined,
    customer_email: m.customer ? undefined : m.email,
    client_reference_id: m.id,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: priceOf(tier, interval), product, recurring: { interval } } }],
    metadata: { memberId: m.id, tier: tier.id, interval },
    subscription_data: { metadata: { memberId: m.id, tier: tier.id } },
    allow_promotion_codes: 'true',
    custom_text: { submit: { message: policyText(origin) } },
    success_url: origin + '/portal/?checkout={CHECKOUT_SESSION_ID}',
    cancel_url: origin + '/portal/?join=' + tier.id
  }, 'nl-join-' + m.id + '-' + rid(6));
  await changeMember(m.id, (x) => { x.pendingCheckout = s.id; x.wantTier = tier.id; x.wantInterval = interval; });
  return s.url;
}

const periodEndOf = (sub) => (sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || 0) * 1000;
/* Stripe is the source of truth: every event re-reads the subscription, so events arriving out of order cannot
   leave a member in the wrong state. */
async function syncSubscription(subId, hintMemberId, origin) {
  const sub = await stripe.api('GET', '/v1/subscriptions/' + encodeURIComponent(subId));
  let id = (sub.metadata && sub.metadata.memberId) || hintMemberId;
  if (!id && sub.customer) id = ((await get('c/' + sub.customer)).data || {}).id;
  if (!id) return null;
  const cfg = await config();
  const item = sub.items && sub.items.data && sub.items.data[0];
  const interval = item && item.price && item.price.recurring ? item.price.recurring.interval : '';
  const tierId = (sub.metadata && sub.metadata.tier) || '';
  const before = (await get('m/' + id)).data;
  if (!before) return null;
  if (before.subscription && before.subscription !== sub.id && ['canceled', 'incomplete_expired'].includes(sub.status)) return before; // an old subscription ending
  const m = await changeMember(id, (x) => {
    if (x.status === 'comp' && sub.status !== 'active') return NO_CHANGE;   // Jorge's gift stays until he changes it
    x.subscription = sub.id; x.customer = sub.customer || x.customer;
    x.status = sub.status === 'incomplete_expired' ? 'canceled' : sub.status;
    if (tierIndex(cfg, tierId) >= 0) x.tier = tierId;
    if (interval) x.interval = interval;
    x.periodEnd = periodEndOf(sub);
    x.cancelAt = sub.cancel_at_period_end ? x.periodEnd : (sub.cancel_at ? sub.cancel_at * 1000 : 0);
    x.updated = Date.now();
  });
  if (sub.customer) { const { data } = await get('c/' + sub.customer); if (!data || data.id !== id) await db().setJSON('c/' + sub.customer, { id }); }
  await welcomeOnce(m, origin);
  return m;
}

/* Called from the shared Stripe webhook. Returns true when the event was ours. */
export async function onStripeEvent(ev) {
  const o = (ev.data && ev.data.object) || {};
  const type = String(ev.type || '');
  if (type.startsWith('checkout.session.')) {
    if (!(o.metadata && o.metadata.memberId) || o.mode !== 'subscription') return false;
    if (o.subscription && (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded')) await syncSubscription(o.subscription, o.metadata.memberId);
    return true;
  }
  if (type.startsWith('customer.subscription.')) {
    if (o.metadata && o.metadata.app === 'bookings') return false;
    await syncSubscription(o.id, o.metadata && o.metadata.memberId);
    return true;
  }
  if (type === 'invoice.paid' || type === 'invoice.payment_failed' || type === 'invoice.payment_succeeded') {
    const subId = o.subscription || (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription);
    if (subId) await syncSubscription(subId);
    return !!subId;
  }
  return false;
}

async function portalConfigId(origin) {
  const mode = stripe.mode(), key = 'portal:' + mode;
  const ids = await stripeIds();
  if (ids[key]) return ids[key];
  const c = await stripe.api('POST', '/v1/billing_portal/configurations', {
    business_profile: { headline: 'Now & Love membership', terms_of_service_url: origin + '/refund-policy/', privacy_policy_url: origin + '/refund-policy/' },
    features: {
      invoice_history: { enabled: 'true' },
      payment_method_update: { enabled: 'true' },
      subscription_cancel: { enabled: 'true', mode: 'at_period_end', proration_behavior: 'none' }
    },
    default_return_url: origin + '/portal/#account'
  }, 'nl-portalcfg-' + mode);
  await upd('stripe', {}, (d) => { if (d[key]) return NO_CHANGE; d[key] = c.id; });
  return (await stripeIds())[key];
}

/* ---------- community ---------- */

const authorOf = (m) => ({ id: m.id, name: m.name, color: m.color });
const HOST = (cfg) => ({ id: 'host', name: cfg.host.name, color: '#ffd84d', host: true });
async function readPost(id) {
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id || '')) throw new HttpError(404, 'That post is gone.');
  const { data } = await get('p/' + id, id === 'welcome' ? WELCOME : undefined);
  if (!data || data.deleted) throw new HttpError(404, 'That post is gone.');
  return data;
}
async function changePost(id, fn) {
  const r = await upd('p/' + id, id === 'welcome' ? WELCOME : null, (p) => { if (!p || p.deleted) throw new HttpError(404, 'That post is gone.'); return fn(p); });
  if (r.written) await upd('feed', DEFAULT_FEED, (f) => {
    const i = f.list.findIndex((x) => x.id === id);
    if (r.data.deleted) { if (i < 0) return NO_CHANGE; f.list.splice(i, 1); return; }
    const s = summaryOf(r.data);
    if (i >= 0) f.list[i] = s; else f.list.unshift(s);
  });
  return r.data;
}
async function createPost(author, { cat, title, body, pinned }, cfg) {
  const c = cfg.categories.find((x) => x.id === cat) || cfg.categories.find((x) => !x.hostOnly);
  if (c.hostOnly && !author.host) throw new HttpError(403, 'Only Jorge can post there.');
  title = clean(title, 140); body = cleanText(body, 6000);
  if (title.length < 2) throw new HttpError(400, 'Give your post a title.', { field: 'title' });
  if (body.length < 2) throw new HttpError(400, 'Write a few words first.', { field: 'body' });
  const p = { id: rid(9), cat: c.id, title, body, author, created: Date.now(), pinned: !!pinned && !!author.host, likes: [], comments: [] };
  await db().setJSON('p/' + p.id, p, { onlyIfNew: true });
  await upd('feed', DEFAULT_FEED, (f) => { f.list.unshift(summaryOf(p)); if (f.list.length > 3000) f.list.length = 3000; });
  return p;
}
function viewPost(p, viewerId, board, cfg) {
  const lvl = (a) => a.host ? 0 : levelOf(((board.m || {})[a.id] || {}).t);
  return { id: p.id, cat: p.cat, title: p.title, body: p.body, created: p.created, edited: p.edited || 0, pinned: !!p.pinned,
    author: { ...p.author, level: lvl(p.author) }, likes: p.likes.length, liked: p.likes.includes(viewerId), mine: p.author.id === viewerId,
    comments: p.comments.map((c) => ({ id: c.id, body: c.body, created: c.created, author: { ...c.author, level: lvl(c.author) },
      likes: (c.likes || []).length, liked: (c.likes || []).includes(viewerId), mine: c.author.id === viewerId })) };
}

/* ---------- classroom and calendar ---------- */

async function courses() { return (await get('courses', { list: DEFAULT_COURSES })).data.list; }
async function events() { return (await get('events', { list: [] })).data.list; }
const lessonCount = (c) => c.modules.reduce((n, mo) => n + mo.lessons.length, 0);
function courseCard(c, m, cfg, pts) {
  const ids = c.modules.flatMap((mo) => mo.lessons.map((l) => c.id + '/' + l.id));
  const done = ids.filter((k) => m.progress && m.progress[k]).length;
  return { id: c.id, title: c.title, subtitle: c.subtitle, desc: c.desc, color: c.color, minTier: c.minTier, minLevel: c.minLevel || 0,
    open: opens(cfg, m, c.minTier, c.minLevel, pts), lessons: ids.length, done, ready: c.modules.reduce((n, mo) => n + mo.lessons.filter((l) => l.video || l.body).length, 0) };
}
function videoEmbed(url) {
  url = String(url || '').trim();
  let m;
  if ((m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,15})/))) return { kind: 'iframe', src: 'https://www.youtube-nocookie.com/embed/' + m[1] + '?rel=0&modestbranding=1' };
  if ((m = url.match(/vimeo\.com\/(?:video\/)?(\d{5,12})(?:\/([0-9a-f]{6,12}))?/))) return { kind: 'iframe', src: 'https://player.vimeo.com/video/' + m[1] + (m[2] ? '?h=' + m[2] : '') };
  if ((m = url.match(/loom\.com\/(?:share|embed)\/([0-9a-f]{20,40})/))) return { kind: 'iframe', src: 'https://www.loom.com/embed/' + m[1] };
  if ((m = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,80})/))) return { kind: 'iframe', src: 'https://drive.google.com/file/d/' + m[1] + '/preview' };
  if (/^https:\/\/[^\s"'<>]+\.(mp4|webm|m4v|mov)(\?[^\s"'<>]*)?$/i.test(url)) return { kind: 'video', src: url };
  if (/^https:\/\/[^\s"'<>]+\.(mp3|m4a|wav|ogg)(\?[^\s"'<>]*)?$/i.test(url)) return { kind: 'audio', src: url };
  return null;
}
const safeUrl = (u) => /^https:\/\/[^\s"'<>]{3,500}$/i.test(String(u || '').trim()) ? String(u).trim() : '';

/* ---------- member routes ---------- */

const ok = (data, headers) => json(data, 200, headers);
const originOf = (url) => url.origin;

async function getConfig(req) {
  const cfg = await config();
  const m = await sessionMember(req);
  return ok({ tiers: cfg.tiers.map((t) => ({ id: t.id, name: t.name, tag: t.tag, blurb: t.blurb, perks: t.perks, color: t.color, monthly: t.monthly, yearly: t.yearly, featured: !!t.featured })),
    categories: cfg.categories, levels: LEVELS, levelNames: cfg.levelNames, host: cfg.host, payments: stripe.mode() !== 'off', mode: stripe.mode(), mail: mail.mailReady(), signedIn: !!m });
}

async function postJoin(req, url, context) {
  const b = await readBody(req);
  if (b.website) throw new HttpError(400, 'We could not do that.');
  if (!(await throttle('join', ipOf(req, context), 8, 3600e3))) throw new HttpError(429, 'Too many tries. Please wait a little and try again.');
  const cfg = await config();
  const tier = cfg.tiers.find((t) => t.id === b.tier);
  const interval = b.interval === 'year' ? 'year' : 'month';
  if (!tier) throw new HttpError(400, 'Please choose a membership.');
  const name = clean(b.name, 60), email = clean(b.email, 254).toLowerCase();
  if (name.length < 2) throw new HttpError(400, 'Please add your name.', { field: 'name' });
  if (!isEmail(email)) throw new HttpError(400, 'Please check your email address.', { field: 'email' });
  if (stripe.mode() === 'off') throw new HttpError(503, 'Memberships open very soon. Please message Jorge to join.');
  const ekey = await emailKey(email);
  const existing = (await get(ekey)).data;
  let m;
  if (existing) {
    m = (await get('m/' + existing.id)).data;
    const signed = await sessionMember(req);
    if (m && isActive(m)) throw new HttpError(409, 'You are already a member. Please sign in.', { signin: true });
    if (!m) throw new HttpError(409, 'Please sign in.', { signin: true });
    // Someone who started joining and never paid, or whose membership ended, comes back with their password.
    if (!(signed && signed.id === m.id) && !(await checkPassword(b.password, m.pw))) throw new HttpError(409, 'That email already has an account. Please sign in with your password to continue.', { signin: true });
  } else {
    const problem = passwordProblem(b.password);
    if (problem) throw new HttpError(400, problem, { field: 'password' });
    m = { id: rid(12), email, name, bio: '', color: COLORS[Math.floor(Math.random() * COLORS.length)], pw: await hashPassword(b.password),
      created: Date.now(), status: 'pending', ver: 1, progress: {} };
    const res = await db().setJSON(ekey, { id: m.id }, { onlyIfNew: true });
    if (res && res.modified === false) throw new HttpError(409, 'That email already has an account. Please sign in.', { signin: true });
    await db().setJSON('m/' + m.id, m, { onlyIfNew: true });
    await saveIndex(m);
  }
  const checkout = await checkoutFor(m, tier, interval, originOf(url));
  return ok({ url: checkout }, { 'Set-Cookie': setCookie(req, await token(m), 30 * 86400) });
}

async function postLogin(req, url, context) {
  const b = await readBody(req);
  const email = clean(b.email, 254).toLowerCase();
  if (!(await throttle('mlogin', ipOf(req, context), 12, 900e3))) throw new HttpError(429, 'Too many tries. Please wait 15 minutes and try again.');
  const idx = isEmail(email) ? (await get(await emailKey(email))).data : null;
  const m = idx ? (await get('m/' + idx.id)).data : null;
  const good = m ? await checkPassword(b.password, m.pw) : (await pbkdf2(String(b.password || ''), 'x', ITER), false);
  if (!m || !good || m.banned) throw new HttpError(401, 'That email and password do not match.');
  return ok({ ok: true, active: isActive(m) }, { 'Set-Cookie': setCookie(req, await token(m), 30 * 86400) });
}

async function postLogout(req) {
  return ok({ ok: true }, { 'Set-Cookie': setCookie(req, '', 0) });
}

async function getMe(req, url) {
  let m = await sessionMember(req);
  if (!m) return ok({ signedIn: false });
  const sid = clean(url.searchParams.get('checkout'), 200);
  if (sid && sid === m.pendingCheckout && !isActive(m)) {
    try {
      const s = await stripe.api('GET', '/v1/checkout/sessions/' + encodeURIComponent(sid));
      if (s.status === 'complete' && s.subscription) m = (await syncSubscription(s.subscription, m.id, originOf(url))) || m;
    } catch (e) { /* the webhook settles it */ }
  }
  const [cfg, { data: board }] = await Promise.all([config(), get('board', { m: {} })]);
  return ok({ signedIn: true, me: publicMember(m, cfg, board), wantTier: m.wantTier || '', wantInterval: m.wantInterval || '' });
}

async function postProfile(req) {
  const m0 = await need(req, { active: false });
  const b = await readBody(req);
  const name = clean(b.name, 60), bio = cleanText(b.bio, 400), color = COLORS.includes(b.color) ? b.color : m0.color;
  if (name.length < 2) throw new HttpError(400, 'Please add your name.', { field: 'name' });
  await changeMember(m0.id, (x) => { x.name = name; x.bio = bio; x.color = color; });
  return ok({ ok: true });
}

async function postPassword(req, url, context) {
  const m0 = await need(req, { active: false });
  const b = await readBody(req);
  if (!(await throttle('mpw', ipOf(req, context), 10, 900e3))) throw new HttpError(429, 'Too many tries. Please wait a little.');
  if (!(await checkPassword(b.current, m0.pw))) throw new HttpError(400, 'Your current password is not right.', { field: 'current' });
  const problem = passwordProblem(b.next);
  if (problem) throw new HttpError(400, problem, { field: 'next' });
  const pw = await hashPassword(b.next);
  const m = await changeMember(m0.id, (x) => { x.pw = pw; x.ver = (x.ver || 1) + 1; });
  return ok({ ok: true }, { 'Set-Cookie': setCookie(req, await token(m), 30 * 86400) });
}

/* Forgotten password: a one-time link, valid for an hour, sent by email. The answer is the same whether or not the
   email has an account, so nobody can use this to find out who is a member. */
async function postForgot(req, url, context) {
  const b = await readBody(req);
  if (!(await throttle('forgot', ipOf(req, context), 6, 3600e3))) throw new HttpError(429, 'Too many tries. Please wait a little and try again.');
  if (!mail.mailReady()) return ok({ mail: false });
  const email = clean(b.email, 254).toLowerCase();
  const idx = isEmail(email) ? (await get(await emailKey(email))).data : null;
  const m0 = idx ? (await get('m/' + idx.id)).data : null;
  if (m0 && !m0.banned && (await throttle('forgot-m-' + m0.id, 'member', 3, 3600e3))) {
    const tok = rid(24), h = await sha256('reset:' + tok);
    await changeMember(m0.id, (x) => { x.reset = { h, exp: Date.now() + 3600e3 }; });
    await mail.send({ to: m0.email, from: memberFrom(), ...mtpl.reset(m0, originOf(url) + '/portal/#reset/' + m0.id + '/' + tok) });
  }
  return ok({ mail: true });
}
async function postReset(req, url, context) {
  const b = await readBody(req);
  if (!(await throttle('mreset', ipOf(req, context), 10, 3600e3))) throw new HttpError(429, 'Too many tries. Please wait a little and try again.');
  const id = clean(b.id, 40), tok = clean(b.token, 80);
  const problem = passwordProblem(b.password);
  if (problem) throw new HttpError(400, problem, { field: 'password' });
  const { data: m0 } = /^[A-Za-z0-9_-]{6,40}$/.test(id) ? await get('m/' + id) : { data: null };
  const h = await sha256('reset:' + tok);
  if (!m0 || m0.banned || !m0.reset || m0.reset.exp < Date.now() || !safeEqual(h, m0.reset.h)) throw new HttpError(400, 'This link has expired or was already used. Please ask for a new one.');
  const pw = await hashPassword(b.password);
  const m = await changeMember(id, (x) => { if (!x.reset || !safeEqual(h, x.reset.h)) throw new HttpError(400, 'This link was already used.'); x.pw = pw; x.ver = (x.ver || 1) + 1; delete x.reset; });
  return ok({ ok: true }, { 'Set-Cookie': setCookie(req, await token(m), 30 * 86400) });
}

async function postBilling(req, url) {
  const m = await need(req, { active: false });
  if (!m.customer) throw new HttpError(400, 'There is no billing to manage yet.');
  const origin = originOf(url);
  const s = await stripe.api('POST', '/v1/billing_portal/sessions', { customer: m.customer, return_url: origin + '/portal/#account', configuration: await portalConfigId(origin) });
  return ok({ url: s.url });
}

/* Change tier or monthly/yearly. A live subscription is changed in place (Stripe prorates the difference);
   otherwise this starts a new checkout. */
async function postPlan(req, url) {
  const m = await need(req, { active: false });
  const b = await readBody(req);
  const cfg = await config();
  const tier = cfg.tiers.find((t) => t.id === b.tier);
  const interval = b.interval === 'year' ? 'year' : 'month';
  if (!tier) throw new HttpError(400, 'Please choose a membership.');
  if (m.status === 'comp') throw new HttpError(400, 'Your membership is a gift from Jorge. Message him to change it.');
  const live = m.subscription && ['active', 'trialing', 'past_due'].includes(m.status);
  if (!live) return ok({ url: await checkoutFor(m, tier, interval, originOf(url)) });
  const sub = await stripe.api('GET', '/v1/subscriptions/' + encodeURIComponent(m.subscription));
  const item = sub.items.data[0];
  if (sub.metadata && sub.metadata.tier === tier.id && item.price.recurring.interval === interval) {
    if (sub.cancel_at_period_end) await stripe.api('POST', '/v1/subscriptions/' + sub.id, { cancel_at_period_end: 'false' });
  } else {
    await stripe.api('POST', '/v1/subscriptions/' + sub.id, {
      items: [{ id: item.id, price_data: { currency: 'usd', unit_amount: priceOf(tier, interval), product: await productFor(tier), recurring: { interval } } }],
      metadata: { memberId: m.id, tier: tier.id }, proration_behavior: 'create_prorations', cancel_at_period_end: 'false'
    }, 'nl-plan-' + m.id + '-' + tier.id + '-' + interval + '-' + rid(4));
  }
  await syncSubscription(sub.id, m.id);
  return ok({ ok: true });
}

async function getFeed(req, url) {
  const m = await need(req);
  const [{ data: feed }, { data: board }] = await Promise.all([get('feed', DEFAULT_FEED), get('board', { m: {} })]);
  const cat = clean(url.searchParams.get('cat'), 40);
  const before = Number(url.searchParams.get('before')) || Infinity;
  let list = feed.list.filter((p) => !cat || p.cat === cat);
  const pinned = before === Infinity ? list.filter((p) => p.pinned) : [];
  list = list.filter((p) => !p.pinned && p.created < before).slice(0, 20);
  const lvl = (a) => a.host ? 0 : levelOf(((board.m || {})[a.id] || {}).t);
  const out = [...pinned, ...list].map((p) => ({ ...p, author: { ...p.author, level: lvl(p.author) } }));
  return ok({ posts: out, more: list.length === 20 ? list[list.length - 1].created : 0, me: m.id });
}
async function getPost(req, url) {
  const m = await need(req);
  const p = await readPost(clean(url.searchParams.get('id'), 40));
  const [{ data: board }, cfg] = await Promise.all([get('board', { m: {} }), config()]);
  return ok({ post: viewPost(p, m.id, board, cfg) });
}
async function postPost(req) {
  const m = await need(req);
  const b = await readBody(req, 20000);
  if (!(await throttle('post-' + m.id, 'member', 12, 3600e3))) throw new HttpError(429, 'You have posted a lot this hour. Take a breath and come back soon.');
  const p = await createPost(authorOf(m), b, await config());
  return ok({ id: p.id });
}
async function postEdit(req) {
  const m = await need(req);
  const b = await readBody(req, 20000);
  const title = clean(b.title, 140), body = cleanText(b.body, 6000);
  if (title.length < 2 || body.length < 2) throw new HttpError(400, 'A post needs a title and a few words.');
  await changePost(clean(b.id, 40), (p) => { if (p.author.id !== m.id) throw new HttpError(403, 'You can only edit your own posts.'); p.title = title; p.body = body; p.edited = Date.now(); });
  return ok({ ok: true });
}
async function postDelete(req) {
  const m = await need(req);
  const b = await readBody(req);
  await changePost(clean(b.id, 40), (p) => { if (p.author.id !== m.id) throw new HttpError(403, 'You can only remove your own posts.'); p.deleted = true; });
  return ok({ ok: true });
}
async function postComment(req) {
  const m = await need(req);
  const b = await readBody(req);
  const body = cleanText(b.body, 2500);
  if (body.length < 1) throw new HttpError(400, 'Write a few words first.');
  if (!(await throttle('cmt-' + m.id, 'member', 40, 3600e3))) throw new HttpError(429, 'You have commented a lot this hour. Please come back soon.');
  const c = { id: rid(8), author: authorOf(m), body, created: Date.now(), likes: [] };
  await changePost(clean(b.postId, 40), (p) => { if (p.comments.length >= 500) throw new HttpError(400, 'This conversation is full.'); p.comments.push(c); p.last = c.created; });
  return ok({ id: c.id });
}
async function postCommentDelete(req) {
  const m = await need(req);
  const b = await readBody(req);
  await changePost(clean(b.postId, 40), (p) => {
    const i = p.comments.findIndex((c) => c.id === b.commentId);
    if (i < 0) return NO_CHANGE;
    if (p.comments[i].author.id !== m.id) throw new HttpError(403, 'You can only remove your own comments.');
    p.comments.splice(i, 1);
  });
  return ok({ ok: true });
}
/* A like gives the author one point (the way Skool counts it), and taking it back takes the point away. */
async function postLike(req) {
  const m = await need(req);
  const b = await readBody(req);
  let author = null, delta = 0, liked = false, count = 0;
  await changePost(clean(b.postId, 40), (p) => {
    const target = b.commentId ? p.comments.find((c) => c.id === b.commentId) : p;
    if (!target) throw new HttpError(404, 'That comment is gone.');
    target.likes = target.likes || [];
    if (target.author.id === m.id) throw new HttpError(400, 'Likes are for lifting up others.');
    const i = target.likes.indexOf(m.id);
    if (i >= 0) { target.likes.splice(i, 1); delta = -1; liked = false; } else { target.likes.push(m.id); delta = 1; liked = true; }
    author = target.author; count = target.likes.length;
  });
  if (author && !author.host) {
    const { data: a } = await get('m/' + author.id);
    if (a) await addPoints(a, delta);
  }
  return ok({ liked, likes: count });
}

async function getClassroom(req) {
  const m = await need(req, { active: false });
  const [list, cfg, { data: board }] = await Promise.all([courses(), config(), get('board', { m: {} })]);
  const pts = ((board.m || {})[m.id] || {}).t || 0;
  return ok({ courses: list.filter((c) => c.published).map((c) => courseCard(c, m, cfg, pts)) });
}
async function getCourse(req, url) {
  const m = await need(req, { active: false });
  const id = clean(url.searchParams.get('id'), 40);
  const [list, cfg, { data: board }] = await Promise.all([courses(), config(), get('board', { m: {} })]);
  const c = list.find((x) => x.id === id && x.published);
  if (!c) throw new HttpError(404, 'That course is not here.');
  const pts = ((board.m || {})[m.id] || {}).t || 0;
  const open = opens(cfg, m, c.minTier, c.minLevel, pts);
  return ok({ course: { ...courseCard(c, m, cfg, pts), modules: c.modules.map((mo) => ({ id: mo.id, title: mo.title, lessons: mo.lessons.map((l) => {
    const base = { id: l.id, title: l.title, minutes: l.minutes || 0, done: !!(m.progress && m.progress[c.id + '/' + l.id]), ready: !!(l.video || l.body) };
    if (!open) return base;
    return { ...base, video: videoEmbed(l.video), body: l.body || '', resources: (l.resources || []).map((r) => ({ label: clean(r.label, 80), url: safeUrl(r.url) })).filter((r) => r.url) };
  }) })) } });
}
async function postProgress(req) {
  const m = await need(req);
  const b = await readBody(req);
  const [list, cfg, { data: board }] = await Promise.all([courses(), config(), get('board', { m: {} })]);
  const c = list.find((x) => x.id === b.course && x.published);
  if (!c || !c.modules.some((mo) => mo.lessons.some((l) => l.id === b.lesson))) throw new HttpError(404, 'That lesson is not here.');
  if (!opens(cfg, m, c.minTier, c.minLevel, ((board.m || {})[m.id] || {}).t)) throw new HttpError(403, 'This course opens with a higher membership.');
  const key = c.id + '/' + b.lesson;
  let first = false;
  await changeMember(m.id, (x) => {
    x.progress = x.progress || {}; x.earned = x.earned || {};
    if (b.done) { if (x.progress[key]) return NO_CHANGE; x.progress[key] = Date.now(); if (!x.earned[key]) { x.earned[key] = 1; first = true; } }
    else { if (!x.progress[key]) return NO_CHANGE; delete x.progress[key]; }
  });
  if (first) await addPoints(m, 1);
  return ok({ ok: true, points: first ? 1 : 0 });
}

function eventView(e, m, cfg) {
  const open = opens(cfg, m, e.minTier, 0, 0);
  return { id: e.id, title: e.title, desc: e.desc, start: e.start, minutes: e.minutes, place: e.place || '', minTier: e.minTier || '', open,
    link: open ? safeUrl(e.link) : '', replay: open ? safeUrl(e.replay) : '' };
}
async function getEvents(req) {
  const m = await need(req);
  const [list, cfg] = await Promise.all([events(), config()]);
  const now = Date.now();
  const pub = list.filter((e) => e.published !== false).sort((a, b) => a.start - b.start);
  return ok({ upcoming: pub.filter((e) => e.start + e.minutes * 60e3 >= now).map((e) => eventView(e, m, cfg)),
    past: pub.filter((e) => e.start + e.minutes * 60e3 < now).slice(-12).reverse().map((e) => eventView(e, m, cfg)) });
}
async function getEventIcs(req, url) {
  const m = await need(req);
  const [list, cfg] = await Promise.all([events(), config()]);
  const e = list.find((x) => x.id === url.searchParams.get('id') && x.published !== false);
  if (!e) throw new HttpError(404, 'That gathering is not here.');
  const v = eventView(e, m, cfg);
  const body = ics({ uid: e.id + '@nowlovelife.com', start: e.start, end: e.start + e.minutes * 60e3, summary: e.title + ' · Now & Love',
    description: (e.desc || '') + (v.link ? '\nJoin: ' + v.link : ''), location: v.link || e.place || 'Now & Love', url: originOf(url) + '/portal/#calendar' });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="now-and-love-gathering.ics"', 'Cache-Control': 'no-store' } });
}

async function getBoard(req, url) {
  const m = await need(req);
  const range = ['7', '30'].includes(url.searchParams.get('range')) ? Number(url.searchParams.get('range')) : 0;
  const [{ data: board }, cfg] = await Promise.all([get('board', { m: {} }), config()]);
  const cut = new Date(Date.now() - (range - 1) * 864e5).toISOString().slice(0, 10);
  const rows = Object.entries(board.m || {}).filter(([, r]) => !r.x).map(([id, r]) => ({ id, name: r.n, color: r.c, level: levelOf(r.t), total: r.t || 0,
    score: range ? Object.entries(r.d || {}).filter(([d]) => d >= cut).reduce((n, [, v]) => n + v, 0) : (r.t || 0) }));
  rows.sort((a, b) => b.score - a.score || b.total - a.total);
  const meRow = rows.findIndex((r) => r.id === m.id);
  const counts = LEVELS.map(() => 0);
  for (const r of rows) counts[r.level - 1]++;
  return ok({ top: rows.slice(0, 10).filter((r) => r.score > 0 || !range), me: { rank: meRow + 1, ...(rows[meRow] || { score: 0, total: 0, level: 1 }) },
    levels: LEVELS.map((p, i) => ({ level: i + 1, name: cfg.levelNames[i] || 'Level ' + (i + 1), points: p, share: rows.length ? Math.round(counts[i] * 100 / rows.length) : 0 })),
    unlocks: (await courses()).filter((c) => c.published && c.minLevel).map((c) => ({ level: c.minLevel, title: c.title })) });
}

async function getProfile(req, url) {
  await need(req);
  const id = clean(url.searchParams.get('id'), 40);
  const [{ data: m }, { data: board }, cfg] = await Promise.all([get('m/' + id), get('board', { m: {} }), config()]);
  if (!m || m.banned) throw new HttpError(404, 'That member is not here.');
  const pts = ((board.m || {})[m.id] || {}).t || 0;
  return ok({ member: { id: m.id, name: m.name, bio: m.bio || '', color: m.color, joined: m.created, level: levelOf(pts), points: pts, levelName: cfg.levelNames[levelOf(pts) - 1] } });
}

/* ---------- Jorge's studio ---------- */

async function adminData(req) {
  await requireAdmin(req, false);
  const [cfg, { data: idx }, list, ev, { data: feed }, { data: board }] = await Promise.all([config(), get('members', { list: [] }), courses(), events(), get('feed', DEFAULT_FEED), get('board', { m: {} })]);
  const members = idx.list.map((r) => ({ ...r, points: ((board.m || {})[r.id] || {}).t || 0 }));
  const activeRows = members.filter((r) => ACTIVE.has(r.status) && !r.banned);
  const mrr = activeRows.reduce((n, r) => { const t = cfg.tiers.find((x) => x.id === r.tier); if (!t || r.status === 'comp') return n; return n + (r.interval === 'year' ? Math.round(t.yearly / 12) : t.monthly); }, 0);
  return ok({ config: cfg, members, courses: list, events: ev, posts: feed.list.slice(0, 200), stats: { members: activeRows.length, mrr, total: members.length }, mode: stripe.mode() });
}
async function adminConfig(req) {
  await requireAdmin(req, true);
  const b = await readBody(req, 60000);
  const cur = await config();
  const tiers = Array.isArray(b.tiers) ? b.tiers.slice(0, 8).map((t, i) => {
    const old = cur.tiers.find((x) => x.id === t.id);
    const id = old ? old.id : (clean(t.id, 20).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'tier' + (i + 1));
    const monthly = Math.round(Number(t.monthly)), yearly = Math.round(Number(t.yearly));
    if (!(monthly >= 100 && monthly <= 10000000) || !(yearly >= 100 && yearly <= 100000000)) throw new HttpError(400, 'Check the prices for ' + clean(t.name, 60) + '.');
    return { id, name: clean(t.name, 60) || 'Membership', tag: clean(t.tag, 40), blurb: cleanText(t.blurb, 300), color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#c58cff',
      monthly, yearly, featured: !!t.featured, perks: (Array.isArray(t.perks) ? t.perks : []).slice(0, 10).map((p) => clean(p, 120)).filter(Boolean) };
  }) : cur.tiers;
  if (!tiers.length) throw new HttpError(400, 'Keep at least one membership.');
  const categories = Array.isArray(b.categories) ? b.categories.slice(0, 12).map((c, i) => ({ id: clean(c.id, 24).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'cat' + (i + 1),
    name: clean(c.name, 40) || 'Category', color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#c58cff', hostOnly: !!c.hostOnly })) : cur.categories;
  const levelNames = Array.isArray(b.levelNames) ? LEVELS.map((_, i) => clean(b.levelNames[i], 30) || DEFAULT_LEVEL_NAMES[i]) : cur.levelNames;
  const host = b.host ? { name: clean(b.host.name, 60) || cur.host.name, title: clean(b.host.title, 80) } : cur.host;
  await upd('config', DEFAULT_CONFIG, (d) => { d.tiers = tiers; d.categories = categories; d.levelNames = levelNames; d.host = host; });
  return ok({ ok: true });
}
async function adminMember(req) {
  await requireAdmin(req, true);
  const b = await readBody(req);
  const cfg = await config();
  const id = clean(b.id, 40);
  let temp = '';
  const update = {};
  if (b.action === 'comp') { if (tierIndex(cfg, b.tier) < 0) throw new HttpError(400, 'Choose a membership to gift.'); update.fn = (x) => { x.status = 'comp'; x.tier = b.tier; x.compSince = Date.now(); }; }
  else if (b.action === 'uncomp') update.fn = (x) => { if (x.status !== 'comp') return NO_CHANGE; x.status = x.subscription ? 'canceled' : 'pending'; };
  else if (b.action === 'ban') update.fn = (x) => { x.banned = true; x.ver = (x.ver || 1) + 1; };
  else if (b.action === 'unban') update.fn = (x) => { x.banned = false; };
  else if (b.action === 'delete') {
    // Permanently forgets an account (used to clear test members before launch). Billing stays in Stripe.
    const { data: m } = await get('m/' + id);
    if (!m) throw new HttpError(404, 'That member is not here.');
    await db().delete('m/' + id);
    await db().delete(await emailKey(m.email));
    if (m.customer) await db().delete('c/' + m.customer);
    await upd('members', { list: [] }, (d) => { const i = d.list.findIndex((x) => x.id === id); if (i < 0) return NO_CHANGE; d.list.splice(i, 1); });
    await upd('board', { m: {} }, (d) => { if (!d.m[id]) return NO_CHANGE; delete d.m[id]; });
    return ok({ ok: true });
  }
  else if (b.action === 'reset') { temp = rid(9); const pw = await hashPassword(temp); update.fn = (x) => { x.pw = pw; x.ver = (x.ver || 1) + 1; }; }
  else throw new HttpError(400, 'Unknown change.');
  const m = await changeMember(id, update.fn);
  if (!m) throw new HttpError(404, 'That member is not here.');
  if (m.subscription && b.action !== 'reset') await syncSubscription(m.subscription, m.id).catch(() => {});
  if (b.action === 'comp') await welcomeOnce((await get('m/' + id)).data);
  return ok({ ok: true, tempPassword: temp || undefined });
}
function cleanCourse(c, i) {
  const id = clean(c.id, 32).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'course' + (i + 1);
  return { id, title: clean(c.title, 100) || 'Untitled course', subtitle: clean(c.subtitle, 80), desc: cleanText(c.desc, 600),
    color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#c58cff', minTier: clean(c.minTier, 20), minLevel: Math.max(0, Math.min(9, Math.round(Number(c.minLevel) || 0))),
    published: c.published !== false,
    modules: (Array.isArray(c.modules) ? c.modules : []).slice(0, 40).map((mo, j) => ({ id: clean(mo.id, 24).replace(/[^A-Za-z0-9_-]/g, '') || 'm' + (j + 1), title: clean(mo.title, 100) || 'Module ' + (j + 1),
      lessons: (Array.isArray(mo.lessons) ? mo.lessons : []).slice(0, 80).map((l, k) => ({ id: clean(l.id, 24).replace(/[^A-Za-z0-9_-]/g, '') || 'l' + (k + 1) + rid(2), title: clean(l.title, 120) || 'Lesson ' + (k + 1),
        minutes: Math.max(0, Math.min(600, Math.round(Number(l.minutes) || 0))), video: clean(l.video, 500), body: cleanText(l.body, 12000),
        resources: (Array.isArray(l.resources) ? l.resources : []).slice(0, 10).map((r) => ({ label: clean(r.label, 80), url: clean(r.url, 500) })).filter((r) => r.url) })) })) };
}
async function adminCourses(req) {
  await requireAdmin(req, true);
  const b = await readBody(req, 400000);
  if (!Array.isArray(b.list)) throw new HttpError(400, 'Nothing to save.');
  const list = b.list.slice(0, 60).map(cleanCourse);
  const ids = new Set();
  for (const c of list) { if (ids.has(c.id)) throw new HttpError(400, 'Two courses share the id "' + c.id + '".'); ids.add(c.id);
    const lids = new Set(); for (const mo of c.modules) for (const l of mo.lessons) { if (lids.has(l.id)) l.id = l.id + rid(2); lids.add(l.id); } }
  await upd('courses', { list: DEFAULT_COURSES }, (d) => { d.list = list; });
  return ok({ ok: true });
}
async function adminEvents(req) {
  await requireAdmin(req, true);
  const b = await readBody(req, 120000);
  if (!Array.isArray(b.list)) throw new HttpError(400, 'Nothing to save.');
  const list = b.list.slice(0, 300).map((e) => {
    const start = Number(e.start);
    if (!Number.isFinite(start) || start < Date.UTC(2024, 0, 1) || start > Date.UTC(2035, 0, 1)) throw new HttpError(400, 'Check the date of "' + clean(e.title, 60) + '".');
    return { id: clean(e.id, 24).replace(/[^A-Za-z0-9_-]/g, '') || rid(8), title: clean(e.title, 100) || 'Live gathering', desc: cleanText(e.desc, 1500), start,
      minutes: Math.max(5, Math.min(720, Math.round(Number(e.minutes) || 60))), place: clean(e.place, 140), link: clean(e.link, 500), replay: clean(e.replay, 500),
      minTier: clean(e.minTier, 20), published: e.published !== false };
  });
  await upd('events', { list: [] }, (d) => { d.list = list; });
  return ok({ ok: true });
}
async function adminPost(req) {
  await requireAdmin(req, true);
  const b = await readBody(req, 20000);
  const cfg = await config();
  const p = await createPost(HOST(cfg), b, cfg);
  return ok({ id: p.id });
}
async function adminPostChange(req) {
  await requireAdmin(req, true);
  const b = await readBody(req);
  const id = clean(b.id, 40);
  if (b.action === 'pin') await changePost(id, (p) => { p.pinned = !!b.pinned; });
  else if (b.action === 'delete') await changePost(id, (p) => { p.deleted = true; });
  else if (b.action === 'delete-comment') await changePost(id, (p) => { const i = p.comments.findIndex((c) => c.id === b.commentId); if (i < 0) return NO_CHANGE; p.comments.splice(i, 1); });
  else if (b.action === 'comment') {
    const cfg = await config(); const body = cleanText(b.body, 2500);
    if (!body) throw new HttpError(400, 'Write a few words first.');
    await changePost(id, (p) => { p.comments.push({ id: rid(8), author: HOST(cfg), body, created: Date.now(), likes: [] }); p.last = Date.now(); });
  } else throw new HttpError(400, 'Unknown change.');
  return ok({ ok: true });
}
async function adminGetPost(req, url) {
  await requireAdmin(req, false);
  const p = await readPost(clean(url.searchParams.get('id'), 40));
  const [{ data: board }, cfg] = await Promise.all([get('board', { m: {} }), config()]);
  return ok({ post: viewPost(p, 'host', board, cfg) });
}

/* ---------- routing ---------- */

const MEMBER = {
  'GET config': getConfig, 'POST join': postJoin, 'POST login': postLogin, 'POST logout': postLogout, 'GET me': getMe,
  'POST profile': postProfile, 'POST password': postPassword, 'POST forgot': postForgot, 'POST reset': postReset, 'POST billing': postBilling, 'POST plan': postPlan,
  'GET feed': getFeed, 'GET post': getPost, 'POST post': postPost, 'POST post/edit': postEdit, 'POST post/delete': postDelete,
  'POST comment': postComment, 'POST comment/delete': postCommentDelete, 'POST like': postLike,
  'GET classroom': getClassroom, 'GET course': getCourse, 'POST progress': postProgress,
  'GET events': getEvents, 'GET event.ics': getEventIcs, 'GET board': getBoard, 'GET member': getProfile
};
const ADMIN = {
  'GET data': adminData, 'POST config': adminConfig, 'POST member': adminMember, 'POST courses': adminCourses, 'POST events': adminEvents,
  'POST post': adminPost, 'POST post/change': adminPostChange, 'GET post': adminGetPost
};

/* path is what follows /api/portal/ (or /api/admin/portal/ when admin is true). */
export async function route(req, url, context, path, admin) {
  const fn = (admin ? ADMIN : MEMBER)[req.method + ' ' + path];
  if (!fn) return json({ error: 'Not found' }, 404);
  if (!admin) guard(req);
  return fn(req, url, context);
}
