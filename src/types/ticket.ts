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
}

export interface PresetCardItem {
  amount: number;
  label?: string;
  hotkey?: string; // e.g. 'a', 's', 'd'
}
