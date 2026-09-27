import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE = "memories_demo_session";
const DAY = 60 * 60 * 24;

export function authConfig() {
  const username = process.env.DEMO_USERNAME || "preview";
  const password = process.env.DEMO_PASSWORD || "";
  const secret = process.env.DEMO_AUTH_SECRET || "";
  return { username, password, secret, configured: Boolean(password && secret) };
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function issueToken(username, secret, maxAgeSec = 7 * DAY) {
  const exp = Math.floor(Date.now() / 1000) + maxAgeSec;
  const body = `${username}.${exp}`;
  return `${body}.${sign(body, secret)}`;
}

export function readToken(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [username, expRaw, mac] = parts;
  const body = `${username}.${expRaw}`;
  if (!safeEqual(sign(body, secret), mac)) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  return { username, exp };
}

export function checkCredentials(username, password) {
  const config = authConfig();
  if (!config.configured) return { ok: false, reason: "unconfigured" };
  const userOk = safeEqual(username, config.username);
  const passOk = safeEqual(password, config.password);
  if (!userOk || !passOk) return { ok: false, reason: "invalid" };
  return { ok: true, username: config.username, secret: config.secret };
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

export function sessionCookie(token, maxAgeSec = 7 * DAY) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (process.env.VERCEL || process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie() {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (process.env.VERCEL || process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}
