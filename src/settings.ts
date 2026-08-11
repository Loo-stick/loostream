import * as fs from 'fs';
import * as path from 'path';

// Réglages runtime éditables depuis l'admin (page Paramétrage > Partage).
// Surchargent le .env : une clé PRÉSENTE dans le fichier gagne ; absente → fallback
// env → défaut. Écrits dans config/runtime-settings.json (bind-mount docker → pas de
// rebuild). Lecture avec cache invalidé à l'écriture.

interface RuntimeSettings {
  mode?: string;
  ownerKey?: string;
  autoWhitelist?: boolean;
  netfreeSocksPool?: boolean;
  disabledSources?: string[];
  captureAllLogs?: boolean;
  // Facteurs ×0.25→×8 sur les TTL du cache, par catégorie (défaut ×1 chacun) :
  cacheMultStreams?: number;   // sources normales (positif, sauf NetMirror)
  cacheMultNetmirror?: number; // scope netmirror (positif)
  cacheMultEmpty?: number;     // « rien trouvé » (négatif), toutes sources
}

export const CACHE_MULT_MIN = 0.25;
export const CACHE_MULT_MAX = 8;
export function clampCacheMultiplier(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(CACHE_MULT_MAX, Math.max(CACHE_MULT_MIN, v));
}

const filePath = process.env.RUNTIME_SETTINGS_CONFIG ||
  (fs.existsSync('/app/config/runtime-settings.json')
    ? '/app/config/runtime-settings.json'
    : path.join(process.cwd(), 'config', 'runtime-settings.json'));

let cache: RuntimeSettings | null = null;

function load(): RuntimeSettings {
  if (cache) return cache;
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      cache = {
        mode: typeof raw.mode === 'string' ? raw.mode : undefined,
        ownerKey: typeof raw.ownerKey === 'string' && raw.ownerKey ? raw.ownerKey : undefined,
        autoWhitelist: typeof raw.autoWhitelist === 'boolean' ? raw.autoWhitelist : undefined,
        netfreeSocksPool: typeof raw.netfreeSocksPool === 'boolean' ? raw.netfreeSocksPool : undefined,
        disabledSources: Array.isArray(raw.disabledSources)
          ? raw.disabledSources.filter((x: unknown) => typeof x === 'string')
          : undefined,
        captureAllLogs: typeof raw.captureAllLogs === 'boolean' ? raw.captureAllLogs : undefined,
        cacheMultStreams: typeof raw.cacheMultStreams === 'number' && raw.cacheMultStreams > 0 ? raw.cacheMultStreams : undefined,
        cacheMultNetmirror: typeof raw.cacheMultNetmirror === 'number' && raw.cacheMultNetmirror > 0 ? raw.cacheMultNetmirror : undefined,
        cacheMultEmpty: typeof raw.cacheMultEmpty === 'number' && raw.cacheMultEmpty > 0 ? raw.cacheMultEmpty : undefined,
      };
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  return cache;
}

export function getModeRaw(): string {
  const s = load();
  return s.mode !== undefined ? s.mode : (process.env.MODE || '');
}

export function getOwnerKeyValue(): string | undefined {
  const s = load();
  if (s.ownerKey !== undefined) return s.ownerKey;
  const env = process.env.OWNER_KEY;
  return env && env.length > 0 ? env : undefined;
}

export function autoWhitelistEnabled(): boolean {
  const s = load();
  return s.autoWhitelist !== undefined ? s.autoWhitelist : (process.env.AUTO_WHITELIST === 'true');
}

// Pool auto-rotatif de SOCKS publics pour le handshake netfree (hébergement datacenter).
// OFF par défaut (cas résidentiel : NetMirror marche en direct).
export function netfreeSocksPoolEnabled(): boolean {
  const s = load();
  return s.netfreeSocksPool !== undefined ? s.netfreeSocksPool : (process.env.NETFREE_SOCKS_POOL === 'true');
}

// Capture systématique de la trace de logs pour TOUTES les requêtes (pas seulement les
// problèmes). Débug ponctuel — off par défaut (les problèmes sont toujours capturés).
export function captureAllLogsEnabled(): boolean {
  const s = load();
  return s.captureAllLogs !== undefined ? s.captureAllLogs : (process.env.CAPTURE_ALL_LOGS === 'true');
}

