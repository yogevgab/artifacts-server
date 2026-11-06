export const CLIENT_NAME: string;
export const LOGIN_SCOPES: readonly string[];
export const RESOURCE_PATH: string;
export const AS_METADATA_PATH: string;
export const CONFIG_DIRNAME: string;
export const CREDENTIALS_FILENAME: string;
export const FILE_MODE: number;
export const DIR_MODE: number;
export const STORE_VERSION: number;
export const REFRESH_SKEW_SECONDS: number;

export interface OAuthCredential {
  issuer?: string | null;
  client_id?: string | null;
  access_token: string;
  refresh_token?: string | null;
  expires_at?: string | null;
  obtained_at?: string | null;
  scopes?: string[];
  token_endpoint?: string | null;
  revocation_endpoint?: string | null;
  resource?: string | null;
}

export interface CredentialStore {
  version: number;
  credentials: Record<string, OAuthCredential>;
}

export function configDir(env?: Record<string, string | undefined>, home?: string, join?: (...parts: string[]) => string): string;
export function credentialsPath(env?: Record<string, string | undefined>, home?: string, join?: (...parts: string[]) => string): string;
export function issuerFor(endpoint: unknown): string | null;
export function resourceFor(issuer: string): string;
export function emptyStore(): CredentialStore;
export function parseStore(text: unknown): CredentialStore;
export function serializeStore(store: Partial<CredentialStore>): string;
export function getCredential(store: CredentialStore | null | undefined, issuer: string | null): OAuthCredential | null;
export function putCredential(store: CredentialStore | null | undefined, issuer: string, credential: OAuthCredential): CredentialStore;
export function removeCredential(store: CredentialStore | null | undefined, issuer: string): CredentialStore;
export function isStoreEmpty(store: CredentialStore | null | undefined): boolean;
export function credentialFromTokenResponse(body: Record<string, unknown>, options: { issuer: string; clientId?: string | null; endpoints?: Record<string, string | null>; nowMs: number; previous?: OAuthCredential | null }): OAuthCredential;
export function needsRefresh(credential: OAuthCredential | null | undefined, nowMs: number, skewSeconds?: number): boolean;
export function isExpired(credential: OAuthCredential | null | undefined, nowMs: number): boolean;
export function describeCredential(credential: OAuthCredential | null | undefined): { issuer: string | null; client_id: string | null; token: string; token_id: string | null; scopes: string[]; expires_at: string | null; has_refresh_token: boolean } | null;
export function redactRefreshToken(token: unknown): string;

export const SOURCE_ENV: "env";
export const SOURCE_OAUTH: "oauth";
export const SOURCE_NONE: "none";
export function resolveCredentialSource(options: { env?: Record<string, string | undefined>; store?: CredentialStore | null; endpoint: string; tokenVar?: string }): { source: string; token: string; credential: OAuthCredential | null; issuer: string | null };

export class OAuthError extends Error {
  detail: string | null;
  hint: string | null;
  needsLogin: boolean;
  status: number | null;
  constructor(message: string, extra?: { detail?: string | null; hint?: string | null; needsLogin?: boolean; status?: number | null });
}

export function base64url(bytes: Uint8Array): string;
export function newCodeVerifier(randomBytes: (n: number) => Uint8Array): string;
export function newState(randomBytes: (n: number) => Uint8Array): string;
export function codeChallenge(verifier: string, digest: (bytes: Uint8Array) => Promise<ArrayBuffer>): Promise<string>;
export function metadataUrl(issuer: string): string;
export function parseMetadata(body: Record<string, unknown>, issuer: string): { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint: string | null; revocation_endpoint: string | null; scopes_supported: string[] | null };
export function registrationRequest(redirectUris: string[], scopes?: readonly string[]): Record<string, unknown>;
export function authorizeUrl(options: { authorizationEndpoint: string; clientId: string; redirectUri: string; scopes?: readonly string[]; state: string; challenge: string; resource?: string }): string;
export function formBody(params: Record<string, unknown>): string;
export function authorizationCodeForm(options: { clientId: string; code: string; codeVerifier: string; redirectUri: string }): string;
export function refreshForm(options: { clientId?: string | null; refreshToken: string }): string;
export function revokeForm(token: string): string;
export function parseCallback(requestUrl: string, expectedState: string): { ok: true; code: string; issuer: string | null } | { ok: false; error: string; detail: string };
export function postToken(options: { tokenEndpoint: string; body: string; fetchImpl: typeof fetch }): Promise<Record<string, unknown>>;
export function refreshCredential(options: { credential: OAuthCredential; fetchImpl: typeof fetch; nowMs: number }): Promise<OAuthCredential>;
