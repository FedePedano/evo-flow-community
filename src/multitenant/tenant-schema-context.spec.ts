/**
 * Leak-harness multitenant A2 (Fase 0.6) — schema-per-tenant DB context.
 *
 * Complements `tenant.interceptor.spec.ts` (HTTP authorization) by proving the
 * storage-level contract of the overlay:
 *  - each tenant gets its OWN pooled DataSource, scoped to its schema;
 *  - the runtime `search_path` is exactly `<schema>,extensions` — `public` is
 *    deliberately absent so a table missing in the tenant FAILS instead of
 *    silently resolving in `public` (the classic A2 leak);
 *  - there is never a fallback to a `default`/`public` tenant;
 *  - unresolvable (unknown/inactive) tenants fail closed.
 *
 * No database: `typeorm` and the registry are faked, which is exactly what we
 * want to pin — the wiring and the generated search_path, not Postgres.
 */
jest.mock('./tenants.registry', () => ({
  resolveTenantSchema: jest.fn(),
  clearTenantSchemaCache: jest.fn(),
}));

jest.mock('typeorm', () => {
  class DataSource {
    options: any;
    isInitialized = false;

    constructor(options: any) {
      this.options = options;
    }

    async initialize() {
      this.isInitialized = true;
      return this;
    }

    get manager() {
      return { schema: this.options.schema, __ds: this };
    }
  }

  return { DataSource };
});

import type { DataSource } from 'typeorm';

import * as registry from './tenants.registry';
import { TenantContextMissingError, UnknownTenantError } from './tenant.errors';
import {
  schemaPerTenantDbContext,
  tenantDataSource,
} from './tenant-schema-context.impl';

const resolveTenantSchema = registry.resolveTenantSchema as jest.Mock;

const base = {
  options: { type: 'postgres', extra: { max: 20 } },
} as unknown as DataSource;

describe('schemaPerTenantDbContext (0.6 — strict per-tenant search_path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds a per-tenant DataSource with search_path=<schema>,extensions (no public)', async () => {
    const ds = await tenantDataSource(base, 'cliente_acme');

    expect((ds.options as any).schema).toBe('cliente_acme');
    expect((ds.options as any).extra.options).toBe(
      '-c search_path=cliente_acme,extensions',
    );
    expect((ds.options as any).extra.options).not.toContain('public');
  });

  it('keeps a separate pooled DataSource per tenant (A never resolves B)', async () => {
    const a = await tenantDataSource(base, 'cliente_acme');
    const b = await tenantDataSource(base, 'cliente_globex');

    expect(a).not.toBe(b);
    expect((a.options as any).schema).toBe('cliente_acme');
    expect((b.options as any).schema).toBe('cliente_globex');
    expect((a.options as any).extra.options).not.toBe(
      (b.options as any).extra.options,
    );
  });

  it('reuses the cached DataSource for the same schema', async () => {
    const first = await tenantDataSource(base, 'cliente_acme');
    const second = await tenantDataSource(base, 'cliente_acme');

    expect(second).toBe(first);
  });

  it('runs work on the tenant-scoped manager', async () => {
    resolveTenantSchema.mockResolvedValue('cliente_acme');
    const seen: any[] = [];

    const result = await schemaPerTenantDbContext(base, 'acme', (manager) => {
      seen.push(manager);
      return Promise.resolve('done');
    });

    expect(result).toBe('done');
    expect(seen[0]).toMatchObject({ schema: 'cliente_acme' });
  });

  it('fails closed without a tenant — never defaults to public', async () => {
    await expect(
      schemaPerTenantDbContext(base, null, () => Promise.resolve('unreachable')),
    ).rejects.toBeInstanceOf(TenantContextMissingError);

    await expect(
      schemaPerTenantDbContext(base, '', () => Promise.resolve('unreachable')),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('fails closed for an unknown/inactive tenant (no schema fallback)', async () => {
    resolveTenantSchema.mockRejectedValue(new UnknownTenantError('ghost'));

    await expect(
      schemaPerTenantDbContext(base, 'ghost', () =>
        Promise.resolve('unreachable'),
      ),
    ).rejects.toBeInstanceOf(UnknownTenantError);
  });
});
