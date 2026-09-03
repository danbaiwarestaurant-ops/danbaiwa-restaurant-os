export type TicketStatus = 'paid' | 'collected' | 'void';

/**
 * How the customer paid.
 *
 * Only two buckets by design: money that lands in the drawer, and money that does not.
 * Card and bank transfer are the same thing to a cashier counting cash at close-out, so
 * they are not separated here.
 */
export type TicketTender = 'cash' | 'transfer';

export interface Ticket {
  id: string; // Composite key: locationId-deviceId-localSeq
  locationId: string;
  deviceId: string;
  localSeq: number;
  amount: number;
  currency: string;
  status: TicketStatus;
  /**
   * Optional on purpose: every ticket written before the split existed was a drawer sale,
   * so an absent tender must read as cash. Never narrow this to a required field without
   * backfilling — reconciliation would start dropping historic cash from expected cash.
   */
  tender?: TicketTender;
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
