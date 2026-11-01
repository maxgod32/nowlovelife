/* Small helpers shared by every route. Web-standard APIs only (fetch, Request, Response, Web Crypto),
   so the same code runs in Netlify Functions and in the browser preview. */

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const BASE = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE, ...headers } });
}

export async function readBody(req, max = 16000) {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, 'That is more than we can take in one go.');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    throw new HttpError(400, 'We could not read that request.');
  }
}

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export function clean(v, max = 200) {
  return String(v == null ? '' : v).replace(CTRL, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}
export function cleanText(v, max = 2000) {
  return String(v == null ? '' : v).replace(CTRL, '').replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max);
}

export function isEmail(e) {
  return typeof e === 'string' && e.length <= 254 && /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[a-z]{2,}$/i.test(e);
}

export function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function rid(bytes = 15) {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return b64url(a);
}

export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const te = new TextEncoder();
export async function sha256(text) {
  return b64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', te.encode(String(text)))));
}
export async function hmac(key, msg, hex) {
  const k = await globalThis.crypto.subtle.importKey('raw', te.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, te.encode(msg)));
  if (!hex) return b64url(sig);
  let h = '';
  for (const b of sig) h += b.toString(16).padStart(2, '0');
  return h;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function money(cents) {
  const n = (cents || 0) / 100;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

export function ipOf(req, context) {
  return (context && context.ip) || req.headers.get('x-nf-client-connection-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
