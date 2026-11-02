/* Storage on Netlify Blobs: a few small JSON documents (config, offerings, bookings, messages).
   Every change is a read-modify-write guarded by the document's ETag (onlyIfMatch / onlyIfNew), so two
   visitors can never overwrite each other and the same time can never be booked twice. */
import { getStore } from '@netlify/blobs';
import { HttpError, sleep } from './util.mjs';

export const NO_CHANGE = Symbol('no-change');
let S = null;
function store() {
  return S || (S = getStore({ name: 'nowlove-booking', consistency: 'strong' }));
}
const clone = (v) => JSON.parse(JSON.stringify(v));

export async function read(key, fallback) {
  const r = await store().getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (!r || r.data == null) return { data: clone(fallback), etag: null };
  return { data: r.data, etag: r.etag };
}

/* fn(data) changes data in place and may return NO_CHANGE to skip the write. It can run more than once
   when another request wins the race, so it must not have side effects outside data. */
export async function update(key, fallback, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, etag } = await read(key, fallback);
    const out = await fn(data);
    if (out === NO_CHANGE) return { data, out, written: false };
    const res = await store().setJSON(key, data, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    // Without conditional writes two visitors could take the same time, so refuse to run rather than risk it.
    if (!res || typeof res.modified !== 'boolean') throw new Error('Netlify Blobs conditional writes are unavailable: update @netlify/blobs');
    if (res.modified) return { data, out, written: true };
    await sleep(25 + Math.random() * 60 * (attempt + 1));
  }
  throw new HttpError(503, 'The calendar is busy right now. Please try again in a moment.');
}

export async function write(key, data) {
  await store().setJSON(key, data);
}
