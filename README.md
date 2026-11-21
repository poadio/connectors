# Connecteurs poad

Catalogue déclaratif des connecteurs des *flows* poad.

Un flow enchaîne des étapes ; chaque étape lourde est un conteneur Docker indépendant, qui peut tourner en local, sur Fly, Kubernetes ou Scaleway. Ce dépôt ne contient pas de moteur : il décrit, une fiche par connecteur, **comment exécuter** l'étape (image épinglée, paramètres, identifiant, ressources) et **comment dessiner son formulaire** dans l'éditeur. Le moteur n'a aucun code propre à un connecteur : tout ce qu'il sait d'un connecteur est dans sa fiche.

```
categories.json              groupes de la palette de l'éditeur
credentials/<type>.json      types d'identifiants
connectors/<id>/fiche.json   fiche du connecteur (+ run.sh si besoin)
lib/poad-step.sh             aide shell commune, montée dans chaque conteneur
schema/*.schema.json         schémas JSON (2020-12) des trois sortes de fichiers
scripts/validate.ts          validation de tout le catalogue
scripts/build-index.ts       produit dist/catalog.json
test/catalog.test.ts         tests
```

## Commandes

```sh
bun install
bun run validate   # vérifie tout le catalogue, liste chaque erreur avec son fichier, sort en 1 s'il y en a
bun test           # tests du validateur, de l'index et de lib/poad-step.sh
bun run build      # écrit dist/catalog.json
```

`dist/catalog.json` réunit tout le catalogue en un fichier : `{ version, categories, credentials, connectors, lib }`. Chaque connecteur est sa fiche, plus `scriptContent` (le texte du script) quand elle en déclare un ; `lib` contient `poad-step.sh`. Les catégories sont triées par `order`, les identifiants par `type`, les connecteurs par `id`, et le fichier ne porte aucun horodatage : deux constructions du même dépôt sont identiques à l'octet près.

## Connecteurs fournis

| id | catégorie | image | rôle |
| --- | --- | --- | --- |
| `http-request` | internet | `curlimages/curl:8.11.1` | requête HTTP, rend code, en-têtes et corps |
| `postgres` | database | `postgres:17.2-alpine` | requête SQL, rend les lignes en JSON |
| `mediainfo` | video | `alpine:3.20.3` | durée, codec et dimensions d'un média (**provisoire**, voir plus bas) |
| `custom-image` | code | choisie par l'utilisateur | n'importe quelle image Docker |

## Fiche d'un connecteur

`connectors/<id>/fiche.json`, en JSON strict (pas de commentaires). Exemple abrégé :

```json
{
  "id": "http-request",
  "version": "1.0.0",
  "name": "Requête HTTP",
  "description": "Appelle une adresse HTTP ou HTTPS et rend le code, les en-têtes et le corps de la réponse.",
  "category": "internet",
  "tags": ["api", "téléchargement"],
  "image": "curlimages/curl:8.11.1",
  "script": "run.sh",
  "command": ["sh", "/poad/run.sh"],
  "parameters": [
    { "key": "url", "label": "Adresse", "type": "text", "required": true, "env": "HTTP_URL", "placeholder": "https://…" },
    { "key": "method", "label": "Méthode", "type": "choice", "options": ["GET", "POST"], "default": "GET", "env": "HTTP_METHOD" },
    { "key": "body", "label": "Corps", "type": "code", "language": "json", "env": "HTTP_BODY", "showIf": { "method": ["POST"] } }
  ],
  "credential": { "type": "http-header", "required": false, "env": { "name": "HTTP_AUTH_HEADER", "value": "HTTP_AUTH_VALUE" } },
  "outputs": [{ "key": "status", "type": "number", "description": "Code HTTP" }],
  "produces": ["file"],
  "resources": { "cpu": 0.5, "memory": "256Mi" },
  "timeout": 300
}
```

