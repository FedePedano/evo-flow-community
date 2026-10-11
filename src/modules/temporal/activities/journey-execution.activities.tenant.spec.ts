import * as fs from 'fs';
import * as path from 'path';
import type { DataSource } from 'typeorm';

/**
 * Track A / A.1b — journey-execution.activities.ts must resolve DB access
 * through the tenant-aware seam, never the global pool.
 *
 * The bypass (bypasses-fase2.md #1) was `initializeCacheServices()` building
 * the cache-service repos from `AppDataSource.getRepository(...)` on the global
 * pool. This spec pins both halves: the source no longer contains the global
 * access (grep guard, same spirit as `single-account.spec.ts`), and the runtime
 * path resolves the repos via `dataSourceFor(input.tenantId)`.
 */

jest.mock('../../cache/services/journey-session-cache.service', () => ({
  JourneySessionCacheService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../cache/services/journey-cache.service', () => ({
  JourneyCacheService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../../multitenant/tenant-services', () => ({
  dataSourceFor: jest.fn(),
  servicesForTenant: jest.fn(),
}));

import { JourneySessionCacheService } from '../../cache/services/journey-session-cache.service';
import { JourneyCacheService } from '../../cache/services/journey-cache.service';
import {
  dataSourceFor,
  servicesForTenant,
} from '../../../multitenant/tenant-services';
import { Journey } from '../../journeys/entities/journey.entity';
import { JourneySession } from '../../journeys/entities/journey-session.entity';
import { journeyExecutionActivities } from './journey-execution.activities';

const dataSourceForMock = dataSourceFor as unknown as jest.Mock;
const servicesForTenantMock = servicesForTenant as unknown as jest.Mock;
const sessionCtor = JourneySessionCacheService as unknown as jest.Mock;
const journeyCtor = JourneyCacheService as unknown as jest.Mock;

const SESSION_REPO = { kind: 'session-repo' };
const JOURNEY_REPO = { kind: 'journey-repo' };

function tenantDataSource(schema: string) {
  const getRepository = jest.fn((entity: unknown) =>
    entity === JourneySession ? SESSION_REPO : JOURNEY_REPO,
  );
  return {
    dataSource: { options: { schema }, getRepository } as unknown as DataSource,
    getRepository,
  };
}

const activeJourney = {
  id: 'j1',
  name: 'Journey 1',
  isActive: true,
  flowData: { nodes: [] },
  flowTriggers: [],
  variables: [],
};

describe('journey-execution.activities — tenant-aware DB access (A.1b)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves cache repos via the tenant DataSource using input.tenantId', async () => {
    const { dataSource, getRepository } = tenantDataSource('cliente_acme');
    dataSourceForMock.mockResolvedValue(dataSource);
    servicesForTenantMock.mockResolvedValue({
      sessionService: { get: jest.fn(), set: jest.fn() },
      journeyService: { get: jest.fn().mockResolvedValue(activeJourney) },
    });

    const result = await journeyExecutionActivities.loadJourneyData({
      tenantId: 'tenant_a',
      journeyId: 'j1',
    });

    expect(dataSourceForMock).toHaveBeenCalledWith('tenant_a');
    expect(getRepository).toHaveBeenCalledWith(JourneySession);
    expect(getRepository).toHaveBeenCalledWith(Journey);
    expect(sessionCtor).toHaveBeenCalledWith(SESSION_REPO, expect.anything());
    expect(journeyCtor).toHaveBeenCalledWith(JOURNEY_REPO, expect.anything());
    expect(result).toMatchObject({
      id: 'j1',
      name: 'Journey 1',
      isActive: true,
    });
  });

  it('falls back to the global DataSource when tenantId is absent (legacy)', async () => {
    const { dataSource } = tenantDataSource('public');
    dataSourceForMock.mockResolvedValue(dataSource);
    servicesForTenantMock.mockResolvedValue({
      sessionService: { get: jest.fn(), set: jest.fn() },
      journeyService: { get: jest.fn().mockResolvedValue(activeJourney) },
    });

    await journeyExecutionActivities.loadJourneyData({ journeyId: 'j1' });

    expect(dataSourceForMock).toHaveBeenCalledWith(undefined);
  });
});

describe('journey-execution.activities.ts — global-pool bypass guard (A.1b)', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'journey-execution.activities.ts'),
    'utf8',
  );

  it('does not resolve repositories from the global AppDataSource', () => {
    expect(source).not.toMatch(/AppDataSource\s*\.\s*getRepository/);
  });

  it("does not use the Nest app 'DataSource' provider", () => {
    expect(source).not.toMatch(/app\s*\.\s*get\(\s*['"]DataSource['"]\s*\)/);
  });

  it('routes repo resolution through the tenant-aware dataSourceFor seam', () => {
    expect(source).toMatch(/dataSourceFor\s*\(/);
  });
});
