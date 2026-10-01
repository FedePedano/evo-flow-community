/** Errores fail-closed del overlay multitenant A2. */
export class TenantContextMissingError extends Error {
  constructor() {
    super('tenant ausente: la operación requiere tenant explícito (AC3: nunca sin scope)');
    this.name = 'TenantContextMissingError';
  }
}

export class UnknownTenantError extends Error {
  constructor(slug: string) {
    super(`tenant desconocido: ${slug}`);
    this.name = 'UnknownTenantError';
  }
}
