# LooStream - TODO

## Idées futures

### Proxy HLS intégré (remplacer MediaFlow)
**Priorité** : Basse (à faire si MFP tombe ou si serveur plus puissant)

**Objectif** : Supprimer la dépendance à MediaFlow Proxy en intégrant le proxy directement dans l'addon.

**À implémenter** :
- [ ] Endpoint proxy HLS (`/proxy/hls/:url`)
- [ ] Injection des headers (Referer, User-Agent, Origin)
- [ ] Réécriture du manifest HLS (URLs relatives → absolues vers le proxy)
- [ ] Proxy des segments .ts/.jpg
- [ ] Transformer segments .jpg → .ts (pour NetMirror)

**Prérequis** :
- Serveur avec bonne bande passante (4K = ~25 Mbps par stream)
- Pas adapté pour Raspberry Pi avec plusieurs streams simultanés

**Référence** : L'endpoint `/play/:platform/:contentId/:quality` existe déjà et fait un proxy basique.
