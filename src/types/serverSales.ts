/**
 * serverSales.ts
 *
 * How many tickets a server turned over on a given trading day, as entered by a manager.
 *
 * Everything else the system reports is a by-product of something that happened at the
 * till: a sale was rung up, so there is a ticket. A server never touches the till — they
 * take orders on the floor and the cashier handles the money — so nothing about their
 * individual selling exists in the data at all. It is counted on paper at the end of
 * service and typed in here. That makes this the one table in the system whose contents
 * are an assertion rather than a record, which is why every row carries who entered it
 * and when.
 */

export interface ServerSalesEntry {
  /**
   * `<businessDay>_<serverId>` — deliberately derived rather than random.
   *
   * A count for one server on one day is a single fact, and a manager correcting Tuesday's
   * number on the office laptop after entering it on the till must overwrite Tuesday's
   * number, not add a second one. With a random id the two rows would both survive and the
   * day would read double. With this one they collide on the primary key and last-write-wins
   * settles it — the same rule every other table already syncs under. See serverSalesId().
   */
  id: string;
  /** The staff row this count belongs to. */
  serverId: string;
  /**
   * Denormalised at entry, like `Shift.cashierName`, so a season's figures still name
   * people after they have left the roster and their user row is gone.
   */
  serverName: string;
  /** Trading day as `YYYY-MM-DD`, from businessDayKey — the 6am-to-6am day, not the calendar one. */
  businessDay: string;
  /** Tickets turned over. A whole number; zero is a real answer and is stored as one. */
  ticketCount: number;
  /** Optional free text — "left after lunch", "covering two sections". */
  note?: string;
  /** The manager who typed it in, and when. Kept because this figure is asserted, not observed. */
  recordedBy: string;
  recordedByName?: string;
  recordedAt: string;
  locationId?: string;
  /** Owning account: the admin's Supabase auth user id, the tenant key the sync layer scopes by. */
  accountId?: string;
  /** Server-authoritative, set by the Postgres trigger — drives last-write-wins merges. */
  updatedAt?: string;
}

/** The one place the composite key is built. See ServerSalesEntry.id. */
export function serverSalesId(businessDay: string, serverId: string): string {
  return `${businessDay}_${serverId}`;
}
