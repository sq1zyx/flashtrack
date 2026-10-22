import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATA_DIR: mkdtempSync(join(tmpdir(), "contract-audit-test-")),
      ADMIN_TOKEN: "test-admin-token-1234567890",
    },
  },
});