| champ | obligatoire | règle |
| --- | --- | --- |
| `id` | oui | égal au nom du dossier ; `^[a-z][a-z0-9-]{0,62}$` ; unique |
| `version` | oui | semver strict (`1.0.0`, `1.2.0-beta.1`) |
| `name`, `description` | oui | texte affiché dans la palette ; `description` tient en une phrase |
| `category` | oui | `id` d'une catégorie de `categories.json` |
| `tags` | non | mots-clés pour la recherche |
| `kind` | non | `image` (défaut) ou `custom` |
| `image` | oui | image **épinglée** (voir ci-dessous) ; `null` uniquement avec `kind: "custom"` |
| `script` | non | fichier du dossier du connecteur, monté en `/poad/run.sh` |
| `command` | non | commande du conteneur ; par défaut `["sh", "/poad/run.sh"]` s'il y a un script, sinon la commande de l'image. Le point d'entrée de l'image est conservé |
| `parameters` | oui | champs du formulaire (liste éventuellement vide) |
| `credential` | non | identifiant utilisé par l'étape |
| `outputs` | non | clés du résultat : `key`, `type` (`string`, `number`, `boolean`, `object`, `array`), `description` |
| `produces` | non | `["file"]` si l'étape peut déposer des fichiers |
| `resources` | oui | `cpu` (cœurs, fraction permise) et `memory` (`256Mi`, `2Gi`) |
| `timeout` | oui | durée maximale, en secondes |

Aucune autre clé n'est acceptée.

### Image épinglée

Une étape doit donner le même résultat demain qu'aujourd'hui : l'image est donc toujours épinglée.

- accepté : un tag qui commence par une version précise, au moins `majeur.mineur` (`8.11.1`, `17.2-alpine`, `v1.4.2`), ou un digest (`nom@sha256:…`, `nom:tag@sha256:…`) ;
- refusé : pas de tag, `latest`, `stable`, `edge`…, ou une version vague (`postgres:17`, `node:lts-alpine`).

Un tag reste déplaçable par celui qui publie l'image ; seul le digest est immuable. Pour une image dont le tag n'a pas de numéro de version, utiliser le digest.

Avant d'ajouter une image, vérifier qu'elle existe : `docker manifest inspect <image>`.

### Paramètres

Chaque paramètre a une `key` (`^[a-z][a-z0-9_]*$`, unique dans la fiche), un `label`, un `type`, et un `env` : le nom de la variable d'environnement qui porte sa valeur dans le conteneur. Facultatifs : `required`, `default`, `help`, `placeholder`, `showIf`.

| type | champ du formulaire | clés propres | valeur dans la variable |
| --- | --- | --- | --- |
| `text` | ligne de texte | | le texte |
| `number` | nombre | `min`, `max` | écriture décimale (`1000`, `0.5`) |
| `boolean` | case à cocher | | `true` ou `false` |
| `choice` | liste | `options` : chaînes ou `{ "value", "label" }` | la valeur choisie |
| `code` | éditeur de code | `language` | le texte |
| `sql` | éditeur SQL | | le texte |
| `pairs` | liste clé / valeur | | objet JSON de chaînes : `{"Accept":"text/csv"}` |

Un paramètre facultatif laissé vide et sans `default` n'est pas transmis : sa variable est absente. Les scripts traitent une variable vide comme absente.

`default` doit être du type du paramètre (pour `choice`, une des options ; pour `number`, entre `min` et `max` ; pour `pairs`, un objet de chaînes).

`showIf` n'affiche le champ que si d'autres paramètres ont certaines valeurs : `{ "method": ["POST", "PUT"] }` ou `{ "mode": "rows" }`. Chaque clé citée doit être un paramètre de la fiche ; si c'est un `choice`, les valeurs doivent être de ses options.

### Variables d'environnement

Un nom de variable respecte `^[A-Z][A-Z0-9_]*$`. Sont interdits :

- tout nom qui commence par `POAD_` (réservé au moteur) ;
- `PATH`, `HOME`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `IFS` (ils changeraient le comportement du conteneur).

Deux paramètres, ou un paramètre et un champ d'identifiant, ne peuvent pas viser la même variable.

### Connecteur « custom »

