import * as fs from 'fs';
import * as path from 'path';
import type { DataSource } from 'typeorm';

/**
 * Track A / A.1d — scheduled-action.node.ts must resolve its DataSource
 * through the tenant-aware `initializeDatabase(tenantId)` seam (base.node.ts),
 * never the global `getRepository('ScheduledJourneyAction')` string lookup, and
 * must fail closed under MULTITENANT_SCHEMA=1 when no tenant travels.
 *
 * The bypass (bypasses-fase2.md #3) was the global string-named repository.
 * This spec pins the runtime path (tenant propagation + repo class + fail
 * closed) and adds a source guard, same spirit as `single-account.spec.ts`.
 */

jest.mock('@temporalio/activity', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../../shared/crm-client/crm-client.service', () => ({
  CrmClientService: jest.fn().mockImplementation(() => ({
    createScheduledAction: jest.fn().mockResolvedValue({
      success: true,
      data: { id: 'crm-action-1' },
    }),
  })),
}));
jest.mock('../../../../multitenant/tenant-services', () => ({
  isMultitenantSchemaEnabled: jest.fn(() => false),
}));

import { isMultitenantSchemaEnabled } from '../../../../multitenant/tenant-services';
import { ScheduledJourneyAction } from '../../../journeys/entities/scheduled-journey-action.entity';
import { ScheduledActionNode } from './scheduled-action.node';

const multitenant = isMultitenantSchemaEnabled as unknown as jest.Mock;

function baseInput(overrides: Record<string, unknown> = {}): any {
  return {
    nodeId: 'n1',
    contactId: 'c1',
    sessionId: 's1',
    journeyId: 'j1',
    nodeData: {
      delayDuration: 5,
      delayUnit: 'minutes',
      actionType: 'send_message',
      actionConfig: {},
      // Skip the CRM round-trip; this spec covers the DB seam only.
      createScheduledAction: false,
    },
    ...overrides,
  };
}

function fakeDataSource() {
  const create = jest.fn((x: Record<string, unknown>) => ({ ...x, id: 'sa-1' }));
  const save = jest.fn(async (x: unknown) => x);
  const update = jest.fn(async () => ({ affected: 1 }));
  const getRepository = jest.fn(() => ({ create, save, update }));
  return {
    dataSource: { getRepository } as unknown as DataSource,
    getRepository,
    create,
    save,
    update,
  };
}

describe('ScheduledActionNode — tenant-aware DataSource (A.1d)', () => {
  beforeEach(() => {
    multitenant.mockClear();
    multitenant.mockReturnValue(false);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves the repository from the tenant-aware DataSource using input.tenantId', async () => {
    const { dataSource, getRepository } = fakeDataSource();
    const node = new ScheduledActionNode();
    const initSpy = jest
      .spyOn(node as any, 'initializeDatabase')
      .mockResolvedValue(dataSource);

    const result = await node.execute(baseInput({ tenantId: 'tenant_a' }));

    expect(initSpy).toHaveBeenCalledWith('tenant_a');
    expect(getRepository).toHaveBeenCalledWith(ScheduledJourneyAction);
    expect(result.success).toBe(true);
    expect(result.variables?.['node_n1_scheduled_action_id']).toBe('sa-1');
  });

  it('keeps the legacy global pool when no tenant is present (community)', async () => {
    const { dataSource, getRepository } = fakeDataSource();
    const node = new ScheduledActionNode();
    const initSpy = jest
      .spyOn(node as any, 'initializeDatabase')
      .mockResolvedValue(dataSource);

    const result = await node.execute(baseInput());

    expect(initSpy).toHaveBeenCalledWith(null);
    expect(getRepository).toHaveBeenCalledWith(ScheduledJourneyAction);
    expect(result.success).toBe(true);
  });

  it('fails closed under MULTITENANT_SCHEMA=1 when tenantId is missing', async () => {
    const { dataSource, getRepository } = fakeDataSource();
    const node = new ScheduledActionNode();
    const initSpy = jest
      .spyOn(node as any, 'initializeDatabase')
      .mockResolvedValue(dataSource);
    multitenant.mockReturnValue(true);

    const result = await node.execute(baseInput());

    expect(result.success).toBe(false);
    expect(result.error).toContain('tenant');
    expect(initSpy).not.toHaveBeenCalled();
    expect(getRepository).not.toHaveBeenCalled();
  });

  it('does not consult the multitenant flag when a tenant is present', async () => {
    const { dataSource } = fakeDataSource();
    const node = new ScheduledActionNode();
    jest
      .spyOn(node as any, 'initializeDatabase')
      .mockResolvedValue(dataSource);

    await node.execute(baseInput({ tenantId: 'tenant_a' }));

    expect(multitenant).not.toHaveBeenCalled();
  });
});

describe('scheduled-action.node.ts — global-pool bypass guard (A.1d)', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'scheduled-action.node.ts'),
    'utf8',
  );

  it('does not look the entity up by string name', () => {
    expect(source).not.toMatch(/getRepository\(\s*['"]/);
  });

  it('threads the tenant into initializeDatabase', () => {
    expect(source).toMatch(/initializeDatabase\(\s*tenantId\s*\)/);
  });

  it('fails closed in multitenant mode when the tenant is absent', () => {
    expect(source).toMatch(/isMultitenantSchemaEnabled\s*\(/);
    expect(source).toMatch(/TenantContextMissingError/);
  });
});
