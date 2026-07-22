// Shared options for the "sid" session cookie.
//
// The client (Netlify) and API (Render) are served from different domains,
// so the session cookie is cross-site. sameSite:"none" is required for the
// browser to send it on cross-site API calls, and secure:true is mandatory
// whenever sameSite is "none". Without these the cookie is silently dropped
// and every authenticated request returns 401 (looks like login "not working"
// for both email/password and Google auth).
//
// clearCookie must be given matching attributes or the browser won't clear it.
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "none",
  secure: true,
};
