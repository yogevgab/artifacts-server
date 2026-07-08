import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: "2025-04-01",
          r2Buckets: ["FILES"],
          d1Databases: ["DB"],
          bindings: {
            ADMIN_EMAILS: "admin@test.com",
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
