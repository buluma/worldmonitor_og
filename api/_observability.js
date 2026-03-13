import * as Sentry from '@sentry/vercel-edge';

const EDGE_FLUSH_TIMEOUT_MS = 1500;
let edgeSentryInitialized = false;

function cleanEnv(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseSampleRate(rawValue, fallback) {
  const parsed = Number.parseFloat(String(rawValue ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function getEdgeDsn() {
  return cleanEnv(process.env.SENTRY_EDGE_DSN || process.env.SENTRY_DSN);
}

function getEdgeEnvironment() {
  return cleanEnv(process.env.SENTRY_ENVIRONMENT)
    || cleanEnv(process.env.VERCEL_ENV)
    || cleanEnv(process.env.NODE_ENV)
    || 'development';
}

function getEdgeRelease() {
  const explicitRelease = cleanEnv(process.env.SENTRY_RELEASE);
  if (explicitRelease) return explicitRelease;

  const commitSha = cleanEnv(process.env.VERCEL_GIT_COMMIT_SHA);
  if (commitSha) return `worldmonitor@${commitSha.slice(0, 12)}`;

  return 'worldmonitor@edge';
}

function ensureEdgeSentryInitialized() {
  if (edgeSentryInitialized) return;

  const dsn = getEdgeDsn();
  Sentry.init({
    dsn: dsn || undefined,
    enabled: Boolean(dsn),
    release: getEdgeRelease(),
    environment: getEdgeEnvironment(),
    sendDefaultPii: true,
    tracesSampleRate: parseSampleRate(process.env.SENTRY_EDGE_TRACES_SAMPLE_RATE, 0.1),
    initialScope: {
      tags: {
        runtime: 'vercel-edge',
      },
    },
  });

  edgeSentryInitialized = true;
}

async function captureEdgeFailure(handlerName, request, status, error) {
  const url = new URL(request.url);

  Sentry.withScope((scope) => {
    scope.setTag('handler', handlerName);
    scope.setTag('runtime', 'vercel-edge');
    scope.setTag('http.status_code', String(status));
    scope.setContext('request', {
      method: request.method,
      url: request.url,
      path: url.pathname,
      query: url.search,
    });

    if (error) {
      Sentry.captureException(error);
      return;
    }

    Sentry.captureMessage(`Edge handler returned HTTP ${status}: ${handlerName}`, 'error');
  });

  try {
    await Sentry.flush(EDGE_FLUSH_TIMEOUT_MS);
  } catch {
    // Best-effort flush only.
  }
}

export function withEdgeObservability(handlerName, handler, options = {}) {
  const captureStatusFailures = options.captureStatusFailures !== false;
  const captureThrownFailures = options.captureThrownFailures !== false;

  return async function observedHandler(request) {
    ensureEdgeSentryInitialized();

    const url = new URL(request.url);
    return Sentry.continueTrace(
      {
        sentryTrace: request.headers.get('sentry-trace'),
        baggage: request.headers.get('baggage'),
      },
      () => Sentry.startSpan(
        {
          name: `${request.method} ${url.pathname}`,
          op: 'http.server',
          attributes: {
            'http.request.method': request.method,
            'url.path': url.pathname,
            'wm.handler': handlerName,
          },
        },
        async (span) => {
          try {
            const response = await handler(request);
            Sentry.setHttpStatus(span, response.status);

            if (captureStatusFailures && response.status >= 500) {
              await captureEdgeFailure(handlerName, request, response.status, null);
            }

            return response;
          } catch (error) {
            Sentry.setHttpStatus(span, 500);
            if (captureThrownFailures) {
              await captureEdgeFailure(handlerName, request, 500, error);
            }
            throw error;
          }
        },
      ),
    );
  };
}
