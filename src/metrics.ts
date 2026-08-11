const WINDOW_SIZE = 20;
const CONSECUTIVE_ERRORS_DOWN = 5;
const WARN_MIN_ERRORS = 3;      // il faut au moins ce nb d'erreurs pour un WARNING
const WARN_ERROR_RATE = 0.25;   // ET ce taux d'erreurs sur la fenêtre

export type Scraper = 'netmirror' | 'streamflix' | 'movix' | 'frenchstream' | 'wiflix' | 'voirdrama' | 'moviebox' | 'voiranime' | 'nabistream' | 'coflix' | 'videasy' | 'animesama' | 'nakastream' | 'vostfree' | 'wavewatch';
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
  frenchstream: [],
  wiflix: [],
  voirdrama: [],
  moviebox: [],
  voiranime: [],
  nabistream: [],
  coflix: [],
  videasy: [],
  animesama: [],
  nakastream: [],
  vostfree: [],
  wavewatch: [],
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
  recent: Outcome[];   // outcomes de la fenêtre (ancien -> récent), pour la frise admin ●○✕
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

  // Le VIDE est un résultat NORMAL — le contenu n'est simplement pas sur toutes les
  // sources (surtout en séries). Le statut ne dépend donc QUE des ERREURS, jamais
  // d'une fenêtre tout-vide ni de l'absence de succès (qui déclenchaient de fausses
  // alertes WARNING en boucle sur une instance à faible trafic). On n'alerte que sur
  // un vrai signal d'échec : erreurs soutenues (down) ou taux d'erreurs élevé (warning).
  if (consecutiveErrors >= CONSECUTIVE_ERRORS_DOWN) {
    status = 'down';
    statusReason = `${consecutiveErrors} erreurs consécutives (dernière : ${lastError})`;
  } else if (errors >= WARN_MIN_ERRORS && errorRate >= WARN_ERROR_RATE) {
    status = 'warning';
    statusReason = `${errors} erreurs sur ${window} req (${Math.round(errorRate * 100)}%)`;
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
    recent: buf.map(e => e.outcome),
  };
}

export function getAllMetrics(): Record<Scraper, ScraperMetrics> {
  return {
    netmirror: getMetrics('netmirror'),
    streamflix: getMetrics('streamflix'),
    movix: getMetrics('movix'),
    frenchstream: getMetrics('frenchstream'),
    wiflix: getMetrics('wiflix'),
    voirdrama: getMetrics('voirdrama'),
    moviebox: getMetrics('moviebox'),
    voiranime: getMetrics('voiranime'),
    nabistream: getMetrics('nabistream'),
    coflix: getMetrics('coflix'),
    videasy: getMetrics('videasy'),
    animesama: getMetrics('animesama'),
    nakastream: getMetrics('nakastream'),
    vostfree: getMetrics('vostfree'),
    wavewatch: getMetrics('wavewatch'),
  };
}
