/* Emails for The Circle: a welcome for new members, password reset links, and a note to Jorge. */
import { esc, money } from './util.mjs';
import { layout, p } from './emails.mjs';

const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'beloved';
const button = (href, label) => '<p style="margin:22px 0 18px;"><a href="' + esc(href) + '" style="display:inline-block;padding:14px 26px;border-radius:999px;'
  + 'background:linear-gradient(135deg,#fff1c9,#f3d79a 40%,#c9a24e);color:#1a0f00;font-size:13px;letter-spacing:.16em;text-transform:uppercase;text-decoration:none;font-weight:bold;">' + esc(label) + '</a></p>';
const small = (t) => '<p style="font-size:12px;line-height:1.6;margin:0 0 8px;color:#a99fcf;">' + t + '</p>';

export function welcome(m, tier, origin, gift) {
  const subject = 'Welcome home to The Circle, ' + first(m.name);
  const html = layout('Welcome home, ' + first(m.name) + '.',
    p(gift ? 'Jorge has opened the doors of <b style="color:#fff;">' + esc(tier.name) + '</b> for you, as a gift.' : 'You are now part of <b style="color:#fff;">' + esc(tier.name) + '</b>, inside The Circle.')
    + p('This is your sacred space: the daily practice, the sacred journeys, live gatherings with Jorge, and a circle of souls walking the path beside you.')
    + button(origin + '/portal/', 'Enter The Circle')
    + p('<b style="color:#fff;">Where to begin</b><br>1. Start The Enlighten Method in the Classroom.<br>2. Check the Calendar for this week&rsquo;s live gathering.<br>3. Introduce yourself in the Circle.')
    + small('You sign in with ' + esc(m.email) + ' and the password you chose.' + (gift ? '' : ' Manage or cancel your membership anytime from your Account.'))
    + small('Reply to this email to reach Jorge.'));
  const text = 'Welcome home, ' + first(m.name) + '.\n\nYou are now part of ' + tier.name + ', inside The Circle.\n\nEnter: ' + origin + '/portal/\n\nWhere to begin:\n1. Start The Enlighten Method in the Classroom.\n2. Check the Calendar for this week\'s live gathering.\n3. Introduce yourself in the Circle.\n\nReply to this email to reach Jorge.';
  return { subject, html, text };
}

export function reset(m, link) {
  const subject = 'Reset your password for The Circle';
  const html = layout('A new password, ' + first(m.name),
    p('Someone (hopefully you) asked to reset the password for your Now &amp; Love membership. Tap below to choose a new one.')
    + button(link, 'Choose a new password')
    + small('This link works once and expires in one hour. If you did not ask for it, you can ignore this email: your password stays the same.'));
  const text = 'Reset your password for The Circle: ' + link + '\n\nThis link works once and expires in one hour. If you did not ask for it, ignore this email.';
  return { subject, html, text };
}

export function jorgeNewMember(m, tier, interval, gift) {
  const price = interval === 'year' ? tier.yearly : tier.monthly;
  const subject = (gift ? 'Gift membership: ' : 'New member: ') + m.name + ' joined ' + tier.name;
  const html = layout(gift ? 'A gift membership is open' : 'A new soul joined The Circle',
    '<table role="presentation" style="border-collapse:collapse;margin:6px 0 16px;">'
    + [['Member', esc(m.name)], ['Email', '<a style="color:#c58cff;" href="mailto:' + esc(m.email) + '">' + esc(m.email) + '</a>'], ['Membership', esc(tier.name)],
      ['Billing', gift ? 'Gift (no billing)' : esc(money(price)) + ' per ' + (interval === 'year' ? 'year' : 'month')]]
      .map((r) => '<tr><td style="padding:6px 12px 6px 0;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a99fcf;">' + r[0] + '</td><td style="padding:6px 0;font-size:15px;color:#fff;">' + r[1] + '</td></tr>').join('')
    + '</table>' + p('Welcome them in the Circle. Your studio: nowlovelife.com/admin/members'));
  const text = subject + '\n\n' + m.name + ' <' + m.email + '>\n' + tier.name + (gift ? ' (gift)' : ', ' + money(price) + ' per ' + interval);
  return { subject, html, text };
}
