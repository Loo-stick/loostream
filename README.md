# LooStream

Addon Stremio pour l'agrégation de flux streaming.

## Disclaimer / Avertissement

**IMPORTANT - VEUILLEZ LIRE ATTENTIVEMENT**

Ce projet est fourni **uniquement à des fins éducatives et de recherche**. L'auteur et les contributeurs de ce projet :

- **NE SONT PAS RESPONSABLES** de l'utilisation qui est faite de ce logiciel
- **NE CAUTIONNENT PAS** le piratage ou toute violation des droits d'auteur
- **NE FOURNISSENT AUCUN CONTENU** - ce logiciel ne fait qu'agréger des liens disponibles publiquement sur Internet
- **NE GARANTISSENT PAS** le fonctionnement, la disponibilité ou la légalité des sources externes
- **DÉCLINENT TOUTE RESPONSABILITÉ** quant aux conséquences légales de l'utilisation de ce logiciel

**L'utilisateur est seul responsable** de vérifier la légalité de l'utilisation de ce logiciel dans sa juridiction et d'obtenir les autorisations nécessaires pour accéder aux contenus.

Ce projet peut cesser de fonctionner à tout moment sans préavis si les sources externes changent ou ferment.

---

## Installation

### Prérequis

- Docker (recommandé)
- Ou Node.js 20+

### Via Docker (recommandé)

```bash
git clone https://github.com/Loo-stick/loostream.git
cd loostream
cp .env.example .env
docker compose up -d

# Avec MediaFlow bundlé (recommandé — voir "Obtenir MediaFlow Proxy")
docker compose --profile mediaflow up -d

# Avec le bot Telegram (optionnel)
docker compose --profile telegram up -d
```

### Via Node.js

```bash
npm install
npm run build
npm start
```

## Configuration

### Option 1 : Via la page Configure (recommandé)

Accédez à `http://localhost:7002/configure` pour configurer l'addon via une interface web :

