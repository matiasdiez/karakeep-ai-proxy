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
- [Recherche : spécificité, posture et structure des étiquettes](#-recherche--spécificité-posture-et-structure-des-étiquettes)
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

Cette logique est couverte par les tests unitaires dans `src/tests/` (`rateLimiter.test.ts`, `activeHours.test.ts`, `providerManager.test.ts`, `tagEnricher.test.ts`, `requestQueue.test.ts`, `metrics.test.ts`, `handler.test.ts`), qui reflètent le comportement réel bien mieux que n'importe quel schéma.

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
| `GET` | `/status` | État actuel : fournisseur actif, consommation du quota par fournisseur, taille de la file, métriques opérationnelles |
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
  "metrics": {
    "bodyRejections": {
      "totals": { "too_large": 0, "read_timeout": 1 },
      "recentEvents": [
        { "timestamp": 1757400000000, "reason": "read_timeout", "elapsedMs": 30000, "limitMs": 30000 }
      ]
    },
    "tagValidation": {
      "totalsByProvider": {
        "groq": { "ok": 128, "tooMany": 2, "tooFew": 0 },
        "cloudflare": { "ok": 40, "tooMany": 0, "tooFew": 11 }
      },
      "recentEvents": [
        { "timestamp": 1757400012000, "provider": "cloudflare", "tagCount": 3, "expected": 5 }
      ]
    },
    "queuePersistence": {
      "totals": { "success": 340, "failure": 0 },
      "lastSuccessAt": 1757400020000,
      "lastFailureAt": null,
      "recentEvents": [
        { "timestamp": 1757400020000, "ok": true, "itemCount": 2 }
      ]
    }
  },
  "timestamp": "2026-09-09T12:00:00.000Z"
}
```

`metrics` est un module indépendant (`src/metrics.ts`), destiné à être interrogé périodiquement par un tableau de bord sans avoir à analyser les logs :

- **`bodyRejections`** — nombre de requêtes entrantes rejetées suite à `MAX_BODY_BYTES` (`too_large`) ou `REQUEST_READ_TIMEOUT_MS` (`read_timeout`), avec le détail des 50 derniers événements (octets reçus, limite active).
- **`tagValidation`** — par fournisseur, répartition des réponses d'étiquetage ayant exactement 5 tags (`ok`), un surplus (`tooMany`, tronquées) ou un déficit (`tooFew`, transmises telles quelles) — utile pour observer une éventuelle dégradation de qualité d'un modèle.
- **`queuePersistence`** — nombre d'opérations `persist()` de la file réussies ou échouées, avec l'horodatage des dernières occurrences — alerte précoce en cas de disque plein ou d'erreur de permissions.

Les totaux sont cumulés depuis le lancement du processus ; les tableaux `recentEvents` conservent une fenêtre glissante des 50 derniers événements. L'ensemble est réinitialisé en cas de redémarrage.

## 🏷️ Enrichissement des tags et taxonomie (`tagEnricher`)

Il s'agit d'un module **optionnel** pensé pour des cas d'usage spécifiques (comme un backlog d'articles avec une taxonomie de tags organisée manuellement) ; si cela ne vous est pas utile, il suffit de ne pas renseigner `CANONICAL_TAGS_PATH` / `canonical_tags.json`, et le proxy opérera simplement comme un proxy de basculement standard.

Lorsqu'il est activé, le proxy intercepte en toute transparence les requêtes de marquage automatique de Karakeep (`/v1/chat/completions`) et injecte la liste maîtresse des tags canoniques avec un schéma structuré (`response_format: json_schema`) et des directives de catégorisation :

1. **Structure obligatoire à 2 niveaux avec champs obligatoires nommés** :
   - **Niveau général (`general_1`, `general_2`)** : concepts larges issus de la liste canonique préexistante (ex. `marxismo`, `economia`, `cine`), pour le classement et la recherche globale.
   - **Niveau spécifique (`especifico_1` à `especifico_4`)** : descendent d'un cran conceptuel par rapport au niveau général — sous-thème, cas d'étude, auteur, pays, événement ou mécanisme analysé dans le texte (ex. si le niveau général est `marxismo`, le spécifique peut être `teoria-del-valor` ou `acumulacion-por-desposesion`).
   - L'usage de **champs nommés et obligatoires** dans le JSON Schema garantit que Groq, Gemini et OpenRouter imposent la structure au niveau du décodage des tokens (`strict: true`), empêchant les modèles de se limiter à des catégories parapluies ou de renvoyer des tableaux incomplets.

2. **Résolution de la contradiction « normaliser vs détailler »** : le fait qu'un concept large existe déjà dans la liste maîtresse dispense uniquement d'inventer une étiquette générale redondante — cela ne dispense jamais de générer les étiquettes spécifiques de niveau 2.

3. **Neutralité de posture / anti-biais nominal** : chaque étiquette reflète la thèse que l'article *défend réellement*, plutôt que le biais statistique habituel des LLM consistant à attribuer le terme « neutre » d'un concept à des textes qui le critiquent. Si un article critique un concept (ex. philanthropie, libre marché, méritocratie), l'étiquette doit refléter cette critique (`filantrocapitalismo`, `critica-meritocracia`) au lieu d'employer le terme affirmatif (`filantropia`).

4. **Normalisation stricte (`kebab-case`), aplanissement et validation dans le code** :
   - Toutes les étiquettes sont obligatoirement converties en minuscules, séparées par des tirets, sans espaces ni caractères spéciaux.
   - `sanitizeTaggingResponse()` convertit les champs nommés vers le format plat `{"tags": [...]}` attendu par Karakeep.
   - **Validation du Critère A dans le code** : le proxy vérifie directement en mémoire si les étiquettes spécifiques correspondent à des entrées de la liste canonique et émet un avertissement `WARN` de diagnostic en cas de collision, sans dépendre de l'attention du LLM. Cela couvre uniquement le critère *mécanique* (l'étiquette figure-t-elle textuellement dans la liste ?) — le critère *sémantique* (s'agit-il d'un sujet récurrent même s'il ne figure pas dans la liste, ex. `dolarizacion` pendant un mandat présidentiel ?) reste sans validation automatique ; le déterminer avec certitude nécessiterait des données que le proxy ne consulte pas actuellement (ex. fréquence d'utilisation d'étiquettes similaires dans la base Karakeep). Pour l'heure, la validation **n'opère qu'à titre de diagnostic** (journalisation sans exclusion des tags) — voir [limites connues](#-limites-connues-et-prochaines-étapes).

5. **Rechargement à chaud** : le fichier de tags canoniques est mis en cache mémoire et son `mtime` est inspecté toutes les 10 secondes, ne se rechargeant que s'il a changé — sans redémarrage de conteneur.

## 🔬 Recherche : spécificité, posture et structure des étiquettes

Au cours du développement du proxy, un processus systématique de recherche et d'expérimentation a été mené afin de diagnostiquer et corriger deux limitations majeures de l'étiquetage automatique dans Karakeep :

1. **Sur-généralisation des étiquettes** : Tendance systématique des modèles à renvoyer des catégories parapluies trop larges (`cultura`, `marxismo`, `economia`) qui ne capturent pas les faits singuliers, documents ou thèses spécifiques de l'article.
2. **Biais nominal et cécité de posture (*Stance Blindness*)** : Attribution du terme nominal ou « neutre » d'un concept (`filantropia`) à des articles qui le critiquent ou le déconstruisent, suggérant à tort une appréciation favorable.

### Découvertes clés et décisions d'architecture

- **Des consignes en texte brut au `response_format` structuré (JSON Schema)** : Les modèles (légers comme de grande taille) ignoraient fréquemment les contraintes de format et de quotas demandées en texte libre (phénomène corroboré par la littérature scientifique, notamment l'étude RECAST sur la dégradation du suivi d'instructions sous contraintes multiples). Pour y remédier de façon portable, un schéma comprenant des **champs obligatoires nommés** (`general_1`, `general_2`, `especifico_1` à `especifico_4`) a été conçu. Cette approche évite l'emploi de `minItems`/`maxItems` sur les tableaux (supporté par Gemini mais rejeté par Groq/OpenAI en mode `strict: true`) et garantit que la structure exacte soit imposée au niveau du décodage des tokens pour Groq, Gemini et OpenRouter.
- **Limites de l'ingénierie de prompt face aux automatismes d'extraction** : L'observation de modèles à raisonnement visible (*chain-of-thought*) tels que `nemotron-3-super-120b` a révélé que le modèle comprenait parfaitement la consigne interdisant d'utiliser des noms propres récurrents comme étiquettes spécifiques, mais décidait délibérément de ne pas l'appliquer lors de la réponse finale (« but that's okay »). **Cinq variantes distinctes de prompt** ont été testées face à ce schéma (règle simple, critères dissociés, exemple résolu, retour au schéma efficace de Gemini et champ supplémentaire) sans observer le moindre changement de comportement — confirmant ainsi que le problème ne réside pas dans la formulation du prompt, mais dans la hiérarchisation interne des priorités propre à ce modèle.
- **Déplacement des vérifications du prompt vers le code** : Demander à un LLM de vérifier avec certitude si une étiquette appartient à une liste de plus de 800 entrées est inefficace et propice à des omissions silencieuses. La validation du **Critère A** (vérifier que les étiquettes spécifiques n'entrent pas en collision avec la liste canonique) a été implémentée de façon déterministe en code au sein de `sanitizeTaggingResponse()`, et son efficacité a été validée en conditions réelles de trafic : sur un test face à la liste canonique de 804 étiquettes, le code a correctement intercepté 3 étiquettes « spécifiques » sur 4 qui étaient en réalité des noms déjà présents dans la liste générale, ce que le modèle lui-même avait échoué à détecter lors de l'analyse du prompt.
- **Évaluation comparative des modèles** : `gemini-3.5-flash` s'est imposé comme le modèle le plus performant pour capturer les éléments concrets de la seconde moitié des articles (titres exacts de documents, mécanismes politiques/économiques ciblés), tandis que les modèles légers (`gpt-oss-20b`, `gemini-flash-lite`) ont tendance à la sur-généralisation ou requièrent un strict encadrement par schéma. `nemotron-3-super-120b` (OpenRouter), malgré sa taille supérieure, s'est révélé être le modèle le plus vulnérable au recyclage de noms propres en tant qu'étiquettes spécifiques.

### ⚠️ Limites connues et prochaines étapes

- Le **Critère B** (s'agit-il d'un thème récurrent même s'il ne figure pas textuellement dans la liste canonique ? — ex. `dolarizacion` durant une mandature) ne dispose d'aucune vérification automatique. Cela a été accepté comme une limite connue : le déterminer avec certitude nécessiterait des données que le proxy ne consulte pas à ce jour (ex. fréquence des tags similaires dans la base Karakeep).
- La validation du Critère A **n'opère qu'à titre diagnostique** (`WARN` dans les logs) — elle ne supprime pas encore l'étiquette en infraction. Une décision reste à prendre sur la conduite à tenir si les 4 étiquettes spécifiques d'un marque-page devaient être éliminées (ne laissant que les 2 étiquettes générales) ; une **seconde passe** du proxy destinée à régénérer uniquement les champs rejetés est à l'étude.
- Compte tenu du comportement confirmé sur `nemotron-3-super-120b`, il est recommandé de réduire sa priorité dans `PROVIDER_ORDER` (voire de le retirer) si la précision des étiquettes spécifiques prime sur la couverture globale. Cloudflare Workers AI n'a pas encore été évalué sous ce schéma.

> 📖 **Rapport complet d'investigation** : Pour consulter le journal chronologique détaillé de toutes les phases expérimentales, les itérations de prompts, la comparaison des modèles et la bibliographie académique associée, voir [investigacion_especificidad_y_postura_tags.md](./investigacion_especificidad_y_postura_tags.md).

## 🗂️ Structure du projet

```
ai-proxy/
├── src/
│   ├── config.ts                    # Lecture et validation des variables d'environnement
│   ├── logger.ts                    # Logger par niveaux
│   ├── metrics.ts                   # Compteurs en mémoire : rejets de body, validation des tags, persistance
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
│   │   └── requestQueue.ts          # File FIFO avec persistance atomique sur disque
│   ├── routes/
│   │   └── status.ts                # GET /status (inclut metrics) + GET /health
│   ├── scripts/
│   │   └── manualTagTest.ts         # Script de test manuel pour tagEnricher
│   └── tests/
│       ├── rateLimiter.test.ts
│       ├── activeHours.test.ts
│       ├── providerManager.test.ts
│       ├── tagEnricher.test.ts
│       ├── requestQueue.test.ts
│       ├── metrics.test.ts
│       └── handler.test.ts          # Intégration : basculement, file d'attente, limites du corps de requête
├── .env.example
├── Dockerfile
├── LICENSE                          # Licence GNU AGPLv3
├── package.json
├── tsconfig.json
├── PROVIDER_SETUP.md                # Guide de configuration et rotation des fournisseurs
└── investigacion_especificidad_y_postura_tags.md # Rapport de recherche sur la taxonomie et les LLMs
```

## 🧪 Tests

```bash
cd ai-proxy
pnpm test          # exécution unique
pnpm test:watch    # mode interactif watch
```

Ils couvrent la logique de limitation de débit (fenêtre glissante RPM/TPM/TPD), le calcul des heures d'activité, la machine d'états de `ProviderManager`, le nettoyage des tags dans `tagEnricher`, la persistance atomique dans `requestQueue` (y compris la gestion d'erreurs), les compteurs de `metrics` et, dans `handler.test.ts`, le cycle complet du gestionnaire de requêtes (basculement entre fournisseurs avec simulation de `forwardRequest`, mise en file d'attente lorsqu'aucun fournisseur n'est disponible et rejet des corps de requête surdimensionnés).

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

Ce projet est sous licence **[GNU Affero General Public License v3 (AGPL-3.0-or-later)](./LICENSE)**.

Choisie pour préserver les biens communs numériques et les principes démocratiques du logiciel libre : vous êtes libre d'utiliser, d'étudier, de modifier et de redistribuer ce proxy, à condition que toute modification ou service dérivé exécuté sur un réseau conserve la même licence libre et mette son code source à la disposition de la communauté.
