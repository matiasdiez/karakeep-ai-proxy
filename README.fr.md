# Karakeep AI Proxy

**Langues / Languages / Idiomas :** [Español](README.md) | [English](README.en.md) | [Français](README.fr.md)

---

Proxy HTTP en Node.js/TypeScript intercalé entre [Karakeep](https://github.com/karakeep-app/karakeep) et plusieurs fournisseurs d'inférence — **Groq**, **Gemini**, **OpenRouter**, **Cloudflare** et **Ollama** — afin de traiter un backlog massif de marque-pages sans qu'aucune limite de débit (*rate limit*) ne provoque l'échec des tâches dans BullMQ.

## Que fait-il ?

- Expose un point de terminaison unique compatible avec l'API OpenAI sur `http://ai-proxy:8080/v1`
- Applique un **basculement automatique (failover)** : Groq → Gemini → attente (mise en file) pendant la journée
- La nuit, redirige automatiquement vers l'instance locale **Ollama** sans intervention manuelle
- Applique un **enrichissement taxonomique à 2 niveaux et une neutralité de posture sur les tags** : intercepte les requêtes d'étiquetage de Karakeep et y injecte la liste des tags canoniques, en imposant un quota strict de 5 étiquettes (2 générales issues de la liste canonique + 3 spécifiques au sujet concret) tout en forçant les étiquettes à refléter la posture réelle ou critique du texte (anti-biais nominal)
- Mesure le RPM/TPM/TPD par fournisseur et déclenche un failover **proactif** dès 80 % de la limite de quota (avant de recevoir une véritable erreur 429)
- En cas de véritable réponse 429, traite le fournisseur comme « épuisé » et bascule immédiatement sur le suivant
- Les requêtes qui ne peuvent pas être traitées immédiatement sont **mises en file d'attente** (au lieu d'être rejetées par une erreur 5xx), évitant ainsi à BullMQ de Karakeep de marquer les tâches en échec
- File d'attente persistée sur disque (redémarrable sans perte de tâches)

## Diagramme d'états

```
[Groq actif]
   │ RPM/TPM/TPD ≥ 80 % de la limite ──→ [Gemini actif]
   │ Erreur 429 réelle de Groq        ──→ [Gemini actif]
   │
[Gemini actif]
   │ RPM/TPM/TPD ≥ 80 % de la limite ──→ [En attente / file d'attente]
   │ Erreur 429 réelle de Gemini      ──→ [En attente / file d'attente]
   │
[En attente / file d'attente]
   │ Groq ou Gemini récupère du quota ──→ [retour au meilleur fournisseur]
   │ ACTIVE_HOURS_END atteint         ──→ [Ollama actif]
   │
[Ollama actif]  ← nuit, sans restriction de quota
   │ ACTIVE_HOURS_START atteint       ──→ [Groq actif] (réinitialisation des compteurs)
```

## Installation et configuration

### 1. Configurer le proxy

```bash
cd ai-proxy
cp .env.example .env
# Éditer .env avec vos clés d'API réelles
nano .env
```

Variables minimales à définir :

| Variable | Où l'obtenir |
|---|---|
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) |
| `GEMINI_API_KEY` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| `TIMEZONE` | Votre fuseau horaire ([liste](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)) |

### 2. Activer le proxy dans Karakeep

```bash
cd karakeep
make use-proxy
```

Cette commande copie `.env.proxy` → `.env` (définissant `OPENAI_BASE_URL=http://ai-proxy:8080/v1`) et redémarre le worker de Karakeep.

### 3. Démarrer la pile complète

```bash
cd karakeep
docker compose up -d
```

Le service `ai-proxy` est construit automatiquement depuis `../ai-proxy/Dockerfile`.

### 4. Vérifier le bon fonctionnement

```bash
# État du proxy (fournisseur actif, quota, taille de la file d'attente)
make proxy-status

# Ou directement via curl
curl http://localhost:8081/status | python3 -m json.tool

# Journaux (logs) du proxy en temps réel
make proxy-logs
```

## Arrêter le service

### Tout arrêter (libérer RAM et CPU)

```bash
cd ~/Web/karakeep/karakeep
docker compose down
```