// Facteurs multiplicateurs des TTL du cache, par catégorie (cf. cache.ts). ×1 par défaut.
// N'affectent PAS les cookies/sessions ni la résolution de métadonnées (exclus dans cache.ts).
export interface CacheMultipliers { streams: number; netmirror: number; empty: number; }
function readMult(fileVal: number | undefined, envName: string): number {
  if (fileVal !== undefined) return clampCacheMultiplier(fileVal);
  const env = Number(process.env[envName]);
  return Number.isFinite(env) && env > 0 ? clampCacheMultiplier(env) : 1;
}
export function getCacheMultipliers(): CacheMultipliers {
  const s = load();
  return {
    streams: readMult(s.cacheMultStreams, 'CACHE_MULT_STREAMS'),
    netmirror: readMult(s.cacheMultNetmirror, 'CACHE_MULT_NETMIRROR'),
    empty: readMult(s.cacheMultEmpty, 'CACHE_MULT_EMPTY'),
  };
}

// Sources désactivées manuellement (admin) — skippées dans le fan-out. Persistant, à chaud.
export function getDisabledSources(): string[] {
  return load().disabledSources || [];
}
export function isSourceEnabled(name: string): boolean {
  return !getDisabledSources().includes(name);
}

export function updateSettings(patch: {
  mode?: string | null; ownerKey?: string | null; autoWhitelist?: boolean | null;
  netfreeSocksPool?: boolean | null; disabledSources?: string[] | null; captureAllLogs?: boolean | null;
  cacheMultStreams?: number | null; cacheMultNetmirror?: number | null; cacheMultEmpty?: number | null;
}): void {
  const current: RuntimeSettings = { ...load() };
  const apply = <K extends keyof RuntimeSettings>(k: K, v: RuntimeSettings[K] | null | undefined) => {
    if (v === undefined) return;            // non fourni → inchangé
    if (v === null) delete current[k];      // null → retour au fallback env
    else current[k] = v;
  };
  apply('mode', patch.mode);
  apply('ownerKey', patch.ownerKey === null ? null : (patch.ownerKey || undefined));
  apply('autoWhitelist', patch.autoWhitelist);
  apply('netfreeSocksPool', patch.netfreeSocksPool);
  apply('captureAllLogs', patch.captureAllLogs);
  const applyMult = (k: 'cacheMultStreams' | 'cacheMultNetmirror' | 'cacheMultEmpty', v: number | null | undefined) =>
    apply(k, v === null ? null : (v !== undefined ? clampCacheMultiplier(v) : undefined));
  applyMult('cacheMultStreams', patch.cacheMultStreams);
  applyMult('cacheMultNetmirror', patch.cacheMultNetmirror);
  applyMult('cacheMultEmpty', patch.cacheMultEmpty);
  apply('disabledSources', patch.disabledSources === null ? null : (patch.disabledSources && patch.disabledSources.length ? patch.disabledSources : null));
  fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
  cache = null; // invalide
}

export function settingsView(): {
  mode: string; modeSource: 'file' | 'env' | 'default';
  ownerKey: { configured: boolean; length: number; source: 'file' | 'env' | 'none' };
  autoWhitelist: boolean; autoWhitelistSource: 'file' | 'env';
  netfreeSocksPool: boolean; netfreeSocksPoolSource: 'file' | 'env';
  captureAllLogs: boolean; captureAllLogsSource: 'file' | 'env';
  cacheMult: CacheMultipliers;
  cacheMultSource: { streams: 'file' | 'env' | 'default'; netmirror: 'file' | 'env' | 'default'; empty: 'file' | 'env' | 'default' };
} {
  const s = load();
  const ownerFile = s.ownerKey !== undefined;
  const ownerEnv = !!(process.env.OWNER_KEY && process.env.OWNER_KEY.length > 0);
  const owner = getOwnerKeyValue();
  return {
    mode: getModeRaw(),
    modeSource: s.mode !== undefined ? 'file' : (process.env.MODE ? 'env' : 'default'),
    ownerKey: {
      configured: !!owner,
      length: owner ? owner.length : 0,
      source: ownerFile ? 'file' : (ownerEnv ? 'env' : 'none'),
    },
    autoWhitelist: autoWhitelistEnabled(),
    autoWhitelistSource: s.autoWhitelist !== undefined ? 'file' : 'env',
    netfreeSocksPool: netfreeSocksPoolEnabled(),
    netfreeSocksPoolSource: s.netfreeSocksPool !== undefined ? 'file' : 'env',
    captureAllLogs: captureAllLogsEnabled(),
    captureAllLogsSource: s.captureAllLogs !== undefined ? 'file' : 'env',
    cacheMult: getCacheMultipliers(),
    cacheMultSource: {
      streams: s.cacheMultStreams !== undefined ? 'file' : (process.env.CACHE_MULT_STREAMS ? 'env' : 'default'),
      netmirror: s.cacheMultNetmirror !== undefined ? 'file' : (process.env.CACHE_MULT_NETMIRROR ? 'env' : 'default'),
      empty: s.cacheMultEmpty !== undefined ? 'file' : (process.env.CACHE_MULT_EMPTY ? 'env' : 'default'),
    },
  };
}
