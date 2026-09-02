/**
 * escpos.ts
 *
 * The receipt, as the bytes a thermal printer actually understands.
 *
 * Every silent-printing route ends up here — the browser talking to the printer over Web
 * Serial or WebUSB, and the local agent talking to it through the Windows spooler — so
 * the receipt is defined once and comes out identical whichever route carried it. The
 * previous arrangement rendered HTML to a PDF through a headless Chromium: ~150MB of
 * dependency, a second or two per ticket, and a layout at the mercy of whatever paper
 * size the printer driver claimed to have.
 *
 * Nothing here touches the DOM or the network, which is what lets the same module run in
 * the browser and under Node.
 */

import QRCode from 'qrcode';

/** The two roll widths in use. Accounts differ, so this travels with the account. */
export type PaperWidthMm = 58 | 80;

export interface PaperSpec {
  widthMm: PaperWidthMm;
  /** Printable dots across the head. Not the same as mm × dpi: the roll has margins. */
  dots: number;
  /** Columns at Font A (12×24 dots per character). */
  columns: number;
}

/**
 * 58mm heads print 384 dots, 80mm heads 576 — near-universal across the cheap ESC/POS
 * market, and the two numbers every QR and separator below is sized against.
 */
export const PAPER: Record<PaperWidthMm, PaperSpec> = {
  58: { widthMm: 58, dots: 384, columns: 32 },
  80: { widthMm: 80, dots: 576, columns: 48 },
};

export function paperSpec(widthMm: number | undefined): PaperSpec {
  return Number(widthMm) === 80 ? PAPER[80] : PAPER[58];
}

// ── Command bytes ────────────────────────────────────────────────────────────
const ESC = 0x1b;
const GS = 0x1d;

export const ALIGN_LEFT = 0;
export const ALIGN_CENTER = 1;
export const ALIGN_RIGHT = 2;

/**
 * Characters a printer can render from a single-byte code page, and what to send instead
 * of the ones it cannot.
 *
 * The naira sign is the reason this exists: it appears on every receipt this business
 * prints and is absent from CP437, so sending it raw produces a stray glyph or nothing.
 * Currency and punctuation the app actually emits are mapped by hand; anything else
 * unknown degrades to '?' rather than corrupting the byte stream and shifting every
 * character after it.
 */
const TRANSLITERATIONS: Record<string, string> = {
  '₦': 'N',
  '₵': 'C',
  '₤': 'L',
  '€': 'EUR',
  '£': 'GBP',
  '•': '*',
  '–': '-',
  '—': '-',
  '‑': '-',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '…': '...',
  '×': 'x',
  ' ': ' ',
};

/** One printable line's worth of text, as code-page bytes. */
export function encodeText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const mapped = TRANSLITERATIONS[ch] ?? ch;
    for (let i = 0; i < mapped.length; i++) {
      const code = mapped.charCodeAt(i);
      out.push(code < 0x80 ? code : 0x3f); // '?' — never a multi-byte sequence
    }
  }
  return out;
}

/**
 * Accumulates a command stream.
 *
 * Deliberately a plain array of bytes rather than a string: ESC/POS interleaves binary
 * image data with text, and a string would have to survive an encoding round-trip that
 * mangles anything above 0x7f.
 */
export class EscPosBuilder {
  private bytes: number[] = [];

  constructor(readonly paper: PaperSpec) {}

  raw(...b: number[]): this {
    this.bytes.push(...b);
    return this;
  }

  /** Reset, then pin the code page so the printer's power-on default cannot surprise us. */
  init(): this {
    return this.raw(ESC, 0x40).raw(ESC, 0x74, 0x00); // ESC @ , ESC t 0 (PC437)
  }

