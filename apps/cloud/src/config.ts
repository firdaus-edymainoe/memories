import type { CloudProvider } from "@memories/core";
import { type DriveProviderSettings, driveProviderSettingsFromEnv, type StorageSettings, storageSettingsFromEnv } from "@memories/storage";
import type { ProviderCredentials } from "./auth.js";
import { ConsoleMailer, type Mailer, ResendMailer } from "./mailer.js";

export type CloudConfig = {
  port: number;
  baseURL: string;
  secret: string;
  databaseUrl: string;
  storage: StorageSettings;
  /** Personal drives people can connect (each needs its OAuth client). */
  drives: DriveProviderSettings;
  providers: Partial<Record<CloudProvider, ProviderCredentials>>;
  requireEmailVerification: boolean;
  mailer: Mailer;
};

type Env = Record<string, string | undefined>;

function required(env: Env, name: string) {
  const value = env[name];
  if (!value) throw new Error(`Set ${name} (see apps/cloud/.env.example)`);
  return value;
}

/** Sign-in providers are turned on by setting their client id and secret. */
function providersFromEnv(env: Env) {
  const providers: Partial<Record<CloudProvider, ProviderCredentials>> = {};
  const names: CloudProvider[] = ["google", "apple", "microsoft", "github", "facebook"];
  for (const name of names) {
    const prefix = name.toUpperCase();
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) continue;
    const tenantId = env[`${prefix}_TENANT_ID`];
    providers[name] = { clientId, clientSecret, ...(tenantId ? { tenantId } : {}) };
  }
  return providers;
}

export function configFromEnv(env: Env = process.env): CloudConfig {
  const secret = required(env, "BETTER_AUTH_SECRET");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  return {
    port: Number(env.PORT || 8787),
    baseURL: required(env, "BETTER_AUTH_URL").replace(/\/+$/, ""),
    secret,
    databaseUrl: required(env, "DATABASE_URL"),
    storage: storageSettingsFromEnv(env),
    drives: driveProviderSettingsFromEnv(env),
    providers: providersFromEnv(env),
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION === "true",
    mailer: env.RESEND_API_KEY ? new ResendMailer(env.RESEND_API_KEY, required(env, "MAIL_FROM")) : new ConsoleMailer(),
  };
}
