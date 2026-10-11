/**
 * Unit tests for BearerAuthGuard — task 0.4a (exp/multitenant-a2).
 *
 * Covers the integration with evo-auth-service `POST /api/v1/auth/validate`:
 *  - forwards the token as `Authorization: Bearer`;
 *  - consumes /validate and preserves the authenticated identity;
 *  - propagates `tenants: string[]` to the request + CLS;
 *  - fails closed (no `default` fallback) on empty/missing tenants, invalid
 *    token, auth 5xx and timeout/network errors.
 */
import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';

process.env.EVO_AUTH_SERVICE_URL = 'http://auth-test.local';

jest.mock('axios');
import axios from 'axios';

import { BearerAuthGuard, TENANTS_CLS_KEY } from './bearer-auth.guard';

describe('BearerAuthGuard (0.4a — consume /validate + propagate tenants)', () => {
  let guard: BearerAuthGuard;
  let postMock: jest.Mock;
  let cls: { set: jest.Mock };
  let request: any;
  let reflector: Reflector;

  const makeContext = (req: any): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  const validateOk = (data: unknown) =>
    postMock.mockResolvedValueOnce({
      status: 200,
      data: { success: true, data },
    });

  beforeEach(() => {
    postMock = jest.fn();
    (axios as any).post = postMock;
    (axios as any).isAxiosError = jest.fn().mockReturnValue(false);

    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    cls = { set: jest.fn() };

    guard = new BearerAuthGuard(reflector, cls as unknown as ClsService);
    request = {
      method: 'GET',
      headers: { authorization: 'Bearer tok-123' },
    };
  });

  it('forwards the token as Authorization: Bearer to /validate', async () => {
    validateOk({ user: { id: 'u1' }, tenants: ['acme'] });

    await guard.canActivate(makeContext(request));

    expect(postMock).toHaveBeenCalledWith(
      'http://auth-test.local/api/v1/auth/validate',
      {},
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tok-123' }),
      }),
    );
  });

  it('propagates multiple tenants as string[] to request + CLS', async () => {
    validateOk({ user: { id: 'u1' }, tenants: ['acme', 'globex'] });

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.tenants).toEqual(['acme', 'globex']);
    expect(cls.set).toHaveBeenCalledWith(TENANTS_CLS_KEY, ['acme', 'globex']);
  });

  it('fails closed when tenants is empty (no default fallback)', async () => {
    validateOk({ user: { id: 'u1' }, tenants: [] });

    await expect(
      guard.canActivate(makeContext(request)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.tenants).toBeUndefined();
  });

  it('fails closed when the response has no tenants field', async () => {
    validateOk({ user: { id: 'u1' } });

    await expect(
      guard.canActivate(makeContext(request)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an invalid token (401)', async () => {
    postMock.mockResolvedValueOnce({ status: 401, data: {} });

    await expect(
      guard.canActivate(makeContext(request)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired token (422)', async () => {
    postMock.mockResolvedValueOnce({ status: 422, data: {} });

    await expect(
      guard.canActivate(makeContext(request)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('treats an auth 5xx as unavailable (fail-closed)', async () => {
    postMock.mockResolvedValueOnce({ status: 503, data: {} });

    await expect(
      guard.canActivate(makeContext(request)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('treats a timeout/network error as unavailable (fail-closed)', async () => {
    const timeoutErr = Object.assign(new Error('timeout of 10000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    postMock.mockRejectedValueOnce(timeoutErr);
    (axios as any).isAxiosError = jest.fn().mockReturnValue(true);

    await expect(
      guard.canActivate(makeContext(request)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('preserves the authenticated identity already populated', async () => {
    validateOk({
      user: { id: 'u9', email: 'u9@example.com', name: 'Nine' },
      accounts: [{ id: 'acc-1' }, { id: 'acc-2' }],
      token: { access_token: 'x' },
      tenants: ['acme'],
    });

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.user).toEqual({
      id: 'u9',
      email: 'u9@example.com',
      name: 'Nine',
    });
    expect(request.accounts).toEqual([{ id: 'acc-1' }, { id: 'acc-2' }]);
    expect(request.account).toEqual({ id: 'acc-1' });
    expect(request.tenants).toEqual(['acme']);
  });
});
