import { defineConfig } from "vitest/config";

// Browser tests fill whole forms; give them time.
export default defineConfig({ test: { testTimeout: 60_000 } });
