/**
 * RPC: ListEtfFlows -- reads seeded BTC spot ETF data from Railway seed cache.
 * All external Yahoo Finance calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  ListEtfFlowsRequest,
  ListEtfFlowsResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import {
  UPSTREAM_TIMEOUT_MS,
  type YahooChartResponse,
} from './_shared';
import { CHROME_UA, yahooGate } from '../../../_shared/constants';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import etfConfig from '../../../../shared/etfs.json';

const SEED_CACHE_KEY = 'market:etf-flows:v1';

const EMPTY_RESPONSE: ListEtfFlowsResponse = {
  timestamp: new Date().toISOString(),
  summary: {
    etfCount: 0,
    totalVolume: 0,
    totalEstFlow: 0,
    netDirection: 'UNAVAILABLE',
    inflowCount: 0,
    outflowCount: 0,
  },
  etfs: [],
  rateLimited: false,
};

export async function listEtfFlows(
  _ctx: ServerContext,
  _req: ListEtfFlowsRequest,
): Promise<ListEtfFlowsResponse> {
  const now = Date.now();
  let seededFallback: ListEtfFlowsResponse | null = null;
  if (etfCache && now - etfCacheTimestamp < ETF_CACHE_TTL) {
    return etfCache;
  }

  try {
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(REDIS_CACHE_KEY, true) as Promise<ListEtfFlowsResponse | null>,
      getCachedJson('seed-meta:market:etf-flows', true) as Promise<{ fetchedAt?: number } | null>,
    ]);
    if (seedData?.etfs?.length) {
      seededFallback = seedData;
      const fetchedAt = seedMeta?.fetchedAt ?? 0;
      const isFresh = now - fetchedAt < SEED_FRESHNESS_MS;
      if (isFresh || !process.env.SEED_FALLBACK_ETF) {
        etfCache = seedData;
        etfCacheTimestamp = now;
        return seedData;
      }
    }
  } catch { /* fall through to live fetch */ }

  try {
  const result = await cachedFetchJson<ListEtfFlowsResponse>(REDIS_CACHE_KEY, REDIS_CACHE_TTL, async () => {
    const etfs: EtfFlow[] = [];
    let misses = 0;
    for (const etf of ETF_LIST) {
      const chart = await fetchEtfChart(etf.ticker);
      if (chart) {
        const parsed = parseEtfChartData(chart, etf.ticker, etf.issuer);
        if (parsed) etfs.push(parsed); else misses++;
      } else {
        misses++;
      }
    }

    // Prefer stale seeded data when live Yahoo fetches are unavailable.
    if (etfs.length === 0 && (etfCache || seededFallback)) {
      return null;
    }

    if (etfs.length === 0) {
      return misses >= 3
        ? { timestamp: new Date().toISOString(), etfs: [], rateLimited: true }
        : null;
    }

    const totalVolume = etfs.reduce((sum, e) => sum + e.volume, 0);
    const totalEstFlow = etfs.reduce((sum, e) => sum + e.estFlow, 0);
    const inflowCount = etfs.filter(e => e.direction === 'inflow').length;
    const outflowCount = etfs.filter(e => e.direction === 'outflow').length;

    etfs.sort((a, b) => b.volume - a.volume);

    return {
      timestamp: new Date().toISOString(),
      summary: {
        etfCount: etfs.length,
        totalVolume,
        totalEstFlow,
        netDirection: totalEstFlow > 0 ? 'NET INFLOW' : totalEstFlow < 0 ? 'NET OUTFLOW' : 'NEUTRAL',
        inflowCount,
        outflowCount,
      },
      etfs,
      rateLimited: false,
    };
  });

  if (result) {
    etfCache = result;
    etfCacheTimestamp = now;
  }

  if (!result && seededFallback) {
    etfCache = seededFallback;
    etfCacheTimestamp = now;
  }

  return result || etfCache || seededFallback || {
    timestamp: new Date().toISOString(),
    summary: {
      etfCount: 0,
      totalVolume: 0,
      totalEstFlow: 0,
      netDirection: 'UNAVAILABLE',
      inflowCount: 0,
      outflowCount: 0,
    },
    etfs: [],
    rateLimited: false,
  };
  } catch {
    if (seededFallback) {
      etfCache = seededFallback;
      etfCacheTimestamp = now;
    }

    return etfCache || seededFallback || {
      timestamp: new Date().toISOString(),
      summary: {
        etfCount: 0,
        totalVolume: 0,
        totalEstFlow: 0,
        netDirection: 'UNAVAILABLE',
        inflowCount: 0,
        outflowCount: 0,
      },
      etfs: [],
      rateLimited: false,
    };
  }
}
