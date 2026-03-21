/**
 * ListFireDetections RPC -- reads seeded wildfire data from Railway seed cache.
 * All external NASA FIRMS API calls happen in seed-wildfires.mjs on Railway.
 */

import type {
  WildfireServiceHandler,
  ServerContext,
  ListFireDetectionsRequest,
  ListFireDetectionsResponse,
} from '../../../../src/generated/server/worldmonitor/wildfire/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'wildfire:fires:v1';
const REDIS_CACHE_TTL = 3600; // 1h — NASA FIRMS VIIRS NRT updates every ~3 hours
const SEED_FRESHNESS_MS = 90 * 60 * 1000; // 90 minutes

const FIRMS_SOURCE = 'VIIRS_SNPP_NRT';
const FIRMS_TIMEOUT_MS = 15_000;
const FIRMS_MAX_ATTEMPTS = 3;
const FIRMS_BATCH_CONCURRENCY = 3;

/** Bounding boxes as west,south,east,north */
const MONITORED_REGIONS: Record<string, string> = {
  'Ukraine': '22,44,40,53',
  'Russia': '20,50,180,82',
  'Iran': '44,25,63,40',
  'Israel/Gaza': '34,29,36,34',
  'Syria': '35,32,42,37',
  'Taiwan': '119,21,123,26',
  'North Korea': '124,37,131,43',
  'Saudi Arabia': '34,16,56,32',
  'Turkey': '26,36,45,42',
};

/** Map VIIRS confidence letters to proto enum values. */
function mapConfidence(c: string): FireConfidence {
  switch (c.toLowerCase()) {
    case 'h':
      return 'FIRE_CONFIDENCE_HIGH';
    case 'n':
      return 'FIRE_CONFIDENCE_NOMINAL';
    case 'l':
      return 'FIRE_CONFIDENCE_LOW';
    default:
      return 'FIRE_CONFIDENCE_UNSPECIFIED';
  }
}

/** Parse a FIRMS CSV response into an array of row objects keyed by header name. */
function parseCSV(csv: string): Record<string, string>[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0]!.split(',').map((h) => h.trim());
  const results: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i]!.split(',').map((v) => v.trim());
    if (vals.length < headers.length) continue;

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx]!;
    });
    results.push(row);
  }

  return results;
}

/**
 * Parse FIRMS acq_date (YYYY-MM-DD) + acq_time (HHMM) into Unix epoch
 * milliseconds.
 */
function parseDetectedAt(acqDate: string, acqTime: string): number {
  const padded = acqTime.padStart(4, '0');
  const hours = padded.slice(0, 2);
  const minutes = padded.slice(2);
  return new Date(`${acqDate}T${hours}:${minutes}:00Z`).getTime();
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchRegionRows(regionName: string, bbox: string, apiKey: string): Promise<{ regionName: string; rows: Record<string, string>[] }> {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/${FIRMS_SOURCE}/${bbox}/1`;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= FIRMS_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/csv', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(FIRMS_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`FIRMS ${res.status} for ${regionName}`);
      }
      const csv = await res.text();
      return { regionName, rows: parseCSV(csv) };
    } catch (error) {
      lastError = error instanceof Error
        ? error
        : new Error(String(error));
      if (attempt < FIRMS_MAX_ATTEMPTS) {
        await sleep(250 * attempt);
      }
    }
  }

  throw new Error(`FIRMS fetch failed for ${regionName} after ${FIRMS_MAX_ATTEMPTS} attempts: ${lastError?.message || 'unknown error'}`);
}

export const listFireDetections: WildfireServiceHandler['listFireDetections'] = async (
  _ctx: ServerContext,
  _req: ListFireDetectionsRequest,
): Promise<ListFireDetectionsResponse> => {
  let staleFallback: ListFireDetectionsResponse | null = null;

  try {
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(REDIS_CACHE_KEY, true) as Promise<ListFireDetectionsResponse | null>,
      getCachedJson('seed-meta:wildfire:fires', true) as Promise<{ fetchedAt?: number } | null>,
    ]);
    if (seedData?.fireDetections?.length) {
      staleFallback = seedData;
      const isFresh = (seedMeta?.fetchedAt ?? 0) > 0 && (Date.now() - seedMeta!.fetchedAt!) < SEED_FRESHNESS_MS;
      if (isFresh || !process.env.SEED_FALLBACK_WILDFIRES) {
        return seedData;
      }
    }
  } catch { /* fall through to live fetch */ }

  const apiKey =
    process.env.NASA_FIRMS_API_KEY || process.env.FIRMS_API_KEY || '';

  if (!apiKey) {
    return { fireDetections: [], pagination: undefined };
  }

  let result: ListFireDetectionsResponse | null = null;
  try {
    result = await cachedFetchJson<ListFireDetectionsResponse>(
      REDIS_CACHE_KEY,
      REDIS_CACHE_TTL,
      async () => {
        const entries = Object.entries(MONITORED_REGIONS);
        const results: PromiseSettledResult<{ regionName: string; rows: Record<string, string>[] }>[] = [];
        for (let i = 0; i < entries.length; i += FIRMS_BATCH_CONCURRENCY) {
          const batch = entries.slice(i, i + FIRMS_BATCH_CONCURRENCY);
          const settled = await Promise.allSettled(
            batch.map(([regionName, bbox]) => fetchRegionRows(regionName, bbox, apiKey)),
          );
          results.push(...settled);
        }

        const fireDetections: ListFireDetectionsResponse['fireDetections'] = [];
        let failedRegions = 0;

        for (const r of results) {
          if (r.status === 'fulfilled') {
            const { regionName, rows } = r.value;
            for (const row of rows) {
              const detectedAt = parseDetectedAt(row.acq_date || '', row.acq_time || '');
              fireDetections.push({
                id: `${row.latitude ?? ''}-${row.longitude ?? ''}-${row.acq_date ?? ''}-${row.acq_time ?? ''}`,
                location: {
                  latitude: parseFloat(row.latitude ?? '0') || 0,
                  longitude: parseFloat(row.longitude ?? '0') || 0,
                },
                brightness: parseFloat(row.bright_ti4 ?? '0') || 0,
                frp: parseFloat(row.frp ?? '0') || 0,
                confidence: mapConfidence(row.confidence || ''),
                satellite: row.satellite || '',
                detectedAt,
                region: regionName,
                dayNight: row.daynight || '',
              });
            }
          } else {
            failedRegions++;
            console.error('[FIRMS]', r.reason?.message);
          }
        }

        if (fireDetections.length === 0 && failedRegions > 0) {
          throw new Error(`FIRMS failed for ${failedRegions}/${entries.length} monitored regions with no successful detections`);
        }

        return fireDetections.length > 0 ? { fireDetections, pagination: undefined } : null;
      },
    );
  } catch {
    if (staleFallback?.fireDetections?.length) {
      console.warn(`[FIRMS] Serving stale cached detections after live fetch failure (${staleFallback.fireDetections.length} records)`);
      return staleFallback;
    }
    return { fireDetections: [], pagination: undefined };
  }
};
