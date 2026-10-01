-- Migración multitenant A2 para ClickHouse (rama exp/multitenant-a2).
-- Estrategia: columna tenant_id (NO schemas: CH es append-only y el
-- aislamiento por query es el patrón estándar).
--
-- Decisiones:
--   * LowCardinality(String) con el slug del tenant (<10 valores).
--   * DEFAULT 'default': las filas legacy y los INSERTs viejos (writer sin
--     actualizar) siguen funcionando; los lectores nuevos filtran
--     `tenant_id = <slug>` y nunca ven 'default' ajeno.
--   * bloom_filter + MATERIALIZE INDEX para que filtre en partes viejas.
--   * NO se toca ORDER BY en tablas existentes (requeriría recreate).
--     En provisioning fresco se recomienda ORDER BY (tenant_id, occurred_at, event_type).
--   * kafka_queue + MV: la MV con SELECT distinto debe recrearse
--     (DROP + CREATE pasando tenant_id); el Kafka Engine no corre en
--     clickhouse-local, ese paso se valida en staging.

-- 1. Tabla principal
ALTER TABLE contact_events ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT 'default';
ALTER TABLE contact_events ADD INDEX IF NOT EXISTS idx_tenant_id tenant_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE contact_events MATERIALIZE INDEX IF EXISTS idx_tenant_id;

-- 2. Cola Kafka (ingesta): el mensaje debe traer tenant_id
ALTER TABLE contact_events_kafka_queue ADD COLUMN IF NOT EXISTS tenant_id String DEFAULT 'default';

-- 3. MV kafka -> principal: RECREAR (el SELECT cambia; IF NOT EXISTS no alcanza)
--    Ejecutar en staging/producción, NO en este archivo automáticamente:
--    DROP VIEW IF EXISTS contact_events_kafka_mv;
--    CREATE MATERIALIZED VIEW contact_events_kafka_mv TO contact_events AS SELECT
--      generateUUIDv4() as id, contact_id, ... ,
--      tenant_id,
--      ... FROM contact_events_kafka_queue WHERE ...;
