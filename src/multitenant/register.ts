/**
 * Registro del overlay (3 líneas que sí tocan el boot; todo lo demás es
 * código nuevo aislado en `src/multitenant/`).
 *
 * Llamar UNA vez al arrancar cuando MULTITENANT_SCHEMA=1:
 *   import { registerSchemaPerTenantOverlay } from './multitenant/register';
 *   if (process.env.MULTITENANT_SCHEMA === '1') registerSchemaPerTenantOverlay();
 *
 * Sin la variable: registry conserva el no-op community (single-account
 * intacto, `single-account.spec.ts` verde porque no tocamos `src/runners/`).
 */
import { EvoExtensionPoints } from '../evo-extension-points/registry';
import { schemaPerTenantDbContext } from './tenant-schema-context.impl';

export function registerSchemaPerTenantOverlay(): void {
  EvoExtensionPoints.replace('tenant_db_context', schemaPerTenantDbContext);
}
