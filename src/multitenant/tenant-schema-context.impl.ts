/**
 * Overlay multitenant A2 (schema-per-tenant) para el seam `tenant_db_context`
 * de evo-flow (rama exp/multitenant-a2).
 *
 * Estrategia v2 (staging 2026-10-02): **pool de DataSources por tenant** en
 * lugar de `SET LOCAL` por request. Motivos:
 * - Los singletons (`waitRegistryServiceCache`, cache services de
 *   journey-execution) cachean repositorios: con SET-por-txn no hay repo
 *   cacheable correcto; con DataSource por tenant, un singleton por tenant
 *   (key = schema) es correcto y longevo.
 * - Sin transacción forzada por request (overhead + el bug del commit/release
 *   que fugaba SET en session-mode). Quien necesita txn usa
 *   `manager.transaction` sobre el DataSource del tenant.
 * - Sin `SET` por query: el `schema` del DataSource cubre entidades y el
 *   `options: -c search_path=` cubre raw SQL (mecanismo probado 2026-10-01).
 * - `public` DELIBERADAMENTE fuera del path: Postgres resuelve al primer
 *   schema que tenga la tabla — con public, tabla ausente en tenant lee/escribe
 *   silenciosamente en public. `extensions` aporta pgcrypto/uuid-ossp/pg_trgm.
 *
 * El resto del contrato no cambia: (dataSource, tenantId, work(manager)).
 * Sin tenantId => TenantContextMissingError (fail-closed).
 */
import { DataSource } from 'typeorm';
import type { EntityManager, ObjectLiteral } from 'typeorm';
import { TenantContextMissingError } from './tenant.errors';
import { resolveTenantSchema } from './tenants.registry';

export type TenantWork<T> = (manager: EntityManager) => Promise<T> | T;

const pools = new Map<string, DataSource>();
const TENANT_POOL_MAX = 3;

/**
 * DataSource por tenant (cacheado). Exportado para que los singletons de
 * activities (cache services) se construyan por tenant sin pasar por el seam.
 */
export async function tenantDataSource(
  base: DataSource,
  schema: string,
): Promise<DataSource> {
  const live = pools.get(schema);
  if (live?.isInitialized) {
    return live;
  }
  const baseExtra = (base.options as unknown as { extra?: Record<string, unknown> }).extra ?? {};
  const ds = new DataSource({
    ...base.options,
    name: `tenant_${schema}`,
    schema,
    extra: {
      ...baseExtra,
      max: TENANT_POOL_MAX,
      options: `-c search_path=${schema},extensions`,
    },
  } as ConstructorParameters<typeof DataSource>[0]);
  await ds.initialize();
  pools.set(schema, ds);
  return ds;
}

export async function schemaPerTenantDbContext<T>(
  dataSource: DataSource,
  tenantId: string | null,
  work: TenantWork<T>,
): Promise<T> {
  if (!tenantId) {
    throw new TenantContextMissingError();
  }
  const schema = await resolveTenantSchema(dataSource, tenantId);
  const tenantDs = await tenantDataSource(dataSource, schema);
  return work(tenantDs.manager);
}

/** Helper para repositorios fuera del request (jobs): delega al manager dado. */
export function scopedRepository<Entity extends object>(
  manager: EntityManager,
  target: new (...args: never[]) => Entity,
) {
  return manager.getRepository(target);
}
