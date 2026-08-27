# Contributing

Thanks for your interest in improving artifacts-server! Contributions of all kinds are
welcome — bug reports, features, docs, and code.

## Getting set up

```bash
git clone https://github.com/yogevgab/artifacts-server.git
cd artifacts-server
npm install
npm run dev      # local server at http://localhost:8787 (DEV_LOGIN: no sign-in, you are admin)
```

You do **not** need a Cloudflare account to develop or run the tests — everything runs locally
against an in-memory Workers runtime (Miniflare) via `@cloudflare/vitest-pool-workers`.

To seed the local database once:

```bash
npx wrangler d1 execute artifacts-meta --local --file schema.sql
```

Simulate a non-admin viewer locally with the `X-Dev-Email` header (dev-only):

```bash
curl -H "X-Dev-Email: alice@example.com" http://localhost:8787/
```

## Before you open a PR

Run the full check and make sure it's green:

```bash
npm run check      # tsc --noEmit && vitest run
```

- **Add tests** for new behavior. Unit tests for pure logic (`src/util.ts`, `src/authz.ts`,
  `src/session.ts`); integration tests (`test/integration.test.ts`) drive the Hono app
  end-to-end and can impersonate viewers via `X-Dev-Email`.
- **Keep files focused.** Each module has one job (see `docs/ARCHITECTURE.md`). Match the
  surrounding style; no formatter config is enforced beyond `.editorconfig` (2-space indent).
- **Security-sensitive areas** (`src/auth.ts`, `src/authz.ts`, `src/session.ts`, `src/otp.ts`,
  the serving and `/api` routes): explain the authorization implications in your PR description.

## Pull request guidelines

- One logical change per PR; a clear title and description of the what/why.
- Reference any issue it closes (`Closes #123`).
- Update `README.md` / `docs/` when you change behavior or configuration.
- CI runs typecheck + tests on every PR; it must pass.

## Reporting bugs / requesting features

Use the issue templates. For bugs, include repro steps and what you expected. For security
vulnerabilities, **do not** open a public issue — see [SECURITY.md](SECURITY.md).

## Project layout

```
src/          Worker source (routing, auth, serving, API, DB, HTML)
cli/          Node CLI (talks to /api/machine with an rtfx_… API token)
test/         vitest unit + integration tests
migrations/   D1 schema migrations (schema.sql is the full current schema)
scripts/      setup.mjs — automated deploy
docs/         architecture and design notes
```

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
