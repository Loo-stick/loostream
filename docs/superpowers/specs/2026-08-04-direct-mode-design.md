# Mode Direct hybride — design

**Date :** 2026-08-04 · **Branche :** `feat/direct-mode`

## Objectif

Un mode `proxy: 'direct'` où LooStream ne relaie PLUS la vidéo : il renvoie l'URL
CDN brute + les en-têtes requis via `behaviorHints.proxyHeaders`, et c'est le
**serveur de streaming intégré de Stremio (côté client)** qui télécharge en
direct. **Économie de ~100 % de la bande passante serveur.** Hybride : repli
automatique sur le proxy local pour les flux non-directables (NetMirror, hosts
DNS-bloqués).

## Contexte validé (mesures de cette session)

- Serveur = **box résidentielle Orange** (AS3215) — même réseau/DNS que le client self-host.
- Directables (résolvent + jouent avec headers) : **fsvid, streamwish (premilkyway), luluvdo (tnmr), vidzy, doodstream**. Segments réels vérifiés (108 Ko → 3,1 Mo, `0x47`).
- Non-directables : **uqload / voe.sx** (DNS Orange → `::1`), **streamflixserver.site** (NXDOMAIN), **NetMirror** (transform `.jpg→ts`).
- Seul host « proxy-OUI / direct-NON » = **NetMirror**. uqload/voe échouent des DEUX côtés (serveur aussi sur Orange) → le repli n'a de valeur pour eux **que si le proxy fait du DoH**.
- Le client peut aussi mettre son DNS en 1.1.1.1/DoH (box/OS) → débloque uqload/voe côté direct, sans rien changer chez nous (documenté, hors-code).

## Décision de livraison (par flux)

Fonction `deliveryMode(host, forceLocal, config)` :

| Condition | Livraison |
|---|---|
| `config.proxy !== 'direct'` | inchangé (local / mediaflow) |
| `forceLocal` (NetMirror) | **proxy local** (transform requis) |
| host ∈ `PROXY_FORCED_HOSTS` (FAI-bloqué : uqload, voe…) | **proxy local + DoH** (phase 2) |
| sinon | **direct** : URL brute + `proxyHeaders` |

## Composants

### 1. `UserConfig` / `parseConfig` (`src/index.ts`)
- `proxy: 'local' | 'mediaflow' | 'direct'`. `parseConfig` accepte `'direct'`.

### 2. Helper `deliver()` (`src/index.ts`) — le cœur du refactor
Remplace les appels `buildProxyUrl()` inline des 8 blocs sources qui l'utilisent
(movix, streamflix, wiflix, voirdrama, voiranime, nabistream, coflix, frenchstream).
```ts
function deliver(streamUrl, headers, opts, req, config): { url: string; proxyHeaders?: Record<string,string> } | null
```
- **Direct** (mode direct, host directable, pas forceLocal) : `{ url: streamUrl, proxyHeaders: headers }`.
- **Proxy** (autres cas) : `{ url: buildProxyUrl(...) }` (comportement actuel) ; `null` si URL bloquée (SSRF).

Chaque bloc source devient :
```ts
const d = deliver(src.url, headers, { isHls, forceHls }, req, config);
if (!d) continue;
drafts.push({
  url: d.url,
  behaviorHints: {
    notWebReady: !!d.proxyHeaders,          // proxyHeaders => passe par le serveur Stremio
    bingeGroup: '<source>',
    ...(d.proxyHeaders ? { proxyHeaders: { request: d.proxyHeaders } } : {}),
  },
  _meta: { ... },
});
```
- Étendre le type `behaviorHints` (ligne ~133) : `proxyHeaders?: { request: Record<string,string> }`.

### 3. `PROXY_FORCED_HOSTS` (config)
- Liste statique de motifs d'hôtes FAI-bloqués (`uqload`, `voe`, `voe.sx`, domaines VOE…) → routés vers proxy+DoH. Extensible via `config/` (comme allowed-domains), hot-reload.
- Enhancement futur possible : probe DNS runtime (`::1`/NXDOMAIN → forcer proxy). **Hors scope v1** (coût latence).

### 4. DoH dans le proxy (`src/doh.ts` + `src/proxy.ts`) — phase 2
- `dohAgent(host)` : `https.Agent` custom dont `createConnection` résout `host` via **Cloudflare DoH JSON** (`https://cloudflare-dns.com/dns-query`, caché TTL) puis `tls.connect({ host: <ip>, servername: host })` — **SNI = host d'origine** (donc certificat valide, contrairement à une URL en IP côté client).
- Le `/proxy` utilise `dohAgent` quand l'hôte cible est dans `PROXY_FORCED_HOSTS` (ou sur échec de résolution système).
- Bénéfice transverse : corrige aussi uqload en mode **local/mediaflow** (aujourd'hui cassé car serveur sur Orange).

### 5. `configure.html`
- Option de proxy **« 🚀 Direct — sans proxy »** (à côté de local/mediaflow), génère `proxy: 'direct'` sans `mfUrl`.
- Note UI : « Stremio lit depuis les CDN, aucune bande passante serveur. NetMirror et quelques hôtes repassent par le proxy. Stremio natif recommandé (le web bute sur le CORS). »

## Inchangé
- **NetMirror** : `forceLocal` → toujours proxy local (marche).
- **MovieBox** : **DÉJÀ direct dans tous les modes**. `/moviebox/stream` résout l'URL CDN brute (`resourceLink`, MP4) et fait `res.redirect(302, url)` → le player streame depuis le CDN, la vidéo ne transite jamais par le serveur. On garde le 302 (résolution **fraîche à la lecture**, car les URLs MovieBox sont éphémères — les mettre en brut dans le draft à l'affichage donnerait des liens périmés). Le CDN aoneroom est permissif (token en URL, pas de Referer) → pas besoin de `proxyHeaders` ; si ça changeait, on en ajouterait. **Inchangé.**
- **Clé d'accès** : les flux qui repassent par le proxy portent toujours `?k=`.

## Limites (documentées côté UI/README)
- **CORS** : le mode direct vise **Stremio natif** (desktop/mobile/box) ; le player web bute sur les CDN sans en-tête CORS.
- **IP client exposée** au CDN (au lieu de l'IP serveur).
- uqload/voe : rejouables seulement via DoH (phase 2) ou DNS client en 1.1.1.1.

## Phasage

- **Phase 1** (livrable seul) : `proxy:'direct'` + `deliver()` + `proxyHeaders` + NetMirror sur local + option WebUI. → économie de bande passante sur tout ce qui marche déjà. uqload/voe restent comme aujourd'hui (morts).
- **Phase 2** : `doh.ts` + intégration proxy → uqload/voe(live) rejouables via repli, et corrige aussi le mode proxy classique.

## Tests
- **Unit** : `deliveryMode()` (4 branches) ; `deliver()` shape (direct → proxyHeaders, proxy → url, blocked → null) ; `doh.ts` (résolution + SNI conservé).
- **Manuel** : install direct → lecture luluvdo → **0 requête `/proxy` côté serveur** (vérifiable dans les logs / `/api/stats` proxy=0) ; NetMirror encore jouable (repli local) ; (phase 2) uqload jouable via DoH.

## Non-objectifs
- Toggles langues on/off dans la WebUI (feature séparée du userscript d'Aerya) — **hors scope**, éventuel follow-up.
- Probe DNS runtime par flux — hors scope v1.
- Support CORS pour le player web — non (mode direct = natif).
