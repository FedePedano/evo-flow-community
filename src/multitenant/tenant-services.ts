/**
 * Servicios por tenant para callers sin request HTTP (Kafka consumers,
 * Temporal activities). Multitenant A2 (schema-per-tenant).
 *
 * Razón: los providers de Nest (`@InjectRepository`, services con DI) quedan
 * atados al DataSource global (search_path público). Un consumer de Kafka no
 * tiene request ni CLS, así que `TenantDbContext.runWithTenant` no puede
 * publicar el manager: hay que resolver el DataSource del tenant y construir
 * las instancias con repos atados a ese schema.
 *
 * Sin `tenantId` => singletons legacy (clave 'public'), comportamiento intacto
 * para single-account.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { AppDataSource } from '../database/ormconfig';
import { Journey } from '../modules/journeys/entities/journey.entity';
import { JourneySession } from '../modules/journeys/entities/journey-session.entity';
import { JourneyCacheService } from '../modules/cache/services/journey-cache.service';
import { JourneySessionCacheService } from '../modules/cache/services/journey-session-cache.service';
import { tenantDataSource } from './tenant-schema-context.impl';
import { resolveTenantSchema } from './tenants.registry';

type SessionCache = JourneySessionCacheService;
type JourneyCache = JourneyCacheService;

const sessionCaches = new Map<string, SessionCache>();
const journeyCaches = new Map<string, JourneyCache>();

export function tenantKeyOf(schema?: string): string {
  return schema ?? 'public';
}

/** DataSource del tenant (o el global cuando no hay tenant). */
export async function dataSourceFor(
  tenantId?: string | null,
): Promise<DataSource> {
  if (!tenantId) {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
    return AppDataSource;
  }
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
  const schema = await resolveTenantSchema(AppDataSource, tenantId);
  return tenantDataSource(AppDataSource, schema);
}

/**
 * Caches por tenant. Los repos atan al DataSource del schema (pool dedicado),
 * así que un singleton por schema es correcto y longevo; el L2 en memoria queda
 * separado por tenant.
 *
 * Riesgo residual documentado: el L1 (Redis) sigue compartido con keys por UUID
 * de sesión/journey. Namespacing por tenant pendiente.
 */
export async function servicesForTenant(tenantId?: string | null): Promise<{
  sessionService: SessionCache;
  journeyService: JourneyCache;
}> {
  const ds = await dataSourceFor(tenantId);
  const schema = (ds.options as { schema?: string }).schema;
  const key = tenantKeyOf(schema);
  if (!sessionCaches.has(key) || !journeyCaches.has(key)) {
    const emitter = new EventEmitter2();
    sessionCaches.set(
      key,
      new JourneySessionCacheService(
        ds.getRepository(JourneySession),
        emitter as never,
      ),
    );
    journeyCaches.set(
      key,
      new JourneyCacheService(ds.getRepository(Journey), emitter as never),
    );
  }
  return {
    sessionService: sessionCaches.get(key)!,
    journeyService: journeyCaches.get(key)!,
  };
}

/**
 * Journeys activos del tenant con la misma degradación que
 * `JourneysService.findActive`: cache por tenant primero, read-through a la DB
 * del tenant cuando está vacía.
 */
export async function activeJourneysForTenant(
  tenantId?: string | null,
): Promise<Journey[]> {
  const { journeyService } = await servicesForTenant(tenantId);
  const cached = await journeyService.getActiveJourneys();
  if (cached.length > 0) {
    return cached.map((c) => c as unknown as Journey);
  }
  const ds = await dataSourceFor(tenantId);
  const repo: Repository<Journey> = ds.getRepository(Journey);
  const rows = await repo.find({ where: { isActive: true } });
  for (const journey of rows) {
    await journeyService.set(journey);
  }
  return rows;
}

export function isMultitenantSchemaEnabled(): boolean {
  return process.env.MULTITENANT_SCHEMA === '1';
}