import axios from 'axios';
// socks-proxy-agent v8 : exports map non résolu par notre moduleResolution 'node' -> require.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require('socks-proxy-agent');

// Fabrique de pools AUTO-ROTATIFS de SOCKS5 publics pour débloquer un HANDSHAKE d'API en
// hébergement DATACENTER (l'API bloque les IP datacenter/WARP, mais le CDN reste ouvert
// -> seul le petit appel signé a besoin d'une IP tierce ; la vidéo ne passe JAMAIS par le
// SOCKS). Les proxies publics sont ÉPHÉMÈRES (ils meurent en minutes) : on maintient un set
// VÉRIFIÉ VIVANT, on bascule dès qu'un meurt (sur échec réseau ET par cycle de fond), on
// re-scanne quand le stock baisse. Le health-check est INJECTÉ (`verify`) : c'est le vrai
// signal de l'API cible (netfree = cookie t_hash_t ; MovieBox = recherche signée non vide).
// Instancié par netfree-pool.ts (NetMirror) et moviebox.ts (MovieBox) ; OFF par défaut.

const DEFAULT_LISTS = [
  'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
];

export interface SocksPoolOptions {
  /** Étiquette de logs, ex. 'NetfreePool' / 'MovieBoxPool'. */
  name: string;
  /** Health-check : vrai si ce SOCKS débloque l'API cible. OWN son timeout. */
  verify: (agent: any) => Promise<boolean>;
  /** Variable d'env de repli (un seul SOCKS fixe) quand le pool est OFF, ex. 'MOVIEBOX_SOCKS'. */
  envVar?: string;
  lists?: string[];
  target?: number;          // on scanne jusqu'à atteindre ce nb de vivants
  maxLive?: number;         // plafond du set
  checkConc?: number;       // health-checks simultanés pendant un scan
  scanBatch?: number;       // candidats testés par passe de scan
  validateEveryMs?: number; // re-valider le courant + recompléter à cette cadence
}

export interface SocksPool {
  /** Agent SOCKS courant : pool actif -> proxy vivant ; sinon env de repli ; sinon rien. */
  agent(): any | undefined;
  /** Proxy du POOL utilisé (null si pool inactif ou repli env) — sert au report d'échec. */
  currentProxy(): string | null;
  /** Échec réseau via ce proxy -> on le vire IMMÉDIATEMENT et on recomplète. Idempotent. */
  reportFailure(hp: string): void;
  setEnabled(on: boolean): void;
  status(): { enabled: boolean; live: number; current: string | null; target: number; lastScan: number };
}

export function createSocksPool(opts: SocksPoolOptions): SocksPool {
  const LISTS = opts.lists || DEFAULT_LISTS;
  const TARGET_LIVE = opts.target ?? 4;
  const MAX_LIVE = opts.maxLive ?? 8;
  const CHECK_CONC = opts.checkConc ?? 30;
  const SCAN_BATCH = opts.scanBatch ?? 120;
  const VALIDATE_EVERY_MS = opts.validateEveryMs ?? 45 * 1000;
  const TAG = `[${opts.name}]`;

  const S = {
    enabled: false,
    live: [] as string[],        // proxies 'host:port' vérifiés vivants (le [0] = courant)
    candidates: [] as string[],  // reste à tester du dernier fetch
    lastScan: 0,
    scanning: false,
    loop: null as NodeJS.Timeout | null,
  };

  // Cache d'agents par proxy (réutilise les connexions).
  const agentCache = new Map<string, any>();
  function agentFor(hp: string): any {
    let a = agentCache.get(hp);
    if (!a) { a = new SocksProxyAgent(`socks5://${hp}`); agentCache.set(hp, a); }
    return a;
  }

  async function alive(hp: string): Promise<boolean> {
    try { return await opts.verify(agentFor(hp)); } catch { return false; }
  }

  // Fetch les listes EN PARALLÈLE -> warm-up plus court.
  async function fetchCandidates(): Promise<string[]> {
    const perList = await Promise.all(LISTS.map(async url => {
      try {
        const { data } = await axios.get<string>(url, { timeout: 12000, responseType: 'text', transformResponse: r => r });
        return [...String(data).matchAll(/(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/g)]
          .filter(m => m[1] !== '0.0.0.0').map(m => `${m[1]}:${m[2]}`);
      } catch { return []; }
    }));
    return [...new Set(perList.flat())];
  }

  // Teste un batch ; ajoute les vivants à S.live AU FUR ET À MESURE.
  async function checkBatch(batch: string[]): Promise<void> {
    for (let i = 0; i < batch.length && S.live.length < TARGET_LIVE; i += CHECK_CONC) {
      const slice = batch.slice(i, i + CHECK_CONC);
      const res = await Promise.all(slice.map(async hp => (await alive(hp)) ? hp : null));
      for (const hp of res) {
        if (hp && !S.live.includes(hp) && S.live.length < MAX_LIVE) {
          S.live.push(hp);
          console.log(`${TAG} +vivant ${hp} -> ${S.live.length} live`);
        }
      }
    }
  }

  async function tick(): Promise<void> {
    if (!S.enabled || S.scanning) return;
    S.scanning = true;
    try {
      if (S.live.length && !(await alive(S.live[0]))) {
        console.log(`${TAG} courant mort (cycle), rotation: ${S.live[0]}`);
        S.live.shift();
      }
      if (S.live.length < TARGET_LIVE) {
        if (S.candidates.length < SCAN_BATCH) {
          S.candidates = (await fetchCandidates()).sort(() => Math.random() - 0.5);
          S.lastScan = Date.now();
        }
        await checkBatch(S.candidates.splice(0, SCAN_BATCH));
        console.log(`${TAG} scan -> ${S.live.length}/${TARGET_LIVE} (courant: ${S.live[0] || 'aucun'})`);
      }
    } catch (e: any) {
      console.log(`${TAG} tick error: ${e?.message}`);
    } finally {
      S.scanning = false;
    }
  }

  return {
    agent(): any | undefined {
      if (S.enabled && S.live.length) return agentFor(S.live[0]);
      if (opts.envVar && process.env[opts.envVar]) {
        let a = agentCache.get('__env__');
        if (!a) { a = new SocksProxyAgent(process.env[opts.envVar] as string); agentCache.set('__env__', a); }
        return a;
      }
      return undefined;
    },
    currentProxy(): string | null {
      return (S.enabled && S.live.length) ? S.live[0] : null;
    },
    reportFailure(hp: string): void {
      if (S.enabled && S.live[0] === hp) {
        console.log(`${TAG} échec réseau -> rotation immédiate: ${hp} (reste ${S.live.length - 1})`);
        S.live.shift();
        if (S.live.length < TARGET_LIVE && !S.scanning) void tick();
      }
    },
    setEnabled(on: boolean): void {
      if (on === S.enabled) return;
      S.enabled = on;
      if (on) {
        console.log(`${TAG} activé — scan initial…`);
        void tick();
        if (!S.loop) S.loop = setInterval(() => void tick(), VALIDATE_EVERY_MS);
      } else {
        console.log(`${TAG} désactivé`);
        if (S.loop) { clearInterval(S.loop); S.loop = null; }
        S.live = []; S.candidates = [];
      }
    },
    status() {
      return { enabled: S.enabled, live: S.live.length, current: S.live[0] || null, target: TARGET_LIVE, lastScan: S.lastScan };
    },
  };
}
