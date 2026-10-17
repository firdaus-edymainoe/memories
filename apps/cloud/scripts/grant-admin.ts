import { configFromEnv } from "../src/config.js";
import { createCloudServer } from "../src/server.js";

/**
 * Makes an existing account an admin: `npm run grant-admin -w @memories/cloud -- you@example.com`.
 * Run it by hand against the database; admins can then promote others from the app.
 * Pass `--revoke` to make them a normal user again.
 */
const args = process.argv.slice(2);
const email = args.find((arg) => !arg.startsWith("--"))?.trim().toLowerCase();
if (!email) {
  console.error("Usage: npm run grant-admin -w @memories/cloud -- <email> [--revoke]");
  process.exit(1);
}
const role = args.includes("--revoke") ? "user" : "admin";

const server = createCloudServer(configFromEnv());
const result = await server.pool.query(`UPDATE "user" SET role = $1, "updatedAt" = now() WHERE lower(email) = $2`, [role, email]);
await server.close();
if (result.rowCount === 0) {
  console.error(`No account for ${email}. Sign up in the app first.`);
  process.exit(1);
}
console.log(`${email} is now ${role === "admin" ? "an admin" : "a user"}.`);
