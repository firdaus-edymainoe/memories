import { configFromEnv } from "../src/config.js";
import { createCloudServer } from "../src/server.js";

/** Creates or updates every table. The server also does this when it starts. */
const server = createCloudServer(configFromEnv());
await server.migrate();
await server.close();
console.log("Database is up to date.");
