#!/usr/bin/env node

export const MODE_ALIASES = {
  fast: 'frequent',
};

export const SEED_SCHEDULER_MANIFEST = {
  version: 1,
  lanes: {
    frequent: {
      schedule: '0 */15 * * * *',
      timeoutSec: 900,
      description: 'Short-TTL market, alert, and operational seeds for self-hosted freshness.',
      dependsOn: [],
      seeds: [
        { script: 'seed-market-quotes.mjs' },
        { script: 'seed-commodity-quotes.mjs' },
        { script: 'seed-crypto-quotes.mjs' },
        { script: 'seed-sector-summary.mjs' },
        { script: 'seed-etf-flows.mjs' },
        { script: 'seed-stablecoin-markets.mjs' },
        { script: 'seed-token-panels.mjs' },
        { script: 'seed-earthquakes.mjs' },
        { script: 'seed-weather-alerts.mjs' },
        { script: 'seed-radiation-watch.mjs' },
        { script: 'seed-unrest-events.mjs' },
        { script: 'seed-correlation.mjs' },
        { script: 'seed-prediction-markets.mjs' },
        { script: 'seed-airport-delays.mjs' },
        { script: 'seed-insights.mjs' },
      ],
    },
    hourly: {
      schedule: '0 7 * * * *',
      timeoutSec: 1200,
      description: 'Medium-cost seeds that should stay warm continuously on self-hosted installs.',
      dependsOn: ['frequent'],
      seeds: [
        { script: 'seed-climate-anomalies.mjs' },
        { script: 'seed-usa-spending.mjs' },
        { script: 'seed-security-advisories.mjs' },
        { script: 'seed-natural-events.mjs' },
        { script: 'seed-thermal-escalation.mjs' },
        { script: 'seed-service-statuses.mjs' },
        { script: 'seed-forecasts.mjs' },
        { script: 'seed-cross-source-signals.mjs', dependsOn: ['seed-forecasts.mjs'] },
      ],
    },
    sixhourly: {
      schedule: '0 17 */6 * * *',
      timeoutSec: 1800,
      description: 'Heavier intelligence and reference jobs with longer acceptable freshness windows.',
      dependsOn: ['hourly'],
      seeds: [
        { script: 'seed-cyber-threats.mjs' },
        { script: 'seed-displacement-summary.mjs' },
        { script: 'seed-conflict-intel.mjs' },
        { script: 'seed-ucdp-events.mjs' },
        { script: 'seed-gdelt-intel.mjs' },
        { script: 'seed-sanctions-pressure.mjs' },
        { script: 'seed-research.mjs' },
        { script: 'seed-supply-chain-trade.mjs' },
      ],
    },
    daily: {
      schedule: '0 32 2 * * *',
      timeoutSec: 1800,
      description: 'Daily refresh jobs for slower-moving economic and reference datasets.',
      dependsOn: ['sixhourly'],
      seeds: [
        { script: 'seed-fx-rates.mjs' },
        { script: 'seed-ecb-fx-rates.mjs', dependsOn: ['seed-fx-rates.mjs'] },
        { script: 'seed-economic-calendar.mjs' },
        { script: 'seed-eurostat-country-data.mjs' },
        { script: 'seed-gie-gas-storage.mjs' },
        { script: 'seed-vpd-tracker.mjs' },
        { script: 'seed-disease-outbreaks.mjs' },
        { script: 'seed-fear-greed.mjs' },
        { script: 'seed-earnings-calendar.mjs' },
      ],
    },
    weekly: {
      schedule: '0 45 3 * * 6',
      timeoutSec: 3600,
      description: 'Heavy slow-moving comparison and macro reference jobs.',
      dependsOn: ['daily'],
      seeds: [
        { script: 'seed-submarine-cables.mjs' },
        { script: 'seed-military-bases.mjs' },
        { script: 'seed-bigmac.mjs', dependsOn: ['seed-fx-rates.mjs'] },
        { script: 'seed-grocery-basket.mjs', dependsOn: ['seed-fx-rates.mjs'] },
        { script: 'seed-fuel-prices.mjs' },
        { script: 'seed-national-debt.mjs' },
        { script: 'seed-fsi-eu.mjs' },
      ],
    },
  },
};

export function resolveLaneName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return 'frequent';
  return MODE_ALIASES[normalized] || normalized;
}

export function getLane(name) {
  const resolved = resolveLaneName(name);
  const lane = SEED_SCHEDULER_MANIFEST.lanes[resolved];
  if (!lane) {
    throw new Error(`Unknown seed lane: ${name}`);
  }
  return { name: resolved, ...lane };
}

export function getLaneScripts(name) {
  return getLane(name).seeds.map((seed) => seed.script);
}

function printUsage() {
  console.error('Usage: node scripts/seed-scheduler-manifest.mjs <resolve|seeds|timeout|schedule|json> [lane]');
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectRun) {
  const command = process.argv[2] || 'json';
  const lane = process.argv[3] || 'frequent';

  try {
    if (command === 'resolve') {
      console.log(resolveLaneName(lane));
    } else if (command === 'seeds') {
      console.log(getLaneScripts(lane).join('\n'));
    } else if (command === 'timeout') {
      console.log(String(getLane(lane).timeoutSec));
    } else if (command === 'schedule') {
      console.log(getLane(lane).schedule);
    } else if (command === 'json') {
      console.log(JSON.stringify(getLane(lane), null, 2));
    } else {
      printUsage();
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}
