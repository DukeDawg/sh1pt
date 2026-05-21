import { defineAffiliate, tokenSetup, type AffiliateConnectContext } from '@profullstack/sh1pt-core';

interface Config {
  accountId?: string;
  baseUrl?: string;
  publisherId?: string | number;
  advertiserId?: string | number;
  campaign?: string;
  clickRef?: string;
  clickRef2?: string;
  clickRef3?: string;
  clickRef4?: string;
  clickRef5?: string;
  clickRef6?: string;
  shorten?: boolean;
  from?: string;
  to?: string;
  dateType?: 'transaction' | 'validation' | 'amendment';
  status?: 'pending' | 'approved' | 'declined' | 'deleted';
  region?: string;
  timezone?: string;
  currency?: string;
}

type JsonRecord = Record<string, unknown>;

interface AwinLinkResponse {
  url?: string;
  shortUrl?: string;
  description?: string;
  message?: string;
}

const API_BASE = 'https://api.awin.com';
const SECRET_KEY = 'AWIN_API_KEY';
const DEFAULT_REGION = 'US';
const DEFAULT_TIMEZONE = 'UTC';

export default defineAffiliate<Config>({
  id: 'affiliate-awin',
  label: 'Awin',
  side: 'publisher',

  async connect(ctx, config) {
    requireToken(ctx);
    return { accountId: String(config.accountId ?? config.publisherId ?? 'affiliate-awin') };
  },

  async createProgram(_ctx, _program, config) {
    const advertiserId = requireAdvertiserId(config.advertiserId);
    return {
      programId: String(advertiserId),
      marketplaceUrl: `https://ui.awin.com/merchant-profile/${advertiserId}`,
    };
  },

  async getTrackingLink(ctx, programId, destinationUrl, config) {
    const publisherId = requirePublisherId(config);
    const advertiserId = requireAdvertiserId(programId);
    const parameters = compact({
      campaign: config.campaign,
      clickref: config.clickRef,
      clickref2: config.clickRef2,
      clickref3: config.clickRef3,
      clickref4: config.clickRef4,
      clickref5: config.clickRef5,
      clickref6: config.clickRef6,
    });

    const data = await awinRequest<AwinLinkResponse>(
      ctx,
      config,
      'POST',
      `/publishers/${encodeURIComponent(publisherId)}/linkbuilder/generate`,
      {
        body: {
          advertiserId,
          destinationUrl,
          ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
          shorten: config.shorten ?? false,
        },
      },
    );

    if (!data.url) {
      throw new Error(`Awin link builder did not return a url${data.description ? `: ${data.description}` : ''}`);
    }

    return {
      url: data.url,
      ...(data.shortUrl ? { shortUrl: data.shortUrl } : {}),
    };
  },

  async stats(ctx, programId, config) {
    const publisherId = requirePublisherId(config);
    const advertiserId = requireAdvertiserId(programId);
    const to = config.to ?? new Date().toISOString();
    const from = config.from ?? daysAgoIso(30);
    const timezone = config.timezone ?? DEFAULT_TIMEZONE;

    const transactions = await awinRequest<JsonRecord[] | JsonRecord>(
      ctx,
      config,
      'GET',
      `/publishers/${encodeURIComponent(publisherId)}/transactions/`,
      {
        query: compact({
          advertiserId: String(advertiserId),
          dateType: config.dateType ?? 'transaction',
          startDate: toDateTime(from, false),
          endDate: toDateTime(to, true),
          status: config.status,
          timezone,
        }),
      },
    );

    const report = await awinRequest<JsonRecord[] | JsonRecord>(
      ctx,
      config,
      'GET',
      `/publishers/${encodeURIComponent(publisherId)}/reports/advertiser`,
      {
        query: compact({
          dateType: config.dateType ?? 'transaction',
          startDate: toDateOnly(from),
          endDate: toDateOnly(to),
          region: config.region ?? DEFAULT_REGION,
          timezone,
        }),
      },
    );

    const transactionRows = asRows(transactions, 'transactions');
    const reportRows = asRows(report, 'report');
    const matchingReportRows = reportRows.filter(row => String(row.advertiserId ?? advertiserId) === String(advertiserId));
    const statRows = matchingReportRows.length > 0 ? matchingReportRows : reportRows;

    return {
      publishers: 0,
      clicks: sum(statRows, 'clicks'),
      conversions: sum(statRows, 'totalNo') || transactionRows.length,
      revenue: sum(statRows, 'totalValue') || sumNested(transactionRows, 'saleAmount'),
      commissionsPaid: sum(statRows, 'totalComm') || sumNested(transactionRows, 'commissionAmount'),
      currency: config.currency ?? firstCurrency(statRows, transactionRows) ?? 'USD',
    };
  },

  setup: tokenSetup<Config>({
    secretKey: SECRET_KEY,
    label: 'Awin',
    vendorDocUrl: 'https://help.awin.com/apidocs/introduction-1',
    steps: [
      'Log into the Awin UI and open API credentials for your publisher account',
      'Create or copy an API access token',
      'Also note your publisher ID for link-builder and reporting calls',
      'Paste the token below; sh1pt stores it in the encrypted vault',
    ],
    fields: [
      {
        key: 'publisherId',
        message: 'Publisher ID',
        required: true,
      },
      {
        key: 'region',
        message: 'Default reporting region, such as US or GB',
      },
    ],
  }),
});

