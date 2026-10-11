/**
 * Interceptor NestJS que autoriza y envuelve el request en el tenant (opt-in
 * por controller con `@UseInterceptors(TenantInterceptor)` — sin cambio global:
 * el default community/single-account FUERA de esas rutas queda intacto).
 *
 * Resuelve el slug por subdominio (`cliente.beexa-flow...` -> `cliente`) o
 * header `X-Tenant-Slug` (dev/test), lo sanea (`^[a-z0-9_]+$`) y lo autoriza
 * contra `tenants: string[]` del contexto autenticado (publicado por
 * BearerAuthGuard en `request.tenants` y en CLS). Fail-closed (0.4b): falta el
 * token/tenants, falta o es inválido el slug, o el slug ∉ tenants[] => 403;
 * jamás fallback a `'default'`. Si pasa, delega en
 * `TenantDbContext.runWithTenant`, que con el overlay registrado abre la txn +
 * `SET LOCAL search_path` y publica el manager en CLS para los 31
 * `getRepository` existentes.
 */
import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable, from, switchMap } from 'rxjs';
import { TenantDbContext } from '../evo-extension-points/tenant-db-context/tenant-db-context.service';
import { TENANTS_CLS_KEY } from '../auth/bearer-auth.guard';
import { UnknownTenantError } from './tenant.errors';

const SLUG_PATTERN = /^[a-z0-9_]+$/;

function slugFromRequest(req: {
  hostname?: string;
  headers?: Record<string, unknown>;
}): string | null {
  const header = req.headers?.['x-tenant-slug'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  const host = (req.hostname ?? '').split(':')[0];
  const parts = host.split('.');
  // cliente.beexa-flow.evonectech.com -> cliente ; host corto -> null
  if (parts.length >= 3) {
    return parts[0];
  }
  return null;
}

/**
 * Slugs de tenants autorizados del request autenticado. Prefiere
 * `request.tenants` (lo publica BearerAuthGuard en la misma request) y cae al
 * CLS como red de seguridad. Nunca inventa un valor ni un tenant `default`.
 */
function authorizedTenants(request: any, cls: ClsService): string[] {
  let fromCls: unknown;
  try {
    fromCls = cls.get(TENANTS_CLS_KEY);
  } catch {
    fromCls = undefined;
  }
  for (const candidate of [request?.tenants, fromCls]) {
    if (Array.isArray(candidate)) {
      return candidate.filter((t): t is string => typeof t === 'string');
    }
  }
  return [];
}

@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    private readonly tenantDb: TenantDbContext,
    private readonly cls: ClsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const slug = slugFromRequest(req);
    // 0.4b: fail-closed. Sin slug saneado no hay tenant válido (nunca 'default').
    if (!slug || !SLUG_PATTERN.test(slug)) {
      throw new ForbiddenException('tenant slug missing or malformed');
    }
    // El slug debe pertenecer a los tenants del contexto autenticado.
    const tenants = authorizedTenants(req, this.cls);
    if (!tenants.includes(slug)) {
      throw new ForbiddenException('tenant not authorized');
    }
    return from(
      this.tenantDb.runWithTenant(slug, () => next.handle().toPromise()),
    ).pipe(
      switchMap((v) => {
        if (v instanceof UnknownTenantError) {
          throw new NotFoundException('unknown tenant');
        }
        return [v];
      }),
    );
  }
}