  align(mode: number): this {
    return this.raw(ESC, 0x61, mode);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /** Character magnification, 1–8 in each axis. GS ! packs both into one nibble each. */
  size(width: number, height: number): this {
    const w = Math.min(8, Math.max(1, width)) - 1;
    const h = Math.min(8, Math.max(1, height)) - 1;
    return this.raw(GS, 0x21, (w << 4) | h);
  }

  text(value: string): this {
    return this.raw(...encodeText(value));
  }

  line(value = ''): this {
    return this.text(value).raw(0x0a);
  }

  feed(lines = 1): this {
    return this.raw(ESC, 0x64, Math.min(255, Math.max(0, lines)));
  }

  /** A full-width rule, drawn in the character the caller wants it drawn in. */
  rule(char = '-'): this {
    return this.line(char.repeat(this.paper.columns));
  }

  /**
   * A label on the left and a value hard against the right edge, on one line.
   * Falls back to two lines when they cannot both fit, rather than wrapping mid-word.
   */
  columns(left: string, right: string): this {
    const width = this.paper.columns;
    const gap = width - left.length - right.length;
    if (gap < 1) return this.line(left).line(right.padStart(width));
    return this.line(left + ' '.repeat(gap) + right);
  }

  /**
   * A QR code, sent as a raster bitmap rather than through the printer's own QR
   * commands (GS ( k).
   *
   * The native commands are faster but unevenly implemented across the cheap printers
   * this runs on — several accept them and print nothing at all, which on a ticket whose
   * whole purpose is being scanned is a silent failure. A raster image is understood by
   * every ESC/POS printer made, and the till cannot tell which one it is talking to.
   */
  async qr(data: string, targetDots?: number): Promise<this> {
    const qr = QRCode.create(data, { errorCorrectionLevel: 'M' });
    const modules = qr.modules;
    const quiet = 2; // modules of mandatory white border
    const gridSize = modules.size + quiet * 2;

    // Largest whole-module scale that still fits the head, so the image is never
    // resampled and every module lands on an exact dot boundary.
    const budget = targetDots ?? Math.floor(this.paper.dots * 0.6);
    const scale = Math.max(1, Math.floor(budget / gridSize));

    const widthPx = gridSize * scale;
    const bytesPerRow = Math.ceil(widthPx / 8);
    const heightPx = widthPx;

    const raster = new Uint8Array(bytesPerRow * heightPx);
    for (let y = 0; y < heightPx; y++) {
      const gridY = Math.floor(y / scale) - quiet;
      for (let x = 0; x < widthPx; x++) {
        const gridX = Math.floor(x / scale) - quiet;
        const dark =
          gridY >= 0 &&
          gridX >= 0 &&
          gridY < modules.size &&
          gridX < modules.size &&
          modules.get(gridY, gridX);
        if (dark) raster[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }

    // GS v 0 — print raster bit image. m=0 is normal density.
    this.raw(GS, 0x76, 0x30, 0x00);
    this.raw(bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff);
    this.raw(heightPx & 0xff, (heightPx >> 8) & 0xff);
    this.bytes.push(...raster);
    return this;
  }

  /**
   * Advance the roll clear of the head and cut.
   *
   * The feed is not decoration: on every one of these printers the cutter sits some
   * millimetres past the print head, so without it the cut lands in the middle of the
   * last few lines. Printers with no cutter ignore GS V and simply keep the feed.
   */
  cutAndFeed(feedLines = 4): this {
    return this.feed(feedLines).raw(GS, 0x56, 0x42, 0x00);
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

// ── The receipt itself ───────────────────────────────────────────────────────

export interface ReceiptSpec {
  businessName: string;
  /** Already formatted for display, currency symbol included. */
  amountText: string;
  ticketId: string;
  timestampText: string;
  /** Encoded into the QR — what a scanner reads back. */
  qrData: string;
  paperWidthMm?: number;
  footerText?: string;
}

/**
 * The ticket, laid out for a roll of the given width.
 *
 * Both widths run the same structure; only the column count and the QR's dot budget
 * differ, both taken from the paper spec, so an account that changes printer changes one
 * setting and nothing else.
 */
export async function buildTicketReceipt(spec: ReceiptSpec): Promise<Uint8Array> {
  const paper = paperSpec(spec.paperWidthMm);
  const b = new EscPosBuilder(paper);

  b.init().align(ALIGN_CENTER);

  b.size(2, 2).bold(true).line(spec.businessName).bold(false).size(1, 1);
  b.line('OFFICIAL RECEIPT / TICKET');
  b.rule('-');

  // The amount is the one thing read across a counter, so it gets the largest type the
  // head can produce without overrunning the roll.
  b.size(2, 3).bold(true).line(spec.amountText).bold(false).size(1, 1);
  b.rule('-');

  b.bold(true).line(`TICKET #${spec.ticketId}`).bold(false);
  b.line(spec.timestampText);
  b.feed(1);

  await b.qr(spec.qrData);
  b.feed(1);

  b.line(spec.footerText ?? 'Scan to Verify * Non-Transferable');

  return b.cutAndFeed().build();
}

/** Bytes → base64, for handing a receipt to the local agent over JSON. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
}
