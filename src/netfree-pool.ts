import axios from 'axios';
// socks-proxy-agent v8 : exports map non résolu par notre moduleResolution 'node' -> require.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require('socks-proxy-agent');

// Pool AUTO-ROTATIF de SOCKS5 publics pour débloquer le handshake netfree en hébergement
// DATACENTER (net52.cc bloque l'IP datacenter/WARP, mais le CDN de segments reste ouvert
// -> seul le petit handshake a besoin d'une IP tierce). Les proxies publics sont ÉPHÉMÈRES
// (ils meurent en minutes) : on maintient donc un set VÉRIFIÉ VIVANT, on bascule dès qu'un
// meurt (instantanément sur échec réseau ET par cycle de fond), on re-scanne quand le stock
// baisse. Health-check = LE vrai signal netfree (POST verify.php -> cookie t_hash_t obtenu).
// OFF par défaut (cas résidentiel : NetMirror marche en direct).

const LISTS = [
  'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
];
const VERIFY_URL = 'https://net52.cc/verify.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TARGET_LIVE = 4;          // on scanne jusqu'à atteindre ce nb de vivants
const MAX_LIVE = 8;             // plafond du set (redondance sans gonfler)
const CHECK_TIMEOUT_MS = 6000;  // timeout d'un health-check
const CHECK_CONC = 30;          // health-checks simultanés pendant un scan
const SCAN_BATCH = 120;         // candidats testés par passe de scan
const VALIDATE_EVERY_MS = 45 * 1000;  // re-valider le courant + recompléter à cette cadence

interface PoolState {
  enabled: boolean;
  live: string[];          // proxies 'host:port' vérifiés vivants (le [0] = courant)
  candidates: string[];    // reste à tester du dernier fetch
  lastScan: number;
  scanning: boolean;
  loop: NodeJS.Timeout | null;
}
const S: PoolState = { enabled: false, live: [], candidates: [], lastScan: 0, scanning: false, loop: null };

// Cache d'agents par proxy (réutilise les connexions).
const agentCache = new Map<string, any>();
function agentFor(hp: string): any {
  let a = agentCache.get(hp);
  if (!a) { a = new SocksProxyAgent(`socks5://${hp}`); agentCache.set(hp, a); }
  return a;
}

/** Health-check d'un SOCKS : true s'il obtient un cookie t_hash_t via netfree. */
async function alive(hp: string): Promise<boolean> {
  try {
    const r = await axios.post(VERIFY_URL, 'g-recaptcha-response=x', {
      httpsAgent: agentFor(hp), timeout: CHECK_TIMEOUT_MS, maxRedirects: 0,
      headers: { 'User-Agent': UA, Referer: 'https://net52.cc/', 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    });
    return ((r.headers['set-cookie'] as string[]) || []).some(c => /t_hash_t=/.test(c));
  } catch { return false; }
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

// Teste un batch ; ajoute les vivants à S.live AU FUR ET À MESURE (compteur incrémental).
async function checkBatch(batch: string[]): Promise<void> {
  for (let i = 0; i < batch.length && S.live.length < TARGET_LIVE; i += CHECK_CONC) {
    const slice = batch.slice(i, i + CHECK_CONC);
    const res = await Promise.all(slice.map(async hp => (await alive(hp)) ? hp : null));
    for (const hp of res) {
      if (hp && !S.live.includes(hp) && S.live.length < MAX_LIVE) {
        S.live.push(hp);
        console.log(`[NetfreePool] +vivant ${hp} -> ${S.live.length} live`);
      }
    }
  }
}

// Maintenance de fond : re-valide le courant, recomplète le stock si besoin.
async function tick(): Promise<void> {
  if (!S.enabled || S.scanning) return;
  S.scanning = true;
  try {
    if (S.live.length && !(await alive(S.live[0]))) {
      console.log(`[NetfreePool] courant mort (cycle), rotation: ${S.live[0]}`);
      S.live.shift();
    }
    if (S.live.length < TARGET_LIVE) {
      if (S.candidates.length < SCAN_BATCH) {
        S.candidates = (await fetchCandidates()).sort(() => Math.random() - 0.5);
        S.lastScan = Date.now();
      }
      await checkBatch(S.candidates.splice(0, SCAN_BATCH));
      console.log(`[NetfreePool] scan -> ${S.live.length}/${TARGET_LIVE} (courant: ${S.live[0] || 'aucun'})`);
    }
  } catch (e: any) {
    console.log(`[NetfreePool] tick error: ${e?.message}`);
  } finally {
    S.scanning = false;
  }
}

/** Agent SOCKS courant : pool activé -> proxy vivant ; sinon NETFREE_SOCKS env ; sinon rien. */
export function netfreeAgent(): any | undefined {
  if (S.enabled && S.live.length) return agentFor(S.live[0]);
  if (process.env.NETFREE_SOCKS) {
    let a = agentCache.get('__env__');
    if (!a) { a = new SocksProxyAgent(process.env.NETFREE_SOCKS); agentCache.set('__env__', a); }
    return a;
  }
  return undefined;
}

/** Proxy du POOL utilisé pour une requête (null si pool inactif ou repli env). Sert au
 *  report d'échec pour la bascule instantanée. */
export function currentPoolProxy(): string | null {
  return (S.enabled && S.live.length) ? S.live[0] : null;
}

/** Le scraper signale un ÉCHEC RÉSEAU via ce proxy -> on le vire IMMÉDIATEMENT (sans
 *  attendre le cycle) et on recomplète. Idempotent : n'agit que si c'est encore le courant. */
export function reportFailure(hp: string): void {
  if (S.enabled && S.live[0] === hp) {
    console.log(`[NetfreePool] échec réseau -> rotation immédiate: ${hp} (reste ${S.live.length - 1})`);
    S.live.shift();
    if (S.live.length < TARGET_LIVE && !S.scanning) void tick();
  }
}

export function setPoolEnabled(on: boolean): void {
  if (on === S.enabled) return;
  S.enabled = on;
  if (on) {
    console.log('[NetfreePool] activé — scan initial…');
    void tick();
    if (!S.loop) S.loop = setInterval(() => void tick(), VALIDATE_EVERY_MS);
  } else {
    console.log('[NetfreePool] désactivé');
    if (S.loop) { clearInterval(S.loop); S.loop = null; }
    S.live = []; S.candidates = [];
  }
}

export function poolStatus(): { enabled: boolean; live: number; current: string | null; target: number; lastScan: number } {
  return { enabled: S.enabled, live: S.live.length, current: S.live[0] || null, target: TARGET_LIVE, lastScan: S.lastScan };
}