async function awinRequest<T>(
  ctx: AffiliateConnectContext,
  config: Config,
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Record<string, string | number | boolean>; body?: unknown } = {},
): Promise<T> {
  const token = requireToken(ctx);
  const url = new URL(`${trimTrailingSlash(config.baseUrl ?? API_BASE)}${path}`);
  url.searchParams.set('accessToken', token);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: token,
  };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });

  const text = await res.text();
  const data = parseJson(text);
  if (!res.ok) {
    throw new Error(`Awin ${method} ${path} failed: ${res.status} ${errorMessage(data, text)}`);
  }

  return data as T;
}

function requireToken(ctx: AffiliateConnectContext): string {
  const token = ctx.secret(SECRET_KEY);
  if (!token) throw new Error(`${SECRET_KEY} not in vault - run \`sh1pt promote affiliates setup\``);
  return token;
}

function requirePublisherId(config: Config): string {
  if (config.publisherId === undefined || config.publisherId === '') {
    throw new Error('Awin requires config.publisherId for publisher API calls');
  }
  return String(config.publisherId);
}

function requireAdvertiserId(value: string | number | undefined): number {
  const advertiserId = Number(value);
  if (!Number.isInteger(advertiserId) || advertiserId <= 0) {
    throw new Error('Awin requires a numeric advertiser/program id');
  }
  return advertiserId;
}

function compact(input: Record<string, string | number | boolean | undefined>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '') output[key] = value;
  }
  return output;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function errorMessage(data: unknown, fallback: string): string {
  if (isRecord(data)) {
    const message = data.message ?? data.description ?? data.error;
    if (typeof message === 'string') return message.slice(0, 200);
  }
  return fallback.slice(0, 200);
}

function asRows(value: unknown, key: string): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  const nested = value[key];
  if (Array.isArray(nested)) return nested.filter(isRecord);
  const results = value.results;
  if (Array.isArray(results)) return results.filter(isRecord);
  return [value];
}

function sum(rows: JsonRecord[], key: string): number {
  return rows.reduce((total, row) => total + numeric(row[key]), 0);
}

function sumNested(rows: JsonRecord[], key: string): number {
  return rows.reduce((total, row) => total + numeric(row[key]), 0);
}

function numeric(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (isRecord(value)) return numeric(value.amount ?? value.value);
  return 0;
}

function firstCurrency(reportRows: JsonRecord[], transactionRows: JsonRecord[]): string | undefined {
  for (const row of [...reportRows, ...transactionRows]) {
    const direct = row.currency;
    if (typeof direct === 'string' && direct) return direct;
    const sale = row.saleAmount;
    if (isRecord(sale) && typeof sale.currency === 'string') return sale.currency;
    const commission = row.commissionAmount;
    if (isRecord(commission) && typeof commission.currency === 'string') return commission.currency;
  }
  return undefined;
}

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function toDateOnly(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(value).toISOString().slice(0, 10);
}

function toDateTime(value: string, endOfDay: boolean): string {
  if (value.includes('T')) return value;
  return `${value}T${endOfDay ? '23:59:59' : '00:00:00'}Z`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
