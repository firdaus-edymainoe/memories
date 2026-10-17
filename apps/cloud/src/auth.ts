import type { CloudProvider } from "@memories/core";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { admin, bearer } from "better-auth/plugins";
import { desktopSignIn } from "./desktop-sign-in.js";
import { type Mailer, actionEmail } from "./mailer.js";

export type ProviderCredentials = { clientId: string; clientSecret: string; tenantId?: string };

export type AuthOptions = {
  /** A `pg` Pool in production; Better Auth's memory adapter in tests. */
  database: BetterAuthOptions["database"];
  /** Public URL of this server, e.g. `https://cloud.memories.app`. */
  baseURL: string;
  /** At least 32 random characters. Signs sessions. */
  secret: string;
  mailer: Mailer;
  /** Only providers with credentials are offered. Email and password is always on. */
  providers?: Partial<Record<CloudProvider, ProviderCredentials>>;
  /** Refuse password sign-in until the email address is confirmed. */
  requireEmailVerification?: boolean;
  trustedOrigins?: string[];
  /** Clean up what the person stored with us (catalogs, cloud files). */
  onUserDeleted?: (userId: string) => Promise<void>;
};

/**
 * Accounts and people management. Better Auth owns the user, session, account and verification
 * tables; plugins add what Memories needs:
 * - `admin`: `admin` and `user` roles, list/ban/remove people. Admins use the app like anyone.
 * - `bearer`: the desktop app sends its session as `Authorization: Bearer`, not a cookie.
 * - `desktopSignIn`: social sign-in in the system browser, handed back to the app with PKCE.
 */
export function createAuth(options: AuthOptions) {
  const providers = options.providers ?? {};
  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  for (const [name, credentials] of Object.entries(providers) as Array<[CloudProvider, ProviderCredentials]>) {
    if (name === "microsoft") {
      socialProviders.microsoft = { ...credentials, tenantId: credentials.tenantId ?? "common" };
    } else {
      socialProviders[name] = { clientId: credentials.clientId, clientSecret: credentials.clientSecret };
    }
  }

  return betterAuth({
    appName: "Memories",
    baseURL: options.baseURL,
    basePath: "/api/auth",
    secret: options.secret,
    database: options.database,
    trustedOrigins: [options.baseURL, ...(options.trustedOrigins ?? [])],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      requireEmailVerification: options.requireEmailVerification ?? false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await options.mailer.send(
          actionEmail({
            to: user.email,
            subject: "Reset your Memories password",
            intro: "Someone asked to reset the password for your Memories account.",
            action: "Choose a new password",
            url,
          }),
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await options.mailer.send(
          actionEmail({
            to: user.email,
            subject: "Confirm your email for Memories",
            intro: `Welcome to Memories, ${user.name || "there"}. Please confirm this is your email address.`,
            action: "Confirm my email",
            url,
          }),
        );
      },
    },
    socialProviders,
    // Links a social sign-in to an existing account only when the provider confirms the email.
    account: { accountLinking: { enabled: true } },
    user: { deleteUser: { enabled: true } },
    databaseHooks: {
      user: {
        delete: {
          after: async (user) => {
            await options.onUserDeleted?.(user.id);
          },
        },
      },
    },
    plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] }), bearer(), desktopSignIn()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
