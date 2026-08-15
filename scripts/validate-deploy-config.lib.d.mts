export const EXPECTED_APP_HOSTNAME: string;
export const EXPECTED_CONTENT_HOSTNAME: string;
export const EXPECTED_MCP_HOSTNAME: string;
export const DEFAULT_ADMIN_EMAIL_PLACEHOLDER: string;
export const DEFAULT_DATABASE_ID_PLACEHOLDER: string;

export function stripJsonComments(text: string): string;

export interface WranglerConfigCheck {
  errors: string[];
  pending: string[];
  ok: string[];
}

export function checkWranglerConfig(config: unknown): WranglerConfigCheck;
