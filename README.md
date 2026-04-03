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

- Node.js 20+
- Docker (optionnel)

### Via Docker (recommandé)

```bash
docker compose up -d
```

### Via Node.js

```bash
npm install
npm run build
npm start
```

### Dans Stremio

Ajouter l'addon via l'URL : `http://localhost:7002/manifest.json`

## Configuration

1. Copier le fichier d'exemple :
```bash
cp .env.example .env
```

2. Éditer `.env` avec vos valeurs :
```env
PORT=7002
USE_LOCAL_PROXY=true
TMDB_API_KEY=votre_cle_tmdb
```

### Variables d'environnement

| Variable | Description | Requis |
|----------|-------------|--------|
| `PORT` | Port du serveur | Non (défaut: 7002) |
| `USE_LOCAL_PROXY` | `true` = proxy local, `false` = MediaFlow | Non (défaut: false) |
| `TMDB_API_KEY` | Clé API TMDB | **Oui** |
| `MEDIAFLOW_URL` | URL MediaFlow | Si USE_LOCAL_PROXY=false |
| `MEDIAFLOW_PASSWORD` | Mot de passe MediaFlow | Si USE_LOCAL_PROXY=false |

### Mode Proxy

| Mode | Variable | Bande passante | Usage recommandé |
|------|----------|----------------|------------------|
| **MediaFlow** (défaut) | `USE_LOCAL_PROXY=false` | Faible | Public / Multi-users |
| **Proxy local** | `USE_LOCAL_PROXY=true` | Élevée | Perso / 1-3 users |

### Obtenir une clé TMDB

1. Créer un compte sur [themoviedb.org](https://www.themoviedb.org/)
2. Aller dans Paramètres > API
3. Demander une clé API (gratuit)

## Fonctionnalités

- Agrégation multi-sources
- Proxy HLS intégré
- Support films et séries
- Priorité contenu français (VF/VOSTFR)

## Structure

```
src/
├── index.ts        # Point d'entrée
├── proxy.ts        # Proxy HLS intégré
└── scrapers/       # Scrapers de sources
```

## Licence

MIT License

Copyright (c) 2024

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

**En utilisant ce logiciel, vous acceptez ces conditions et assumez l'entière responsabilité de son utilisation.**
