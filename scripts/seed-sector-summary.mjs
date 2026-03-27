#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, sleep, runSeed, parseYahooChart } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const sectorConfig = loadSharedConfig('sectors.json');

const CANONICAL_KEY = 'market:sectors:v1';
const CACHE_TTL = 5400;
const YAHOO_DELAY_MS = 150;

const SECTORS = sectorConfig.sectors;
const SECTOR_SYMBOLS = SECTORS.map((sector) => sector.symbol);
const QUOTES_KEY = `market:quotes:v1:${[...SECTOR_SYMBOLS].sort().join(',')}`;

async function fetchYahooWithRetry(url, label, maxAttempts = 4) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 429) {
      const wait = 5000 * (i + 1);
      console.warn(`  [Yahoo] ${label} 429 — waiting ${wait / 1000}s (attempt ${i + 1}/${maxAttempts})`);
      await sleep(wait);
      continue;
    }
    if (!resp.ok) {
      console.warn(`  [Yahoo] ${label} HTTP ${resp.status}`);
      return null;
    }
    return resp;
  }
  console.warn(`  [Yahoo] ${label} rate limited after ${maxAttempts} attempts`);
  return null;
}

async function fetchSectorSummary() {
  const sectors = [];

  for (let i = 0; i < SECTORS.length; i++) {
    const sector = SECTORS[i];
    if (i > 0) await sleep(YAHOO_DELAY_MS);

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sector.symbol)}`;
      const resp = await fetchYahooWithRetry(url, sector.symbol);
      if (!resp) continue;
      const parsed = parseYahooChart(await resp.json(), sector.symbol);
      if (!parsed) continue;
      sectors.push({
        symbol: sector.symbol,
        name: sector.name,
        change: parsed.change,
      });
      console.log(`  ${sector.symbol}: ${parsed.change > 0 ? '+' : ''}${parsed.change}%`);
    } catch (err) {
      console.warn(`  [Yahoo] ${sector.symbol} error: ${err.message}`);
    }
  }

  if (sectors.length === 0) {
    throw new Error('All sector summary fetches failed');
  }

  return { sectors };
}

function validate(data) {
  return Array.isArray(data?.sectors) && data.sectors.length >= 1;
}

runSeed('market', 'sectors', CANONICAL_KEY, fetchSectorSummary, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'yahoo-chart',
  extraKeys: [
    {
      key: QUOTES_KEY,
      ttl: CACHE_TTL,
      transform: (data) => ({
        quotes: (data.sectors ?? []).map((sector) => ({
          symbol: sector.symbol,
          name: sector.name,
          display: sector.name,
          price: 0,
          change: sector.change,
          sparkline: [],
        })),
        finnhubSkipped: false,
        skipReason: '',
        rateLimited: false,
      }),
    },
  ],
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
