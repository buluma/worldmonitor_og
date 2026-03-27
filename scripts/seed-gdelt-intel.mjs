#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, sleep, verifySeedKey, writeExtraKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:gdelt-intel:v1';
const CACHE_TTL = 86400; // 24h — intentionally much longer than the 2h cron so verifySeedKey always has a prior snapshot to merge from when GDELT 429s all topics
const TIMELINE_TTL = 43200; // 12h = 2× cron interval; tone/vol must survive until next 6h run
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const REQUEST_TIMEOUT_MS = Number(process.env.GDELT_REQUEST_TIMEOUT_MS || 8_000);
const INTER_TOPIC_DELAY_MS = Number(process.env.GDELT_INTER_TOPIC_DELAY_MS || 5_000);
const POST_EXHAUST_DELAY_MS = Number(process.env.GDELT_POST_EXHAUST_DELAY_MS || 15_000);
const RETRY_BASE_DELAY_MS = Number(process.env.GDELT_RETRY_BASE_DELAY_MS || 15_000);
const MAX_RETRIES = Number(process.env.GDELT_MAX_RETRIES || 1);
const DEADLINE_SAFETY_MS = Number(process.env.GDELT_DEADLINE_SAFETY_MS || 15_000);

const INTEL_TOPICS = [
  { id: 'military',     query: '(military exercise OR troop deployment OR airstrike OR "naval exercise") sourcelang:eng' },
  { id: 'cyber',        query: '(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng' },
  { id: 'nuclear',      query: '(nuclear OR uranium enrichment OR IAEA OR "nuclear weapon" OR plutonium) sourcelang:eng' },
  { id: 'sanctions',    query: '(sanctions OR embargo OR "trade war" OR tariff OR "economic pressure") sourcelang:eng' },
  { id: 'intelligence', query: '(espionage OR spy OR "intelligence agency" OR covert OR surveillance) sourcelang:eng' },
  { id: 'maritime',     query: '(naval blockade OR piracy OR "strait of hormuz" OR "south china sea" OR warship) sourcelang:eng' },
];

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function normalizeArticle(raw) {
  const url = raw.url || '';
  if (!isValidUrl(url)) return null;
  return {
    title: String(raw.title || '').slice(0, 500),
    url,
    source: String(raw.domain || raw.source?.domain || '').slice(0, 200),
    date: String(raw.seendate || ''),
    image: isValidUrl(raw.socialimage || '') ? raw.socialimage : '',
    language: String(raw.language || ''),
    tone: typeof raw.tone === 'number' ? raw.tone : 0,
  };
}

async function fetchTopicArticles(topic) {
  const url = new URL(GDELT_DOC_API);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('maxrecords', '10');
  url.searchParams.set('format', 'json');
  url.searchParams.set('sort', 'date');
  url.searchParams.set('timespan', '24h');

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) throw new Error(`GDELT ${topic.id}: HTTP ${resp.status}`);

  const data = await resp.json();
  const articles = (data.articles || [])
    .map(normalizeArticle)
    .filter(Boolean);

  return {
    id: topic.id,
    articles,
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeTimeline(data, mode) {
  const raw = data?.timeline ?? data?.data ?? [];
  return raw.map((pt) => ({
    date: String(pt.date || pt.datetime || ''),
    value: typeof pt.value === 'number' ? pt.value : (typeof pt[mode] === 'number' ? pt[mode] : 0),
  })).filter((pt) => pt.date);
}

async function fetchTopicTimeline(topic, mode) {
  const url = new URL(GDELT_DOC_API);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', mode);
  url.searchParams.set('format', 'json');
  url.searchParams.set('timespan', '14d');

  try {
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return normalizeTimeline(data, mode === 'TimelineTone' ? 'tone' : 'value');
  } catch {
    return [];
  }
}

function getDeadlineMs() {
  const timeoutSec = Number(process.env.SEEDER_TIMEOUT_SEC || 180);
  return Date.now() + Math.max(60_000, timeoutSec * 1000 - DEADLINE_SAFETY_MS);
}

function cloneCachedTopic(topic) {
  return {
    id: topic.id,
    articles: Array.isArray(topic.articles) ? [...topic.articles] : [],
    fetchedAt: topic.fetchedAt || new Date().toISOString(),
  };
}

async function fetchWithRetry(topic, deadlineMs, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchTopicArticles(topic);
    } catch (err) {
      const is429 = err.message?.includes('429');
      if (!is429 || attempt === maxRetries) {
        console.warn(`    ${topic.id}: giving up after ${attempt + 1} attempts (${err.message})`);
        // exhausted:true only when 429 was the reason — post-exhaust cooldown is only relevant for rate-limit windows
        return { id: topic.id, articles: [], fetchedAt: new Date().toISOString(), exhausted: is429 };
      }
      const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      if (Date.now() + backoff + REQUEST_TIMEOUT_MS >= deadlineMs) {
        console.warn(`    ${topic.id}: skipping retry to stay within seeder timeout budget`);
        return { id: topic.id, articles: [], fetchedAt: new Date().toISOString(), exhausted: true };
      }
      console.log(`    429 rate-limited, waiting ${backoff / 1000}s... (attempt ${attempt + 1}/${maxRetries + 1})`);
      await sleep(backoff);
    }
  }
}

