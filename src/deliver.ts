// Décision de livraison pour le mode `proxy:'direct'`.
//
// En direct, LooStream ne relaie plus la vidéo : il renvoie l'URL CDN brute +
// les en-têtes (via behaviorHints.proxyHeaders) et c'est le serveur de streaming
// de Stremio, côté client, qui télécharge. Économie ~100 % de la bande passante
// serveur. Repli sur le proxy pour NetMirror (transform, `forceLocal`) et les
// hôtes bloqués par les FAI (DNS -> ::1) — qui, en Phase 2, seront résolus par
// DoH côté proxy.

// Hôtes NON livrables en direct : bloqués par les FAI FR (Orange -> ::1), ou dont
// le CDN a un cert TLS invalide que le lecteur client refuse. Ils repassent par le
// proxy (qui bypasse le cert via INSECURE_AGENT et re-sert sur notre cert valide).
// À étendre au fil des blocages constatés.
//   - uqload / voe.sx : DNS-bloqués (Orange -> ::1)
//   - vmnow / vmeas    : CDN vidmoly = mini-PC perso exposés via Tailscale, cert
//                        `*.ts.net` invalide/expiré -> Nuvio refuse le TLS en direct.
//                        Doit passer par le proxy (comme sur `main` avant direct-first).
//   - vmpx.online      : CDN d'ansembed (AnimeSama/VoirAnime). Le token HLS est LIÉ
//                        À L'IP/ASN de l'extracteur (param asn=) -> injouable depuis
//                        le client en direct ; seul notre serveur (proxy local) a la
//                        bonne IP. En mode direct pur : écarté (mieux qu'un flux mort).
//   - tnmr             : CDN de livavid (LuluVdo). Exige le JEU COMPLET de headers
//                        (UA mobile + Referer + Origin + Sec-Fetch) sur CHAQUE requête,
//                        segments compris (sinon 302 -> endpoint mort). Le player ne
//                        les applique pas de façon fiable en direct -> « charge, pas de
//                        vidéo ». Doit passer par le proxy (qui pose les headers partout).
//   - fsvid            : RETIRÉ de cette liste (2026-10-31). Longue chasse : on a d'abord
//                        cru le token `?t=` IP-lié -> forcé le proxy. FAUX. Preuves serveur :
//                        master + media playlist fsvid répondent 200 partout ; seuls les
//                        SEGMENTS .ts sont gatés (exigent un Referer + un UA ≠ `okhttp`). Le
//                        proxy (local ET public via Cloudflare) sort le VRAI TS de 1,27 Mo
//                        même en UA okhttp — donc le proxy livre les bons octets. POURTANT
//                        Nuvio « Playback failed » sur TOUT ce qui est proxifié, alors que
//                        TOUT le direct joue nickel (constaté par Stick). L'échec est
//                        CÔTÉ CLIENT (Nuvio gère mal nos manifestes proxifiés), pas nos octets.
//                        -> fsvid repart en DIRECT (raw + proxyHeaders Referer/UA navigateur),
//                        que Nuvio propage aux segments. Voir mémoire nuvio_proxy_playback_fail.
//   - zen-blk / falzey : source VF de Cinex (zen-blk.store -> 302 -> falzey.lol video_proxy).
//                        Gatée STRICTEMENT sur `Referer: https://cinex.buzz/` (sans lui, ou
//                        autre referer -> page de blocage), sur le 302 ET chaque Range. Nuvio
//                        ne propage PAS le referer en direct (testé KO) -> doit passer par le
//                        proxy, qui pose le referer partout. Pas de token/IP-lock -> stable.
//   - cinex.buzz       : chemin SÉRIES de Cinex (/api/m3u8-proxy). On le force aussi au proxy
//                        pour que le CLIENT n'ait JAMAIS à contacter cinex.buzz (flaggé
//                        « phishing » par certains AV/Bitdefender) : tout passe par MFP côté
//                        serveur. Même raison de referer que zen-blk/falzey.
export const PROXY_FORCED_HOSTS = ['uqload', 'voe.sx', 'vmnow', 'vmeas', 'vmpx.online', 'tnmr', 'zen-blk', 'falzey', 'cinex.buzz'];

/** Un hôte est directable s'il n'est pas dans la liste non-directable ci-dessus ET si
 * son token n'est pas LIÉ À L'ASN de l'extracteur. Un CDN qui met `asn=<ASN serveur>`
 * dans le token (dramiyos-cdn/filelions, vmpx…) rejette toute autre ASN -> injouable
 * en direct depuis le client. Il DOIT passer par le proxy (le serveur a la bonne ASN ;
 * MediaFlow tourne sur le même serveur -> token valide). En direct pur : écarté. */
export function isDirectable(streamUrl: string): boolean {
  let host: string;
  try { host = new URL(streamUrl).hostname; } catch { return false; }
  if (/[?&]asn=/i.test(streamUrl)) return false; // token ASN-bound -> jamais directable
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
