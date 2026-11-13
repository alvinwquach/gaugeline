/**
 * A local stand-in for Discord (X69, part 3): no real application, no token, no network. It holds the
 * messages a channel shows, "presses" their buttons by sending the signed interaction request Discord would
 * send (JSON, Ed25519 over timestamp + body, from an application key it generated), and applies the
 * callback the hosted app answers with (type 7 replaces the message, type 4 with flag 64 is shown to the
 * clicker only, type 6 changes nothing). Everything in it is invented (rule 12).
 */
import { generateKeyPairSync, randomInt, sign, type KeyObject } from "node:crypto";

interface Message {
  embeds: { title: string; description: string }[];
  components: { components: { custom_id?: string; url?: string }[] }[];
}

export class FakeDiscord {
  readonly channel = new Map<string, Message>();
  readonly private = new Map<string, string[]>();
  readonly publicKeyHex: string;
  private readonly privateKey: KeyObject;
  /** As posted: a stale copy of a replaced message still has its buttons, as in real Discord. */
  private readonly original = new Map<string, Message>();
  private n = 0;

  constructor(readonly guild: string) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.publicKeyHex = publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
    this.privateKey = privateKey;
  }

  post(body: unknown): string {
    const id = String(1_000_000_000_000 + ++this.n);
    this.channel.set(id, body as Message);
    this.original.set(id, body as Message);
    return id;
  }

  customIds(id: string): string[] {
    return (this.original.get(id)?.components[0]?.components ?? []).flatMap((c) =>
      c.custom_id ? [c.custom_id] : [],
    );
  }

  /** The signed request for pressing the button whose custom_id starts with `action` on message `id`. */
  press(
    id: string,
    action: string,
    user: string,
    over: {
      customId?: string;
      guild?: string | null;
      timestamp?: number;
      key?: KeyObject;
      mutate?: (p: Record<string, unknown>) => void;
      bot?: boolean;
    } = {},
  ) {
    const customId =
      over.customId ?? this.customIds(id).find((c) => c.startsWith(action + ":")) ?? action;
    const payload: Record<string, unknown> = {
      id: String(randomInt(1_000_000_000, 2_000_000_000)),
      application_id: "900000000000000001",
      type: 3,
      token: "invented-interaction-token",
      version: 1,
      ...(over.guild === null ? {} : { guild_id: over.guild ?? this.guild }),
      channel_id: "900000000000000002",
      ...(over.guild === null
        ? { user: { id: user, username: "invented.person" } }
        : {
            member: {
              user: { id: user, username: "invented.person", ...(over.bot ? { bot: true } : {}) },
            },
          }),
      message: { id },
      data: { custom_id: customId, component_type: 2 },
    };
    over.mutate?.(payload);
    return this.sign(JSON.stringify(payload), over);
  }

  /** A PING, as Discord sends one when an endpoint is registered. */
  ping(over: { key?: KeyObject; timestamp?: number } = {}) {
    return this.sign(JSON.stringify({ id: "900000000000000003", type: 1, version: 1 }), over);
  }

  private sign(body: string, over: { key?: KeyObject; timestamp?: number }) {
    const timestamp = over.timestamp ?? Math.floor(Date.now() / 1000);
    const signature = sign(
      null,
      Buffer.from(`${timestamp}${body}`),
      over.key ?? this.privateKey,
    ).toString("hex");
    return {
      path: (id: string) => `/api/chat/discord/${id}`,
      body,
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": signature,
        "x-signature-timestamp": String(timestamp),
      } as Record<string, string>,
    };
  }

  /** What Discord does with the callback the app answered with. */
  apply(
    callback: { type: number; data?: Record<string, unknown> },
    messageId: string,
    user: string,
  ): void {
    if (callback.type === 7) this.channel.set(messageId, callback.data as unknown as Message);
    else if (callback.type === 4 && callback.data?.flags === 64)
      this.private.set(user, [...(this.private.get(user) ?? []), String(callback.data.content)]);
  }
}
