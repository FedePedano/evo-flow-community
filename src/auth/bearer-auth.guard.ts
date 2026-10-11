import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import axios from 'axios';
import { getAuthConfig } from './config/auth.config';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

interface AuthResult {
  user: any;
  accounts?: any[];
  token?: any;
  tenants?: string[];
}

/**
 * CLS key under which the authenticated token's tenant slugs (`string[]`) are
 * published for the current request, so downstream services can read them
 * without re-parsing the token. Mirrors the `role` key set by RolesGuard.
 */
export const TENANTS_CLS_KEY = 'tenants';

/**
 * BearerAuthGuard validates tokens via evo-auth-service-community.
 *
 * Contract:
 *  - POST {EVO_AUTH_SERVICE_URL}/api/v1/auth/validate with `Authorization: Bearer {token}`
 *  - 200 -> { success, data: { user, token, accounts, tenants } } -> populate
 *    request.user / request.accounts / request.account / request.tenants
 *  - 401 -> invalid token (UnauthorizedException)
 *  - 422 -> expired token (UnauthorizedException, message="expired")
 *  - 5xx -> ServiceUnavailableException
 *
 * Fail-closed (0.4a, exp/multitenant-a2): a 200 whose payload does not carry a
 * non-empty `tenants` array of slugs is treated as an authentication failure
 * (UnauthorizedException). There is never a fallback to a "default" tenant.
 *
 * No local cache: every request validates fresh against evo-auth-service.
 * The auth-service has its own Rails.cache (TTL 5min) — single source of truth.
 *
 * Integration API key (`x-integration-api-key`) bypasses the HTTP call entirely
 * (service-to-service authentication) and carries no tenant scope (`[]`).
 *
 * Timeouts aligned with evo_auth_service.rb on CRM Rails: open=5s, read=10s (axios `timeout`
 * covers the full round-trip; we use 10s as the effective combined budget).
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private cls: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    // @ts-ignore - Express request typing
    const request = context.switchToHttp().getRequest();

    // Allow CORS preflight requests
    if (request.method === 'OPTIONS') {
      return true;
    }

    // @ts-ignore - Headers typing
    const authHeader = request.headers?.authorization;
    // @ts-ignore - Headers typing
    const apiAccessToken =
      request.headers?.api_access_token ||
      request.headers?.['api-access-token'] ||
      request.headers?.apiAccessToken;

    // @ts-ignore - Integration API key (service-to-service)
    const integrationApiKey =
      request.headers?.['x-integration-api-key'] ||
      request.headers?.['X-Integration-API-Key'] ||
      request.headers?.['integration-api-key'] ||
      request.headers?.integrationApiKey ||
      request.headers?.['X-INTEGRATION-API-KEY'];

    if (
      !authHeader?.startsWith('Bearer ') &&
      !apiAccessToken &&
      !integrationApiKey
    ) {
      throw new UnauthorizedException(
        'Bearer token, API access token, or integration API key required',
      );
    }

    // Service-to-service: bypass cache and HTTP call
    if (integrationApiKey) {
      return this.validateIntegrationApiKey(integrationApiKey, request);
    }

    // Decide effective bearer token (Bearer header takes precedence)
    const bearerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : (apiAccessToken as string);

    const config = getAuthConfig();
    const validateUrl = `${config.evoAuth.serviceUrl}${config.evoAuth.validateEndpoint}`;

    // Build headers based on token type — mirrors evo_auth_service.rb pattern
    // on the CRM Rails side. Bearer tokens use `Authorization: Bearer`,
    // api_access_token uses the `api_access_token` header.
    const validationHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authHeader?.startsWith('Bearer ')) {
      validationHeaders.Authorization = authHeader;
    } else if (apiAccessToken) {
      validationHeaders.api_access_token = apiAccessToken as string;
    }

    try {
      const response = await axios.post(
        validateUrl,
        {},
        {
          headers: validationHeaders,
          timeout: 10_000,
          // axios doesn't expose `open` vs `read` separately. 10s covers the
          // total budget; evo-auth-service typically responds in <100ms.
          validateStatus: () => true,
        },
      );

      if (response.status === 200) {
        const payload = response.data?.data ?? response.data;
        // Fail-closed (0.4a): the contract requires `tenants: string[]` with
        // at least one slug. A missing/empty/malformed list is an auth failure
        // — never fall back to a "default" tenant.
        const tenants = BearerAuthGuard.normalizeTenants(payload?.tenants);
        if (!tenants) {
          throw new UnauthorizedException(
            'Authentication failed: token response has no tenants',
          );
        }
        const result: AuthResult = {
          user: payload?.user,
          accounts: payload?.accounts,
          token: payload?.token,
          tenants,
        };
        this.populateRequest(request, result);
        return true;
      }

      if (response.status === 401) {
        throw new UnauthorizedException('Invalid token');
      }

      if (response.status === 422) {
        throw new UnauthorizedException('expired');
      }

      if (response.status >= 500) {
        // Do not cache 5xx
        throw new ServiceUnavailableException(
          'evo-auth-service unavailable',
        );
      }

      // Debug: capture unexpected status codes to understand what auth-service returned
      console.error('[BearerAuthGuard] Unexpected status from evo-auth-service:', {
        status: response.status,
        statusText: response.statusText,
        url: validateUrl,
        headers: validationHeaders,
        responseData: response.data,
        responseHeaders: response.headers,
      });
      throw new UnauthorizedException('Token validation failed');
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      if (axios.isAxiosError(error)) {
        // Network/connection errors are treated as service unavailable
        throw new ServiceUnavailableException(
          'evo-auth-service unreachable',
        );
      }
      throw new UnauthorizedException('Authentication failed');
    }
  }

  private populateRequest(request: any, result: AuthResult): void {
    request.user = result.user;
    request.accounts = result.accounts;
    request.account = result.accounts?.[0];
    request.tenants = result.tenants ?? [];
    // Also publish to the request-scoped CLS so non-HTTP-arg consumers
    // (services, interceptors) can read the authorized tenant slugs.
    this.cls?.set(TENANTS_CLS_KEY, request.tenants);
  }

  /**
   * Validates and copies the `tenants` field from the /validate payload.
   * Returns the `string[]` only when it is a non-empty array of non-empty
   * strings; otherwise `null` (caller fails closed).
   */
  private static normalizeTenants(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.length === 0) {
      return null;
    }
    if (!value.every((slug) => typeof slug === 'string' && slug.length > 0)) {
      return null;
    }
    return value as string[];
  }

  /**
   * Service-to-service authentication via AUTH_APIKEY_INTEGRATION_LOCAL.
   * Bypasses the evo-auth-service HTTP call.
   */
  private validateIntegrationApiKey(
    providedApiKey: string,
    request: any,
  ): boolean {
    const expectedApiKey = process.env.AUTH_APIKEY_INTEGRATION_LOCAL;

    if (!expectedApiKey) {
      throw new UnauthorizedException('Integration API key not configured');
    }

    if (providedApiKey !== expectedApiKey) {
      throw new UnauthorizedException('Invalid integration API key');
    }

    request.user = {
      id: 'integration-service',
      email: 'integration@evo-services.local',
      name: 'Integration Service',
      isIntegration: true,
    };
    request.accounts = [];
    request.account = null;
    request.isIntegrationRequest = true;
    request.tenants = [];
    this.cls?.set(TENANTS_CLS_KEY, request.tenants);

    return true;
  }
}
