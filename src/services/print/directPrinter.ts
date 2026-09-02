/**
 * directPrinter.ts
 *
 * The till writing receipt bytes to the printer itself, from the page, with nothing
 * installed on the machine.
 *
 * This is the only silent path that survives being loaded from the Vercel URL as an
 * ordinary PWA. The local agent needs Node on every till and depends on an HTTPS page
 * being allowed to call http://127.0.0.1 — an exemption Chrome is in the middle of
 * putting behind a permission prompt, and one Safari and Firefox never granted at all.
 * `--kiosk-printing` needs Chrome to have been launched from a batch file. Neither can
 * be relied on for a device that simply opens the link.
 *
 * Two transports, because thermal printers present themselves in two different ways:
 *
 *   Web Serial — the printer (or its USB-to-serial bridge) shows up as a COM port. The
 *     vendor's Windows print driver is irrelevant here; the port is a separate device
 *     and both can coexist. This is the easy case and should always be tried first.
 *
 *   WebUSB — a USB printer with no COM port. On Windows the class driver (usbprint.sys)
 *     owns the interface and will not release it, so claimInterface fails until the
 *     device is rebound to WinUSB. That swap also removes the printer from "Printers &
 *     scanners", so the agent path stops working on that machine. Deliberately never
 *     attempted automatically — see pairUsb.
 *
 * Permission survives reloads and offline use: the browser remembers granted devices per
 * origin, so pairing is once per till, not once per shift.
 */

import { db } from '../db/dexieSchema';

const LINK_KEY = 'printer_link';

export type PrinterTransport = 'serial' | 'usb';

/**
 * How to find the paired printer again after a reload.
 *
 * Device handles cannot be persisted — only re-obtained from the browser's own grant
 * list — so what is stored is enough to recognise the right one among several.
 */
export interface PrinterLink {
  transport: PrinterTransport;
  vendorId?: number;
  productId?: number;
  /** Serial only. Thermal printers vary wildly; 9600 is the near-universal default. */
  baudRate?: number;
  label?: string;
  pairedAt: string;
}

export async function loadPrinterLink(): Promise<PrinterLink | null> {
  try {
    const row = await db.config.get(LINK_KEY);
    return (row?.value as PrinterLink) ?? null;
  } catch {
    return null;
  }
}

export async function savePrinterLink(link: PrinterLink): Promise<void> {
  await db.config.put({ key: LINK_KEY, value: link });
}

export async function clearPrinterLink(): Promise<void> {
  await db.config.delete(LINK_KEY);
}

const nav = (): any => (typeof navigator === 'undefined' ? {} : (navigator as any));

export function isSerialSupported(): boolean {
  return typeof nav().serial?.requestPort === 'function';
}

export function isUsbSupported(): boolean {
  return typeof nav().usb?.requestDevice === 'function';
}

export function isDirectPrintSupported(): boolean {
  return isSerialSupported() || isUsbSupported();
}

/** Both APIs are gated on a secure origin, which is worth saying separately. */
export function directPrintUnavailableReason(): string | null {
  if (typeof window === 'undefined') return 'Not running in a browser.';
  if (!window.isSecureContext) {
    return 'This address is not a secure origin, so the browser blocks direct printer access. Open the till over https:// or on localhost.';
  }
  if (!isDirectPrintSupported()) {
    return 'This browser has no Web Serial or WebUSB support. Direct printing needs Chrome or Edge on a computer — Safari, Firefox and iPad cannot do it.';
  }
  return null;
}

// ── Web Serial ───────────────────────────────────────────────────────────────

/** A port already granted to this origin, matched against the saved pairing. */
async function findGrantedSerialPort(link: PrinterLink | null): Promise<any | null> {
  if (!isSerialSupported()) return null;
  const ports: any[] = await nav().serial.getPorts();
  if (!ports.length) return null;
  if (!link?.vendorId) return ports[0];

  return (
    ports.find((p) => {
      const info = p.getInfo?.() ?? {};
      return info.usbVendorId === link.vendorId && info.usbProductId === link.productId;
    }) ?? ports[0]
  );
}

async function writeSerial(port: any, bytes: Uint8Array, baudRate: number): Promise<void> {
  // Opening a port already open throws; reopening one left open by a previous ticket is
  // both slower and a common source of "the second receipt never prints".
  let opened = false;
  if (!port.writable) {
    await port.open({ baudRate });
    opened = true;
  }

  const writer = port.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    // The lock must go back before anything else can use the port, even on failure.
    try {
      await writer.close();
    } catch {
      try {
        writer.releaseLock();
      } catch {
        /* already gone */
      }
    }
    if (opened) {
      try {
        await port.close();
      } catch {
        /* a closed port is the desired state either way */
      }
    }
  }
}

// ── WebUSB ───────────────────────────────────────────────────────────────────

async function findGrantedUsbDevice(link: PrinterLink | null): Promise<any | null> {
  if (!isUsbSupported()) return null;
  const devices: any[] = await nav().usb.getDevices();
  if (!devices.length) return null;
  if (!link?.vendorId) return devices[0];
  return (
    devices.find((d) => d.vendorId === link.vendorId && d.productId === link.productId) ??
    devices[0]
  );
}

