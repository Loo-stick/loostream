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

export function updateSettings(patch: {
  mode?: string | null; ownerKey?: string | null; autoWhitelist?: boolean | null;
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
  fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
  cache = null; // invalide
}

export function settingsView(): {
  mode: string; modeSource: 'file' | 'env' | 'default';
  ownerKey: { configured: boolean; length: number; source: 'file' | 'env' | 'none' };
  autoWhitelist: boolean; autoWhitelistSource: 'file' | 'env';
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
  };
}
