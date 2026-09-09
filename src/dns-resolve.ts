import * as dns from 'dns';
import * as https from 'https';

// Résolution DNS résiliente au blocage FAI.
//
// Le FAI de l'hébergeur (Orange, sur nipogi-srv) bloque légalement les domaines
// de streaming : au lieu d'un NXDOMAIN, son résolveur répond `::1` / `127.0.0.1`.
// Nos requêtes partent alors sur NOTRE PROPRE localhost et atterrissent sur le
// vhost Apache du serveur -> échec TLS, page vide, ou 200 trompeur. Vérifié le
// 2026-09-07 : voe.sx -> ::1 (réel 186.2.163.208), cinestream.info -> ::1.
// Ce piège a déjà produit six faux verdicts « hôte forteresse ».
//
// Principe : on garde le résolveur système (rapide, mis en cache par l'OS) et on
// ne bascule sur un résolveur public QUE si sa réponse est une boucle locale ou
// s'il échoue. Rayon d'action minimal : un DNS sain n'est jamais court-circuité,
// et une panne du résolveur public ne casse rien de ce qui marchait déjà.

const FALLBACK_RESOLVER = process.env.DNS_FALLBACK_RESOLVER || '1.1.1.1';
const CACHE_TTL_MS = 60 * 60 * 1000;

const isLoopback = (ip: string) => ip === '::1' || ip === '0.0.0.0' || /^127\./.test(ip);

let resolver: dns.Resolver | null = null;
function publicResolver(): dns.Resolver {
  if (!resolver) {
    resolver = new dns.Resolver();
    resolver.setServers([FALLBACK_RESOLVER]);
  }
  return resolver;
}

const cache = new Map<string, { ip: string; at: number }>();

/** Résout via le résolveur public (A uniquement) et met en cache. */
function resolvePublic(hostname: string): Promise<string> {
  const hit = cache.get(hostname);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.ip);
  return new Promise((resolve, reject) => {
    publicResolver().resolve4(hostname, (err, addrs) => {
      if (err || !addrs || !addrs.length) {
        reject(err || new Error(`aucun enregistrement A pour ${hostname}`));
        return;
      }
      cache.set(hostname, { ip: addrs[0], at: Date.now() });
      resolve(addrs[0]);
    });
  });
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void;

/**
 * `lookup` compatible avec net/https : système d'abord, résolveur public en
 * secours quand la réponse est une boucle locale (= blocage FAI) ou qu'elle échoue.
 * Le SNI et l'en-tête Host restent intacts : seule l'adresse change.
 */
export function resilientLookup(hostname: string, options: any, callback?: LookupCallback): void {
  const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
  const wantsAll = typeof options === 'object' && options !== null && options.all === true;
  const done = (ip: string) => (wantsAll ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4));

  const rescue = (why: string) => {
    resolvePublic(hostname).then(
      ip => {
        console.log(`[DNS] ${hostname} : ${why} -> ${FALLBACK_RESOLVER} donne ${ip}`);
        done(ip);
      },
      err => cb(err),
    );
  };

  dns.lookup(hostname, { family: 4 }, (err, address) => {
    if (err || !address) { rescue('résolution système en échec'); return; }
    if (isLoopback(address)) { rescue(`résolu en ${address} (blocage FAI)`); return; }
    done(address);
  });
}

/** Agent HTTPS partagé, immunisé au DNS menteur. */
export function makeDnsSafeAgent(options: https.AgentOptions = {}): https.Agent {
  return new https.Agent({ keepAlive: true, ...options, lookup: resilientLookup as any });
}
