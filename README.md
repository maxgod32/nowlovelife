# nowlovelife.com

The Now & Love website and the private sessions booking system.

- `public/` is the site Netlify serves, including the booking page at `/book/` and Jorge's studio at `/admin/`.
- `netlify/functions/api.mjs` is the booking back end at `/api/*`. Bookings, hours and messages are stored in Netlify Blobs.

Deploys happen automatically when this repository changes. Drag-and-drop deploys cannot run the back end, so do not use them for this site.

## Settings (Netlify > Project configuration > Environment variables)

| Variable | What it is |
| --- | --- |
| `ADMIN_PASSWORD` | Jorge's studio password, at least 12 characters |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...` for real payments, `sk_test_...` to test) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the Stripe webhook below (`whsec_...`) |
| `RESEND_API_KEY` | Resend API key for confirmation emails |
| `MAIL_FROM` | Optional sender, default `Now & Love <bookings@nowlovelife.com>` |
| `NOTIFY_EMAIL` | Where booking alerts and messages go (Jorge can also set this in the studio) |
| `SITE_URL` | `https://nowlovelife.com` |
| `SESSION_SECRET` | Optional long random string that signs studio sign-ins |

## Stripe webhook

Stripe Dashboard > Developers > Webhooks > Add endpoint:
`https://nowlovelife.com/api/stripe-webhook`, events `checkout.session.completed`,
`checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`charge.refunded` and `charge.dispute.created`.

## Email

Add the domain `nowlovelife.com` in Resend and copy the DNS records it shows into Netlify DNS.

Site and booking system by Max Cole Glaser, maxcoleglaser.com.
