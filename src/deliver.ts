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
 * Ce flux peut-il être livré en direct ? Vrai si l'hôte est directable et qu'il
 * n'exige pas le proxy local (NetMirror / `forceLocal`). **Indépendant du mode** :
 * le direct est toujours prioritaire ; le mode ne choisit que le *fallback* des
 * flux non-directables (MFP / proxy local / rien). Fonction pure -> testable.
 */
export function canDirect(streamUrl: string, forceLocal: boolean): boolean {
  return !forceLocal && isDirectable(streamUrl);
}
