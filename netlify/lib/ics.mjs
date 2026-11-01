/* A calendar invite (.ics) any calendar app can open. */
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');

function fold(line) {
  const out = [];
  let s = line;
  while (s.length > 73) { out.push(s.slice(0, 73)); s = ' ' + s.slice(73); }
  out.push(s);
  return out.join('\r\n');
}

export function ics({ uid, start, end, summary, description, location, url }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Now & Love//Private Sessions//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp(Date.now()), 'DTSTART:' + stamp(start), 'DTEND:' + stamp(end),
    'SUMMARY:' + escText(summary), 'DESCRIPTION:' + escText(description), 'LOCATION:' + escText(location)];
  if (url) lines.push('URL:' + url);
  lines.push('BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:' + escText(summary), 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
