export type TicketStatus = 'paid' | 'collected' | 'void';

/**
 * How the ticket was settled.
 *
 * Two of these are money: 'cash' lands in the drawer, 'transfer' covers card and bank
 * transfer, which are the same thing to a cashier counting cash at close-out and so are
 * not separated.
 *
 * 'staff' is not money at all. A staff meal is a real plate leaving a real kitchen, so it
 * needs a real ticket the collector can honour — but nobody paid for it, and counting it
 * as revenue would report sales the business never took. It is excluded from every money
 * figure (see isRevenueTicket) and reported on its own as a cost.
 */
export type TicketTender = 'cash' | 'transfer' | 'staff';

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
  /**
   * The employee a staff meal was issued to. Set only when `tender` is 'staff'.
   *
   * A staff meal that names nobody is indistinguishable from a giveaway, which is the
   * whole reason to record it: an owner needs to see who ate and how often, not merely
   * that the kitchen served meals it was not paid for.
   */
  staffId?: string;
  /**
   * The employee's name as it stood when the meal was issued.
   *
   * Denormalised on purpose, exactly as Shift.cashierName is: the staff-meal report has
   * to keep reading correctly after an account is renamed or removed, and a report that
   * turns into a column of "Unknown" the moment someone leaves is no record at all.
   */
  staffName?: string;
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
