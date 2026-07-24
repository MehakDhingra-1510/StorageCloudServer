// Shared options for the "sid" session cookie.
//
// In production, the client (Netlify) and API (Render) are served from
// different domains, so the session cookie is cross-site. sameSite:"none" is
// required for the browser to send it on cross-site API calls, and
// secure:true is mandatory whenever sameSite is "none".
//
// BUG THIS FIXES: those two attributes were previously hardcoded regardless
// of environment. secure:true cookies are refused by browsers over plain
// HTTP — and local dev runs the API on http://localhost:4000. So locally,
// the "sid" cookie was silently never stored, every authenticated request
// 401'd, and both email/password login and Google login looked completely
// broken in dev while working fine in production. That's the "works in some
// places, not others" symptom.
//
// This now switches based on NODE_ENV: relaxed (sameSite:"lax", secure:false)
// for local HTTP dev, strict cross-site settings for production. Set
// NODE_ENV=production in your deployment platform's env vars (Render, etc.)
// — if it's unset, this now defaults to the safer "dev" behavior rather than
// silently shipping a cookie the browser refuses to store.
//
// Note: even with this fixed, cross-site cookies in production can still be
// blocked by browsers with strict tracking-prevention (Safari ITP, Firefox
// Enhanced Tracking Protection, some private-browsing modes). If login still
// intermittently fails for specific browsers in production, the durable fix
// is to stop relying on a cross-site cookie entirely — e.g. serve client and
// API from the same origin behind a reverse proxy (sameSite:"lax" then
// works), or switch to a bearer-token session (Authorization header instead
// of a cookie).
const isProduction = process.env.NODE_ENV === "production";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: isProduction ? "none" : "lax",
  secure: isProduction,
};