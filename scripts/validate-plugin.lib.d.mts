export const COMPONENT_DIRS: readonly string[];
export const KEBAB_CASE: RegExp;

export interface Frontmatter {
  frontmatter: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter | null;

export function findSecrets(text: string): string[];

export interface CheckResult {
  errors: string[];
  ok: string[];
}

export function checkPluginManifest(manifest: unknown): CheckResult;
export function checkMarketplace(manifest: unknown, knownPluginDirs?: string[]): CheckResult;
export function checkCommand(path: string, text: string): CheckResult;
export function checkSkill(path: string, text: string): CheckResult;
export function checkSkillNameMatchesDir(dirName: string, text: string): CheckResult;
export function checkPluginRootRefs(
  path: string,
  text: string,
  exists: (ref: string) => boolean
): CheckResult;
export function mergeResults(results: CheckResult[]): CheckResult;
