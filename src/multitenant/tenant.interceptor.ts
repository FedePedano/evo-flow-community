/**
 * Interceptor NestJS que envuelve el request en el tenant (opt-in por
 * controller con `@UseInterceptors(TenantInterceptor)` — sin cambio global,
 * el default community/single-account queda intacto).
 *
 * Resuelve el slug por subdominio (`cliente.beexa-flow...` -> `cliente`) o
 * header `X-Tenant-Slug` (dev/test), y delega en `TenantDbContext.runWithTenant`,
 * que con el overlay registrado abre la txn + `SET LOCAL search_path` y
 * publica el manager en CLS para los 31 `getRepository` existentes.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';
import { TenantDbContext } from '../evo-extension-points/tenant-db-context/tenant-db-context.service';
import { UnknownTenantError } from './tenant.errors';

function slugFromRequest(req: { hostname?: string; headers?: Record<string, unknown> }): string | null {
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

@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly tenantDb: TenantDbContext) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const slug = slugFromRequest(req);
    if (!slug) {
      throw new NotFoundException('unknown tenant');
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
