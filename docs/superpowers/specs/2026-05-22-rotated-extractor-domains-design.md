# Design — Détection & ajout assisté des domaines d'extracteurs rotés

- **Date** : 2026-05-22
- **Statut** : Validé (en attente de relecture)
- **Périmètre** : addon `loostream` + bot Telegram

## 1. Contexte & problème

`loostream` agrège des scrapers qui résolvent des liens d'embed de file-hosts
(Voe, Uqload, Vidmoly, LuluStream…). La reconnaissance d'un hôte se fait dans
`src/extractors/index.ts` via `detectExtractor(url)`, qui teste le hostname
contre des **listes de domaines codées en dur** (`VOE_DOMAINS`, `DOOD_DOMAINS`,
etc.).

Ces hébergeurs **changent de domaine en permanence**. Quand Voe passe de
`vidara.to` à `kathyinformationwhether.com`, `detectExtractor()` renvoie `null`,
le scraper **jette silencieusement** l'embed (`flemmix` logge seulement
`15 embeds, 6 supported`, sans nommer les rejetés), et la source est perdue
jusqu'à une modification manuelle du code suivie d'un rebuild.

Le bot Telegram sait déjà proposer l'ajout d'un domaine à la **whitelist SSRF**
(`allowed-domains.json`) via un bouton, parce que cette whitelist est un fichier
JSON hot-reloadé. Les domaines d'extracteurs, eux, n'ont **aucun équivalent** :
codés en dur, pas de fichier de config, pas d'endpoint de reload.

C'est le seul réglage de `loostream` encore non externalisé : les endpoints
flemmix/movix et la whitelist sont déjà en JSON + hot-reload.

## 2. Objectifs / Non-objectifs

### Objectifs

- Externaliser **toutes** les listes de domaines d'extracteurs dans un fichier
  JSON hot-reloadé (Approche B — externalisation totale).
- Émettre un log exploitable quand un scraper rencontre un embed sur un hôte non
  reconnu, en y incluant le **label serveur** affiché par le site.
- Permettre au bot Telegram de détecter ce log, **déduire l'extracteur cible
  depuis le label**, et proposer l'ajout du domaine via un bouton — d'un clic,
  sans rebuild.

### Non-objectifs

- Couvrir `faklum` : il résout bien des embeds mais ne fournit **aucun label
  serveur** (une seule iframe par film). Sans label, rien à déduire. Exclu.
- Couvrir `netmirror` / `streamflix` / `videasy` : ils ne résolvent pas
  d'embeds de file-hosts → la fonctionnalité n'a aucun sens pour eux.
- Créer de nouveaux extracteurs (Vidsonic, Hxfile, Savefiles, FMX…) : ce sont
  des hôtes réellement non supportés, pas des domaines rotés. Hors périmètre.
- Vérifier automatiquement qu'un domaine ajouté « fonctionne » : on ajoute, le
  trafic réel jugera.
- Ajout entièrement automatique sans intervention : on **propose**, l'humain
  valide d'un clic (cohérent avec le flux whitelist).

## 3. Approche retenue

**Approche B — Externalisation totale.** Toutes les listes de domaines
déménagent dans `config/extractor-domains.json`, source de vérité runtime. Le
code conserve une constante `DEFAULT_EXTRACTOR_DOMAINS` servant **uniquement de
filet de sécurité** si le JSON est absent ou malformé.

Approches écartées :

- **A — Overlay** (défauts en code + JSON purement additif) : plus sûr mais
  laisse la connaissance des domaines à deux endroits de façon permanente.
- **C — Le bot édite le code + rebuild** : fragile, lent, le bot manipulerait
  du code source. Rejetée.

## 4. Architecture — flux d'ensemble

```
embed sur hôte inconnu
  └─ loostream logge : [Flemmix] Unrecognized host: kathy….com (server="Voe", title="Projet Dernière Chance")
      └─ bot Telegram grep cette ligne (docker logs -f)
          └─ déduit l'extracteur depuis le label "Voe" → voe
              └─ alerte Telegram + bouton [➕ Ajouter à voe]
                  └─ clic → bot écrit extractor-domains.json + GET /api/extractor-domains?reload=true
                      └─ detectExtractor() reconnaît désormais le domaine
```

## 5. Modèle de données — `config/extractor-domains.json`

Fichier **committé au repo** (donc présent dans l'image Docker et dans le
bind-mount `config/` → il existe toujours → `fs.watch` est toujours armé, ce qui
évite le piège « watcher non enregistré si le fichier est absent au boot »).