1. **Clé API TMDB** - Obtenez-la gratuitement sur [themoviedb.org](https://www.themoviedb.org/settings/api)
2. **Mode Proxy** - Choisissez entre MediaFlow (recommandé) ou Proxy Local
3. **Générer le lien** - Un lien d'installation personnalisé sera généré

Chaque utilisateur peut avoir sa propre configuration encodée dans l'URL de l'addon.

### Option 2 : Via fichier .env (pour configuration serveur par défaut)

```bash
cp .env.example .env
```

Éditez `.env` :

```env
PORT=7002
USE_LOCAL_PROXY=false
TMDB_API_KEY=votre_cle_tmdb
MEDIAFLOW_URL=https://votre-mediaflow.com
MEDIAFLOW_PASSWORD=votre_mot_de_passe
```

> **Note** : La configuration via `/configure` est prioritaire sur le `.env`

### Variables d'environnement

| Variable | Description | Requis |
|----------|-------------|--------|
| `PORT` | Port du serveur | Non (défaut: 7002) |
| `USE_LOCAL_PROXY` | `true` = proxy local, `false` = MediaFlow | Non (défaut: false) |
| `TMDB_API_KEY` | Clé API TMDB (fallback si non configuré via /configure) | Non |
| `MEDIAFLOW_URL` | URL MediaFlow (publique) | Si USE_LOCAL_PROXY=false |
| `MEDIAFLOW_PASSWORD` | Mot de passe MediaFlow (partagé avec le conteneur bundlé) | Si USE_LOCAL_PROXY=false |
| `MEDIAFLOW_PORT` | Port hôte du MediaFlow bundlé (profil `mediaflow`) | Non (défaut: 8888) |
| `AUTO_WHITELIST` | `true` = whitelist auto des nouveaux domaines de sources (voir [Maintenance des sources](#maintenance-des-sources)) | Non (défaut: false) |
| `ADMIN_USER` / `ADMIN_PASS` | Active le dashboard `/admin`. Vides = `/admin` renvoie 503 | Non |
| `SESSION_SECRET` | Signe les sessions admin. Vide = clé aléatoire par démarrage | Non |

> Voir `.env.example` pour la liste complète et commentée (dont les overrides avancés `NETMIRROR_API_BASE`, chemins de config…).

### Mode Proxy

| Mode | Description | Bande passante serveur | Usage recommandé |
|------|-------------|------------------------|------------------|
| **MediaFlow** | Flux via serveur MediaFlow externe | Faible | Public / Multi-users / Stremio Web |
| **Proxy Local** | Flux via ce serveur | Élevée | Usage perso / 1-3 users / Apps natives |

> **Note** : Le proxy local peut avoir des problèmes de décodage sur Stremio Web. Utilisez MediaFlow pour le web.

## Maintenance des sources

Les sources changent de domaine régulièrement. Selon la source, la mise à jour se fait de trois façons.

### 1. Éditables à chaud (fichiers `config/*.json`) — sans rebuild

Ces fichiers sont **bind-montés** (`./config:/app/config`) et **rechargés automatiquement** à la moindre modification (`fs.watch`). On édite, on sauvegarde, c'est appliqué — aucun rebuild ni redémarrage.

| Fichier | Pilote |
|---------|--------|
| `config/movix-endpoints.json` | **Movix** — et aussi **Wiflix, VoirDrama et FrenchStream** (tous via l'API Movix) |
| `config/frenchstream-endpoints.json` | domaine front de FrenchStream |
| `config/streamflix-endpoints.json` | base de l'API StreamFlix |
| `config/faklum-endpoints.json` | base du site Faklum |
| `config/voirdrama-endpoints.json` | base du site VoirDrama (scraping) |
| `config/extractor-domains.json` | domaines des hébergeurs (voe, vidmoly…) |
| `config/allowed-domains.json` | whitelist du proxy (anti-SSRF) |

Après édition manuelle, le rechargement est automatique. Pour forcer : `GET /api/<source>/endpoints?reload=true` (ex. `/api/movix/endpoints?reload=true`).

### 2. Depuis le dashboard admin (recommandé)

La page `/admin` a une carte **« URLs des sources »** : modifiez les bases directement dans l'interface, sauvegarde + rechargement à chaud en un clic (écriture protégée par l'auth admin). La carte **« Whitelist des domaines »** permet d'ajouter un domaine et d'afficher l'état de l'auto-whitelist.

### 3. Auto-whitelist des domaines

Sans le bot Telegram, mettez `AUTO_WHITELIST=true` dans le `.env` : tout nouveau domaine renvoyé par une source est ajouté automatiquement à la whitelist au lieu d'être bloqué.

> ⚠️ Cette option relâche l'allowlist de domaines. Le blocage des **IP privées** (127.x, 10.x, 169.254.x…) reste **toujours actif** — la protection SSRF critique est préservée.

### Sources codées en dur

Le **pool de résolveurs mobidetect** de NetMirror est dans le code (`src/scrapers/netmirror.ts`) ; sa base est overridable via `NETMIRROR_API_BASE` / `NETMIRROR_HLS_BASE` (`.env`, restart requis). Tout le reste des bases de sources est désormais externalisé (voir tableau ci-dessus).

## Bot Telegram (Optionnel)

Un bot Telegram **optionnel** permet de gérer la whitelist des domaines CDN en temps réel.

> **Note** : L'addon fonctionne parfaitement sans le bot. Vous pouvez toujours gérer la whitelist manuellement via le fichier `config/allowed-domains.json`.

### Fonctionnalités

- Alerte instantanée quand un domaine est bloqué
- Ajout en 1 clic à la whitelist via Telegram
- Rechargement automatique de la config (sans restart)
- Commandes : `/status`, `/domains`

### Installation du bot

1. **Créer le bot Telegram**
   - Ouvrez [@BotFather](https://t.me/BotFather) sur Telegram
   - Envoyez `/newbot` et suivez les instructions
   - Notez le **token** fourni

2. **Récupérer votre Chat ID**
   - Envoyez `/start` à votre nouveau bot
   - Visitez `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Trouvez votre `chat.id` dans la réponse

3. **Créer le fichier de config** `config/telegram.json` :
   ```json
   {
     "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
     "chatId": "987654321"
   }
   ```

4. **Lancer avec Docker Compose**
   ```bash
   docker compose --profile telegram up -d
   ```

Le bot détecte automatiquement le fichier de config (hot-reload).

> **Sans le bot** : `docker compose up -d` (sans `--profile telegram`)

### Gestion de la whitelist

Les domaines autorisés sont dans `config/allowed-domains.json` :

```json
{
  "domains": [
    "exemple-cdn.com",
    "autre-cdn.net"
  ]
}
```

**Méthodes pour ajouter un domaine :**
1. Via Telegram (cliquer sur "Ajouter" dans l'alerte)
2. Éditer manuellement `config/allowed-domains.json`
3. Appeler `GET /proxy/domains?reload=true` après modification

## Installation dans Stremio

### Via la page Configure

1. Accédez à `http://votre-serveur:7002/configure`
2. Remplissez les champs (TMDB, MediaFlow)
3. Cliquez sur "Générer le lien d'installation"
4. Copiez le lien et ouvrez-le dans Stremio

### Manuellement

Ajoutez l'addon via l'URL : `http://localhost:7002/manifest.json`

## Obtenir une clé TMDB

1. Créez un compte sur [themoviedb.org](https://www.themoviedb.org/)
2. Allez dans Paramètres > API
3. Demandez une clé API (gratuit)

## Obtenir MediaFlow Proxy

MediaFlow est un proxy HLS qui résout les hôtes (voe, doodstream…) et streame les
vidéos sans surcharger votre serveur. **Fortement recommandé** : sans lui, seuls
les extracteurs locaux fonctionnent (couverture réduite).

### Option 1 — MediaFlow bundlé (le plus simple)

Un service MediaFlow est fourni dans le `docker-compose.yml` (profil `mediaflow`) :

```bash
docker compose --profile mediaflow up -d
# + Telegram : docker compose --profile mediaflow --profile telegram up -d
```

Ça démarre un conteneur `loostream-mediaflow` exposé sur le port `MEDIAFLOW_PORT`
(défaut 8888). **Ensuite, deux étapes obligatoires** (MediaFlow forge ses URLs de
lecture depuis le host de la requête : l'addon doit l'appeler par son URL publique) :

1. **Reverse-proxy** : `mediaflow.votredomaine` → `http://127.0.0.1:8888`
   (exemple Apache : `ProxyPass / http://127.0.0.1:8888/` sur un vhost HTTPS)
2. **`.env`** :
   ```env
   MEDIAFLOW_URL=https://mediaflow.votredomaine
   MEDIAFLOW_PASSWORD=un-secret-au-hasard
   ```
   Le même `MEDIAFLOW_PASSWORD` est injecté dans le conteneur MediaFlow.

> Test 100% local (client sur la même machine) : `MEDIAFLOW_URL=http://127.0.0.1:8888` suffit.

### Option 2 — Instance MediaFlow externe

1. Installez [MediaFlow Proxy](https://github.com/mhdzumair/mediaflow-proxy) ailleurs
2. Renseignez son URL publique + mot de passe dans `.env` ou `/configure`

## Sécurité

L'addon inclut plusieurs protections :

- **Whitelist de domaines** - Seuls les CDN autorisés peuvent être proxifiés
- **Blocage IP privées** - Protection SSRF (localhost, 10.x, 192.168.x, etc.)
- **Rate limiting** - 100 requêtes/minute par IP
- **Validation des configs** - Entrées utilisateur nettoyées

## Structure

```
├── src/
│   ├── index.ts          # Point d'entrée et routes
│   ├── configure.html    # Page de configuration
│   ├── proxy.ts          # Proxy HLS avec whitelist
│   └── scrapers/         # Scrapers de sources
├── config/
│   ├── allowed-domains.json  # Whitelist des CDN
│   └── telegram.json         # Config bot Telegram (à créer)
├── telegram-bot.js       # Bot Telegram pour alertes
├── Dockerfile
├── Dockerfile.telegram
└── docker-compose.yml
```

## Licence

MIT License - Voir le fichier LICENSE

---

**En utilisant ce logiciel, vous acceptez ces conditions et assumez l'entière responsabilité de son utilisation.**
