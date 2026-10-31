import { z } from "zod";

export const clientId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const roomName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u);
export const joinSchema = z.object({ room: roomName }).strict();
export const sendSchema = z
  .object({
    to: z.union([z.literal("all"), clientId]).default("all"),
    channel: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/)
      .default("general"),
    body: z.string().trim().min(1).max(2000),
    kind: z
      .enum(["note", "question", "answer", "directive", "done"])
      .default("note"),
    reply_to: z.number().int().positive().optional(),
    idempotency_key: z.string().min(1).max(128).optional(),
  })
  .strict();
export const ackSchema = z
  .object({ ids: z.array(z.number().int().positive()).min(1).max(100) })
  .strict();
export const inboxSchema = z
  .object({ limit: z.number().int().min(1).max(8).default(8) })
  .strict();
export const inboxNoticeSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    acknowledged: z.number().int().nonnegative(),
  })
  .strict();
export const toolDefinitions = [
  {
    name: "join_room",
    description:
      "Join the named task room, creating it if needed. Only explicitly joined, active participants are discoverable and addressable. Returns your identity and the room participants. Joining another room leaves the previous one. Room names are case-sensitive.",
    schema: joinSchema,
    read: false,
  },
  {
    name: "leave_room",
    description:
      "Leave your current task room and stop being discoverable or addressable. Device approval is retained.",
    schema: z.object({}).strict(),
    read: false,
  },
  {
    name: "send_message",
    description:
      "Send a message to all active participants in your joined room or one participant ID. Sender comes from your credential. Use idempotency_key for safe retries.",
    schema: sendSchema,
    read: false,
  },
  {
    name: "read_inbox",
    description:
      "Read up to eight unacknowledged messages, oldest first. Read in response to a channel notice or once when resuming work; do not poll.",
    schema: inboxSchema,
    read: true,
  },
  {
    name: "acknowledge_messages",
    description:
      "Acknowledge messages after processing. Notification delivery alone never acknowledges a message. More pending messages trigger another channel notice.",
    schema: ackSchema,
    read: false,
  },
  {
    name: "list_clients",
    description:
      "Discover active participants in your joined task room, including IDs, names, kinds, and live connections. No global agent directory.",
    schema: z.object({}).strict(),
    read: true,
  },
] as const;
export const toolCatalog = toolDefinitions.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: z.toJSONSchema(tool.schema, { io: "input" }) as {
    type: "object";
  },
  annotations: {
    readOnlyHint: tool.read,
    destructiveHint: false,
    openWorldHint: false,
  },
}));