`custom-image` est l'étape « n'importe quelle image Docker ». C'est le seul cas où une fiche n'a pas d'image : `"kind": "custom"` et `"image": null`. Ses paramètres `image`, `command` et `env` sont lus par le moteur lui-même, ils n'ont donc pas de variable `env`. Une fiche `custom` ne peut déclarer ni `script`, ni `command`, ni `credential`, et doit avoir un paramètre `image` de type `text`, obligatoire.

## Types d'identifiants

`credentials/<type>.json` :

```json
{
  "type": "postgres",
  "name": "PostgreSQL",
  "fields": [
    { "key": "host", "label": "Hôte", "kind": "text", "required": true },
    { "key": "port", "label": "Port", "kind": "number", "required": true, "default": 5432 },
    { "key": "password", "label": "Mot de passe", "kind": "secret", "required": true }
  ]
}
```

`kind` vaut `text`, `number`, `boolean` ou `secret`. Un secret n'a jamais de valeur par défaut. `type` est égal au nom du fichier.

Types fournis : `postgres`, `mysql`, `s3`, `sftp`, `http-header`, `api-key`.

Dans une fiche, `credential.env` associe des clés de champs à des variables d'environnement (mêmes règles de nommage que les paramètres). Chaque clé doit exister dans le type. `credential.required` dit si l'étape peut tourner sans identifiant.

## Catégories

`categories.json` : `{ "version": 1, "categories": [{ "id", "label", "icon", "order" }] }`. `icon` est un nom d'icône [lucide](https://lucide.dev/icons/), `order` fixe l'ordre dans la palette.

## Contrat d'exécution

Le moteur lance le conteneur de l'étape avec :

- les **paramètres** dans leurs variables `env`, l'**identifiant** dans les siennes. Rien n'est jamais interpolé dans une commande shell : une valeur ne peut pas devenir du code ;
- `POAD_STEP_URL` : adresse de rappel de l'étape (`https://…/flows/v1/steps/<id>`) ;
- `POAD_STEP_TOKEN` : jeton à usage unique, valable pour cette seule étape ;
- `POAD_WORKDIR` (`/work`) : dossier de travail vide, où l'utilisateur de l'image doit pouvoir écrire ;
- `/poad/run.sh` (le script de la fiche) et `/poad/poad-step.sh` montés en lecture seule.

L'étape **rend son résultat en appelant poad**, pas par ses journaux :

```
POST $POAD_STEP_URL/result
Authorization: Bearer $POAD_STEP_TOKEN
Content-Type: application/json

{ "output": { … } }                  succès
{ "error": { "message": "…" } }      échec
```

- un code de sortie non nul sans rappel est un échec ;
- ce qui est écrit sur stdout et stderr est le journal de l'étape, jamais son résultat ;
- un fichier produit s'envoie par `PUT $POAD_STEP_URL/files/<nom>`, avec le même jeton ;
- un fichier d'une étape précédente arrive par un paramètre : son adresse.

### lib/poad-step.sh

Script POSIX `sh` à sourcer en tête de `run.sh`. Il n'a besoin que de `od`, `awk` et de `curl` (ou, à défaut, `wget`) ; pas de `jq`.

```sh
#!/bin/sh
set -eu
. /poad/poad-step.sh

[ -n "${DEMO_NAME:-}" ] || poad_fail "Le paramètre « name » est obligatoire."
poad_output "{\"greeting\":$(poad_json_string "Bonjour $DEMO_NAME")}"
```

| fonction | effet |
| --- | --- |
| `poad_output <json>` | envoie `{ "output": <json> }` |
| `poad_output_file <chemin>` | idem, la valeur JSON est lue dans un fichier (gros résultats) |
| `poad_fail <message>` | écrit le message dans le journal, envoie `{ "error": { "message": … } }`, sort en 1 |
| `poad_file <chemin> [nom]` | dépose un fichier ; le nom n'accepte que lettres, chiffres, `.`, `-`, `_` |
| `poad_json_string [texte]` | écrit le texte en chaîne JSON, guillemets compris ; sans argument, lit l'entrée standard |

