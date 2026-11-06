import { z } from "zod";

export const clientId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const roomName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u);
export const participantName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}]+$/u)
  .refine((name) => name.toLowerCase() !== "all", {
    message: '"all" is reserved for broadcasts',
  });
export const joinSchema = z
  .object({ room: roomName, name: participantName.optional() })
  .strict();
export const heartbeatSchema = z.object({ room: roomName }).strict();
export const sendSchema = z
  .object({
    to: z.string().trim().min(1).max(80).default("all"),
    channel: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/)
      .default("general"),
    body: z.string().trim().min(1).max(8000),
    reply_to: z.number().int().positive().optional(),
    idempotency_key: z.string().min(1).max(128).optional(),
  })
  .strict();
export const ackSchema = z
  .object({ ids: z.array(z.number().int().positive()).min(1).max(100) })
  .strict();
export const inboxSchema = z
  .object({ limit: z.number().int().min(1).max(4).default(4) })
  .strict();
export const inboxNoticeSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    acknowledged: z.number().int().nonnegative(),
  })
  .strict();

/** A room message as agents see it: participants are addressed by their room names. */
export type AgentMessage = {
  id: number;
  room: string;
  from: string;
  to: string;
  body: string;
  reply_to: number | null;
  created_at: string;
};
export const agentMessage = (message: {
  id: number;
  room: string | null;
  sender_name: string;
  recipient_name: string | null;
  body: string;
  reply_to: number | null;
  created_at: string;
}): AgentMessage => ({
  id: message.id,
  room: message.room!,
  from: message.sender_name,
  to: message.recipient_name ?? "all",
  body: message.body,
  reply_to: message.reply_to,
  created_at: message.created_at,
});
export const agentParticipant = (participant: {
  name: string;
  kind: string;
  client_name: string;
  status: "active" | "away";
}) => ({
  name: participant.name,
  kind: participant.kind,
  client_name: participant.client_name,
  status: participant.status,
});

/** Names every rejected field so an agent can correct its call without guessing. */
export function invalidArguments(
  error: z.ZodError,
  schema?: z.ZodType,
): { error: string; accepted_fields?: string[] } {
  const issues = error.issues.map((issue) =>
    issue.code === "unrecognized_keys"
      ? "unknown field" +
        (issue.keys.length > 1 ? "s " : " ") +
        issue.keys.map((key) => JSON.stringify(key)).join(", ")
      : (issue.path.length ? issue.path.join(".") + ": " : "") + issue.message,
  );
  return {
    error: "Invalid arguments: " + issues.join("; "),
    ...(schema instanceof z.ZodObject
      ? { accepted_fields: Object.keys(schema.shape) }
      : {}),
  };
}
export const toolDefinitions = [
  {
    name: "join_room",
    description:
      "Join the named task room, creating it if needed. Optionally choose the name you appear under in this room, such as your role; it defaults to your device name and is kept when rejoining the same room without a name. Names are unique per room, ignoring case. Peers address you by this name. Membership survives restarts: you stay in the room, marked away while disconnected, until you leave or join another room. Returns your room name and the participants. Room names are case-sensitive.",
    schema: joinSchema,
    read: false,
  },
  {
    name: "leave_room",
    description:
      "Leave your current task room when the task is finished. You stop being discoverable or addressable and no longer receive its messages. Device approval is retained.",
    schema: z.object({}).strict(),
    read: false,
  },
  {
    name: "send_message",
    description:
      'Send a message to one participant of your room by name, or to "all". Away participants receive it when they return. Bodies hold up to 8000 characters. Setting reply_to acknowledges that message for you. After sending a request, end your turn: the reply arrives as a channel notice. Use idempotency_key for safe retries.',
    schema: sendSchema,
    read: false,
  },
  {
    name: "read_inbox",
    description:
      "Read up to four unacknowledged messages, oldest first. Read in response to a channel notice or once when resuming work; do not poll or wait in a loop.",
    schema: inboxSchema,
    read: true,
  },
  {
    name: "acknowledge_messages",
    description:
      "Acknowledge messages after handling them, including ones you answered without reply_to. Notification delivery alone never acknowledges a message. More pending messages trigger another channel notice.",
    schema: ackSchema,
    read: false,
  },
  {
    name: "list_clients",
    description:
      "List the participants of your task room: the names to address them by, kinds, client names and whether each is active or away. No global agent directory.",
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
