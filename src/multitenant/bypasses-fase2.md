# Bypass del seam `TenantDbContext` — checklist Fase 2 (auditoría 2026-10-01)

8 sitios usan `AppDataSource.getRepository(...)` directo (pool global, sin
tenant). Bajo el overlay, cada uno ve/contamina todos los schemas.
Patrón de fix por sitio: envolver en
`runActivityInTenantDbContext(input.tenantId, manager => ...)` y usar
`manager.getRepository(...)`. `input.tenantId` debe viajar en el payload
del workflow/activity (hoy NO viaja: agregarlo es parte del fix).

| # | Archivo | Línea | Entidad | Nota |
|---|---------|-------|---------|------|
| 1 | modules/journeys/services/journey-trigger-processor.service.ts | 640 | JourneySession | fuera de activities: necesita tenant del evento disparador |
| 2 | modules/temporal/activities/action-nodes.activities.ts | 630 | JourneySession | envolver con tenantId del input |
| 3 | modules/temporal/activities/utils/variable-interpolation.util.ts | 152,166 | JourneySession | util compartida: recibir manager por parámetro |
| 4 | modules/temporal/activities/journey-execution.activities.ts | 130-131 | JourneySession, Journey | envolver con tenantId del input |
| 5 | modules/temporal/activities/wait.activities.ts | 58 | JourneySession | **el más delicado**: repo cacheado en singleton (`waitRegistryServiceCache`) — el cache debe ser por-tenant o reconstruirse por ejecución |

Verificación: `grep -rn "AppDataSource.getRepository\|AppDataSource.manager" src`
debe dar 0 fuera de `database/` y este overlay al cerrar Fase 2.
Convertir este archivo en un spec que falle si aparecen nuevos bypasses.
