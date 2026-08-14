import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Agent worktrees are checked out inside the repo (.claude/worktrees/*), so
    // without this the suite globs every worktree's copy of every test and
    // reports a count that has nothing to do with this working tree.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: "2025-04-01",
          r2Buckets: ["FILES"],
          d1Databases: ["DB"],
          bindings: {
            // admin@test.com stays first so it remains the default dev identity.
            // admin2@test.com is a plain admin, so tests can check that only a
            // super admin may act on another admin.
            ADMIN_EMAILS: "admin@test.com,admin2@test.com",
            SUPER_ADMIN_EMAILS: "admin@test.com",
            ADMIN_SERVICE_TOKENS: "admin-token.access",
            ACCESS_TEAM_DOMAIN: "",
            ACCESS_AUD: "",
            DEV_LOGIN: "true",
          },
        },
      },
    },
  },
});
