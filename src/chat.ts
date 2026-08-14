/**
 * Per-artifact chat.
 *
 * One Durable Object per artifact, keyed by slug — the coordination atom is a
 * single document's conversation, so a global object would be both a bottleneck
 * and a privacy problem.
 *
 * **Authorization is not this object's job.** The Worker decides who may open a
 * socket, using the same `canView` that decides who may read the artifact, and
 * only then hands the connection over. This object never sees a credential and
 * cannot be reached from outside the Worker. One rule governs "can you see this
 * document" and "can you see its conversation", rather than two rules that can
 * drift apart.
 *
 * See docs/superpowers/specs/2026-08-14-viewer-shell-design.md §7.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/** What the Worker vouches for when it hands over a socket. */
export interface ChatAuthor {
  /** Display identity. Null for a share-link viewer, who has no identity. */
  email: string | null;
  /** How they got here — shown so readers know who they are talking to. */
  kind: "owner" | "member" | "guest" | "link";
  /** The artifact version they were reading when they connected. */
  version: number;
}

interface StoredMessage extends Record<string, SqlStorageValue> {
  id: number;
  author_email: string | null;
  author_kind: string;
  version: number;
  body: string;
  created_at: string;
}

/** Long enough for a real thought, short enough that one message cannot flood a room. */
const MAX_BODY = 2000;
/** How much history a joiner receives. */
const HISTORY_LIMIT = 100;

export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema setup only — this is the one place blocking concurrency is correct,
    // because nothing may read the table before it exists.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          author_email TEXT,
          author_kind  TEXT NOT NULL,
          version      INTEGER NOT NULL,
          body         TEXT NOT NULL,
          created_at   TEXT NOT NULL
        )
      `);
    });
  }

  /**
   * Accept a socket the Worker has already authorized.
   *
   * Hibernation (`acceptWebSocket`) rather than `addEventListener`: a room that
   * is quiet for hours should not hold an object in memory, and a document's
   * conversation is quiet almost all of the time.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const author = this.authorFrom(request);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    // Attached rather than held in a map: hibernation discards memory, and the
    // attachment survives it.
    server.serializeAttachment(author);

    server.send(JSON.stringify({ type: "history", messages: this.recent() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The Worker is the only caller, so these headers are trustworthy by construction. */
  private authorFrom(request: Request): ChatAuthor {
    const email = request.headers.get("X-Chat-Email");
    const kind = (request.headers.get("X-Chat-Kind") ?? "guest") as ChatAuthor["kind"];
    const version = Number(request.headers.get("X-Chat-Version") ?? "0") || 0;
    return { email: email && email.length ? email : null, kind, version };
  }

  private recent(): StoredMessage[] {
    return this.ctx.storage.sql
      .exec<StoredMessage>(
        `SELECT id, author_email, author_kind, version, body, created_at
           FROM messages ORDER BY id DESC LIMIT ?`,
        HISTORY_LIMIT
      )
      .toArray()
      .reverse();
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;

    let parsed: { type?: string; body?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed.type !== "post") return;

    const body = String(parsed.body ?? "").trim().slice(0, MAX_BODY);
    if (!body) return;

    const author = ws.deserializeAttachment() as ChatAuthor | null;
    if (!author) return;

    const now = new Date().toISOString();
    // Persisted before broadcast: a message somebody saw but that was never
    // stored is worse than one that arrives a moment late.
    const row = this.ctx.storage.sql
      .exec<StoredMessage>(
        `INSERT INTO messages (author_email, author_kind, version, body, created_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id, author_email, author_kind, version, body, created_at`,
        author.email,
        author.kind,
        author.version,
        body,
        now
      )
      .one();

    this.broadcast({ type: "message", message: row });
  }

  private broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text);
      } catch {
        // A socket that has gone away is not an error worth failing a post over.
      }
    }
  }

  /** Read-only history, for callers that want it without a socket. */
  async history(): Promise<StoredMessage[]> {
    return this.recent();
  }
}
