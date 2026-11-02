import { describe, expect, it, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { purgeArtifact } from "../src/api";
import { initDb, clearR2 } from "./fixtures";

/**
 * Deleting an artifact erases its chat room. Rooms are keyed by slug, so a room
 * that outlived its artifact would show the old conversation to whoever later
 * publishes — and shares — a new artifact under the same slug.
 */

const SLUG = "chat-purge-demo";

beforeEach(async () => {
  await initDb();
  await clearR2();
});

const room = () => (env as any).CHAT.get((env as any).CHAT.idFromName(SLUG));

async function messageCount(): Promise<number> {
  return runInDurableObject(room(), async (_instance: unknown, state: DurableObjectState) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n
  );
}

describe("purgeArtifact", () => {
  it("erases the artifact's chat history", async () => {
    await runInDurableObject(room(), async (_instance: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(
        "INSERT INTO messages (author_email, author_kind, version, body, created_at) VALUES (?, ?, ?, ?, ?)",
        "alice@test.com",
        "member",
        1,
        "the confidential bit",
        new Date().toISOString()
      );
    });
    expect(await messageCount()).toBe(1);

    await purgeArtifact(env as any, SLUG);

    expect(await messageCount()).toBe(0);
  });

  it("still deletes the artifact when no chat binding is configured", async () => {
    await expect(purgeArtifact({ ...(env as any), CHAT: undefined }, SLUG)).resolves.toMatchObject({
      versions: 0,
    });
  });
});
