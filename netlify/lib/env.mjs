/* Environment. On Netlify the settings come from process.env (Project configuration > Environment variables).
   The preview of the booking pages runs this same code in the browser, with a demo-only settings object that a
   server never has, so demo behaviour can never switch on in production. */
export const DEMO = !!(globalThis.NL_DEMO_ENV && globalThis.NL_DEMO_ENV.DEMO);

export function env(key) {
  if (DEMO) return globalThis.NL_DEMO_ENV[key] || '';
  const p = globalThis.process;
  return (p && p.env && p.env[key]) || '';
}
