/**
 * Markdown imported as text. `test/repo-docs.test.ts` asserts against the
 * repository's own documentation, and Vite's `?raw` suffix is the only way to
 * read a file from inside the Workers pool — there is no `node:fs` in there.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}

/**
 * The same trick for shipped source. `test/repo-docs.test.ts` also pins the
 * user-facing copy inside `src/people.ts` and `cli/artifacts.mjs` — reading them
 * as text is what lets one test cover a rendered HTML string, an embedded
 * client-side script and CLI help output at once.
 */
declare module "*.ts?raw" {
  const content: string;
  export default content;
}

declare module "*.mjs?raw" {
  const content: string;
  export default content;
}

/**
 * And the same for SQL. `test/account-slugs.test.ts` checks that migration 0020,
 * `schema.sql` and the test fixture agree about the branded-address column and
 * its uniqueness index — three files that must not be allowed to drift, and the
 * only way to compare them from inside the Workers pool is to read them as text.
 */
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
