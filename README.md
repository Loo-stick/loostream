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

## Sources

| Source | Type | Contenu |
|--------|------|---------|
| **Movix** | VF/VOSTFR | Films & Séries en français |
| **NetMirror** | Original | Netflix, Prime Video, Disney+ |
| **StreamFlix** | Original | Films & Séries |

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
| `MEDIAFLOW_URL` | URL MediaFlow | Si USE_LOCAL_PROXY=false |
| `MEDIAFLOW_PASSWORD` | Mot de passe MediaFlow | Si USE_LOCAL_PROXY=false |

### Mode Proxy

| Mode | Description | Bande passante serveur | Usage recommandé |
|------|-------------|------------------------|------------------|
| **MediaFlow** | Flux via serveur MediaFlow externe | Faible | Public / Multi-users / Stremio Web |
| **Proxy Local** | Flux via ce serveur | Élevée | Usage perso / 1-3 users / Apps natives |

> **Note** : Le proxy local peut avoir des problèmes de décodage sur Stremio Web. Utilisez MediaFlow pour le web.

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

MediaFlow est un proxy HLS qui permet de streamer les vidéos sans surcharger votre serveur.

1. Installez [MediaFlow Proxy](https://github.com/mhdzumair/mediaflow-proxy)
2. Configurez l'URL et le mot de passe dans `/configure`

## Structure

```
src/
├── index.ts          # Point d'entrée et routes
├── configure.html    # Page de configuration
├── proxy.ts          # Proxy HLS intégré
└── scrapers/         # Scrapers de sources
    ├── movix.ts      # Source Movix (VF/VOSTFR)
    ├── netmirror.ts  # Source NetMirror (Netflix, Prime, Disney+)
    └── streamflix.ts # Source StreamFlix
```

## Licence

MIT License - Voir le fichier LICENSE

---

**En utilisant ce logiciel, vous acceptez ces conditions et assumez l'entière responsabilité de son utilisation.**