/** The printer-class interface (USB class 0x07) and its bulk OUT endpoint. */
function findPrinterEndpoint(device: any): { interfaceNumber: number; endpoint: number } | null {
  for (const config of device.configurations ?? []) {
    for (const iface of config.interfaces ?? []) {
      for (const alt of iface.alternates ?? []) {
        if (alt.interfaceClass !== 0x07) continue;
        const out = (alt.endpoints ?? []).find(
          (e: any) => e.direction === 'out' && e.type === 'bulk'
        );
        if (out) return { interfaceNumber: iface.interfaceNumber, endpoint: out.endpointNumber };
      }
    }
  }
  return null;
}

async function writeUsb(device: any, bytes: Uint8Array): Promise<void> {
  if (!device.opened) await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);

  const target = findPrinterEndpoint(device);
  if (!target) {
    throw new Error('That USB device exposes no printer interface this browser can write to.');
  }

  await device.claimInterface(target.interfaceNumber);
  try {
    await device.transferOut(target.endpoint, bytes);
  } finally {
    try {
      await device.releaseInterface(target.interfaceNumber);
    } catch {
      /* releasing a lost interface is not itself a failure */
    }
  }
}

// ── Pairing (must be called from a user gesture) ─────────────────────────────

export interface PairResult {
  ok: boolean;
  link?: PrinterLink;
  message: string;
}

/**
 * Ask for a COM port. The browser shows its own device chooser; this cannot be triggered
 * without a click, by design.
 */
export async function pairSerial(baudRate = 9600): Promise<PairResult> {
  const blocked = directPrintUnavailableReason();
  if (blocked) return { ok: false, message: blocked };
  if (!isSerialSupported()) {
    return { ok: false, message: 'This browser has no Web Serial support.' };
  }

  try {
    const port = await nav().serial.requestPort();
    const info = port.getInfo?.() ?? {};
    const link: PrinterLink = {
      transport: 'serial',
      vendorId: info.usbVendorId,
      productId: info.usbProductId,
      baudRate,
      label: info.usbVendorId
        ? `Serial printer ${info.usbVendorId.toString(16)}:${String(info.usbProductId).padStart(4, '0')}`
        : 'Serial printer',
      pairedAt: new Date().toISOString(),
    };
    await savePrinterLink(link);
    return { ok: true, link, message: 'Printer paired. Receipts will now print silently on this till.' };
  } catch (e: any) {
    // A cancelled chooser throws exactly like a real failure; it is not one.
    if (e?.name === 'NotFoundError') {
      return { ok: false, message: 'No printer was selected.' };
    }
    return { ok: false, message: e?.message || 'Could not pair that serial port.' };
  }
}

/**
 * Ask for a USB printer.
 *
 * Separate from pairSerial and never tried automatically: on Windows this only succeeds
 * after the printer has been rebound to WinUSB, which takes it out of "Printers &
 * scanners" for every other program on the machine. That is a decision for whoever sets
 * the till up, not something a fallback chain should make on their behalf.
 */
export async function pairUsb(): Promise<PairResult> {
  const blocked = directPrintUnavailableReason();
  if (blocked) return { ok: false, message: blocked };
  if (!isUsbSupported()) {
    return { ok: false, message: 'This browser has no WebUSB support.' };
  }

  try {
    const device = await nav().usb.requestDevice({ filters: [{ classCode: 0x07 }] });
    const link: PrinterLink = {
      transport: 'usb',
      vendorId: device.vendorId,
      productId: device.productId,
      label: device.productName || 'USB printer',
      pairedAt: new Date().toISOString(),
    };
    await savePrinterLink(link);
    return { ok: true, link, message: `Paired with ${link.label}.` };
  } catch (e: any) {
    if (e?.name === 'NotFoundError') {
      return { ok: false, message: 'No printer was selected.' };
    }
    return { ok: false, message: e?.message || 'Could not pair that USB device.' };
  }
}

// ── Printing ─────────────────────────────────────────────────────────────────

/** Whether a paired printer is present and reachable right now. */
export async function isDirectPrinterReady(): Promise<boolean> {
  const link = await loadPrinterLink();
  if (!link) return false;
  try {
    if (link.transport === 'serial') return !!(await findGrantedSerialPort(link));
    return !!(await findGrantedUsbDevice(link));
  } catch {
    return false;
  }
}

/**
 * Send bytes to the paired printer.
 *
 * Throws rather than returning false, so the caller's fallback chain treats an unplugged
 * printer the same as an absent one and moves on to the local agent.
 */
export async function printDirect(bytes: Uint8Array): Promise<void> {
  const link = await loadPrinterLink();
  if (!link) throw new Error('No printer is paired with this till.');

  if (link.transport === 'serial') {
    const port = await findGrantedSerialPort(link);
    if (!port) {
      throw new Error(
        'The paired printer is not connected. Check the cable, or pair it again from Settings.'
      );
    }
    await writeSerial(port, bytes, link.baudRate ?? 9600);
    return;
  }

  const device = await findGrantedUsbDevice(link);
  if (!device) {
    throw new Error(
      'The paired USB printer is not connected. Check the cable, or pair it again from Settings.'
    );
  }
  await writeUsb(device, bytes);
}