Les fonctions d'envoi échouent avec un message clair si `POAD_STEP_URL` ou `POAD_STEP_TOKEN` manque, ou si poad ne répond pas 2xx. `poad_json_string` produit de l'ASCII pur : guillemets, antislash et caractères de contrôle sont échappés, les caractères non ASCII sont écrits en `\uXXXX`, un octet qui n'est pas de l'UTF-8 valide devient `�`.

Le `wget` de busybox ne sait faire que GET et POST : `poad_file` (PUT) demande une image qui contient `curl` ou GNU wget.

## Limites connues des connecteurs

**http-request**

- `body` est le corps en texte, tronqué à 256 Kio (`body_truncated`). Un corps qui contient des octets nuls est tenu pour binaire et n'est pas rendu (`body_binary`) ; `save_as` le dépose en fichier, entier.
- `body_json` n'est présent que si la réponse se déclare JSON, n'a pas été tronquée et est réellement du JSON en UTF-8 valide.
- Les en-têtes de réponse sont rendus en minuscules, sans les octets non ASCII ; un en-tête répété est réuni par une virgule.
- Un code ≥ 400 fait échouer l'étape, sauf `fail_on_error: false`.
- Les redirections ne sont suivies que sur demande ; les en-têtes ajoutés sont alors renvoyés à la nouvelle adresse (curl retient `Authorization` si l'hôte change).

**postgres**

- En mode `rows`, la requête est enveloppée dans une CTE et agrégée par `json_agg` : une seule instruction, qui rend des lignes (`SELECT`, `VALUES`, ou `INSERT` / `UPDATE` / `DELETE … RETURNING`). Pas de `WITH … INSERT/UPDATE/DELETE` imbriqué, pas de commentaire après le point-virgule final.
- Le résultat tient en mémoire : `max_rows` (1000 par défaut) le borne, `truncated` signale la coupe. Les valeurs suivent `json_agg` : un `bigint` ou un `numeric` au-delà de 2^53 perd en précision côté lecteur JSON, les dates sont des chaînes.
- Le mode `execute` lance le SQL tel quel dans une transaction et ne rend aucune ligne.

**mediainfo** — provisoire

Aucune image publique épinglée et crédible ne contient `mediainfo` en ligne de commande. La fiche part donc de `alpine:3.20.3` et installe l'outil au démarrage (`apk add --no-cache mediainfo`). Conséquences : l'étape a besoin du réseau, tourne en root, démarre plus lentement, et la version de mediainfo n'est pas épinglée (celle du dépôt Alpine 3.20). À remplacer par une image dédiée, construite et épinglée, dès qu'elle existe.

## Ajouter un connecteur

1. Créer `connectors/<id>/fiche.json`. L'`id` est le nom du dossier.
2. Choisir une image **épinglée** et vérifier qu'elle existe (`docker manifest inspect`).
3. Déclarer les paramètres, chacun avec sa variable `env`. Préfixer les variables par le nom du connecteur (`HTTP_URL`, `PG_SQL`) sauf quand l'outil lit lui-même une variable connue (`PGHOST`).
4. Si l'étape a besoin d'un identifiant, réutiliser un type de `credentials/` ou en ajouter un, puis associer ses champs à des variables dans `credential.env`.
5. Si l'image ne fait pas le travail seule, écrire `run.sh` et le déclarer dans `script`. Règles :
   - POSIX `sh`, pas de bashismes : le script doit passer `sh -n` et `shellcheck -s sh` ;
   - sourcer `/poad/poad-step.sh`, et toujours finir par `poad_output`, `poad_output_file` ou `poad_fail` ;
   - ne jamais construire une commande avec une valeur reçue (`eval`, `sh -c "… $VAR"`) : passer les valeurs en arguments entre guillemets, par un fichier ou par l'entrée standard ;
   - valider ce qui vient de l'utilisateur (schéma d'URL, nombres, noms de fichiers) et échouer avec un message lisible ;
   - ne pas écrire de secret dans le journal.
6. Lister les clés du résultat dans `outputs`, fixer `resources` et `timeout`.
7. `bun run validate && bun test`.

La CI (`.github/workflows/ci.yml`) rejoue `bun install`, `bun run validate` et `bun test` à chaque push et pull request.
