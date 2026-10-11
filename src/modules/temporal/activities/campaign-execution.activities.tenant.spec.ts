import * as fs from 'fs';
import * as path from 'path';

/**
 * Track A / A.1c — campaign-execution.activities.ts must resolve DB access
 * through the tenant-aware seam, never the global pool.
 *
 * The bypass (bypasses-fase2.md #2) was three `app.get('DataSource')`
 * repository lookups: getCampaignBatch, updateCampaignStatus and
 * markBatchAsProcessed. This spec pins both halves: the source no longer
 * contains the global access (grep guard, same spirit as
 * `single-account.spec.ts`), and the runtime path threads `tenantId` through
 * `runActivityInTenantDbContext(input.tenantId, manager => ...)`.
 */

jest.mock('../../../shared/app-context.holder', () => ({
  getAppContext: () => ({ get: jest.fn() }),
}));
jest.mock('@temporalio/activity', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock('../tenant-activity-context', () => ({
  runActivityInTenantDbContext: jest.fn(),
}));

import { runActivityInTenantDbContext } from '../tenant-activity-context';
import { Campaign } from '../../campaigns/entities/campaign.entity';
import {
  CampaignContact,
  CampaignContactStatus,
} from '../../campaigns/entities/campaign-contact.entity';
import {
  getCampaignBatch,
  markBatchAsProcessed,
  updateCampaignStatus,
} from './campaign-execution.activities';

const runSpy = runActivityInTenantDbContext as unknown as jest.Mock;

function managerReturning(getRepository: jest.Mock) {
  return { getRepository };
}

function wireRun(getRepository: jest.Mock): void {
  runSpy.mockImplementation(
    (_tenantId: unknown, work: (manager: unknown) => unknown) =>
      work(managerReturning(getRepository)),
  );
}

beforeEach(() => {
  runSpy.mockReset();
});

describe('campaign-execution.activities — tenant-aware DB access (A.1c)', () => {
  it('reads a batch via the tenant EntityManager (getCampaignBatch)', async () => {
    const getMany = jest.fn().mockResolvedValue([
      { id: 'cc-1', contactId: 'contact-1' },
      { id: 'cc-2', contactId: 'contact-2' },
    ]);
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany,
    };
    const getRepository = jest.fn(() => ({
      createQueryBuilder: jest.fn(() => qb),
    }));
    wireRun(getRepository);

    const result = await getCampaignBatch({
      tenantId: 'tenant_a',
      campaignId: 'camp-1',
      batchNumber: 2,
    });

    expect(runSpy).toHaveBeenCalledWith('tenant_a', expect.any(Function));
    expect(getRepository).toHaveBeenCalledWith(CampaignContact);
    expect(result).toEqual({
      batchNumber: 2,
      contacts: [
        { id: 'contact-1', campaignContactId: 'cc-1' },
        { id: 'contact-2', campaignContactId: 'cc-2' },
      ],
      totalInBatch: 2,
    });
  });

  it('falls back to the global pool when tenantId is absent (legacy)', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const getRepository = jest.fn(() => ({
      createQueryBuilder: jest.fn(() => qb),
    }));
    wireRun(getRepository);

    await getCampaignBatch({ campaignId: 'camp-1', batchNumber: 1 });

    expect(runSpy).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  it('writes campaign status via the tenant EntityManager (updateCampaignStatus)', async () => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const getRepository = jest.fn(() => ({ update }));
    wireRun(getRepository);

    await updateCampaignStatus({
      tenantId: 'tenant_a',
      campaignId: 'camp-1',
      status: 2,
      sentContacts: 5,
    });

    expect(runSpy).toHaveBeenCalledWith('tenant_a', expect.any(Function));
    expect(getRepository).toHaveBeenCalledWith(Campaign);
    expect(update).toHaveBeenCalledWith(
      { id: 'camp-1' },
      { status: 2, sentContacts: 5 },
    );
  });

  it('marks a batch processed via the tenant EntityManager (markBatchAsProcessed)', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 3 });
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    const getRepository = jest.fn(() => ({
      createQueryBuilder: jest.fn(() => qb),
    }));
    wireRun(getRepository);

    await markBatchAsProcessed('camp-1', 2, 'tenant_a');

    expect(runSpy).toHaveBeenCalledWith('tenant_a', expect.any(Function));
    expect(getRepository).toHaveBeenCalledWith(CampaignContact);
    expect(qb.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: CampaignContactStatus.SENT }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the two-arg markBatchAsProcessed call working (legacy, no tenant)', async () => {
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const getRepository = jest.fn(() => ({
      createQueryBuilder: jest.fn(() => qb),
    }));
    wireRun(getRepository);

    await markBatchAsProcessed('camp-1', 2);

    expect(runSpy).toHaveBeenCalledWith(undefined, expect.any(Function));
  });
});

describe('campaign-execution.activities.ts — global-pool bypass guard (A.1c)', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'campaign-execution.activities.ts'),
    'utf8',
  );

  it("does not use the Nest app 'DataSource' provider", () => {
    expect(source).not.toMatch(/app\s*\.\s*get\(\s*['"]DataSource['"]\s*\)/);
  });

  it('does not resolve repositories from the global AppDataSource', () => {
    expect(source).not.toMatch(/AppDataSource\s*\.\s*getRepository/);
  });

  it('does not look entities up by string name', () => {
    expect(source).not.toMatch(/getRepository\(\s*['"]/);
  });

  it('routes repo resolution through the tenant-aware seam', () => {
    expect(source).toMatch(/runActivityInTenantDbContext\s*\(/);
  });
});
