/* Jorge's back end login: one password (ADMIN_PASSWORD), a signed session cookie that JavaScript cannot read,
   sign-out that really ends the session, and throttling so the password cannot be guessed by brute force.

   Sessions are signed with SESSION_SECRET if set, otherwise with a random secret created once and kept in the
   store, never with anything derived from the password. Signing out bumps a version number, which ends every
   open session; changing ADMIN_PASSWORD ends them too. */
import { env, DEMO } from './env.mjs';
import { read, update, NO_CHANGE } from './store.mjs';
import { HttpError, b64url, b64urlDecode, hmac, rid, safeEqual, sha256, netOf } from './util.mjs';

const COOKIE = 'nl_admin';
const te = new TextEncoder(), td = new TextDecoder();

export const adminReady = () => env('ADMIN_PASSWORD').length >= 12 || (DEMO && !!env('ADMIN_PASSWORD'));

async function state() {
  let { data } = await read('auth', {});
  if (!data.secret) data = (await update('auth', {}, (d) => { if (d.secret) return NO_CHANGE; d.secret = rid(32); d.ver = 1; })).data;
  return data;
}
const keyOf = (st) => env('SESSION_SECRET') || st.secret;
const fingerprint = (st) => hmac(keyOf(st), 'pw:' + env('ADMIN_PASSWORD'));

export async function passwordOk(pw) {
  if (!adminReady()) return false;
  const [a, b] = await Promise.all([sha256('pw:' + String(pw || '')), sha256('pw:' + env('ADMIN_PASSWORD'))]);
  return safeEqual(a, b);
}

/* Called after a correct password: remembers which password the sessions belong to and signs a token. */
export async function makeToken(days = 7) {
  let st = await state();
  const fp = await fingerprint(st);
  if (st.pw !== fp) st = (await update('auth', {}, (d) => { if (d.pw === fp) return NO_CHANGE; d.pw = fp; })).data;
  const payload = b64url(te.encode(JSON.stringify({ exp: Date.now() + days * 86400e3, v: st.ver || 1, n: rid(6) })));
  return payload + '.' + await hmac(keyOf(st), payload);
}

async function tokenOk(tok) {
  if (!tok || !adminReady()) return false;
  const [p, s] = String(tok).split('.');
  if (!p || !s) return false;
  const st = await state();
  if (!safeEqual(s, await hmac(keyOf(st), p))) return false;
  if (st.pw !== await fingerprint(st)) return false;          // the password changed since this sign-in
  try {
    const t = JSON.parse(td.decode(b64urlDecode(p)));
    return t.exp > Date.now() && t.v === (st.ver || 1);
  } catch (e) { return false; }
}

function cookieOf(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return ''; }
    }
  }
  return '';
}
const tokenOf = (req) => cookieOf(req, COOKIE) || (DEMO ? req.headers.get('x-nl-session') || '' : '');

export function sessionCookie(req, tok, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return COOKIE + '=' + (tok || '') + '; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + secure;
}

/* Admin requests must carry the session, and changes must also carry a header that other websites cannot send. */
export async function requireAdmin(req, changing) {
  if (!adminReady()) throw new HttpError(503, 'Set ADMIN_PASSWORD (12 characters or more) in Netlify to open the back end.');
  if (!(await tokenOk(tokenOf(req)))) throw new HttpError(401, 'Please sign in again.');
  if (changing) {
    if (req.headers.get('x-nl-admin') !== '1') throw new HttpError(403, 'That request was blocked.');
    const origin = req.headers.get('origin');
    if (origin && origin !== 'null' && origin !== new URL(req.url).origin) throw new HttpError(403, 'That request was blocked.');
  }
}

/* Ends every open session, but only when asked by a signed-in studio. */
export async function endSessions(req) {
  if (req.headers.get('x-nl-admin') !== '1' || !(await tokenOk(tokenOf(req)))) return false;
  await update('auth', {}, (d) => { d.ver = (d.ver || 1) + 1; });
  return true;
}

/* At most `limit` attempts per `windowMs` from one network. Each network has its own counter, and a blocked
   attempt writes nothing, so a flood from one place cannot slow down anyone else. */
export async function throttle(bucket, ip, limit, windowMs) {
  const who = (await sha256('net:' + netOf(ip))).slice(0, 20);
  let allowed = true;
  await update('rl/' + bucket + '/' + who, { t: [] }, (d) => {
    const now = Date.now();
    d.t = (Array.isArray(d.t) ? d.t : []).filter((t) => now - t < windowMs);
    allowed = d.t.length < limit;
    if (!allowed) return NO_CHANGE;
    d.t.push(now);
  });
  return allowed;
}
