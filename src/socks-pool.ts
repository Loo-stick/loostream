import axios from 'axios';
// socks-proxy-agent v8 : exports map non résolu par notre moduleResolution 'node' -> require.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require('socks-proxy-agent');

// Fabrique de pools AUTO-ROTATIFS de SOCKS5 publics pour débloquer un HANDSHAKE d'API en
// hébergement DATACENTER (l'API bloque les IP datacenter/WARP, mais le CDN reste ouvert
// -> seul le petit appel signé a besoin d'une IP tierce ; la vidéo ne passe JAMAIS par le
// SOCKS). Les proxies publics sont ÉPHÉMÈRES (ils meurent en minutes) : on maintient un set
// VÉRIFIÉ VIVANT, on RÉPARTIT la charge dessus (round-robin) et on re-scanne pour recompléter.
//
// POURQUOI round-robin : sous forte charge (ex. 1750 users), concentrer tout le trafic sur UN
// seul proxic « courant » le crame en secondes -> cascade -> set vidé. En étalant sur tout le
// set (cible ~60), chaque proxy ne voit que ~1/60 du trafic et survit. L'éviction est DOUCE
// (STRIKE_LIMIT échecs avant de virer) pour qu'un blip réseau ne tue pas un proxy sain.
//
// Le health-check est INJECTÉ (`verify`) : c'est le vrai signal de l'API cible (netfree =
// cookie t_hash_t ; MovieBox = recherche signée non vide). Instancié par netfree-pool.ts
// (NetMirror, cible basse) et moviebox.ts (MovieBox, gros set) ; OFF par défaut.

const DEFAULT_LISTS = [
  'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
];

const STRIKE_LIMIT = 3;       // échecs tolérés avant éviction d'un proxy
const VALIDATE_SAMPLE = 12;   // proxies re-validés par cycle de fond (rotatif)

export interface SocksPoolOptions {
  /** Étiquette de logs, ex. 'NetfreePool' / 'MovieBoxPool'. */
  name: string;
  /** Health-check : vrai si ce SOCKS débloque l'API cible. OWN son timeout. */
  verify: (agent: any) => Promise<boolean>;
  /** Variable d'env de repli (un seul SOCKS fixe) quand le pool est OFF, ex. 'MOVIEBOX_SOCKS'. */
  envVar?: string;
  lists?: string[];
  target?: number;          // on scanne jusqu'à atteindre ce nb de vivants
  maxLive?: number;         // plafond du set (buffer au-dessus de target)
  checkConc?: number;       // health-checks simultanés pendant un scan
  scanBatch?: number;       // candidats testés par passe de scan
  validateEveryMs?: number; // re-valider un échantillon + recompléter à cette cadence
}

export interface SocksLease { agent: any; hp: string; }

export interface SocksPool {
  /** Agent SOCKS (round-robin) : pool actif -> proxy vivant ; sinon env de repli ; sinon rien. */
  agent(): any | undefined;
  /** Réserve atomiquement un proxy (round-robin) + son id, pour router UNE requête et pouvoir
   *  attribuer l'échec/succès au bon proxy. Repli env -> hp '__env__' (report = no-op). */
  lease(): SocksLease | undefined;
  /** Proxy représentatif (live[0]) — pour l'affichage admin. */
  currentProxy(): string | null;
  /** Échec réseau via ce proxy -> +1 strike ; au-delà de STRIKE_LIMIT on le vire. Idempotent. */
  reportFailure(hp: string): void;
  /** Succès via ce proxy -> remet ses strikes à zéro (un proxy qui remarche n'est pas pénalisé). */
  reportSuccess(hp: string): void;
  setEnabled(on: boolean): void;
  status(): { enabled: boolean; live: number; current: string | null; target: number; lastScan: number };
}

