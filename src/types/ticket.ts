export type TicketStatus = 'paid' | 'collected' | 'void';

export interface Ticket {
  id: string; // Composite key: locationId-deviceId-localSeq
  locationId: string;
  deviceId: string;
  localSeq: number;
  amount: number;
  currency: string;
  status: TicketStatus;
  createdAt: string; // ISO 8601 string
  cashierId: string;
  voidReason?: string;
  voidedBy?: string;
  voidedAt?: string;
  qrPayload: string;
  /** Owning account: the admin's Supabase auth user id, and the tenant key the
   *  whole sync layer scopes by. */
  accountId?: string;
  /** Server-authoritative, set by the Postgres trigger — used for last-write-wins
   *  merges when reconciling remote changes into the local copy. */
  updatedAt?: string;
}

export interface PresetCardItem {
  amount: number;
  label?: string;
  hotkey?: string; // e.g. 'a', 's', 'd'
}
