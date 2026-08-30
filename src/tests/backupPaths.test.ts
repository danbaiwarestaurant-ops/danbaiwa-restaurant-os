/**
 * backupPaths.test.ts
 *
 * Locks in the rule that makes cloud disaster recovery work at all: a snapshot must be
 * findable by a machine that knows the ACCOUNT but not the device that wrote it.
 */

import { describe, it, expect } from 'vitest';
import {
  LATEST_FILE,
  SNAPSHOT_ROOT,
  candidateLocationDirs,
  isSnapshotFile,
  locationDir,
  normalizeSegment,
  pickNewestSnapshot,
  snapshotDir,
  snapshotPath,
  snapshotTimestamp,
} from '../utils/backupPaths';

describe('Cloud snapshot addressing', () => {
  it('keys snapshots by location first and device last', () => {
    expect(snapshotPath('LOC01', 'DEV01', LATEST_FILE)).toBe('snapshots/LOC01/DEV01/latest.json');
    // The device id must never appear before the location, otherwise a restoring
    // machine would have to guess it before it could even list the folder.
    expect(snapshotDir('LOC01', 'DEV01').startsWith(locationDir('LOC01'))).toBe(true);
  });

  it('scopes every device at a location under one listable folder', () => {
    const tillA = snapshotDir('LOC01', 'DEV01');
    const tillB = snapshotDir('LOC01', 'DEV02');
    expect(tillA).not.toBe(tillB);
    expect(tillA.startsWith('snapshots/LOC01/')).toBe(true);
    expect(tillB.startsWith('snapshots/LOC01/')).toBe(true);
  });

  it('normalises segments so the same place is never written to two folders', () => {
    expect(normalizeSegment('  main branch ', 'LOC01')).toBe('MAIN_BRANCH');
    expect(normalizeSegment('Main Branch', 'LOC01')).toBe(normalizeSegment('main branch', 'LOC01'));
    expect(normalizeSegment('a/b', 'LOC01')).toBe('A_B'); // never injects a path segment
    expect(normalizeSegment('', 'LOC01')).toBe('LOC01');
    expect(normalizeSegment(null, 'DEV01')).toBe('DEV01');
  });

  it('searches the account location before the local one, without duplicates', () => {
    expect(candidateLocationDirs('BRANCH2', 'LOC01')).toEqual([
      'snapshots/BRANCH2',
      'snapshots/LOC01',
    ]);
    expect(candidateLocationDirs('LOC01', 'loc01')).toEqual(['snapshots/LOC01']);
  });

  it('drops unknown locations rather than defaulting them to LOC01', () => {
    // Defaulting a missing cloud location to LOC01 would send a restore hunting in a
    // folder that has nothing to do with the account.
    expect(candidateLocationDirs(null, undefined, '  ')).toEqual([]);
    expect(candidateLocationDirs(null, 'BRANCH2')).toEqual(['snapshots/BRANCH2']);
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
    expect(locationDir('LOC01').startsWith(`${SNAPSHOT_ROOT}/`)).toBe(true);
  });
});
