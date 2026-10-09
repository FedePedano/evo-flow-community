# ClickHouse tenant_id — checklist Fase 2 (re-auditoría 2026-10-09, post `d639ab5`)

## Estado actual (hecho)

- Migración base VALIDADA (`clickhouse-tenant-migration.sql`):
  `tenant_id LowCardinality(String) DEFAULT 'default'` + bloom index +
  MATERIALIZE, idempotente, legacy intacto. MV Kafka: passthrough (validado).
- **Escritura OK**: el contrato `events-received.contract.ts` ya lleva
  `tenantId`; el intake resuelve el slug del header `X-Tenant-Slug`
  (saneado `^[a-z0-9_]+$`, null → `'default'` legacy);
  `clickhouse-writer.service.ts` escribe `tenant_id`.
- ⚠️ **`createContactEventsTable()` (`clickhouse.service.ts:596-644`)** — el
  CREATE runtime de la tabla **NO incluye `tenant_id`** (el DDL vive solo en el
  SQL de migración). Alinear el runtime con el SQL antes de crear tablas nuevas.

## Pendiente

- **Settings CH**: reemplazar `max_bytes_ratio_before_external_group_by` (no
  existe en CH ≥23.x) por `max_bytes_before_external_group_by` (valor absoluto
  en bytes, env-configurable) en:
  - `modules/processing/clickhouse/clickhouse.service.ts:51` y `:102`
  - `modules/processing/services/batch-database-optimizer.service.ts:211`
  - Verificar la versión real de ClickHouse en prod (solo lectura) antes de
    desplegar; no pinchar versión.
- **Lectura**: filtrar TODO `FROM contact_events` con
  `AND tenant_id = <slug>` (parámetro, nunca interpolado). Re-auditoría
  2026-10-09 (`grep -rl "contact_events" src`, excluye specs/DTO/migración):
  - modules/events/services/contact-events.service.ts
  - modules/events/services/event-search.service.ts
  - modules/click-tracking/services/click-tracking.service.ts
  - modules/journeys/services/triggers/webhook.trigger.ts
  - modules/journeys/services/journey-trigger-processor.service.ts
  - modules/segments/queries/contact-event-names.ts
  - modules/segments/services/segment-query-execution.service.ts
  - modules/segments/services/modular-segment-computation.service.ts
  - modules/segments/services/segment-clickhouse-query-builder.service.ts
  - modules/processing/clickhouse/clickhouse.service.ts
  - modules/processing/storage-processors/clickhouse.processor.ts
  - modules/processing/storage-processors/optimized-clickhouse.processor.ts
  - modules/processing/services/batch-processor.service.ts
  - modules/processing/services/atomic-processor.service.ts
  - modules/processing/services/single-contact-updater.service.ts
  - runners/event-process/metrics/event-process-metrics.ts

  El slug llega por interceptor HTTP (`TenantInterceptor`, `src/multitenant/`)
  o por payload Temporal. Sin tenant => 404/error, nunca query sin filtro
  (fail-closed; `'default'` existe solo para compat de escritura legacy).

## Verificación

Spec que grepee `FROM contact_events` sin `tenant_id` en el mismo query
(análogo a `single-account.spec.ts`).