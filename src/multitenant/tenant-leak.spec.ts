/**
 * Leak-harness multitenant A2 (Fase 0.6) — two-tenant authorization chain.
 *
 * Wires the real `BearerAuthGuard` (0.4a) and the real `TenantInterceptor`
 * (0.4b) with fakes for the DB seam, and asserts the end-to-end contract on
 * the opt-in tenant-aware routes:
 *  - a token that only authorizes tenant A can read tenant A;
 *  - the same token requesting tenant B is rejected with 403 — never routed to
 *    B (the mandatory leak case, MAPA Fase 0.6 (b));
 *  - a request without a tenant does not fall back to a `default` tenant;
 *  - an unknown/inactive registry tenant fails closed (404);
 *  - a token with an empty `tenants[]` is rejected at the guard (401) before
 *    any tenant resolution.
 *
 * No HTTP and no database: this pins the authorization wiring, while
 * `tenant-schema-context.spec.ts` pins the strict `<schema>,extensions` path.
 */
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, of } from 'rxjs';

process.env.EVO_AUTH_SERVICE_URL = 'http://auth-leak.local';

jest.mock('axios');
import axios from 'axios';

import { BearerAuthGuard, TENANTS_CLS_KEY } from '../auth/bearer-auth.guard';
import type { TenantDbContext } from '../evo-extension-points/tenant-db-context/tenant-db-context.service';
import { UnknownTenantError } from './tenant.errors';
import { TenantInterceptor } from './tenant.interceptor';

describe('Two-tenant leak harness (0.6 — guard + interceptor)', () => {
  let postMock: jest.Mock;
  let runWithTenant: jest.Mock;
  let clsStore: Map<string, unknown>;
  let cls: ClsService;
  let reflector: Reflector;
  let tenantDb: TenantDbContext;

  const handler = { handle: () => of('handler-result') };

  const makeContext = (req: any) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    }) as any;

  const withSlug = (request: any, slug: string) => ({
    ...request,
    headers: { ...request.headers, 'x-tenant-slug': slug },
  });

  beforeEach(() => {
    postMock = jest.fn();
    (axios as any).post = postMock;
    (axios as any).isAxiosError = jest.fn().mockReturnValue(false);

    clsStore = new Map<string, unknown>();
    cls = {
      isActive: () => true,
      get: (k: string) => clsStore.get(k),
      set: (k: string, v: unknown) => {
        clsStore.set(k, v);
        return cls;
      },
    } as unknown as ClsService;

    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;

    runWithTenant = jest.fn((_slug: string, cb: () => unknown) => cb());
    tenantDb = { runWithTenant } as unknown as TenantDbContext;
  });

  /** Runs the real guard against a mocked /validate payload. */
  const authenticate = async (request: any, tenants: string[]) => {
    postMock.mockResolvedValueOnce({
      status: 200,
      data: { success: true, data: { user: { id: 'u1' }, tenants } },
    });
    const guard = new BearerAuthGuard(reflector, cls);
    return guard.canActivate(makeContext(request));
  };

  it('authorizes tenant A and rejects tenant B with 403 for the same token', async () => {
    const request: any = {
      method: 'GET',
      headers: { authorization: 'Bearer tokA' },
    };
    await authenticate(request, ['tenant_a']);

    expect(request.tenants).toEqual(['tenant_a']);
    expect(clsStore.get(TENANTS_CLS_KEY)).toEqual(['tenant_a']);

    const interceptor = new TenantInterceptor(tenantDb, cls);

    await expect(
      firstValueFrom(
        interceptor.intercept(makeContext(withSlug(request, 'tenant_a')), handler),
      ),
    ).resolves.toBe('handler-result');
    expect(runWithTenant).toHaveBeenCalledWith(
      'tenant_a',
      expect.any(Function),
    );

    runWithTenant.mockClear();

    expect(() =>
      interceptor.intercept(makeContext(withSlug(request, 'tenant_b')), handler),
    ).toThrow(ForbiddenException);
    expect(runWithTenant).not.toHaveBeenCalled();
  });

  it('does not fall back to a default tenant when the request carries none', () => {
    const interceptor = new TenantInterceptor(tenantDb, cls);
    const request = { headers: {}, tenants: ['tenant_a'] };

    expect(() => interceptor.intercept(makeContext(request), handler)).toThrow(
      ForbiddenException,
    );
    expect(runWithTenant).not.toHaveBeenCalled();
  });

  it('fails closed (404) for an unknown/inactive registry tenant', async () => {
    const interceptor = new TenantInterceptor(tenantDb, cls);
    const request = { headers: { 'x-tenant-slug': 'tenant_a' }, tenants: ['tenant_a'] };
    runWithTenant.mockReturnValueOnce(
      Promise.resolve(new UnknownTenantError('tenant_a')),
    );

    await expect(
      firstValueFrom(interceptor.intercept(makeContext(request), handler)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a token with an empty tenants[] at the guard (401) before resolution', async () => {
    postMock.mockResolvedValueOnce({
      status: 200,
      data: { success: true, data: { user: { id: 'u1' }, tenants: [] } },
    });
    const guard = new BearerAuthGuard(reflector, cls);

    await expect(
      guard.canActivate(
        makeContext({ method: 'GET', headers: { authorization: 'Bearer tokA' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('uses CLS tenants when the request carries none, still denying B', async () => {
    const interceptor = new TenantInterceptor(tenantDb, cls);
    clsStore.set(TENANTS_CLS_KEY, ['tenant_a']);

    await expect(
      firstValueFrom(
        interceptor.intercept(
          makeContext({ headers: { 'x-tenant-slug': 'tenant_a' } }),
          handler,
        ),
      ),
    ).resolves.toBe('handler-result');

    expect(() =>
      interceptor.intercept(
        makeContext({ headers: { 'x-tenant-slug': 'tenant_b' } }),
        handler,
      ),
    ).toThrow(ForbiddenException);
  });
});
