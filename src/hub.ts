import type { Message, Store } from "./store.js";

export type WireEvent =
  | { type: "message"; message: Message }
  | { type: "inbox"; acknowledged: number }
  | { type: "clients" | "devices" | "resync" };
type Listener = {
  client: string;
  send: (event: WireEvent) => void;
  close: () => void;
};

/** Live delivery is an optimization; only an explicit client acknowledgment clears the inbox. */
export class Hub {
  private listeners = new Set<Listener>();
  constructor(private store: Store) {}
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.publish({ type: "clients" });
    return () => {
      this.listeners.delete(listener);
      this.publish({ type: "clients" });
    };
  }
  online(id: string): number {
    return [...this.listeners].filter((item) => item.client === id).length;
  }
  publish(event: WireEvent, only?: string): void {
    for (const listener of this.listeners) {
      // A device/account revocation can invalidate several clients in one batch.
      // Remove every revoked listener before publishing roster or device data.
      if (!this.store.client(listener.client)) {
        this.listeners.delete(listener);
        listener.close();
        continue;
      }
      if (only && listener.client !== only) continue;
      if (
        event.type === "message" &&
        !this.store.message(listener.client, event.message.id)
      )
        continue;
      listener.send(event);
    }
  }
  disconnect(id: string): void {
    for (const listener of [...this.listeners]) {
      if (listener.client === id) {
        this.listeners.delete(listener);
        listener.close();
      }
    }
    this.publish({ type: "clients" });
  }
  close(): void {
    for (const listener of [...this.listeners]) listener.close();
    this.listeners.clear();
  }
}