```json
{
  "_comment": "Domaines reconnus par detectExtractor. Édité par le bot Telegram, hot-reloadé.",
  "voe":         ["voe", "voe.sx", "vidara.so", "vidara.to", "smoki.cc", "..."],
  "doodstream":  ["dood", "doodstream", "dsvplay", "d0o0d", "..."],
  "filemoon":    ["filemoon", "filmoon", "moonlink", "..."],
  "vidoza":      ["vidoza"],
  "vidmoly":     ["vidmoly", "molystream", "vidhide"],
  "streamtape":  ["streamtape", "strcloud", "shavetape", "tapewithadblock"],
  "mixdrop":     ["mixdrop", "mdrop", "mdy48tn97"],
  "sharecloudy": ["sharecloudy", "moovbob", "moovtop"],
  "lulustream":  ["luluvdo", "lulustream", "lulu.st"],
  "filelions":   ["filelions", "minochinos", "javplaya", "lionshare"],
  "streamwish":  ["streamwish", "hgcloud", "awish", "embedwish", "strwish"],
  "uqload":      ["uqload"],
  "lastUpdatedAt": "2026-05-22T00:00:00.000Z"
}
```

- Les clés sont exactement les valeurs du type `ExtractorId`.
- Le contenu initial est la copie des 12 listes `*_DOMAINS` actuelles.
- **loostream ne fait que LIRE** ce fichier. Le **bot est le seul à écrire** →
  aucun conflit d'écriture.
- Robustesse au chargement (`loadExtractorDomains()`) :
  - JSON absent **ou** illisible **ou** JSON racine non-objet → log d'erreur +
    on utilise `DEFAULT_EXTRACTOR_DOMAINS` en entier.
  - Fusion **par clé** : pour chaque `ExtractorId`, on prend le tableau du JSON
    s'il est présent et valide (tableau de strings), sinon le défaut de cette
    clé. → un JSON partiel ne peut jamais vider un extracteur.
  - Clés inconnues dans le JSON → ignorées.

## 6. Changements côté `loostream`

### 6.1 `src/extractors/index.ts`

- Les 12 `const *_DOMAINS` sont regroupées dans une constante
  `DEFAULT_EXTRACTOR_DOMAINS: Record<ExtractorId, string[]>` (filet de
  sécurité).
- Nouveau `loadExtractorDomains()` : lit `config/extractor-domains.json`,
  applique la fusion par clé et le fallback décrits §5, stocke le résultat dans
  une variable de module `domains`.
- `fs.watch` sur le fichier → recharge à chaud sur événement `change`
  (mêmes précautions que `flemmix.ts` : `try/catch`, `setTimeout` anti-rebond).
- `detectExtractor(url)` teste désormais `domains[id]` au lieu des constantes.
- Export `reloadExtractorDomains()` et `getExtractorDomains()`.
- Chemin du fichier : `process.env.EXTRACTOR_DOMAINS_CONFIG` sinon
  `/app/config/extractor-domains.json` sinon `<cwd>/config/extractor-domains.json`
  (même résolution que `flemmix.ts`).

### 6.2 `src/scrapers/flemmix.ts` & `src/scrapers/movix.ts`

Au moment du filtrage des embeds, pour **chaque embed rejeté**
(`detectExtractor(e.url) === null`), émettre une ligne de log :

```
[Flemmix] Unrecognized host: <hostname> (server="<label>", title="<titre du film>")
[Movix]   Unrecognized host: <hostname> (server="<label>", title="<titre du film>")
```

- `<hostname>` : `new URL(embed.url).hostname`.
- `<label>` : `embed.server` (flemmix) / `link.server` (movix).
- `<titre>` : le titre du film/série déjà connu du scraper à cet instant.
- Le log existant `N embeds, M supported` est conservé tel quel.

### 6.3 `src/index.ts`

Nouvel endpoint admin, calqué sur `/api/flemmix/endpoints` :

```
GET /api/extractor-domains?reload=true
→ { ...domaines chargés, reloaded: true }
```

## 7. Changements côté bot (`telegram-bot.js`)

### 7.1 Surveillance des logs

Dans `monitorLogs()`, ajouter un 2ᵉ regex à côté de celui de la whitelist,
appliqué aux mêmes flux `stdout`/`stderr` :

```js
/\[(Flemmix|Movix)\] Unrecognized host: (\S+) \(server="([^"]*)", title="([^"]*)"\)/
```

Capture : scraper, hostname, label serveur, titre.

### 7.2 Table label → extracteur

Constante du bot. Le label est normalisé en minuscules, puis on cherche un token
connu par inclusion (`label.includes(token)`) :

| Extracteur | Tokens label |
|---|---|
| `voe` | `voe`, `vidara` |
| `uqload` | `uqload` |
| `vidmoly` | `vmoly`, `vidmoly`, `molystream`, `vidhide` |
| `filelions` | `filelions`, `lions` |
| `streamwish` | `swish`, `streamwish`, `wish` |
| `lulustream` | `lulu`, `lulutv`, `luluvdo` |
| `doodstream` | `dood`, `ddstream` |
| `vidoza` | `vidoza` |
| `filemoon` | `filemoon`, `moon` |
| `streamtape` | `streamtape`, `tape` |
| `mixdrop` | `mixdrop`, `mdrop` |
| `sharecloudy` | `sharecloudy`, `cloudy` |

