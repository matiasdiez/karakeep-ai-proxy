# Karakeep AI Proxy

[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](#option-b--standalone-avec-docker)

**Langues / Languages / Idiomas :** [Español](README.md) | [English](README.en.md) | [Français](README.fr.md)

---

Proxy HTTP en Node.js/TypeScript, compatible avec l'API OpenAI, intercalé entre [Karakeep](https://github.com/karakeep-app/karakeep) et plusieurs fournisseurs d'inférence LLM (**Groq**, **Gemini**, **OpenRouter**, **Cloudflare Workers AI** et **Ollama**) pour traiter un backlog massif de marque-pages en utilisant **uniquement des forfaits gratuits**, sans que les limites de débit (*rate limits*) ne marquent les tâches en échec.

## 🧩 Le problème résolu

Karakeep utilise un LLM pour étiqueter et résumer chaque marque-page enregistré. Lorsque le backlog est volumineux (des milliers d'articles), le forfait gratuit de n'importe quel fournisseur s'épuise en quelques minutes, et Karakeep commence à marquer les tâches comme échouées dans BullMQ. Ce proxy sert de couche intermédiaire qui :

- Répartit la charge entre **plusieurs fournisseurs gratuits en cascade**, en basculant vers le suivant *avant* d'atteindre la limite de débit réelle (plutôt que d'attendre l'erreur 429).
- **Met en file d'attente** les requêtes impossibles à traiter immédiatement au lieu de les rejeter, afin que Karakeep ne reçoive jamais d'erreur.
- La nuit, lorsque le trafic interactif est faible, redirige automatiquement vers un modèle **local (Ollama)** sans restriction de quota.
- Facultativement, intercepte les requêtes d'étiquetage pour injecter une taxonomie personnalisée de tags canoniques avec des règles strictes de cohérence (voir [Enrichissement des tags et taxonomie](#-enrichissement-des-tags-et-taxonomie-tagenricher)).

## 📑 Sommaire

- [Que fait-il ?](#-que-fait-il-)
- [Architecture / diagramme d'états](#-architecture--diagramme-détats)
- [Prérequis](#-prérequis)
- [Installation](#-installation)
  - [En conteneur aux côtés de Karakeep (usage prévu)](#option-a--en-conteneur-aux-côtés-de-karakeep-usage-prévu)
  - [Standalone avec Docker](#option-b--standalone-avec-docker)
  - [Développement local sans Docker](#option-c--développement-local-sans-docker)
- [Configuration (variables d'environnement)](#-configuration-variables-denvironnement)
- [Points de terminaison (endpoints)](#-points-de-terminaison-endpoints)
- [Enrichissement des tags et taxonomie](#-enrichissement-des-tags-et-taxonomie-tagenricher)
- [Structure du projet](#-structure-du-projet)
- [Tests](#-tests)
- [Limites des forfaits gratuits](#-limites-suggérées-forfaits-gratuits--à-vérifier-sur-chaque-tableau-de-bord)
- [Dépannage (Troubleshooting)](#-dépannage-troubleshooting)
- [Licence](#-licence)

## ✅ Que fait-il ?

- Expose un point de terminaison unique compatible OpenAI sur `http://ai-proxy:8080/v1`, conçu pour être configuré en tant que `OPENAI_BASE_URL` dans Karakeep (ou tout client compatible avec l'API OpenAI).
- Applique un **basculement automatique en cascade** entre fournisseurs : `Groq → Gemini → OpenRouter → Cloudflare → file d'attente`, configurable via `PROVIDER_ORDER`.
- La nuit (en dehors de la plage horaire `ACTIVE_HOURS_START`–`ACTIVE_HOURS_END`), route automatiquement vers **Ollama local**, sans intervention manuelle.
- Suit le RPM/TPM/TPD/RPD par fournisseur à l'aide de fenêtres glissantes et déclenche un basculement **proactif** dès que `EXHAUSTION_THRESHOLD` est atteint (80 % par défaut) — avant même de recevoir une erreur 429 réelle.
- Si une erreur 429 survient tout de même, il interprète le fournisseur comme « épuisé » et bascule instantanément.
- Les requêtes ne pouvant pas être traitées immédiatement sont **mises en file d'attente** (aucune réponse 5xx n'est renvoyée) pour éviter que BullMQ ne marque les tâches en échec.
- La file d'attente est persistée sur disque (`QUEUE_PERSIST_PATH`), survivant aux redémarrages du conteneur.
- Expose `GET /status` et `GET /health` pour l'observabilité.
- Facultativement, **enrichit les requêtes d'étiquetage** de Karakeep avec une taxonomie de tags personnalisée (voir plus bas).

## 🔀 Architecture / diagramme d'états

À haut niveau, le système suit une cascade simple : `Groq → Gemini → OpenRouter → Cloudflare → file d'attente`, et en dehors des heures d'activité (`ACTIVE_HOURS_START`–`ACTIVE_HOURS_END`), tout est acheminé vers Ollama local. L'ordre se configure via `PROVIDER_ORDER`.

La complexité se situe dans la gestion fine de chaque transition :

- **Limitation de débit par fenêtre glissante plutôt que par compteur fixe** : chaque fournisseur suit 4 métriques en parallèle (RPM, TPM, TPD, RPD) avec des fenêtres indépendantes — un compteur simpliste réinitialisé à chaque minute pleine autorise des pointes doubles à la frontière de deux minutes ; la fenêtre glissante l'empêche.
- **Basculement proactif, et pas seulement réactif** : le proxy bascule dès que `EXHAUSTION_THRESHOLD` (80 % par défaut) de la limite la plus restrictive des 4 métriques est atteint, *avant* que le fournisseur ne renvoie une erreur 429. Si un 429 arrive malgré tout, il est considéré comme un signal supplémentaire d'épuisement.
- **File d'attente persistée sur disque de manière atomique, et non en mémoire** : les requêtes qui ne peuvent pas être traitées immédiatement sont écrites dans `QUEUE_PERSIST_PATH` au lieu d'être perdues. Chaque écriture transite d'abord par un fichier temporaire avant d'être renommée vers le fichier définitif (`rename` étant une opération atomique en POSIX) ; ainsi, un arrêt inattendu en cours d'écriture laisse le fichier précédent intact plutôt que de générer un JSON corrompu ou tronqué.
- **Arrêt gracieux avec délai d'attente (graceful shutdown)** : à la réception de `SIGTERM`/`SIGINT`, le serveur cesse d'accepter de nouvelles connexions, vide la file sur le disque et accorde 30 s avant de forcer l'arrêt — évitant d'interrompre une écriture en cours.
- **Rechargement à chaud de la taxonomie de tags** : `canonical_tags.json` est mis en cache mémoire et son horodatage `mtime` est vérifié toutes les 10 secondes, permettant de modifier la liste de tags sans redémarrer le proxy.

Cette logique est couverte par les tests unitaires dans `src/tests/` (`rateLimiter.test.ts`, `activeHours.test.ts`, `providerManager.test.ts`, `tagEnricher.test.ts`, `handler.test.ts`), qui reflètent le comportement réel bien mieux que n'importe quel schéma.

## 📋 Prérequis

- Node.js ≥ 20
- [pnpm](https://pnpm.io/) (le projet utilise `pnpm-lock.yaml`)
- Docker et Docker Compose (optionnel, recommandé pour la production)
- Au moins une clé d'API d'un fournisseur pris en charge ([voir tableau des limites](#-limites-suggérées-forfaits-gratuits--à-vérifier-sur-chaque-tableau-de-bord))

## 🚀 Installation

### Option A — En conteneur aux côtés de Karakeep (Usage prévu)

Ce proxy est conçu pour tourner comme un service supplémentaire au sein du fichier `docker-compose.yml` de Karakeep, en y pointant `OPENAI_BASE_URL`.

**1. Configurer le proxy**

```bash
cd ai-proxy
cp .env.example .env
nano .env   # renseigner les vraies clés d'API
```

**2. Ajouter le service au `docker-compose.yml` de Karakeep**

```yaml
services:
  ai-proxy:
    build: ../ai-proxy
    env_file: ../ai-proxy/.env
    ports:
      - "8081:8080"
    restart: unless-stopped

  karakeep_worker:
    environment:
      - OPENAI_BASE_URL=http://ai-proxy:8080/v1
```

**3. Lancer la pile**

```bash
docker compose up -d
```

**4. Vérifier le bon fonctionnement**

```bash
curl http://localhost:8081/status | python3 -m json.tool
docker compose logs -f ai-proxy
```

> Les noms de services, les ports et la manière de redéfinir `OPENAI_BASE_URL` dépendent de l'organisation de votre propre `docker-compose.yml` Karakeep — l'exemple ci-dessus constitue un point de départ, pas un schéma immuable.

### Option B — Standalone avec Docker

Pour tester le proxy seul, sans Karakeep :

```bash
cd ai-proxy
cp .env.example .env
# Éditer .env avec vos clés d'API

docker build -t ai-proxy .
docker run -d --name ai-proxy \
  --env-file .env \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  ai-proxy
```

### Option C — Développement local (sans Docker)

```bash
cd ai-proxy
pnpm install
cp .env.example .env
# Éditer .env
pnpm run build
node dist/index.js

# ou en mode watch :
pnpm run dev
```

## ⚙️ Configuration (variables d'environnement)

Toutes les variables sont documentées avec leurs valeurs par défaut dans [`.env.example`](./.env.example). Résumé par fournisseur :

| Fournisseur | Variables clés | Obligatoire |
|---|---|---|
| **Groq** | `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_RATE_LIMIT_{RPM,TPM,TPD,RPD}` | Oui |
| **Gemini** | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_RATE_LIMIT_{RPM,TPM,TPD,RPD}` | Oui |
| **OpenRouter** | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_RATE_LIMIT_{RPM,RPD}` | Oui |
| **Cloudflare Workers AI** | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_MODEL`, `CLOUDFLARE_RATE_LIMIT_{RPM,TPD}` | Oui |
| **Ollama** (local) | `ENABLE_OLLAMA`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Non (par défaut `true`, requiert une instance active d'Ollama) |

> La clé d'API de chaque fournisseur n'est requise que si ce fournisseur est présent dans `PROVIDER_ORDER`. Si, par exemple, vous souhaitez uniquement utiliser Groq et Gemini, vous pouvez laisser `OPENROUTER_API_KEY` / `CLOUDFLARE_API_TOKEN` vides et les retirer de `PROVIDER_ORDER` — l'application démarrera normalement.

Variables générales du proxy :

| Variable | Par défaut | Description |
|---|---|---|
| `PROXY_PORT` | `8080` | Port du serveur HTTP |
| `PROVIDER_ORDER` | `groq,gemini,openrouter,cloudflare` | Ordre de la cascade de basculement |
| `EXHAUSTION_THRESHOLD` | `0.80` | % de la limite à partir duquel un fournisseur est considéré comme « épuisé » (failover proactif) |
| `WAIT_MAX_MS` | `20000` | Durée maximale (ms) de maintien de la connexion avant mise en file d'attente |
| `QUEUE_PERSIST_PATH` | — | Chemin d'enregistrement de la file d'attente entre redémarrages (ex. `/app/data/queue.json`) |
| `MAX_BODY_BYTES` | `5000000` | Taille maximale du corps d'une requête entrante ; renvoie `413` au-delà |
| `REQUEST_READ_TIMEOUT_MS` | `30000` | Délai max. pour terminer la lecture du corps entrant ; renvoie `408` au-delà |
| `ACTIVE_HOURS_START` / `ACTIVE_HOURS_END` | `07:00` / `22:00` | Plage horaire d'utilisation de la cascade cloud ; en dehors, Ollama prend le relais |
| `TIMEZONE` | `America/Argentina/Buenos_Aires` | Fuseau horaire pour le calcul de `ACTIVE_HOURS_*` |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `CANONICAL_TAGS_PATH` | `./data/canonical_tags.json` | Chemin du fichier JSON des tags canoniques pour `tagEnricher` (optionnel) |

**Où obtenir chaque clé d'API :**

| Fournisseur | Où l'obtenir |
|---|---|
| Groq | [console.groq.com/keys](https://console.groq.com/keys) |
| Gemini | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Cloudflare Workers AI | [dash.cloudflare.com](https://dash.cloudflare.com/) → *Manage Account → Tokens* (permission *Workers AI*) + Account ID dans *Account Overview* |

## 🔌 Points de terminaison (endpoints)

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/v1/*` | Endpoint compatible OpenAI ; redirige vers le fournisseur actif selon la machine d'états |
| `GET` | `/status` | État actuel : fournisseur actif, consommation du quota par fournisseur, taille de la file |
| `GET` | `/health` | Vérification de santé basique (`{ ok: true }`) |

Exemple de `GET /status` :

```json
{
  "activeProvider": "GROQ",
  "activeHours": true,
  "providers": {
    "groq":       { "exhausted": false, "rpm": { "used": 4, "limit": 30, "pct": 0.13 } },
    "gemini":     { "exhausted": false, "rpm": { "used": 0, "limit": 15, "pct": 0 } },
    "openrouter": { "exhausted": false, "rpm": { "used": 0, "limit": 20, "pct": 0 } },
    "cloudflare": { "exhausted": false, "rpm": { "used": 0, "limit": 300, "pct": 0 } },
    "ollama":     { "active": false }
  },
  "queueSize": 0,
  "timestamp": "2026-09-09T12:00:00.000Z"
}
```

## 🏷️ Enrichissement des tags et taxonomie (`tagEnricher`)

Il s'agit d'un module **optionnel** pensé pour des cas d'usage spécifiques (comme un backlog d'articles avec une taxonomie de tags organisée manuellement) ; si cela ne vous est pas utile, il suffit de ne pas renseigner `CANONICAL_TAGS_PATH` / `canonical_tags.json`, et le proxy opérera simplement comme un proxy de basculement standard.

Lorsqu'il est activé, le proxy intercepte en toute transparence les requêtes de marquage automatique de Karakeep (`/v1/chat/completions`) et injecte la liste maîtresse des tags canoniques avec des directives de catégorisation :

1. **Structure obligatoire à 2 niveaux avec quotas fixes (exactement 5 étiquettes)**
   - **Niveau général (2 étiquettes)** : concepts larges issus de la liste canonique préexistante (ex. `marxismo`, `economia`, `cine`), pour le classement et la recherche globale.
   - **Niveau spécifique (3 étiquettes)** : un cran plus concret — sous-thème, cas d'étude, auteur, pays, événement ou mécanisme analysé dans le texte (ex. si le niveau général est `marxismo`, le niveau spécifique peut être `teoria-del-valor` ou `acumulacion-por-desposesion`).
   - Le quota fixe (2 + 3 = 5) empêche les modèles légers (Groq/Gemini Flash/Llama sur Cloudflare) de choisir la facilité en ne retournant que des catégories parapluies.

2. **Résolution de la contradiction « normaliser vs détailler »** : le fait qu'un concept large existe déjà dans la liste maîtresse dispense uniquement d'inventer une étiquette générale redondante — cela ne dispense jamais de générer les 3 étiquettes spécifiques de niveau 2.

3. **Neutralité de posture / anti-biais nominal** : chaque étiquette reflète la thèse que l'article *défend réellement*, plutôt que le biais statistique habituel des LLM consistant à attribuer le terme « neutre » d'un concept à des textes qui le critiquent. Si un article critique un concept (ex. philanthropie, libre marché, méritocratie), l'étiquette doit refléter cette critique (`filantrocapitalismo`, `critica-meritocracia`) au lieu d'employer le terme affirmatif (`filantropia`).

4. **Normalisation stricte (`kebab-case`) et validation du quota** : toutes les étiquettes sont obligatoirement converties en minuscules, séparées par des tirets, sans espaces ni caractères spéciaux. `sanitizeTaggingResponse()` compte également les étiquettes renvoyées : si le modèle n'a pas respecté la règle des 5 et en a retourné davantage, la liste est tronquée ; s'il en a retourné moins, la réponse est transmise tout en émettant un avertissement dans les logs — le proxy ne peut pas reconstruire des étiquettes que le modèle n'a jamais générées, mais cela met au moins en évidence dans les logs que le quota n'a pas été honoré.

5. **Rechargement à chaud** : le fichier de tags canoniques est mis en cache mémoire et son `mtime` est inspecté toutes les 10 secondes, ne se rechargeant que s'il a changé — sans redémarrage de conteneur.

## 🗂️ Structure du projet

```
ai-proxy/
├── src/
│   ├── config.ts                    # Lecture et validation des variables d'environnement
│   ├── logger.ts                    # Logger par niveaux
│   ├── index.ts                     # Point d'entrée, Express, arrêt gracieux
│   ├── providers/
│   │   ├── types.ts                 # Interfaces et énumérations
│   │   ├── rateLimiter.ts           # Fenêtre glissante RPM/TPM + TPD/RPD quotidien
│   │   └── providerManager.ts       # Machine à états Groq/Gemini/OpenRouter/Cloudflare/Ollama
│   ├── proxy/
│   │   ├── forwardRequest.ts        # Acheminement HTTP + réécriture du modèle
│   │   ├── handler.ts               # Gestionnaire Express + purge de la file
│   │   └── tagEnricher.ts           # Intercepteur et injecteur de tags canoniques (optionnel)
│   ├── queue/
│   │   └── requestQueue.ts          # File FIFO avec persistance sur disque
│   ├── routes/
│   │   └── status.ts                # GET /status + GET /health
│   ├── scripts/
│   │   └── manualTagTest.ts         # Script de test manuel pour tagEnricher
│   └── tests/
│       ├── rateLimiter.test.ts
│       ├── activeHours.test.ts
│       ├── providerManager.test.ts
│       ├── tagEnricher.test.ts
│       └── handler.test.ts          # Intégration : basculement, file d'attente, limites du corps de requête
├── .env.example
├── Dockerfile
├── package.json
└── tsconfig.json
```

## 🧪 Tests

```bash
cd ai-proxy
pnpm test          # exécution unique
pnpm test:watch    # mode interactif watch
```

Ils couvrent la logique de limitation de débit (fenêtre glissante RPM/TPM/TPD), le calcul des heures d'activité, la machine d'états de `ProviderManager`, le nettoyage des tags dans `tagEnricher` et, dans `handler.test.ts`, le cycle complet du gestionnaire de requêtes (basculement entre fournisseurs avec simulation de `forwardRequest`, mise en file d'attente lorsqu'aucun fournisseur n'est disponible et rejet des corps de requête surdimensionnés).

## 📊 Limites suggérées (forfaits gratuits) — à vérifier sur chaque tableau de bord

> ⚠️ Ces valeurs sont des estimations susceptibles de varier selon le forfait et le modèle. **Vérifiez-les sur votre propre tableau de bord avant toute mise en production.**

| Fournisseur | Modèle d'exemple | RPM | TPM | TPD | Coût |
|---|---|---|---|---|---|
| Groq | `openai/gpt-oss-20b` | 30 | 14 400 | 200 000 | Gratuit |
| Gemini | `gemini-flash-lite-latest` | 15 | 1 000 000 | illimité | Gratuit |
| OpenRouter | modèles `:free` | 20 | — | basé sur crédits | Gratuit |
| Cloudflare Workers AI | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 300 | — | 10 000 neurones/jour | Gratuit |
| Ollama | `qwen2.5:7b` (local) | ∞ | ∞ | ∞ | Gratuit (votre matériel) |

- Groq : [console.groq.com/settings/limits](https://console.groq.com/settings/limits)
- Gemini : [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- OpenRouter : `curl https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer $OPENROUTER_API_KEY"`
- Cloudflare : [developers.cloudflare.com/workers-ai](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## 🛠️ Dépannage (Troubleshooting)

| Symptôme | Cause probable | Solution |
|---|---|---|
| Le processus ne démarre pas / `Missing required env var` | Clé d'API manquante pour un fournisseur présent dans `PROVIDER_ORDER` | Renseignez cette clé dans `.env`, ou retirez ce fournisseur de `PROVIDER_ORDER` si vous ne l'utilisez pas |
| `413 Payload too large` | Le corps de la requête dépasse `MAX_BODY_BYTES` | Augmentez la limite dans `.env` si vos requêtes sont légitimement plus volumineuses |
| `408 Request body read timeout` | Le client n'a pas terminé d'envoyer le corps dans le délai `REQUEST_READ_TIMEOUT_MS` | Vérifiez la connexion réseau entre Karakeep et le proxy ; augmentez le timeout si le réseau est lent |
| Toutes les requêtes sont en file d'attente et ne se résolvent jamais | Tous les fournisseurs cloud sont épuisés et `ENABLE_OLLAMA=false` (ou Ollama inaccessible) | Activez Ollama ou attendez la réinitialisation quotidienne des quotas |
| `ECONNREFUSED` lors de la connexion à Ollama | `OLLAMA_BASE_URL` pointe vers `localhost` depuis l'intérieur d'un conteneur | Utilisez `http://host.docker.internal:11434/v1` (ou le nom d'hôte du service sur votre réseau Docker) |
| Karakeep continue de requêter directement le fournisseur | `OPENAI_BASE_URL` ne pointe pas vers le proxy | Vérifiez que le worker de Karakeep dispose bien de `OPENAI_BASE_URL=http://ai-proxy:8080/v1` |
| Les étiquettes ne respectent pas le quota de 5 | `tagEnricher` désactivé ou `canonical_tags.json` manquant | Vérifiez `CANONICAL_TAGS_PATH` et assurez-vous que le fichier existe et soit un JSON valide |

## 📄 Licence

Ce dépôt ne comporte pas encore de fichier `LICENSE`. Si vous envisagez de le partager publiquement, il est conseillé d'en ajouter un (par exemple [MIT](https://choosealicense.com/licenses/mit/)) pour clarifier les conditions d'utilisation du code.