export function createSocksPool(opts: SocksPoolOptions): SocksPool {
  const LISTS = opts.lists || DEFAULT_LISTS;
  const TARGET_LIVE = opts.target ?? 4;
  const MAX_LIVE = opts.maxLive ?? Math.max(8, TARGET_LIVE * 2);
  const CHECK_CONC = opts.checkConc ?? 30;
  const SCAN_BATCH = opts.scanBatch ?? 120;
  const VALIDATE_EVERY_MS = opts.validateEveryMs ?? 45 * 1000;
  const TAG = `[${opts.name}]`;

  const S = {
    enabled: false,
    live: [] as string[],         // proxies 'host:port' vérifiés vivants
    strikes: new Map<string, number>(),
    cursor: 0,                    // curseur round-robin
    candidates: [] as string[],   // reste à tester du dernier fetch
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
  function envAgent(): any | undefined {
    if (!opts.envVar || !process.env[opts.envVar]) return undefined;
    let a = agentCache.get('__env__');
    if (!a) { a = new SocksProxyAgent(process.env[opts.envVar] as string); agentCache.set('__env__', a); }
    return a;
  }

  function removeLive(hp: string): void {
    const i = S.live.indexOf(hp);
    if (i >= 0) S.live.splice(i, 1);
    S.strikes.delete(hp);
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
    // On ne retente pas ce qu'on a déjà vivant.
    const known = new Set(S.live);
    return [...new Set(perList.flat())].filter(hp => !known.has(hp));
  }

  // Teste un batch ; ajoute les vivants à S.live AU FUR ET À MESURE (jusqu'à MAX_LIVE).
  async function checkBatch(batch: string[]): Promise<void> {
    for (let i = 0; i < batch.length && S.live.length < MAX_LIVE; i += CHECK_CONC) {
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

  // Re-valide un échantillon rotatif du set vivant ; vire les morts (strike direct : une
  // revalidation ratée = proxy mort, pas un blip). Léger (borné à VALIDATE_SAMPLE).
  async function revalidateSample(): Promise<void> {
    if (!S.live.length) return;
    const sample = S.live.slice(0, VALIDATE_SAMPLE);
    const res = await Promise.all(sample.map(async hp => ({ hp, ok: await alive(hp) })));
    for (const { hp, ok } of res) {
      if (!ok) { console.log(`${TAG} revalidation KO, éviction: ${hp}`); removeLive(hp); }
    }
    // Rotation : on pousse l'échantillon testé en fin de file pour tester d'autres au tour suivant.
    const tested = new Set(sample);
    S.live = [...S.live.filter(hp => !tested.has(hp)), ...S.live.filter(hp => tested.has(hp))];
  }

  async function tick(): Promise<void> {
    if (!S.enabled || S.scanning) return;
    S.scanning = true;
    try {
      await revalidateSample();
      if (S.live.length < TARGET_LIVE) {
        if (S.candidates.length < SCAN_BATCH) {
          S.candidates = (await fetchCandidates()).sort(() => Math.random() - 0.5);
          S.lastScan = Date.now();
        }
        await checkBatch(S.candidates.splice(0, SCAN_BATCH));
        console.log(`${TAG} scan -> ${S.live.length}/${TARGET_LIVE} vivants (plafond ${MAX_LIVE})`);
      }
    } catch (e: any) {
      console.log(`${TAG} tick error: ${e?.message}`);
    } finally {
      S.scanning = false;
    }
  }

  function doLease(): SocksLease | undefined {
    if (S.enabled && S.live.length) {
      const hp = S.live[S.cursor % S.live.length];
      S.cursor = (S.cursor + 1) % Math.max(1, S.live.length);
      return { agent: agentFor(hp), hp };
    }
    const ea = envAgent();
    if (ea) return { agent: ea, hp: '__env__' };
    return undefined;
  }

  return {
    agent(): any | undefined {
      return doLease()?.agent;
    },
    lease(): SocksLease | undefined {
      return doLease();
    },
    currentProxy(): string | null {
      return (S.enabled && S.live.length) ? S.live[0] : null;
    },
    reportFailure(hp: string): void {
      if (!S.enabled || hp === '__env__') return;
      if (!S.live.includes(hp)) return;
      const n = (S.strikes.get(hp) || 0) + 1;
      if (n >= STRIKE_LIMIT) {
        console.log(`${TAG} ${STRIKE_LIMIT} échecs -> éviction: ${hp} (reste ${S.live.length - 1})`);
        removeLive(hp);
        if (S.live.length < TARGET_LIVE && !S.scanning) void tick();
      } else {
        S.strikes.set(hp, n);
        // Déprioriser : on le pousse en fin de file (le round-robin l'évitera un moment).
        const i = S.live.indexOf(hp);
        if (i >= 0) { S.live.splice(i, 1); S.live.push(hp); }
      }
    },
    reportSuccess(hp: string): void {
      if (hp !== '__env__' && S.strikes.has(hp)) S.strikes.delete(hp);
    },
    setEnabled(on: boolean): void {
      if (on === S.enabled) return;
      S.enabled = on;
      if (on) {
        console.log(`${TAG} activé — scan initial (cible ${TARGET_LIVE}, plafond ${MAX_LIVE})…`);
        void tick();
        if (!S.loop) S.loop = setInterval(() => void tick(), VALIDATE_EVERY_MS);
      } else {
        console.log(`${TAG} désactivé`);
        if (S.loop) { clearInterval(S.loop); S.loop = null; }
        S.live = []; S.candidates = []; S.strikes.clear(); S.cursor = 0;
      }
    },
    status() {
      return { enabled: S.enabled, live: S.live.length, current: S.live[0] || null, target: TARGET_LIVE, lastScan: S.lastScan };
    },
  };
}