- Label reconnu → on déduit l'extracteur → alerte avec bouton.
- Label inconnu **ou** générique (« vostfr 1 », « lecteur 2 »…) → **pas
  d'alerte**, le bot reste muet.

### 7.3 Alerte Telegram

Calquée sur `sendDomainAlert` :

```
⚠️ Domaine d'extracteur inconnu

kathyinformationwhether.com
serveur : « Voe »  —  film : Projet Dernière Chance

[ ➕ Ajouter à voe ]   [ ❌ Ignorer ]
```

Dédup : un `Set` en mémoire des hôtes déjà signalés (clé = hostname) — comme
l'`alertKey` de la whitelist. Empêche les alertes en double quand le même hôte
revient (y compris vu à la fois via flemmix et movix).

### 7.4 Callbacks

Nouveau namespace de `callback_data` pour ne pas heurter le `add:` /  `ignore:`
de la whitelist :

- `xadd:<extracteur>:<domaine>`
- `xign:<domaine>`

`callback_data` Telegram est limité à 64 octets ; `xadd:voe:domaine.com` fait
~30 octets → marge confortable.

Au clic `xadd` → `addExtractorDomain(extractor, domain)` :

1. Lit `config/extractor-domains.json`.
2. Ajoute `domain` au tableau de `extractor` s'il n'y est pas déjà (dédup).
3. Réécrit le fichier (met à jour `lastUpdatedAt`).
4. `GET http://loostream:7002/api/extractor-domains?reload=true`.
5. Édite le message Telegram → `✅ <domaine> ajouté à <extracteur> (rechargé)`
   ou `ℹ️ <domaine> déjà présent`.

## 8. Cas limites & robustesse

| Cas | Comportement |
|---|---|
| Label inconnu / générique | Pas d'alerte, bot muet |
| Domaine déjà dans la liste | Clic → « ℹ️ déjà présent » |
| Même hôte vu via flemmix **et** movix | Dédup en mémoire par hôte → 1 alerte |
| Extracteur mal deviné (label trompeur) | L'humain voit le bouton avant de cliquer. Si ajouté par erreur : impact nul (l'extracteur échoue à l'extraction) + corrigeable dans le JSON |
| Redémarrage du bot | Le `Set` de dédup se vide → ré-alerte possible (acceptable, comme la whitelist) |
| JSON malformé / absent | loostream → fallback `DEFAULT_EXTRACTOR_DOMAINS` + log d'erreur ; le bot n'écrit jamais par-dessus un fichier illisible sans le réparer (read-modify-write : si parse échoue, abandonner l'écriture et logguer) |
| `fs.watch` non supporté | `try/catch` → le hot-reload est simplement inactif, `loadExtractorDomains()` reste appelable via l'endpoint |

## 9. Tests

Unités à isoler en fonctions pures, donc testables :

- `loadExtractorDomains()` : parsing, fallback total, fusion par clé, clé
  inconnue ignorée.
- `detectExtractor()` : reconnaissance contre les domaines chargés.
- Bot : déduction label → extracteur ; parsing du regex de log.

Le repo n'a **pas de runner de test** (`tsc --strict` est le seul contrôle
statique). Le plan d'implémentation tranchera entre (a) ajouter un runner
minimal pour ces fonctions pures, ou (b) une checklist de vérification manuelle.
Checklist manuelle minimale :

1. Boot loostream → domaines chargés depuis le JSON ; `detectExtractor()`
   reconnaît toujours les domaines existants.
2. JSON volontairement malformé → log d'erreur + fallback, l'app tourne.
3. Recherche d'un film avec un domaine Voe roté → ligne
   `[Flemmix] Unrecognized host: …` présente dans les logs.
4. Le bot envoie l'alerte avec le bon extracteur déduit.
5. Clic sur le bouton → JSON mis à jour, endpoint reload appelé,
   `detectExtractor()` reconnaît le nouveau domaine.
6. Édition manuelle du JSON → `fs.watch` recharge à chaud.

## 10. Déploiement & migration

- **Fichiers touchés** : `src/extractors/index.ts`, `src/scrapers/flemmix.ts`,
  `src/scrapers/movix.ts`, `src/index.ts`, `telegram-bot.js`.
- **Nouveau fichier** : `config/extractor-domains.json` (committé), généré à
  partir des listes `*_DOMAINS` actuelles.
- **Build** : `npm run build` (le `Dockerfile` copie `dist/` pré-buildé), puis
  `docker compose --profile telegram up -d --build` (rebuild addon **+** bot).
  Opération unique.

## 11. Hors périmètre / pistes futures

- Externaliser la table label → extracteur du bot (pour l'instant constante ;
  les labels sont stables, YAGNI).
- Digest périodique des hôtes **réellement** non supportés (Vidsonic, Hxfile…)
  pour décider d'écrire de nouveaux extracteurs.
- Support de `faklum` via une heuristique basée sur le hostname (pas de label).
