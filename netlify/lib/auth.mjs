/* Jorge's back end login: one password (ADMIN_PASSWORD), a signed session cookie that JavaScript cannot read,
   and throttling so the password cannot be guessed by brute force. */
import { env, DEMO } from './env.mjs';
import { update } from './store.mjs';
import { HttpError, b64url, b64urlDecode, hmac, rid, safeEqual, sha256 } from './util.mjs';

const COOKIE = 'nl_admin';
const te = new TextEncoder(), td = new TextDecoder();
const secret = () => env('SESSION_SECRET') || ('nl-admin-session:' + env('ADMIN_PASSWORD'));

export const adminReady = () => env('ADMIN_PASSWORD').length >= 8 || (DEMO && !!env('ADMIN_PASSWORD'));

export async function passwordOk(pw) {
  if (!adminReady()) return false;
  const [a, b] = await Promise.all([sha256('pw:' + String(pw || '')), sha256('pw:' + env('ADMIN_PASSWORD'))]);
  return safeEqual(a, b);
}

export async function makeToken(days = 7) {
  const payload = b64url(te.encode(JSON.stringify({ exp: Date.now() + days * 86400e3, n: rid(6) })));
  return payload + '.' + await hmac(secret(), payload);
}

async function tokenOk(tok) {
  if (!tok || !adminReady()) return false;
  const [p, s] = String(tok).split('.');
  if (!p || !s || !safeEqual(s, await hmac(secret(), p))) return false;
  try { return JSON.parse(td.decode(b64urlDecode(p))).exp > Date.now(); } catch (e) { return false; }
}

function cookieOf(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

export function sessionCookie(req, tok, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return COOKIE + '=' + (tok || '') + '; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + secure;
}

/* Admin requests must carry the session, and changes must also carry a header that other websites cannot send. */
export async function requireAdmin(req, changing) {
  if (!adminReady()) throw new HttpError(503, 'Set ADMIN_PASSWORD (8 characters or more) in Netlify to open the back end.');
  const tok = cookieOf(req, COOKIE) || (DEMO ? req.headers.get('x-nl-session') : '');
  if (!(await tokenOk(tok))) throw new HttpError(401, 'Please sign in again.');
  if (changing) {
    if (req.headers.get('x-nl-admin') !== '1') throw new HttpError(403, 'That request was blocked.');
    const origin = req.headers.get('origin');
    if (origin && origin !== 'null' && origin !== new URL(req.url).origin) throw new HttpError(403, 'That request was blocked.');
  }
}

/* At most `limit` attempts per `windowMs` from one address. */
export async function throttle(bucket, ip, limit, windowMs) {
  const who = (await sha256('ip:' + ip)).slice(0, 16);
  let allowed = true;
  await update('rl-' + bucket, {}, (d) => {
    allowed = true;
    const now = Date.now();
    for (const k of Object.keys(d)) { d[k] = (d[k] || []).filter((t) => now - t < windowMs); if (!d[k].length) delete d[k]; }
    const list = d[who] || (d[who] = []);
    if (list.length >= limit) { allowed = false; return; }
    list.push(now);
  });
  return allowed;
}
