# ClickHouse tenant_id — checklist Fase 2 (auditoría 2026-10-01)

Migración base VALIDADA con clickhouse-local (`clickhouse-tenant-migration.sql`):
`tenant_id LowCardinality(String) DEFAULT 'default'` + bloom index +
MATERIALIZE, idempotente, legacy intacto. MV Kafka: recrear con passthrough
(validado el SELECT contra tabla Memory).

## Escritura (llevar tenant hasta la fila)

1. **Intake** (`runners/event-receiver/services/webhook-intake.service.ts`):
   resolver tenant del path del webhook (`/webhooks/<slug>/...`) o del
   inbox mapeado. Sin tenant resoluble => rechazar (fail-closed), no 'default'.
2. **Contrato** (`shared/broker/contracts/events-received.contract.ts`):
   agregar `tenantSlug: z.string()` al schema zod (`.strict()` lo exige
   explícito; es backward-compatible porque el productor es el intake).
   El tópico sigue siendo por plataforma (`events.received.<platform>`):
   el tenant viaja DENTRO del mensaje, no hacen falta tópicos por tenant.
3. **Enricher** (`runners/event-process/services/enricher.service.ts`):
   pasar `tenantSlug` de envelope a `EnrichedEvent` (viene gratis por
   intersección de tipos una vez que el contrato lo tiene).
4. **Writer** (`runners/event-process/services/clickhouse-writer.service.ts`):
   `ContactEventRow` += `tenant_id: string`; `toRow()` lo toma de
   `event.tenantSlug`. DLQ/reproceso lo hereda (el evento ya lo trae).
5. **Kafka path**: `contact_events_kafka_queue` += columna (migración §2);
   recrear `contact_events_kafka_mv` con `tenant_id` en el SELECT (§3 del SQL).

## Lectura (filtrar TODO lo que lea contact_events)

Patrón: `AND tenant_id = <slug>` (parámetro, nunca interpolado). Archivos
con `FROM contact_events` (grep 2026-10-01, excluye specs):
- modules/segments/services/segment-clickhouse-query-builder.service.ts
- modules/segments/services/segment-query-execution.service.ts
- modules/segments/services/modular-segment-computation.service.ts
- modules/segments/queries/contact-event-names.ts
- modules/events/services/contact-events.service.ts
- modules/events/services/event-search.service.ts
- modules/click-tracking/services/click-tracking.service.ts
- modules/journeys/services/triggers/webhook.trigger.ts
- modules/processing/services/atomic-processor.service.ts
- modules/processing/services/batch-processor.service.ts
- modules/processing/services/single-contact-updater.service.ts
- modules/processing/storage-processors/clickhouse.processor.ts
- modules/processing/storage-processors/optimized-clickhouse.processor.ts
- runners/event-process/metrics/event-process-metrics.ts

El slug llega por interceptor HTTP (`TenantInterceptor`, ya existe en
`src/multitenant/`) o por payload en Temporal. Sin tenant => 404/error,
nunca query sin filtro (fail-closed; el DEFAULT 'default' existe solo
para compatibilidad de escritura legacy).

Verificación: spec que grepea `FROM contact_events` sin `tenant_id`
en el mismo query (análogo a `single-account.spec.ts`).
