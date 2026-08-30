/**
 * caseMapping.ts
 *
 * Converts between the app's camelCase domain objects and Postgres's snake_case
 * columns. Shared by the outbox push path (toSnakeCase) and the realtime/reconciliation
 * pull path (toCamelCase) so both directions agree on exactly one mapping.
 */

export function toSnakeCase(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    let val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      val = toSnakeCase(val);
    }
    result[snakeKey] = val;
  }
  return result;
}

export function toCamelCase(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    const camelKey = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    let val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      val = toCamelCase(val);
    }
    result[camelKey] = val;
  }
  return result;
}
