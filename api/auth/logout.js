import { clearCookie, send } from "../../server/demo-session.js";

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "DELETE") {
    send(res, 405, { error: "Use POST to sign out." });
    return;
  }
  send(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
}
