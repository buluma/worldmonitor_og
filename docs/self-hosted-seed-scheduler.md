# Self-Hosted Seed Scheduler

WorldMonitor's seed scripts are designed as scheduled jobs, not ad-hoc helpers. For self-hosted Docker deployments, the recommended pattern is:

- `worldmonitor` for the web/API container
- `ais-relay` for relay-only polling and proxy work
- `redis` + `redis-rest` for local cache + REST compatibility
- `seed-runner` for executing `scripts/seed-*.mjs`
- `scheduler` (Ofelia) for running grouped seed lanes inside `seed-runner`

The source of truth for lane membership, cadence, timeout, and lightweight dependency notes is `scripts/seed-scheduler-manifest.mjs`.

## Start the stack with the scheduler

```bash
docker compose up -d --build
```

## Scheduled lanes

The scheduler runs grouped lanes through `scripts/wm-cron-seeder.sh`, which resolves its seed list from `scripts/seed-scheduler-manifest.mjs`:

- `frequent`: every 15 minutes. Short-TTL market/news/alert seeds.
- `hourly`: every hour. Medium-cost forecast and operational seeds.
- `sixhourly`: every 6 hours. Heavier intelligence/reference seeds.
- `daily`: once per day. Daily refresh jobs.
- `weekly`: once per week. Slow-moving comparison/reference datasets.

The grouping is intentionally conservative for Raspberry Pi-class hardware. Redis locking in `scripts/_seed-utils.mjs` and Ofelia's `no-overlap` setting provide two layers of overlap protection.

## Useful commands

Run one lane on demand inside the seed runner:

```bash
docker compose exec seed-runner /app/scripts/wm-cron-seeder.sh frequent
docker compose exec seed-runner /app/scripts/wm-cron-seeder.sh hourly
```

Inspect scheduler and seed logs:

```bash
docker compose logs -f scheduler
docker compose exec seed-runner tail -f /tmp/wm-seeders.log
```

## Environment notes

- The default Compose stack rewires seed Redis traffic to `http://redis-rest:80`.
- The service-status warm-ping script can target the self-hosted app through `WM_RPC_BASE_URL` instead of the public production API.
- On macOS and Raspberry Pi, the same Docker Compose topology is used. The only platform-specific requirement is using images/dependencies that work on your host architecture.
