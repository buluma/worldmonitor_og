import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SEED_SCHEDULER_MANIFEST, getLaneScripts, resolveLaneName } from '../scripts/seed-scheduler-manifest.mjs';

const compose = readFileSync('docker-compose.yml', 'utf8');

test('lane alias resolves fast to frequent', () => {
  assert.equal(resolveLaneName('fast'), 'frequent');
  assert.equal(resolveLaneName('frequent'), 'frequent');
});

test('compose Ofelia schedules match the manifest', () => {
  for (const [lane, meta] of Object.entries(SEED_SCHEDULER_MANIFEST.lanes)) {
    const escaped = meta.schedule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`ofelia\\.job-exec\\.${lane}\\.schedule:\\s+"${escaped}"`);
    assert.match(compose, pattern, `missing compose schedule for lane ${lane}`);
  }
});

test('non-full lanes do not duplicate seed scripts', () => {
  const seen = new Set();
  for (const lane of Object.keys(SEED_SCHEDULER_MANIFEST.lanes)) {
    for (const script of getLaneScripts(lane)) {
      assert.equal(seen.has(script), false, `${script} duplicated across lanes`);
      seen.add(script);
    }
  }
});

test('cross-source signals remains sequenced after forecasts', () => {
  const hourlyScripts = getLaneScripts('hourly');
  const forecastsIndex = hourlyScripts.indexOf('seed-forecasts.mjs');
  const crossSourceIndex = hourlyScripts.indexOf('seed-cross-source-signals.mjs');
  assert.ok(forecastsIndex >= 0, 'seed-forecasts.mjs missing from hourly lane');
  assert.ok(crossSourceIndex > forecastsIndex, 'seed-cross-source-signals.mjs must run after seed-forecasts.mjs');
});
