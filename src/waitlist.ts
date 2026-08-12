import { Hono } from "hono";
import type { AppBindings } from "./env";
import { addToWaitlist } from "./db";

export const waitlist = new Hono<AppBindings>();

const MAX_EMAIL_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim/lowercase and validate an email; returns the cleaned value or null. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().toLowerCase();
  if (!clean || clean.length > MAX_EMAIL_LENGTH) return null;
  if (!EMAIL_RE.test(clean)) return null;
  return clean;
}

waitlist.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_email" }, 400);
  }
  const email = normalizeEmail((body as { email?: unknown } | null)?.email);
  if (!email) return c.json({ error: "invalid_email" }, 400);

  const joined = await addToWaitlist(c.env, email, new Date().toISOString());
  return c.json({ status: joined ? "joined" : "already" }, 200);
});

// A bookmarked/shared waitlist link should still land somewhere sensible.
waitlist.get("/", (c) => c.redirect("/#waitlist", 302));
