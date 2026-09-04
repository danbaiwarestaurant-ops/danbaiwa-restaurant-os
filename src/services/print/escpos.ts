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

/** Font A is 24 dots tall; every line costs that times the height magnification. */
const LINE_DOTS = 24;

/**
 * The largest magnification at which `text` still fits one line of this roll.
 *
 * Magnified text does not wrap gracefully — it wraps mid-word, at double or
 * quadruple size, and turns a total into nonsense. Sizing to the content instead means
 * a five-figure amount shrinks a step rather than spilling onto a second line, and a
 * long business name stays on one.
 */
export function fitWidth(text: string, columns: number, max: number): number {
  const len = Math.max(1, text.length);
  return Math.max(1, Math.min(max, Math.floor(columns / len)));
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
  /** Current height magnification, for the running height total. */
  private heightMul = 1;
  /** Dots of roll this receipt will consume — what 'ticket length' actually means. */
  private dotsTall = 0;

  constructor(readonly paper: PaperSpec) {}

  /** Roll consumed so far, in printer dots. */
  get heightDots(): number {
    return this.dotsTall;
  }

  /** Roll consumed so far, in millimetres, at the 203dpi these heads print. */
  get heightMm(): number {
    return this.dotsTall / 8;
  }

  raw(...b: number[]): this {
    this.bytes.push(...b);
    return this;
  }

  /**
   * Reset, pin the code page, and tighten the line spacing.
   *
   * ESC/POS powers up at 30 dots per line for a font that is only 24 dots tall, so every
   * plain line of every ticket carried 0.75mm of blank roll nobody asked for. ESC 3 24
   * sets the feed to exactly the character height. At a thousand tickets a day those
   * six dots a line are metres of paper a month.
   */
  init(): this {
    this.heightMul = 1;
    return this.raw(ESC, 0x40) // ESC @  — reset
      .raw(ESC, 0x74, 0x00)    // ESC t 0 — PC437
      .raw(ESC, 0x33, LINE_DOTS); // ESC 3 n — line spacing = one character height
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
    this.heightMul = h + 1;
    return this.raw(GS, 0x21, (w << 4) | h);
  }

  text(value: string): this {
    return this.raw(...encodeText(value));
  }

  line(value = ''): this {
    this.dotsTall += LINE_DOTS * this.heightMul;
    return this.text(value).raw(0x0a);
  }

  feed(lines = 1): this {
    const n = Math.min(255, Math.max(0, lines));
    this.dotsTall += LINE_DOTS * n;
    return this.raw(ESC, 0x64, n);
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
    this.dotsTall += heightPx;
    return this;
  }

  /**
   * Cut, letting the printer do its own feed to the blade.
   *
   * `GS V 66 n` means "feed to the cutting position, then partial cut" — the printer
   * already advances the head-to-blade distance itself. The extra feed this used to send
   * first was therefore bought twice: 6mm of blank roll on every ticket, on top of the
   * feed the printer was going to make anyway.
   *
   * `feedLines` exists for the printers that have no cutter at all. Those ignore GS V
   * entirely, so the feed is the only thing that gets the last line clear of the head to
   * be torn off. Callers with a cutter should leave it at 0.
   */
  cutAndFeed(feedLines = 0): this {
    if (feedLines > 0) this.feed(feedLines);
    return this.raw(GS, 0x56, 0x42, 0x00);
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
  paperWidthMm?: number;
  footerText?: string;
  /**
   * Printed only when the sale was not cash.
   *
   * Cash is what a ticket already implies, so labelling it would spend a line of roll on
   * every receipt to say nothing. A transfer is the case someone argues about later —
   * "I paid by transfer" — and that is the one worth the paper.
   */
  tenderText?: string;
}

/**
 * The ticket, laid out for a roll of the given width.
 *
 * Deliberately short. Every line printed is roll consumed and time at the counter, so
 * this carries only what someone actually needs off the paper: who issued it, how much,
 * which ticket, and when.
 *
 * What used to be here and is not any more:
 *
 *   * a QR code — a raster block roughly 28mm tall, over half the ticket, replaced by
 *     the tracking id printed as one plain line that a person can read out or type;
 *   * an "OFFICIAL RECEIPT / TICKET" subtitle and a "Scan to Verify" footer, which said
 *     nothing the ticket did not already say.
 *
 * Both widths run the same structure; only the column count differs, taken from the
 * paper spec, so an account changing printer changes one setting and nothing else.
 */
export async function composeTicket(spec: ReceiptSpec): Promise<EscPosBuilder> {
  const paper = paperSpec(spec.paperWidthMm);
  const b = new EscPosBuilder(paper);

  b.init().align(ALIGN_CENTER);

  // Taller than the body, and fitted so it never wraps: a business name broken across
  // two lines costs a line of roll and reads as a fault in the printer.
  const nameWidth = fitWidth(spec.businessName, paper.columns, 2);
  b.size(nameWidth, 2).bold(true).line(spec.businessName).bold(false);

  // The amount is the one thing read across a counter, so it stays the largest thing on
  // the ticket — but four times the body height is already that, and the sixth multiple
  // was costing 6mm of roll per ticket to say the same number.
  b.size(1, 1);
  const amountWidth = fitWidth(spec.amountText, paper.columns, 4);
  b.size(amountWidth, Math.min(4, amountWidth * 2)).bold(true).line(spec.amountText).bold(false);
  b.size(1, 1);

  // No rule between the two. An amount printed four times taller than everything around
  // it separates itself, and the line cost 3mm of every roll to repeat that.
  // The tracking id, on one line, in place of the QR block that used to sit here.
  b.bold(true).line(spec.ticketId).bold(false);
  if (spec.tenderText) b.bold(true).line(spec.tenderText).bold(false);
  b.line(spec.timestampText);

  if (spec.footerText) b.line(spec.footerText);

  // Nothing but the cut: GS V feeds to the blade on its own. See cutAndFeed.
  return b.cutAndFeed();
}

export async function buildTicketReceipt(spec: ReceiptSpec): Promise<Uint8Array> {
  return (await composeTicket(spec)).build();
}
/** Bytes → base64, for handing a receipt to the local agent over JSON. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
}
