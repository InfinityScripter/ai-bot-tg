import "dotenv/config";

import { EnvSchema } from "./schemas/env-schema.js";

/**
 * Loads and validates the environment once at import. The schema lives in
 * src/schemas/env-schema.ts (validation separated by entity); this module only
 * runs it and exposes the typed, frozen result as CONFIG. A missing/invalid var
 * aborts the process with a readable error rather than failing deep in the loop.
 */
function loadConfig() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const CONFIG = loadConfig();

export type Config = typeof CONFIG;
