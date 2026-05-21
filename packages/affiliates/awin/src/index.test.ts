import { smokeTest } from '@profullstack/sh1pt-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import adapter from './index.js';

smokeTest(adapter, { idPrefix: 'affiliate' });

const ctx = (secrets: Record<string, string> = { AWIN_API_KEY: 'test-awin-token' }) => ({
  secret: (key: string) => secrets[key],
  log: vi.fn(),
});

describe('affiliate-awin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires an Awin API token to connect', async () => {
    await expect(adapter.connect(ctx({}), {})).rejects.toThrow('AWIN_API_KEY');
  });

  it('uses a configured advertiser as the program id', async () => {
    await expect(adapter.createProgram?.(ctx(), {
      name: 'Test program',
      commissionType: 'percentage',
      commissionRate: 10,
      destinationUrl: 'https://example.com',
    }, { advertiserId: 456 })).resolves.toEqual({
      programId: '456',
      marketplaceUrl: 'https://ui.awin.com/merchant-profile/456',
    });
  });

  it('generates publisher tracking links through Awin link builder', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _request?: RequestInit) => new Response(JSON.stringify({
      url: 'https://www.awin1.com/cread.php?awinmid=456&awinaffid=123',
      shortUrl: 'https://tidd.ly/abc',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.getTrackingLink?.(ctx(), '456', 'https://merchant.example/product', {
      publisherId: 123,
      campaign: 'spring',
      clickRef: 'lead-1',
      clickRef2: 'slot-a',
      shorten: true,
    })).resolves.toEqual({
      url: 'https://www.awin1.com/cread.php?awinmid=456&awinaffid=123',
      shortUrl: 'https://tidd.ly/abc',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(request).toBeDefined();
    const requestInit = request as RequestInit;
    const parsed = new URL(String(url));
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://api.awin.com/publishers/123/linkbuilder/generate');
    expect(parsed.searchParams.get('accessToken')).toBe('test-awin-token');
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'test-awin-token',
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(String(requestInit.body))).toEqual({
      advertiserId: 456,
      destinationUrl: 'https://merchant.example/product',
      parameters: {
        campaign: 'spring',
        clickref: 'lead-1',
        clickref2: 'slot-a',
      },
      shorten: true,
    });
  });

  it('aggregates transactions and advertiser performance stats', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _request?: RequestInit) => new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          id: 'transaction-1',
          saleAmount: { amount: 100, currency: 'USD' },
          commissionAmount: { amount: 10, currency: 'USD' },
          status: 'approved',
        },
        {
          id: 'transaction-2',
          saleAmount: '50',
          commissionAmount: '5',
          status: 'pending',
        },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          advertiserId: 456,
          currency: 'USD',
          clicks: 22,
          totalNo: 2,
          totalValue: 150,
          totalComm: 15,
        },
      ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.stats?.(ctx(), '456', {
      publisherId: '123',
      from: '2026-05-01',
      to: '2026-05-20',
      region: 'US',
      timezone: 'UTC',
    })).resolves.toEqual({
      publishers: 0,
      clicks: 22,
      conversions: 2,
      revenue: 150,
      commissionsPaid: 15,
      currency: 'USD',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const transactionUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(transactionUrl.pathname).toBe('/publishers/123/transactions/');
    expect(transactionUrl.searchParams.get('advertiserId')).toBe('456');
    expect(transactionUrl.searchParams.get('startDate')).toBe('2026-05-01T00:00:00Z');
    expect(transactionUrl.searchParams.get('endDate')).toBe('2026-05-20T23:59:59Z');

    const reportUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(reportUrl.pathname).toBe('/publishers/123/reports/advertiser');
    expect(reportUrl.searchParams.get('region')).toBe('US');
    expect(reportUrl.searchParams.get('startDate')).toBe('2026-05-01');
    expect(reportUrl.searchParams.get('endDate')).toBe('2026-05-20');
  });

  it('requires publisher id for publisher API calls', async () => {
    await expect(adapter.getTrackingLink?.(ctx(), '456', 'https://example.com', {})).rejects.toThrow('publisherId');
  });
});
