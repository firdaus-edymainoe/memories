import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { createHash, timingSafeEqual } from "node:crypto";
import * as z from "zod";

/**
 * Hands a browser sign-in (Google, Apple, …) over to the desktop app, following RFC 8252: the app
 * opens the system browser, the person signs in there, and the browser is sent back to the app's
 * own server on 127.0.0.1 with a one-time code. Only the app that made the PKCE challenge can
 * turn that code into a session, and the app gets its own session, separate from the browser's.
 */

const CODE_TTL_MS = 5 * 60 * 1000;
const PREFIX = "desktop-sign-in:";

/** The app listens on loopback only, on a port it picks at launch. */
export function isDesktopRedirect(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost") &&
    url.port !== "" &&
    !url.username &&
    !url.password &&
    url.pathname === "/cloud/callback" &&
    !url.hash
  );
}

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sameText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const redirectUri = z.string().max(200).refine(isDesktopRedirect, "redirect_uri must be the app's loopback callback");
const state = z.string().min(16).max(200);
const challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "code_challenge must be an S256 challenge");

export const desktopAuthorizeQuery = z.object({
  redirect_uri: redirectUri,
  state,
  code_challenge: challenge,
  code_challenge_method: z.literal("S256"),
});

type Pending = { token: string; challenge: string; redirectUri: string };

export const desktopSignIn = () =>
  ({
    id: "desktop-sign-in",
    endpoints: {
      /** Called in the browser once signed in; sends a one-time code back to the app. */
      desktopAuthorize: createAuthEndpoint(
        "/desktop/authorize",
        { method: "GET", query: desktopAuthorizeQuery, use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const desktop = await ctx.context.internalAdapter.createSession(user.id);
          if (!desktop) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not create a session" });

          const code = generateRandomString(43);
          const pending: Pending = {
            token: desktop.token,
            challenge: ctx.query.code_challenge,
            redirectUri: ctx.query.redirect_uri,
          };
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: PREFIX + code,
            value: JSON.stringify(pending),
            expiresAt: new Date(Date.now() + CODE_TTL_MS),
          });

          // The browser's session was only for signing in; don't leave it behind.
          await ctx.context.internalAdapter.deleteSession(session.token);
          deleteSessionCookie(ctx);

          const back = new URL(ctx.query.redirect_uri);
          back.searchParams.set("code", code);
          back.searchParams.set("state", ctx.query.state);
          throw ctx.redirect(back.toString());
        },
      ),

      /** Called by the app: the code and the PKCE verifier become a session token. */
      desktopToken: createAuthEndpoint(
        "/desktop/token",
        {
          method: "POST",
          body: z.object({
            code: z.string().min(1).max(200),
            code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
            redirect_uri: redirectUri,
          }),
        },
        async (ctx) => {
          const stored = await ctx.context.internalAdapter.consumeVerificationValue(PREFIX + ctx.body.code);
          if (!stored || stored.expiresAt < new Date()) throw new APIError("BAD_REQUEST", { message: "This sign-in link has expired" });
          const pending = JSON.parse(stored.value) as Pending;
          if (!sameText(pkceChallenge(ctx.body.code_verifier), pending.challenge) || pending.redirectUri !== ctx.body.redirect_uri) {
            throw new APIError("BAD_REQUEST", { message: "This sign-in link is not for this app" });
          }
          const found = await ctx.context.internalAdapter.findSession(pending.token);
          if (!found) throw new APIError("BAD_REQUEST", { message: "This sign-in link has expired" });
          return ctx.json({ token: found.session.token, user: found.user });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
