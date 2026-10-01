/**
 * Overlay multitenant A2 (schema-per-tenant) para el seam `tenant_db_context`
 * de evo-flow (rama exp/multitenant-a2).
 *
 * El seam ya existe y TODO el acceso a BD de los runners pasa por él
 * (`TenantDbContext.getRepository`, 31 call sites). Su contrato es:
 *   (dataSource, tenantId, work) => work(manager)
 * El diseño enterprise asumía RLS (`set_config tenant_id`); esta
 * implementación cumple el mismo contrato con `SET LOCAL search_path`
 * dentro de una transacción por request. Ventajas:
 *   - Funciona hasta en pooler transaction-mode (SET LOCAL vive en la txn).
 *   - Cero cambios en los 31 call sites ni en las entidades.
 *   - Fuera de `src/runners/`: el guard `single-account.spec.ts` sigue verde.
 *   - Opt-in: solo se registra con MULTITENANT_SCHEMA=1 (default = community).
 */
import type { DataSource, EntityManager, ObjectLiteral } from 'typeorm';
import { TenantContextMissingError } from './tenant.errors';
import { resolveTenantSchema } from './tenants.registry';

export type TenantWork<T> = (manager: EntityManager) => Promise<T> | T;

/**
 * Implementación del extension point `tenant_db_context` con schemas.
 * Compatible estructuralmente con `TenantDbContextImpl` del registry
 * (se registra con `EvoExtensionPoints.replace`, ver register.ts).
 */
export async function schemaPerTenantDbContext<T>(
  dataSource: DataSource,
  tenantId: string | null,
  work: TenantWork<T>,
): Promise<T> {
  if (!tenantId) {
    throw new TenantContextMissingError();
  }
  const schema = await resolveTenantSchema(dataSource, tenantId);

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    // SET LOCAL: muere con la transacción; jamás contamina el pool.
    // `public` al final resuelve extensiones sin instalarlas por schema.
    await runner.query(`SET LOCAL search_path TO ${schema}, public`);
    const result = await work(runner.manager);
    // Commit (no solo release): una txn abierta al liberar devolvería la
    // conexión al pool con el SET LOCAL vivo en session-mode => fuga entre
    // requests. El commit mata el SET LOCAL determinísticamente.
    await runner.commitTransaction();
    return result;
  } catch (err) {
    // Rollback tolerante: si la conexión murió, el release la descarta igual.
    try {
      await runner.rollbackTransaction();
    } catch {
      /* noop */
    }
    throw err;
  } finally {
    await runner.release(); // rollback implícito si no hubo commit
  }
}

/** Helper para repositorios fuera del request (jobs): delega al manager dado. */
export function scopedRepository<Entity extends ObjectLiteral>(
  manager: EntityManager,
  target: new (...args: never[]) => Entity,
) {
  return manager.getRepository(target);
}
