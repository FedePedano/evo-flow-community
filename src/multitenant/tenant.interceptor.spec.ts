/**
 * Unit tests for TenantInterceptor — task 0.4b (exp/multitenant-a2).
 *
 * Enforces tenant-aware authorization on the routes that opt in via
 * `@UseInterceptors(TenantInterceptor)`:
 *  - resolves the slug from `X-Tenant-Slug` or the subdomain;
 *  - sanitizes it (`^[a-z0-9_]+$`);
 *  - requires the slug to belong to the authenticated `tenants: string[]`
 *    (published by BearerAuthGuard on the request + CLS);
 *  - fails closed (403) when the token/tenants/slug is missing or the slug is
 *    not authorized — never falls back to `default`;
 *  - delegates to TenantDbContext.runWithTenant once authorized.
 */
import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, of } from 'rxjs';

import { TENANTS_CLS_KEY } from '../auth/bearer-auth.guard';
import { TenantDbContext } from '../evo-extension-points/tenant-db-context/tenant-db-context.service';
import { UnknownTenantError } from './tenant.errors';
import { TenantInterceptor } from './tenant.interceptor';

describe('TenantInterceptor (0.4b — tenant-aware authorization)', () => {
  let interceptor: TenantInterceptor;
  let runWithTenant: jest.Mock;
  let clsGet: jest.Mock;

  const makeContext = (req: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  const handler: CallHandler = { handle: () => of('handler-result') };

  const invoke = (req: any) => interceptor.intercept(makeContext(req), handler);

  beforeEach(() => {
    runWithTenant = jest.fn((_slug: string, cb: () => unknown) => cb());
    clsGet = jest.fn();
    interceptor = new TenantInterceptor(
      { runWithTenant } as unknown as TenantDbContext,
      { get: clsGet } as unknown as ClsService,
    );
  });

  it('authorizes a slug present in the authenticated tenants (header)', async () => {
    const req = {
      headers: { 'x-tenant-slug': 'tenant_a' },
      tenants: ['tenant_a', 'tenant_b'],
    };

    await expect(firstValueFrom(invoke(req))).resolves.toBe('handler-result');
    expect(runWithTenant).toHaveBeenCalledWith(
      'tenant_a',
      expect.any(Function),
    );
  });

  it('rejects tenant B when the token only authorizes tenant A (403)', () => {
    const req = {
      headers: { 'x-tenant-slug': 'tenant_b' },
      tenants: ['tenant_a'],
    };

    expect(() => invoke(req)).toThrow(ForbiddenException);
    expect(runWithTenant).not.toHaveBeenCalled();
  });

  it('rejects when the authenticated context exposes no tenants — 403', () => {
    const req = { headers: { 'x-tenant-slug': 'tenant_a' } };

    expect(() => invoke(req)).toThrow(ForbiddenException);
    expect(runWithTenant).not.toHaveBeenCalled();
  });

  it('rejects an empty tenants[] — 403 (fail-closed, never default)', () => {
    const req = { headers: { 'x-tenant-slug': 'tenant_a' }, tenants: [] };

    expect(() => invoke(req)).toThrow(ForbiddenException);
    expect(runWithTenant).not.toHaveBeenCalled();
  });

  it('rejects a missing slug — 403', () => {
    const req = { headers: {}, tenants: ['tenant_a'] };

    expect(() => invoke(req)).toThrow(ForbiddenException);
    expect(runWithTenant).not.toHaveBeenCalled();
  });

  it('rejects a malformed slug — 403', () => {
    const req = {
      headers: { 'x-tenant-slug': 'Tenant-A/../etc' },
      tenants: ['Tenant-A/../etc'],
    };

    expect(() => invoke(req)).toThrow(ForbiddenException);
    expect(runWithTenant).not.toHaveBeenCalled();
  });

  it('resolves the slug from the subdomain', async () => {
    const req = {
      hostname: 'tenant_a.flow.evonectech.com',
      headers: {},
      tenants: ['tenant_a'],
    };

    await expect(firstValueFrom(invoke(req))).resolves.toBe('handler-result');
    expect(runWithTenant).toHaveBeenCalledWith(
      'tenant_a',
      expect.any(Function),
    );
  });

  it('falls back to the CLS tenants when the request carries none', async () => {
    clsGet.mockImplementation((key: string) =>
      key === TENANTS_CLS_KEY ? ['tenant_a'] : undefined,
    );
    const req = { headers: { 'x-tenant-slug': 'tenant_a' } };

    await expect(firstValueFrom(invoke(req))).resolves.toBe('handler-result');
    expect(runWithTenant).toHaveBeenCalled();
  });

  it('does not fall back to CLS when request.tenants is present but empty', () => {
    clsGet.mockReturnValue(['tenant_a']);
    const req = { headers: { 'x-tenant-slug': 'tenant_a' }, tenants: [] };

    expect(() => invoke(req)).toThrow(ForbiddenException);
  });

  it('maps UnknownTenantError (unknown/inactive registry slug) to 404', async () => {
    runWithTenant.mockResolvedValueOnce(new UnknownTenantError('tenant_a'));
    const req = {
      headers: { 'x-tenant-slug': 'tenant_a' },
      tenants: ['tenant_a'],
    };

    await expect(firstValueFrom(invoke(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
