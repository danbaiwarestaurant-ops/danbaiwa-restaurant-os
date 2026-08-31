/**
 * Generates a composite ticket key.
 * Format: `${locationId}-${deviceId}-${installationId}-${seqPadded}`
 * Example: `LOC01-DEV01-K3F9QZ-000042`
 *
 * The installation segment is what actually guarantees uniqueness. locationId and
 * deviceId are account-level settings that follow the admin to every device they sign
 * in on, so two tills necessarily share them — and `seq` comes from a counter that is
 * per-install, not global. Without a per-install discriminator, two tills would mint
 * identical ids and the outbox's `upsert(onConflict:'id')` would silently overwrite one
 * ticket with the other. The installation id is generated once per browser, never
 * synced, and never shown in settings.
 *
 * Omitting `installationId` reproduces the legacy 3-part format, which is still parsed
 * correctly below — existing tickets keep the ids they were printed with.
 */
export function generateCompositeKey(
  locationId: string,
  deviceId: string,
  seq: number,
  installationId?: string
): string {
  const cleanLoc = locationId.trim().toUpperCase() || 'LOC01';
  const cleanDev = deviceId.trim().toUpperCase() || 'DEV01';
  const seqPadded = String(seq).padStart(6, '0');
  const cleanInstall = installationId?.trim().toUpperCase();
  return cleanInstall
    ? `${cleanLoc}-${cleanDev}-${cleanInstall}-${seqPadded}`
    : `${cleanLoc}-${cleanDev}-${seqPadded}`;
}

/**
 * Parses either format. Reads the first two segments and the last one, so an inserted
 * installation segment doesn't change how location, device or sequence are recovered.
 */
export function parseCompositeKey(
  key: string
): { locationId: string; deviceId: string; installationId?: string; localSeq: number } | null {
  const parts = key.split('-');
  if (parts.length < 3) return null;
  const seq = parseInt(parts[parts.length - 1], 10);
  if (isNaN(seq)) return null;
  return {
    locationId: parts[0],
    deviceId: parts[1],
    installationId: parts.length >= 4 ? parts[parts.length - 2] : undefined,
    localSeq: seq,
  };
}
