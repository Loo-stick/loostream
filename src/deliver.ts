// Décision de livraison pour le mode `proxy:'direct'`.
//
// En direct, LooStream ne relaie plus la vidéo : il renvoie l'URL CDN brute +
// les en-têtes (via behaviorHints.proxyHeaders) et c'est le serveur de streaming
// de Stremio, côté client, qui télécharge. Économie ~100 % de la bande passante
// serveur. Repli sur le proxy pour NetMirror (transform, `forceLocal`) et les
// hôtes bloqués par les FAI (DNS -> ::1) — qui, en Phase 2, seront résolus par
// DoH côté proxy.

// Motifs d'hôtes bloqués par les FAI FR (ex. Orange -> ::1) ou morts en direct.
// Ils repassent par le proxy plutôt que d'être livrés en direct (inutile). À
// étendre au fil des blocages constatés.
export const PROXY_FORCED_HOSTS = ['uqload', 'voe.sx'];

/** Un hôte est directable s'il n'est pas dans la liste FAI-bloquée. */
export function isDirectable(streamUrl: string): boolean {
  let host: string;
  try { host = new URL(streamUrl).hostname; } catch { return false; }
  return !PROXY_FORCED_HOSTS.some(p => host.includes(p));
}

/**
 * Livrer ce flux en direct ? Vrai seulement si : mode `direct`, pas de
 * `forceLocal` (NetMirror), et hôte directable. Fonction pure -> testable.
 */
export function directDecision(streamUrl: string, forceLocal: boolean, proxy: string | undefined): boolean {
  return proxy === 'direct' && !forceLocal && isDirectable(streamUrl);
}
