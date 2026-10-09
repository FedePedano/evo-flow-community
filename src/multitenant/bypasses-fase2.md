# Bypass del seam `TenantDbContext` — checklist Fase 2 (re-auditoría 2026-10-09, post `d639ab5`)

Estado tras la propagación de `tenantId` (commit `d639ab5`): el intake, el
`journey-trigger-processor` y la mayoría de activities/nodos ya pasan por el
seam `runActivityInTenantDbContext(tenantId, ...)` o por el dataSource
por-tenant (`base.node.ts` → `getTenantDataSource()`). **Quedan estos sitios
con pool global sin tenant:**

| # | Archivo | Línea | Qué usa | Fix |
|---|---------|-------|---------|-----|
| 1 | modules/temporal/activities/journey-execution.activities.ts | 182-183 | `AppDataSource.getRepository(JourneySession/Journey)` (pool global) | envolver con `runActivityInTenantDbContext(input.tenantId, ...)`; el `input.tenantId` ya viaja |
| 2 | modules/temporal/activities/campaign-execution.activities.ts | 226, 281, 363 | `app.get('DataSource').getRepository('CampaignContact'/'Campaign')` | idem (414-415 ya migrado, de referencia); 6 de 7 inputs sin `tenantId` (solo `UpdateExecutionProgressInput:90` lo lleva) |
| 3 | modules/temporal/activities/nodes/scheduled-action.node.ts | 56, 62 | `initializeDatabase()` sin tenant + `getRepository('ScheduledJourneyAction')` | pasar `tenantId` a `initializeDatabase` y resolver contra dataSource por-tenant |
| 4 | nodes `add-label` / `remove-label` / `update-custom-attribute` / `transfer-journey` | constructores | `appContext.get(LabelsService\|ContactsService\|CustomAttributesService\|JourneysService)` — servicios globales con repos de `AppDataSource` | inyectar `tenantId` y resolver el servicio contra el dataSource por-tenant |

**Delicadeza heredada del checklist original** — `wait.activities.ts:49-72`
YA usa `runActivityInTenantDbContext(tenantId ?? null, ...)`, pero el repo
cacheado en singleton (`waitRegistryServiceCache`) debe quedar **por-tenant** o
reconstruirse por ejecución; envolver el repo no basta.

Patrón de fix por sitio: envolver en
`runActivityInTenantDbContext(input.tenantId, manager => ...)` y usar
`manager.getRepository(...)`; para nodos con DI, resolver el servicio con el
dataSource por-tenant (mirar `base.node.ts` como seam referencial).

Verificación (Fase 2 cerrada): con `MULTITENANT_SCHEMA=1`,
`grep -rn "AppDataSource.getRepository\|app.get('DataSource')" src` debe dar 0
fuera de `database/` y de `src/multitenant/` y del seam `base.node.ts`.
Convertir este archivo en un spec que falle si aparecen nuevos bypasses
(análogo a `single-account.spec.ts`).