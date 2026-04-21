const WINDOW_SIZE = 20;
const NO_SUCCESS_ALERT_MS = 2 * 60 * 60 * 1000;
const CONSECUTIVE_ERRORS_DOWN = 5;
const EMPTY_RATE_WARN = 0.8;

export type Scraper = 'netmirror' | 'streamflix' | 'movix' | 'faklum' | 'flemmix';
export type Outcome = 'success' | 'empty' | 'error';

interface Entry {
  outcome: Outcome;
  at: number;
  error?: string;
}

const buffers: Record<Scraper, Entry[]> = {
  netmirror: [],
  streamflix: [],
  movix: [],
  faklum: [],
  flemmix: [],
};

export function recordOutcome(scraper: Scraper, outcome: Outcome, error?: string): void {
  const buf = buffers[scraper];
  buf.push({ outcome, at: Date.now(), error });
  if (buf.length > WINDOW_SIZE) buf.shift();
}

export type ScraperStatus = 'ok' | 'warning' | 'down';

export interface ScraperMetrics {
  window: number;
  success: number;
  empty: number;
  errors: number;
  emptyRate: number;
  errorRate: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  status: ScraperStatus;
  statusReason: string | null;
}

export function getMetrics(scraper: Scraper): ScraperMetrics {
  const buf = buffers[scraper];
  const window = buf.length;

  let success = 0, empty = 0, errors = 0;
  let lastSuccessAt: number | null = null;
  let lastErrorAt: number | null = null;
  let lastError: string | null = null;

  for (const entry of buf) {
    if (entry.outcome === 'success') {
      success++;
      lastSuccessAt = entry.at;
    } else if (entry.outcome === 'empty') {
      empty++;
    } else {
      errors++;
      lastErrorAt = entry.at;
      lastError = entry.error || 'Unknown';
    }
  }

  let consecutiveErrors = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].outcome === 'error') consecutiveErrors++;
    else break;
  }

  const emptyRate = window ? empty / window : 0;
  const errorRate = window ? errors / window : 0;

  let status: ScraperStatus = 'ok';
  let statusReason: string | null = null;

  if (consecutiveErrors >= CONSECUTIVE_ERRORS_DOWN) {
    status = 'down';
    statusReason = `${consecutiveErrors} consecutive errors (last: ${lastError})`;
  } else if (window >= 5 && emptyRate > EMPTY_RATE_WARN) {
    status = 'warning';
    statusReason = `${empty}/${window} requests returned empty`;
  } else if (window >= 5 && !lastSuccessAt && (Date.now() - (buf[0]?.at || Date.now())) > NO_SUCCESS_ALERT_MS) {
    status = 'warning';
    statusReason = `No successful stream in last ${window} requests`;
  }

  return {
    window,
    success,
    empty,
    errors,
    emptyRate,
    errorRate,
    lastSuccessAt,
    lastErrorAt,
    lastError,
    consecutiveErrors,
    status,
    statusReason,
  };
}

export function getAllMetrics(): Record<Scraper, ScraperMetrics> {
  return {
    netmirror: getMetrics('netmirror'),
    streamflix: getMetrics('streamflix'),
    movix: getMetrics('movix'),
    faklum: getMetrics('faklum'),
    flemmix: getMetrics('flemmix'),
  };
}