async function fetchAllTopics() {
  const deadlineMs = getDeadlineMs();
  const previous = await verifySeedKey(CANONICAL_KEY).catch(() => null);
  const prevMap = previous && Array.isArray(previous.topics)
    ? new Map(previous.topics.map((t) => [t.id, t]))
    : new Map();
  const topics = [];
  for (let i = 0; i < INTEL_TOPICS.length; i++) {
    const topic = INTEL_TOPICS[i];
    if (Date.now() + REQUEST_TIMEOUT_MS >= deadlineMs) {
      if (prevMap.has(topic.id)) {
        const cached = cloneCachedTopic(prevMap.get(topic.id));
        console.log(`  Timeout budget reached before ${topic.id}; using ${cached.articles.length} cached articles`);
        topics.push(cached);
      } else {
        console.log(`  Timeout budget reached before ${topic.id}; leaving topic empty`);
        topics.push({ id: topic.id, articles: [], fetchedAt: new Date().toISOString(), exhausted: true });
      }
      continue;
    }
    if (i > 0) {
      const delay = Math.min(INTER_TOPIC_DELAY_MS, Math.max(0, deadlineMs - Date.now() - REQUEST_TIMEOUT_MS));
      if (delay > 0) await sleep(delay);
    }
    console.log(`  Fetching ${topic.id}...`);
    const result = await fetchWithRetry(topic, deadlineMs);
    console.log(`    ${result.articles.length} articles`);
    if (result.articles.length === 0 && prevMap.has(topic.id)) {
      const cached = prevMap.get(topic.id);
      if (cached?.articles?.length > 0) {
        console.log(`    ${topic.id}: using ${cached.articles.length} cached articles from previous snapshot`);
        result.articles = [...cached.articles];
        result.fetchedAt = cached.fetchedAt;
      }
    }
    if (result.articles.length > 0 && Date.now() + REQUEST_TIMEOUT_MS < deadlineMs) {
      // Fetch tone/vol timelines in parallel — best-effort, 429s silently return []
      const [tone, vol] = await Promise.all([
        fetchTopicTimeline(topic, 'TimelineTone'),
        fetchTopicTimeline(topic, 'TimelineVol'),
      ]);
      result._tone = tone;
      result._vol = vol;
      console.log(`    timeline: ${tone.length} tone pts, ${vol.length} vol pts`);
    } else {
      result._tone = [];
      result._vol = [];
      console.log('    timeline: skipped to preserve timeout budget');
    }
    topics.push(result);
    // After a topic exhausts all retries, give GDELT a longer cooldown before hitting
    // it again with the next topic — the rate limit window for popular queries exceeds 50s
    if (result.exhausted && i < INTEL_TOPICS.length - 1) {
      const cooldown = Math.min(POST_EXHAUST_DELAY_MS, Math.max(0, deadlineMs - Date.now() - REQUEST_TIMEOUT_MS));
      if (cooldown > 0) {
        console.log(`    Rate-limit cooldown: waiting ${cooldown / 1000}s before next topic...`);
        await sleep(cooldown);
      }
    }
  }

  return { topics, fetchedAt: new Date().toISOString() };
}

function validate(data) {
  if (!Array.isArray(data?.topics) || data.topics.length === 0) return false;
  const populated = data.topics.filter((t) => Array.isArray(t.articles) && t.articles.length > 0);
  return populated.length >= 3; // at least 3 of 6 topics must have articles; partial 429s handled by per-topic merge above
}

// Strip private fields (_tone, _vol, exhausted) before writing to the canonical Redis key.
function publishTransform(data) {
  return {
    ...data,
    topics: (data.topics ?? []).map(({ _tone: _t, _vol: _v, exhausted: _e, ...rest }) => rest),
  };
}

// Write per-topic tone/vol timeline keys (1h TTL) — separate from the 24h canonical key.
async function afterPublish(data, _meta) {
  for (const topic of data.topics ?? []) {
    const fetchedAt = topic.fetchedAt ?? data.fetchedAt;
    if (Array.isArray(topic._tone) && topic._tone.length > 0) {
      await writeExtraKey(`gdelt:intel:tone:${topic.id}`, { data: topic._tone, fetchedAt }, TIMELINE_TTL);
    }
    if (Array.isArray(topic._vol) && topic._vol.length > 0) {
      await writeExtraKey(`gdelt:intel:vol:${topic.id}`, { data: topic._vol, fetchedAt }, TIMELINE_TTL);
    }
  }
}

if (process.argv[1]?.endsWith('seed-gdelt-intel.mjs')) {
  runSeed('intelligence', 'gdelt-intel', CANONICAL_KEY, fetchAllTopics, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'gdelt-doc-v2',
    publishTransform,
    afterPublish,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(0);
  });
}
