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