Arrête et supprime tous les conteneurs. Les données (marque-pages, file d'attente du proxy) restent préservées dans les volumes Docker.

### Relancer le service

```bash
docker compose up -d
```

> L'option `--build` n'est pas nécessaire, sauf si vous avez modifié le code source du proxy.

### Arrêter uniquement le proxy (garder Karakeep actif)

Si vous devez libérer des ressources tout en maintenant Karakeep en fonctionnement, vous pouvez arrêter seulement le proxy et pointer directement Karakeep vers un fournisseur :

```bash
docker compose stop ai-proxy
make use-groq    # ou use-gemini / use-ollama
```

Pour réactiver le proxy ultérieurement :

```bash
docker compose start ai-proxy
make use-proxy
```

## Limites suggérées (palier gratuit) — à vérifier sur chaque tableau de bord

> ⚠️ Ces valeurs sont des estimations. Les limites réelles varient en fonction de votre offre et du modèle utilisé. **Vérifiez-les sur votre tableau de bord avant toute utilisation en production.**

| Fournisseur | Modèle | RPM | TPM | TPD | ~marque-pages/jour |
|---|---|---|---|---|---|
| Groq | `openai/gpt-oss-20b` | 30 | 14 400 | 200 000 | ~80 |
| Gemini | `gemini-3.5-flash` | 15 | 1 000 000 | illimité | ~400+ |
| Ollama | `qwen2.5:7b` | ∞ | ∞ | ∞ | ∞ |

- Groq : [console.groq.com/settings/limits](https://console.groq.com/settings/limits)
- Gemini : [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)

## Coordination avec Ollama

Le proxy détecte automatiquement lorsque l'heure se situe en dehors de la plage horaire `ACTIVE_HOURS_START–ACTIVE_HOURS_END` et route les requêtes vers Ollama. Aucune tâche cron ni commande `make use-ollama` n'est requise.

Si vous souhaitez contourner complètement le proxy (urgence, débogage) :

```bash
make use-ollama   # Karakeep pointe directement vers Ollama sans passer par le proxy
make use-proxy    # Rétablit l'utilisation du proxy
```

## Enrichissement des tags et taxonomie (`tagEnricher`)

Le proxy intercepte de manière transparente les requêtes d'étiquetage automatique envoyées par Karakeep (`/v1/chat/completions`) et injecte la liste maîtresse des tags canoniques (`canonical_tags.json`), accompagnée de directives rigoureuses de catégorisation et de cadrage thématique.

### Propriétés du système d'étiquetage :

1. **Structure obligatoire à 2 niveaux avec quotas fixes (exactement 5 tags)** :
   - **Niveau général (exactement 2 tags)** : Concepts généraux issus de la liste canonique préexistante (`canonical_tags.json`, ~800 tags). Ils servent à la classification et à la recherche globale (ex. `marxismo`, `economia`, `cine`).
   - **Niveau spécifique (exactement 3 tags)** : Descendent d'un cran conceptuel par rapport au niveau général en désignant le sous-thème, le cas d'étude, l'auteur, le pays, l'événement ou le mécanisme concret analysé dans le texte (ex. si le niveau général est `marxismo`, le niveau spécifique peut être `teoria-del-valor`, `debate-partido-sindicato` ou `acumulacion-por-desposesion`).
   - Le quota fixe (2 + 3 = 5) évite que les modèles légers (comme ceux de Groq, Gemini Flash ou Llama sur Cloudflare) ne choisissent la solution de facilité en renvoyant uniquement des catégories parapluies trop larges.

2. **Résolution de contradiction sur la règle de spécificité** :
   - Le LLM reçoit la consigne explicite que l'existence d'un concept général dans la liste maîtresse **l'exempte uniquement d'inventer un tag général redondant**, mais **ne l'exempte jamais de générer les 3 tags spécifiques de niveau 2**. Cela évite que la normalisation ne bloque la création de tags détaillés.

3. **Neutralité de posture et anti-biais nominal (*Stance Neutrality*)** :
   - Chaque étiquette reflète la thèse que l'article **défend ou soutient concrètement**, contournant le biais statistique courant des LLMs consistant à attribuer le terme nominal ou « neutre » d'un concept à des textes qui le critiquent.
   - Si un article critique, réfute ou remet en question un concept (ex. philanthropie, libre marché, méritocratie), le tag doit refléter cette critique — via un terme établi (ex. `filantrocapitalismo`) ou descriptif (ex. `critica-meritocracia`, `precarizacion-laboral`) — plutôt que d'employer le nom affirmatif ou neutre (`filantropia`), qui laisserait faussement supposer une posture favorable.

4. **Normalisation stricte (`kebab-case`)** :
   - Toutes les étiquettes sont obligatoirement formatées en minuscules et composées de mots séparés par des tirets, sans espaces ni caractères spéciaux (`#`, `'`, `"`).
   - `sanitizeTaggingResponse()` valide et nettoie de façon programmatique la réponse JSON du modèle avant transmission à Karakeep, garantissant une cohérence irréprochable en base de données.

5. **Injection complète de la liste canonique avec rechargement à chaud** :
   - Préserve la couverture et la cohérence de la taxonomie globale en injectant les ~800 tags canoniques à chaque requête.
   - Le fichier est mis en cache mémoire et vérifie son horodatage de modification (`mtime`) toutes les 10 secondes pour se recharger automatiquement en cas de mise à jour, sans redémarrage de conteneur.

## Structure du projet

```
ai-proxy/
├── src/
│   ├── config.ts                    # Lecture et validation des variables d'environnement
│   ├── logger.ts                    # Logger par niveaux
│   ├── index.ts                     # Point d'entrée, Express, arrêt gracieux
│   ├── providers/
│   │   ├── types.ts                 # Interfaces et énumérations
│   │   ├── rateLimiter.ts           # Fenêtre glissante RPM/TPM + TPD quotidien
│   │   └── providerManager.ts       # Machine à états Groq/Gemini/Ollama
│   ├── proxy/
│   │   ├── forwardRequest.ts        # Acheminement HTTP + réécriture du modèle
│   │   ├── handler.ts               # Gestionnaire Express + purge de la file
│   │   └── tagEnricher.ts           # Intercepteur et injecteur de tags canoniques
│   ├── queue/
│   │   └── requestQueue.ts          # File FIFO avec persistance JSON sur disque
│   ├── routes/
│   │   └── status.ts                # GET /status + GET /health
│   └── tests/
│       ├── rateLimiter.test.ts
│       ├── activeHours.test.ts
│       ├── providerManager.test.ts
│       └── tagEnricher.test.ts
├── .env.example
├── Dockerfile
├── package.json
└── tsconfig.json
```

## Développement local (sans Docker)

```bash
cd ai-proxy
pnpm install
cp .env.example .env
# Éditer .env
pnpm run build
node dist/index.js
```

## Tests

```bash
cd ai-proxy
pnpm test
```
