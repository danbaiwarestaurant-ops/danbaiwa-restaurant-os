/**
 * escpos.test.ts
 *
 * The receipt is now bytes rather than HTML rendered through a headless Chromium, and
 * those bytes reach the printer by three different routes. Nothing between here and the
 * paper can catch a mistake: a wrong length field in a raster header does not throw, it
 * prints a page of noise, and a character the code page cannot represent shifts every
 * byte after it.
 *
 * These pin the parts a printer cannot forgive.
 */

import { describe, it, expect } from 'vitest';
import {
  EscPosBuilder,
  PAPER,
  buildTicketReceipt,
  bytesToBase64,
  composeTicket,
  encodeText,
  fitWidth,
  paperSpec,
} from '../services/print/escpos';

/** Index of the first occurrence of a byte sequence, or -1. */
function indexOfSeq(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

describe('paper spec', () => {
  it('defaults to 58mm and takes 80mm only when asked', () => {
    expect(paperSpec(undefined).widthMm).toBe(58);
    expect(paperSpec(58).widthMm).toBe(58);
    expect(paperSpec(80).widthMm).toBe(80);
    // A config carrying a width this build does not know must not silently print at a
    // width the head does not have.
    expect(paperSpec(76 as any).widthMm).toBe(58);
  });

  it('carries the printable dots and columns each head actually has', () => {
    expect(PAPER[58]).toMatchObject({ dots: 384, columns: 32 });
    expect(PAPER[80]).toMatchObject({ dots: 576, columns: 48 });
  });
});

describe('text encoding', () => {
  it('never emits a byte above the code page, whatever it is handed', () => {
    const bytes = encodeText('₦1,500 • Ọlá — "quoted"');
    expect(bytes.every((b) => b < 0x80)).toBe(true);
  });

  it('spells the naira sign rather than dropping or mangling it', () => {
    // It is on every receipt this business prints and is absent from CP437.
    expect(String.fromCharCode(...encodeText('₦2,000'))).toBe('N2,000');
  });

  it('substitutes one byte per unknown character, so nothing after it shifts', () => {
    const src = 'a中b';
    expect(encodeText(src)).toHaveLength(3);
    expect(encodeText(src)[1]).toBe(0x3f);
  });
});

describe('layout', () => {
  it('rules the full width of whichever roll is in use', () => {
    const narrow = new EscPosBuilder(PAPER[58]).rule('-').build();
    const wide = new EscPosBuilder(PAPER[80]).rule('-').build();
    // Content plus the trailing newline.
    expect(narrow).toHaveLength(33);
    expect(wide).toHaveLength(49);
  });

  it('right-aligns a value against the far edge of the roll', () => {
    const line = new EscPosBuilder(PAPER[58]).columns('TOTAL', 'N1,500').build();
    const text = String.fromCharCode(...line.slice(0, -1));
    expect(text).toHaveLength(32);
    expect(text.endsWith('N1,500')).toBe(true);
    expect(text.startsWith('TOTAL')).toBe(true);
  });

  it('breaks a too-long pair onto two lines rather than overrunning the head', () => {
    const line = new EscPosBuilder(PAPER[58])
      .columns('A VERY LONG LABEL INDEED FOR A RECEIPT', 'N1,000,000')
      .build();
    expect(String.fromCharCode(...line).split('\n').filter(Boolean)).toHaveLength(2);
  });
});

describe('QR raster', () => {
  it('declares a row length that matches the pixels it then sends', async () => {
    // A mismatch here does not throw — it prints a page of noise and jams the roll.
    const bytes = (await new EscPosBuilder(PAPER[58]).qr('DANBAIWA|TEST')).build();
    const at = indexOfSeq(bytes, [0x1d, 0x76, 0x30, 0x00]);
    expect(at).toBeGreaterThanOrEqual(0);

    const bytesPerRow = bytes[at + 4] | (bytes[at + 5] << 8);
    const rows = bytes[at + 6] | (bytes[at + 7] << 8);
    const payload = bytes.length - (at + 8);

    expect(bytesPerRow).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
    expect(payload).toBe(bytesPerRow * rows);
  });

  it('never lays a QR wider than the print head', async () => {
    for (const spec of [PAPER[58], PAPER[80]]) {
      const bytes = (await new EscPosBuilder(spec).qr('DANBAIWA|TEST|LONGER-PAYLOAD-HERE')).build();
      const at = indexOfSeq(bytes, [0x1d, 0x76, 0x30, 0x00]);
      const bytesPerRow = bytes[at + 4] | (bytes[at + 5] << 8);
      expect(bytesPerRow * 8).toBeLessThanOrEqual(spec.dots);
    }
  });

  it('prints a bigger QR on the wider roll', async () => {
    const read = async (spec: typeof PAPER[58]) => {
      const bytes = (await new EscPosBuilder(spec).qr('DANBAIWA|TEST')).build();
      const at = indexOfSeq(bytes, [0x1d, 0x76, 0x30, 0x00]);
      return bytes[at + 4] | (bytes[at + 5] << 8);
    };
    expect(await read(PAPER[80])).toBeGreaterThan(await read(PAPER[58]));
  });
});

describe('magnification fitting', () => {
  it('gives short text the largest size and steps long text down', () => {
    // Magnified text wraps mid-word at quadruple size, which turns a total into
    // nonsense — so the size follows the content rather than the content overflowing.
    expect(fitWidth('N500', 32, 4)).toBe(4);
    expect(fitWidth('N1,500,000', 32, 4)).toBe(3);
    expect(fitWidth('N1,500,000,000,000', 32, 4)).toBe(1);
  });

  it('never returns zero, however long the text', () => {
    expect(fitWidth('x'.repeat(500), 32, 4)).toBe(1);
    expect(fitWidth('', 32, 4)).toBe(4);
  });

  it('lets the wider roll hold the bigger size for the same text', () => {
    expect(fitWidth('Danbaiwa Restaurant', 48, 2)).toBeGreaterThanOrEqual(
      fitWidth('Danbaiwa Restaurant', 32, 2)
    );
  });
});

describe('the ticket receipt', () => {
  const spec = {
    businessName: 'Danbaiwa Restaurant',
    amountText: '₦1,500',
    ticketId: 'LOC01-DEV01-K3F9QZ-000042',
    timestampText: '02 Sep 2026, 14:05',
  };

  it('opens with a reset so the previous job cannot leak into this one', async () => {
    const bytes = await buildTicketReceipt(spec);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
  });

  it('feeds before cutting — the cutter sits past the head', async () => {
    const bytes = await buildTicketReceipt(spec);
    const cut = indexOfSeq(bytes, [0x1d, 0x56, 0x42]);
    const lastFeed = indexOfSeq(bytes.slice(cut - 3), [0x1b, 0x64]);
    expect(cut).toBeGreaterThan(0);
    expect(lastFeed).toBe(0);
  });

  it('prints the tracking id as one plain line, and no QR at all', async () => {
    const bytes = await buildTicketReceipt(spec);
    expect(indexOfSeq(bytes, encodeText(spec.ticketId))).toBeGreaterThan(0);
    // GS v 0 is the raster image command. Its absence is the QR's absence.
    expect(indexOfSeq(bytes, [0x1d, 0x76, 0x30, 0x00])).toBe(-1);
  });

  it('prints the amount at twice the magnification it used to', async () => {
    // Was GS ! with width 2, height 3 — nibbles (1,2). Now width 4, height 6 — (3,5).
    const bytes = await buildTicketReceipt(spec);
    expect(indexOfSeq(bytes, [0x1d, 0x21, (3 << 4) | 5])).toBeGreaterThan(0);
  });

  it('shrinks a very large amount rather than letting it wrap', async () => {
    const bytes = await buildTicketReceipt({ ...spec, amountText: '₦12,345,678.90' });
    // 14 characters cannot go above width 2 on a 32-column roll.
    expect(indexOfSeq(bytes, [0x1d, 0x21, (3 << 4) | 5])).toBe(-1);
    expect(indexOfSeq(bytes, [0x1d, 0x21, (1 << 4) | 3])).toBeGreaterThan(0);
  });

  it('prints the business name taller than the body text', async () => {
    const bytes = await buildTicketReceipt(spec);
    // Height nibble 2 means a 3x-tall line; whatever width it fitted to.
    const at = indexOfSeq(bytes, [0x1d, 0x21]);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(bytes[at + 2] & 0x0f).toBe(2);
  });

  it('is about half the length of the old QR ticket', async () => {
    const now = (await composeTicket(spec)).heightMm;

    // The layout as it stood: name, subtitle, rule, amount, rule, ticket line,
    // timestamp, a QR block, a footer, and four lines of feed.
    const before = new EscPosBuilder(PAPER[58]);
    before.init();
    before.size(2, 2).line(spec.businessName);
    before.size(1, 1).line('OFFICIAL RECEIPT / TICKET').rule('-');
    before.size(2, 3).line(spec.amountText);
    before.size(1, 1).rule('-').line('TICKET #' + spec.ticketId).line(spec.timestampText).feed(1);
    await before.qr('TICKET|' + spec.ticketId);
    before.feed(1).line('Scan to Verify * Non-Transferable').cutAndFeed(4);

    // 76.4mm before, 42mm now. The remaining floor is the amount itself: printed six
    // times taller than body text, it alone is 18mm, and the feed before the cut cannot
    // shrink much further without the cutter biting into the last line.
    expect(now).toBeLessThanOrEqual(before.heightMm * 0.56);
    expect(now).toBeLessThan(45);
  });

  it('produces the same receipt at both widths, differing only in size', async () => {
    const narrow = await buildTicketReceipt({ ...spec, paperWidthMm: 58 });
    const wide = await buildTicketReceipt({ ...spec, paperWidthMm: 80 });
    for (const bytes of [narrow, wide]) {
      expect(indexOfSeq(bytes, encodeText(spec.ticketId))).toBeGreaterThan(0);
      expect(indexOfSeq(bytes, encodeText('N1,500'))).toBeGreaterThan(0);
    }
  });

  it('survives the base64 round trip the local agent sends it through', async () => {
    const bytes = await buildTicketReceipt(spec);
    const restored = Buffer.from(bytesToBase64(bytes), 'base64');
    expect(Uint8Array.from(restored)).toEqual(bytes);
  });
});
