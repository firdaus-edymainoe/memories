import { authConfig, COOKIE, parseCookies, readToken, send } from "../../server/demo-session.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    send(res, 405, { error: "Use GET to check the session." });
    return;
  }

  const config = authConfig();
  if (!config.configured) {
    send(res, 503, { ok: false, error: "Preview sign-in is not configured on this server." });
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const session = readToken(cookies[COOKIE], config.secret);
  if (!session) {
    send(res, 401, { ok: false });
    return;
  }

  send(res, 200, { ok: true, username: session.username });
}
