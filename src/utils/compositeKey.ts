/**
 * Generates a composite ticket key based on Location ID, Device ID, and Local Sequence.
 * Composite format: `${locationId}-${deviceId}-${seqPadded}`
 * Example: `LOC01-DEV01-000042`
 */
export function generateCompositeKey(
  locationId: string,
  deviceId: string,
  seq: number
): string {
  const cleanLoc = locationId.trim().toUpperCase() || 'LOC01';
  const cleanDev = deviceId.trim().toUpperCase() || 'DEV01';
  const seqPadded = String(seq).padStart(6, '0');
  return `${cleanLoc}-${cleanDev}-${seqPadded}`;
}

export function parseCompositeKey(key: string): { locationId: string; deviceId: string; localSeq: number } | null {
  const parts = key.split('-');
  if (parts.length < 3) return null;
  const seq = parseInt(parts[parts.length - 1], 10);
  if (isNaN(seq)) return null;
  return {
    locationId: parts[0],
    deviceId: parts[1],
    localSeq: seq,
  };
}
