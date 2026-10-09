# Overlay multitenant A2 para evo-flow (rama `exp/multitenant-a2`)

El seam `TenantDbContext` ya existe y los 31 accesos a repositorios pasan
por él. Este overlay cumple su contrato con **schemas** en vez de RLS:

- `tenant-schema-context.impl.ts` — txn por request + `SET LOCAL
  search_path` (vive en la txn: sirve hasta en pooler transaction-mode).
- `tenants.registry.ts` — slug→schema contra `public.tenants` (fail-closed,
  cache 30s TTL).
- `tenant.interceptor.ts` — opt-in por controller (`@UseInterceptors`),
  slug por subdominio o header `X-Tenant-Slug`.
- `register.ts` — `EvoExtensionPoints.replace(...)` con `MULTITENANT_SCHEMA=1`.
- Temporal activities: ya reciben `tenantId` en el payload
  (`runActivityInTenantDbContext`) — el overlay lo cubre sin cambios.

Validado: `tsc --noEmit` + prueba runtime del impl contra Supabase test
(ver `scripts/multitenant/` del umbrella). `single-account.spec.ts` solo
escanea `src/runners/`: este directorio no lo afecta.

## Estrategia v2: pool de DataSources por tenant (2026-10-02)

Reemplaza al `SET LOCAL` por request: un DataSource por schema (cacheado,
pool max 3) con `schema` + `options: -c search_path=<schema>,extensions`.
Motivos: singletons cacheables por tenant, sin txn forzada, sin SET por
query. `public` fuera del path (fallback silencioso = fuga).

## Migraciones por schema (mecanismo Fase 2, probado 2026-10-01)

- La tabla `migrations` de TypeORM se crea **por schema** (tracking
  independiente por tenant) ✓.
- PERO el raw SQL de las migraciones NO hereda el `schema` del DataSource:
  va al `search_path` de la conexión (probado: cayó en `public`).
- Mecanismo correcto: `extra: { options: '-c search_path=<schema>,extensions' }`
  (`public` fuera: fallback silencioso = fuga — staging 2026-10-02).
  en el DataSource del tenant — aplica a **todo el pool**, cubre raw SQL y
  migraciones (probado: `raw_probe` cayó en el schema). Funciona vía
  Supavisor session-mode.
- Las migraciones que usen query-builder/entidades ya respetan `schema`;
  solo el raw SQL necesita este mecanismo (o calificar a mano).
