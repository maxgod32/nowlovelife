/* Time zones with the built-in Intl API (no libraries). Jorge's hours live in his time zone; every booking is
   stored as a UTC instant in milliseconds. Handles daylight saving changes. */
const cache = new Map();
function dtf(tz) {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    cache.set(tz, f);
  }
  return f;
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function parts(tz, ms) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute, ss: +o.second, wd: WD[o.weekday] };
}

function offset(tz, ms) {
  const p = parts(tz, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}

/* The UTC instant of a wall-clock time in tz. */
export function zoned(tz, y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = offset(tz, guess);
  let t = guess - o1;
  const o2 = offset(tz, t);
  if (o2 !== o1) t = guess - o2;
  return t;
}

export function validTZ(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

export const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (p) => p.y + '-' + pad(p.m) + '-' + pad(p.d);
export function parseDay(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || '');
  if (!m) return null;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCMonth() === +m[2] - 1 ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
export function nextDay(p) {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
export const weekdayOf = (p) => new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();

/* "HH:MM" to minutes after midnight; "24:00" allowed as an end time. */
export function hm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

export function fmtDay(tz, ms) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(ms);
}
export function fmtTime(tz, ms, zone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', ...(zone ? { timeZoneName: 'short' } : {}) }).format(ms);
}
export function fmtWhen(tz, start, end) {
  return fmtDay(tz, start) + ', ' + fmtTime(tz, start) + ' to ' + fmtTime(tz, end, true);
}
export function fmtShort(tz, ms) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(ms);
}
