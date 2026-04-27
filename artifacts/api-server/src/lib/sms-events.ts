// Tiny in-process pub/sub used by the customer SMS chat features. Every
// SMS event (new inbound, new outbound, blocklist change, unread mark)
// pushes an envelope onto the bus; the SSE endpoint wraps it as a
// `data:` line.
//
// Single-process Node deployment, so a Set of subscribers is enough.
// If we ever scale horizontally we'll need to swap this for Redis
// pub/sub or PG LISTEN/NOTIFY — every publish/subscribe goes through
// this module so the swap is local.

export type SmsEvent =
  | {
      type: "inbound";
      messageId: number;
      inquiryId: number | null;
      customerPhone: string;
      body: string;
      occurredAt: string;
    }
  | {
      type: "outbound";
      messageId: number;
      inquiryId: number | null;
      customerPhone: string;
      body: string;
      occurredAt: string;
      source: "admin" | "owner_relay" | "system";
    }
  | {
      type: "unmatched-changed";
    }
  | {
      type: "blocklist-changed";
      phone: string;
      blocked: boolean;
      reason?: "customer-opt-out" | "admin-blocked";
    }
  | {
      type: "messages-seen";
      inquiryId: number;
    };

type Listener = (ev: SmsEvent) => void;

const listeners = new Set<Listener>();

export function subscribeSmsEvents(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function publishSmsEvent(ev: SmsEvent): void {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch (err) {
      console.warn("[sms-events] listener threw, dropping", err);
    }
  }
}
