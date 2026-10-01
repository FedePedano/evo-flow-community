/**
 * Resolución slug -> schema contra el registro `public.tenants`
 * (tabla calificada: resuelve igual con cualquier search_path).
 * Cache en memoria con TTL corto; ante slug desconocido o tenant no
 * activo => UnknownTenantError (fail-closed, jamás default a un schema).
 */
import type { DataSource } from 'typeorm';
import { UnknownTenantError } from './tenant.errors';

const SCHEMA_PREFIX = 'cliente_';
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { schema: string; at: number }>();

export function tenantSchemaName(slug: string): string {
  if (!/^[a-z0-9_]+$/.test(slug)) {
    throw new UnknownTenantError(slug);
  }
  return `${SCHEMA_PREFIX}${slug}`;
}

export async function resolveTenantSchema(
  dataSource: DataSource,
  slug: string,
): Promise<string> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.schema;
  }
  const rows: Array<{ schema_name: string }> = await dataSource.query(
    `SELECT schema_name FROM public.tenants WHERE slug = $1 AND status = 'active'`,
    [slug],
  );
  if (rows.length === 0) {
    throw new UnknownTenantError(slug);
  }
  const schema = rows[0].schema_name;
  if (!schema.startsWith(SCHEMA_PREFIX)) {
    throw new UnknownTenantError(slug);
  }
  cache.set(slug, { schema, at: Date.now() });
  return schema;
}

export function clearTenantSchemaCache(): void {
  cache.clear();
}
