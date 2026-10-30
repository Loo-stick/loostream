import axios from 'axios';
import { createSocksPool } from './socks-pool';

// Pool AUTO-ROTATIF de SOCKS5 publics pour débloquer le handshake netfree en hébergement
// DATACENTER (net52.cc bloque l'IP datacenter/WARP, mais le CDN de segments reste ouvert
// -> seul le petit handshake a besoin d'une IP tierce). La mécanique générique vit dans
// socks-pool.ts ; ici on ne fait que le câbler au health-check netfree. OFF par défaut
// (cas résidentiel : NetMirror marche en direct). La vidéo ne passe JAMAIS par le SOCKS.

const VERIFY_URL = 'https://net52.cc/verify.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHECK_TIMEOUT_MS = 6000;

// Health-check netfree : true si le SOCKS obtient un cookie t_hash_t via verify.php.
const pool = createSocksPool({
  name: 'NetfreePool',
  envVar: 'NETFREE_SOCKS',
  verify: async (agent) => {
    const r = await axios.post(VERIFY_URL, 'g-recaptcha-response=x', {
      httpsAgent: agent, timeout: CHECK_TIMEOUT_MS, maxRedirects: 0,
      headers: { 'User-Agent': UA, Referer: 'https://net52.cc/', 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    });
    return ((r.headers['set-cookie'] as string[]) || []).some(c => /t_hash_t=/.test(c));
  },
});

/** Agent SOCKS (round-robin) : pool activé -> proxy vivant ; sinon NETFREE_SOCKS env ; sinon rien. */
export function netfreeAgent(): any | undefined { return pool.agent(); }
/** Réserve atomiquement un proxy (round-robin) + son id, pour router UNE requête et attribuer
 *  l'échec/succès au bon proxy (évite la course agent()/currentProxy() sous round-robin). */
export function netfreeLease(): { agent: any; hp: string } | undefined { return pool.lease(); }
/** Proxy représentatif (live[0]) — affichage admin. */
export function currentPoolProxy(): string | null { return pool.currentProxy(); }
/** Échec réseau via ce proxy -> +strike (éviction douce). Idempotent. */
export function reportFailure(hp: string): void { pool.reportFailure(hp); }
/** Succès via ce proxy -> reset de ses strikes. */
export function reportSuccess(hp: string): void { pool.reportSuccess(hp); }
export function setPoolEnabled(on: boolean): void { pool.setEnabled(on); }
export function poolStatus(): { enabled: boolean; live: number; current: string | null; target: number; lastScan: number } {
  return pool.status();
}
