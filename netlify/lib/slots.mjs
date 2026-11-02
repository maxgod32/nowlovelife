/* Jorge's availability and the open times it produces. Everything here is pure: same inputs, same answer. */
import { parts, zoned, dayKey, nextDay, weekdayOf, hm } from './time.mjs';

export const DEFAULT_CONFIG = {
  timezone: 'America/New_York',
  // 0 = Sunday ... 6 = Saturday. Each day holds [start, end] ranges in Jorge's time zone.
  weekly: { 0: [], 1: [['10:00', '17:00']], 2: [['10:00', '17:00']], 3: [['10:00', '17:00']], 4: [['10:00', '17:00']], 5: [['10:00', '17:00']], 6: [] },
  stepMinutes: 60,       // how often a session may start
  bufferMinutes: 0,      // breathing room kept free around every booking
  minNoticeHours: 24,    // no bookings sooner than this
  maxDaysAhead: 60,      // how far ahead people can book
  maxPerDay: 0,          // 0 means no daily limit
  blocked: [],           // days off, as "YYYY-MM-DD"
  extra: [],             // one-off openings: { date, start, end }
  location: 'Online by private video call, or in person in Naples, Florida. Jorge confirms the details with you by email.',
  policy: 'Need to move your session? Message Jorge and he will help you find a new time.',
  notifyEmail: ''
};

export const DEFAULT_OFFERINGS = [
  { id: 'elevation-consultation', name: 'Advisory Consult: All-Day Evolution Journey', minutes: 420, priceCents: 74900, active: true,
    description: 'An all-day evolution healing journey with Jorge: finding your dream soulmate, growing your business and developing your super human abilities. We assist with trauma healing, gaining spiritual elevation, accomplishing your goals, and becoming the Godhead version of you that God created you to become. Unlock your full potential.' },
  { id: 'elevation-course-2', name: 'Elevation Course, Two Hours', minutes: 120, priceCents: 150000, active: false,
    description: 'Two private hours: the Enlighten Method taught to you one to one, with practices to carry home.' },
  { id: 'elevation-course-3', name: 'Elevation Course, Three Hours', minutes: 180, priceCents: 225000, active: false,
    description: 'Three private hours in one sitting, for a deeper turning point and a path you can walk on your own.' }
];

/* Bookings that hold time on the calendar right now. A hold whose Stripe checkout has not been settled stays
   busy even after its timer runs out, until Stripe says the checkout expired: it may already be paid. */
export function busyOf(bookings, now) {
  return bookings.filter((b) => b.status === 'confirmed' || b.status === 'processing' || b.status === 'review'
    || (b.status === 'hold' && (b.holdUntil > now || !!b.stripeSession)));
}

/* Open start times (UTC ms) for one offering. from = { y, m, d } in Jorge's zone; days limits the scan. */
export function computeSlots({ config, offering, bookings, now, from, days, limit, excludeId }) {
  const tz = config.timezone;
  const dur = offering.minutes * 60e3;
  const step = Math.max(5, (config.stepMinutes | 0) || 60) * 60e3;
  const buf = Math.max(0, config.bufferMinutes | 0) * 60e3;
  const earliest = now + Math.max(0, +config.minNoticeHours || 0) * 3600e3;
  const latest = now + Math.max(1, Math.min(365, +config.maxDaysAhead || 60)) * 86400e3;
  const held = busyOf(bookings, now).filter((b) => b.id !== excludeId);
  const busy = held.map((b) => [b.start - buf, b.end + buf]);
  const perDay = {};
  for (const b of held) { const k = dayKey(parts(tz, b.start)); perDay[k] = (perDay[k] || 0) + 1; }
  const blocked = new Set(config.blocked || []);
  const lastKey = dayKey(parts(tz, latest));
  let day = from || (({ y, m, d }) => ({ y, m, d }))(parts(tz, now));
  const out = new Set();
  for (let i = 0; i < (days || 400); i++) {
    const key = dayKey(day);
    if (key > lastKey) break;
    const full = config.maxPerDay > 0 && (perDay[key] || 0) >= config.maxPerDay;
    if (!blocked.has(key) && !full) {
      const ranges = [...((config.weekly || {})[weekdayOf(day)] || []), ...(config.extra || []).filter((x) => x.date === key).map((x) => [x.start, x.end])]
        .map(([a, b]) => [hm(a), hm(b)]).filter(([a, b]) => a != null && b != null && b > a).sort((p, q) => p[0] - q[0]);
      for (const [a, b] of ranges) {
        const ws = zoned(tz, day.y, day.m, day.d, Math.floor(a / 60), a % 60);
        const we = zoned(tz, day.y, day.m, day.d, Math.floor(b / 60), b % 60);
        for (let t = ws; t + dur <= we; t += step) {
          if (t < earliest || t > latest) continue;
          const e = t + dur;
          let free = true;
          for (const [bs, be] of busy) if (t < be && e > bs) { free = false; break; }
          if (free) out.add(t);
        }
      }
    }
    if (limit && out.size >= limit) break;
    day = nextDay(day);
  }
  const list = [...out].sort((x, y) => x - y);
  return limit ? list.slice(0, limit) : list;
}
