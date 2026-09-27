import {
  checkCredentials,
  issueToken,
  readJson,
  send,
  sessionCookie,
} from "../../server/demo-session.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
    });
    res.end();
    return;
  }

  if (req.method !== "POST") {
    send(res, 405, { error: "Use POST to sign in." });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    send(res, 400, { error: "Could not read that sign-in form." });
    return;
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const result = checkCredentials(username, password);

  if (result.reason === "unconfigured") {
    send(res, 503, { error: "Preview sign-in is not configured on this server." });
    return;
  }
  if (!result.ok) {
    send(res, 401, { error: "That email or password doesn’t match." });
    return;
  }

  const token = issueToken(result.username, result.secret);
  send(res, 200, { ok: true, username: result.username }, { "Set-Cookie": sessionCookie(token) });
}
