/* Email templates: a confirmation for the client, an alert for Jorge, cancellations and messages. */
import { esc, money } from './util.mjs';
import { fmtWhen, fmtShort } from './time.mjs';

function layout(title, inner) {
  return '<!doctype html><html><body style="margin:0;padding:0;background:#0d0920;">'
    + '<div style="max-width:560px;margin:0 auto;padding:28px 18px;font-family:Helvetica,Arial,sans-serif;color:#ebe6ff;">'
    + '<div style="font-family:Georgia,serif;font-size:22px;letter-spacing:.04em;color:#ebe6ff;margin-bottom:18px;">Now <span style="color:#ff6ad5;">&amp;</span> Love</div>'
    + '<div style="background:#160d33;border:1px solid #3b2a6e;border-radius:16px;padding:26px 22px;">'
    + '<h1 style="font-family:Georgia,serif;font-weight:400;font-size:26px;line-height:1.2;margin:0 0 14px;color:#ffffff;">' + esc(title) + '</h1>'
    + inner + '</div>'
    + '<p style="font-size:12px;color:#8f86b5;margin:18px 4px 0;">Now &amp; Love &middot; The Enlighten Method &middot; nowlovelife.com</p>'
    + '</div></body></html>';
}
const p = (t) => '<p style="font-size:15px;line-height:1.6;margin:0 0 12px;color:#d9d2f5;">' + t + '</p>';
const row = (k, v) => '<tr><td style="padding:6px 12px 6px 0;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a99fcf;vertical-align:top;white-space:nowrap;">' + esc(k)
  + '</td><td style="padding:6px 0;font-size:15px;color:#ffffff;">' + v + '</td></tr>';
const table = (rows) => '<table role="presentation" style="border-collapse:collapse;margin:6px 0 16px;">' + rows.join('') + '</table>';
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'friend';

export function clientConfirmed(b, config) {
  const when = fmtWhen(config.timezone, b.start, b.end);
  const subject = 'You are booked with Jorge: ' + fmtShort(config.timezone, b.start);
  const html = layout('You are booked, ' + first(b.client.name) + '.',
    p('Thank you for choosing to sit with Jorge. Your time is held and your session is confirmed.')
    + table([row('Session', esc(b.offeringName)), row('When', esc(when)), row('Length', b.minutes + ' minutes'), row('Paid', esc(money(b.amountPaid != null ? b.amountPaid : b.priceCents)))])
    + p(esc(config.location))
    + (config.policy ? p(esc(config.policy)) : '')
    + p('A calendar invite is attached. Reply to this email to reach Jorge directly.'));
  const text = 'You are booked, ' + first(b.client.name) + '.\n\n' + b.offeringName + '\n' + when + '\n' + b.minutes + ' minutes\n\n' + config.location + '\n\n' + (config.policy || '') + '\n\nReply to this email to reach Jorge directly.';
  return { subject, html, text };
}

export function jorgeNewBooking(b, config, conflict) {
  const when = fmtWhen(config.timezone, b.start, b.end);
  const subject = (conflict ? 'Check this booking: ' : 'New booking: ') + b.client.name + ', ' + fmtShort(config.timezone, b.start);
  const html = layout(conflict ? 'A booking overlaps another' : 'New session booked',
    (conflict ? p('This payment arrived after its time was released, and it overlaps another booking. Please reach out to the client to move one of them.') : '')
    + table([row('Client', esc(b.client.name)), row('Email', '<a style="color:#c58cff;" href="mailto:' + esc(b.client.email) + '">' + esc(b.client.email) + '</a>'),
      row('Phone', esc(b.client.phone || 'Not given')), row('Session', esc(b.offeringName)), row('When', esc(when)),
      row('Paid', esc(money(b.amountPaid != null ? b.amountPaid : b.priceCents)) + (b.payment === 'manual' ? ' (added by hand)' : ''))])
    + (b.client.intention ? p('<b style="color:#fff;">What they would like to bring:</b><br>' + esc(b.client.intention).replace(/\n/g, '<br>')) : '')
    + p('Open your studio at nowlovelife.com/admin to see every booking.'));
  const text = subject + '\n\n' + b.client.name + ' <' + b.client.email + '>\n' + (b.client.phone || '') + '\n' + b.offeringName + '\n' + when + '\n\n' + (b.client.intention || '');
  return { subject, html, text };
}

export function clientCancelled(b, config, refunded) {
  const when = fmtWhen(config.timezone, b.start, b.end);
  const subject = 'Your session on ' + fmtShort(config.timezone, b.start) + ' has been cancelled';
  const html = layout('Your session has been cancelled',
    p('Dear ' + esc(first(b.client.name)) + ', your ' + esc(b.offeringName) + ' on ' + esc(when) + ' has been cancelled.')
    + (refunded ? p('Your payment of ' + esc(money(b.amountPaid != null ? b.amountPaid : b.priceCents)) + ' has been refunded. Banks usually show it within 5 to 10 business days.') : '')
    + p('Reply to this email to reach Jorge, or book a new time at nowlovelife.com/book.'));
  const text = 'Your ' + b.offeringName + ' on ' + when + ' has been cancelled.' + (refunded ? ' Your payment has been refunded.' : '') + '\nReply to reach Jorge, or book again at nowlovelife.com/book.';
  return { subject, html, text };
}

export function jorgeMessage(m) {
  const subject = 'New message from ' + m.name + ' (nowlovelife.com)';
  const html = layout('A message for you',
    table([row('From', esc(m.name)), row('Email', '<a style="color:#c58cff;" href="mailto:' + esc(m.email) + '">' + esc(m.email) + '</a>'), row('Phone', esc(m.phone || 'Not given')), ...(m.topic ? [row('About', esc(m.topic))] : [])])
    + p(esc(m.text).replace(/\n/g, '<br>'))
    + p('Reply to this email to answer ' + esc(first(m.name)) + ' directly.'));
  const text = 'From ' + m.name + ' <' + m.email + '> ' + (m.phone || '') + '\n\n' + m.text;
  return { subject, html, text };
}

export function clientMessageReceived(m) {
  const subject = 'Jorge received your message';
  const html = layout('Your message reached Jorge',
    p('Thank you, ' + esc(first(m.name)) + '. Your words are with Jorge now, and he will answer you personally.')
    + p('<span style="color:#a99fcf;">You wrote:</span><br>' + esc(m.text).replace(/\n/g, '<br>')));
  return { subject, html, text: 'Thank you, ' + first(m.name) + '. Your message is with Jorge and he will answer you personally.\n\nYou wrote:\n' + m.text };
}
