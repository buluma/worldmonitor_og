/**
 * RPC: ListCommodityQuotes -- reads seeded commodity data from Railway seed cache.
 * All external Yahoo Finance calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  ListCommodityQuotesRequest,
  ListCommodityQuotesResponse,
  CommodityQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import {
  fetchYahooQuotesBatch,
  parseStringArray,
  shouldSkipLiveYahooFallback,
  warnMarketDegradedThrottled,
} from './_shared';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';

const BOOTSTRAP_KEY = 'market:commodities-bootstrap:v1';

export async function listCommodityQuotes(
  _ctx: ServerContext,
  req: ListCommodityQuotesRequest,
): Promise<ListCommodityQuotesResponse> {
  const symbols = parseStringArray(req.symbols);
  if (!symbols.length) return { quotes: [] };

  try {
    const bootstrap = await getCachedJson(BOOTSTRAP_KEY, true) as ListCommodityQuotesResponse | null;
    if (!bootstrap?.quotes?.length) return { quotes: [] };

  const redisKey = redisCacheKey(symbols);

  if (shouldSkipLiveYahooFallback()) {
    warnMarketDegradedThrottled(
      'market:commodities',
      '[market:commodities] Skipping live Yahoo fetch: Redis seed cache and WS_RELAY_URL are both unavailable',
    );
    return fallbackCommodityCache.get(redisKey)?.data || { quotes: [] };
  }

  try {
  const result = await cachedFetchJson<ListCommodityQuotesResponse>(redisKey, REDIS_CACHE_TTL, async () => {
    const batch = await fetchYahooQuotesBatch(symbols);
    const quotes: CommodityQuote[] = [];
    for (const s of symbols) {
      const yahoo = batch.results.get(s);
      if (yahoo) {
        quotes.push({ symbol: s, name: s, display: s, price: yahoo.price, change: yahoo.change, sparkline: yahoo.sparkline });
      }
    }
    return quotes.length > 0 ? { quotes } : null;
  });

  if (result) {
    if (fallbackCommodityCache.size > 50) fallbackCommodityCache.clear();
    fallbackCommodityCache.set(redisKey, { data: result, ts: Date.now() });
  }
  return result || fallbackCommodityCache.get(redisKey)?.data || { quotes: [] };
  } catch {
    return { quotes: [] };
  }
}
