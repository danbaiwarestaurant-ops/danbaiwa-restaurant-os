/**
 * backupPaths.test.ts
 *
 * Locks in the two rules that make cloud disaster recovery work at all, and safely:
 * a snapshot must be findable by a machine that knows the ACCOUNT but not the device
 * that wrote it, and it must be unreachable from any other account. The second rule is
 * newer, and its absence was not theoretical — two accounts on the default location
 * shared one snapshots/LOC01 folder, so a fresh till restored the wrong tenant's whole
 * database and then spent its life being refused when it tried to re-upload it.
 */

import { describe, it, expect } from 'vitest';
import {
  LATEST_FILE,
  SNAPSHOT_ROOT,
  accountDir,
  accountSegment,
  candidateLocationDirs,
  isSnapshotFile,
  locationDir,
  normalizeSegment,
  pickNewestSnapshot,
  snapshotDir,
  snapshotPath,
  snapshotTimestamp,
} from '../utils/backupPaths';

const ACCOUNT = 'ce7ed427-7f95-4852-b80e-a3739ef025a4';
const OTHER_ACCOUNT = '6894e791-18b1-4f53-83c7-0f644312eed5';

describe('Cloud snapshot addressing', () => {
  it('keys snapshots by account first, location next and device last', () => {
    expect(snapshotPath(ACCOUNT, 'LOC01', 'DEV01', LATEST_FILE)).toBe(
      `snapshots/${ACCOUNT}/LOC01/DEV01/latest.json`
    );
    // The device id must never appear before the location, otherwise a restoring
    // machine would have to guess it before it could even list the folder.
    expect(snapshotDir(ACCOUNT, 'LOC01', 'DEV01')!.startsWith(locationDir(ACCOUNT, 'LOC01')!)).toBe(true);
  });

  it('puts two accounts on the same location in different folders', () => {
    // The whole point: identical location and device, different tenants, no overlap.
    const mine = snapshotDir(ACCOUNT, 'LOC01', 'DEV01')!;
    const theirs = snapshotDir(OTHER_ACCOUNT, 'LOC01', 'DEV01')!;
    expect(mine).not.toBe(theirs);
    expect(mine.startsWith(accountDir(ACCOUNT)!)).toBe(true);
    expect(theirs.startsWith(accountDir(ACCOUNT)!)).toBe(false);
  });

  it('refuses to address a snapshot when the account is unknown', () => {
    // Null is a refusal, not a default — guessing would file it under somebody.
    expect(accountSegment('  ')).toBeNull();
    expect(accountDir(null)).toBeNull();
    expect(snapshotDir(null, 'LOC01', 'DEV01')).toBeNull();
    expect(snapshotPath(undefined, 'LOC01', 'DEV01', LATEST_FILE)).toBeNull();
  });

  it('keeps the account segment comparable to current_account_id()', () => {
    // A storage policy compares this segment against current_account_id()::text, which
    // Postgres renders lowercase — so unlike location and device it must not be mangled.
    expect(accountSegment(' CE7ED427-7f95-4852-b80e-a3739ef025a4 ')).toBe(ACCOUNT);
  });

  it('scopes every device at a location under one listable folder', () => {
    const tillA = snapshotDir(ACCOUNT, 'LOC01', 'DEV01')!;
    const tillB = snapshotDir(ACCOUNT, 'LOC01', 'DEV02')!;
    expect(tillA).not.toBe(tillB);
    expect(tillA.startsWith(`snapshots/${ACCOUNT}/LOC01/`)).toBe(true);
    expect(tillB.startsWith(`snapshots/${ACCOUNT}/LOC01/`)).toBe(true);
  });

  it('normalises segments so the same place is never written to two folders', () => {
    expect(normalizeSegment('  main branch ', 'LOC01')).toBe('MAIN_BRANCH');
    expect(normalizeSegment('Main Branch', 'LOC01')).toBe(normalizeSegment('main branch', 'LOC01'));
    expect(normalizeSegment('a/b', 'LOC01')).toBe('A_B'); // never injects a path segment
    expect(normalizeSegment('', 'LOC01')).toBe('LOC01');
    expect(normalizeSegment(null, 'DEV01')).toBe('DEV01');
  });

  it('searches the account location before the local one, without duplicates', () => {
    expect(candidateLocationDirs(ACCOUNT, 'BRANCH2', 'LOC01')).toEqual([
      `snapshots/${ACCOUNT}/BRANCH2`,
      `snapshots/${ACCOUNT}/LOC01`,
    ]);
    expect(candidateLocationDirs(ACCOUNT, 'LOC01', 'loc01')).toEqual([`snapshots/${ACCOUNT}/LOC01`]);
  });

  it('drops unknown locations rather than defaulting them to LOC01', () => {
    // Defaulting a missing cloud location to LOC01 would send a restore hunting in a
    // folder that has nothing to do with the account.
    expect(candidateLocationDirs(ACCOUNT, null, undefined, '  ')).toEqual([]);
    expect(candidateLocationDirs(ACCOUNT, null, 'BRANCH2')).toEqual([`snapshots/${ACCOUNT}/BRANCH2`]);
    // And with no account there is nowhere to search at all, rather than everywhere.
    expect(candidateLocationDirs(null, 'LOC01')).toEqual([]);
  });

  it('recognises hot and dated snapshot files', () => {
    expect(isSnapshotFile('latest.json')).toBe(true);
    expect(isSnapshotFile('2026-08-16.json')).toBe(true);
    expect(isSnapshotFile('.emptyFolderPlaceholder')).toBe(false);
  });

  it('picks the newest snapshot across devices deterministically', () => {
    const newest = pickNewestSnapshot([
      { path: 'snapshots/LOC01/DEV01/latest.json', updatedAt: 1000 },
      { path: 'snapshots/LOC01/DEV02/latest.json', updatedAt: 5000 },
      { path: 'snapshots/LOC01/DEV03/2026-08-01.json', updatedAt: 2000 },
    ]);
    expect(newest?.path).toBe('snapshots/LOC01/DEV02/latest.json');

    // Ties resolve the same way every run.
    const tied = pickNewestSnapshot([
      { path: 'snapshots/LOC01/DEV02/latest.json', updatedAt: 42 },
      { path: 'snapshots/LOC01/DEV01/latest.json', updatedAt: 42 },
    ]);
    expect(tied?.path).toBe('snapshots/LOC01/DEV01/latest.json');

    expect(pickNewestSnapshot([])).toBeNull();
  });

  it('falls back to the filename date when storage reports no timestamps', () => {
    expect(snapshotTimestamp({ name: 'latest.json', updated_at: '2026-08-16T10:00:00Z' }))
      .toBe(new Date('2026-08-16T10:00:00Z').getTime());
    expect(snapshotTimestamp({ name: '2026-08-01.json' })).toBe(new Date('2026-08-01').getTime());
    expect(snapshotTimestamp({ name: 'latest.json' })).toBe(0);
  });

  it('keeps every snapshot under one scannable root', () => {
    expect(locationDir(ACCOUNT, 'LOC01')!.startsWith(`${SNAPSHOT_ROOT}/`)).toBe(true);
  });
});
