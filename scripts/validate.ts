// Validation de tout le catalogue de connecteurs.
//
//   bun run scripts/validate.ts [dossier]
//
// La structure des fichiers est vérifiée avec les schémas JSON de schema/
// (ajv, JSON Schema 2020-12) ; les règles croisées (catégorie connue, image
// épinglée, variables uniques, showIf, default, scripts...) sont vérifiées ici.
// `validateCatalog(dir)` ne modifie rien et ne termine pas le processus :
// elle rend la liste des erreurs et le catalogue lu.

import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject, ValidateFunction } from "ajv";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CatalogError {
  /** Chemin du fichier fautif, relatif au dossier du catalogue. */
  file: string;
  message: string;
}

export type JsonObject = Record<string, unknown>;

export interface CatalogConnector {
  /** Nom du dossier du connecteur. */
  dir: string;
  fiche: JsonObject;
  /** Contenu du script déclaré par la fiche, s'il existe. */
  scriptContent?: string;
}

export interface CatalogData {
  categories: JsonObject[];
  credentials: JsonObject[];
  connectors: CatalogConnector[];
}

export interface ValidationResult {
  errors: CatalogError[];
  catalog: CatalogData;
}

const SCHEMA_DIR = resolve(import.meta.dir, "..", "schema");

/** Tags qui désignent une image mouvante, quel que soit leur nom. */
const FLOATING_TAGS = new Set(["latest", "stable", "edge", "main", "master", "nightly", "dev", "current", "lts", "rolling"]);

// ---------------------------------------------------------------------------
// Schémas

interface Validators {
  fiche: ValidateFunction;
  credential: ValidateFunction;
  categories: ValidateFunction;
}

let validators: Validators | undefined;

function loadValidators(): Validators {
  if (validators) return validators;
  const ajv = new Ajv2020({ allErrors: true, verbose: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
  // « x-message » : message d'erreur en clair porté par le schéma lui-même.
  ajv.addKeyword({ keyword: "x-message", schemaType: "string" });
  const compile = (name: string) => ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")));
  validators = {
    fiche: compile("fiche.schema.json"),
    credential: compile("credential.schema.json"),
    categories: compile("categories.schema.json"),
  };
  return validators;
}

/** `/parameters/0/env` → `parameters[0].env` */
function prettyPath(instancePath: string): string {
  let out = "";
  for (const raw of instancePath.split("/").slice(1)) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    out += /^\d+$/.test(part) ? `[${part}]` : out ? `.${part}` : part;
  }
  return out;
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function describeSchemaError(error: ErrorObject): string | undefined {
  const path = prettyPath(error.instancePath);
  const at = path ? `${path} : ` : "";
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "if":
      return undefined; // doublon : les erreurs de then/else sont déjà listées
    case "additionalProperties":
      return `${at}clé inconnue « ${String(params.additionalProperty)} »`;
    case "unevaluatedProperties":
      return `${at}clé inconnue ou non permise pour ce type « ${String(params.unevaluatedProperty)} »`;
    case "required":
      return `${at}champ obligatoire manquant « ${String(params.missingProperty)} »`;
  }
  const parent = error.parentSchema as Record<string, unknown> | undefined;
  const custom = parent?.["x-message"];
  if (typeof custom === "string") return `${at}${custom} (reçu : ${show(error.data)})`;
  switch (error.keyword) {
    case "type":
      return `${at}type attendu : ${[params.type].flat().join(" ou ")} (reçu : ${show(error.data)})`;
    case "enum":
      return `${at}valeur non permise ${show(error.data)} ; attendu : ${(params.allowedValues as unknown[]).map(show).join(", ")}`;
    case "const":
      return `${at}doit valoir ${show(params.allowedValue)} (reçu : ${show(error.data)})`;
    case "minLength":
      return `${at}ne doit pas être vide`;
    case "minItems":
    case "minProperties":
      return `${at}doit contenir au moins ${String(params.limit)} élément(s)`;
    case "uniqueItems":
      return `${at}contient des doublons`;
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
      return `${at}doit être ${String(params.comparison)} ${String(params.limit)} (reçu : ${show(error.data)})`;
    case "pattern":
      return `${at}ne respecte pas le motif ${String(params.pattern)} (reçu : ${show(error.data)})`;
    default:
      return `${at}${error.message ?? error.keyword}`;
  }
}

/** Applique un schéma ; rend true si la structure est conforme. */
function checkSchema(validate: ValidateFunction, data: unknown, file: string, errors: CatalogError[]): boolean {
  if (validate(data)) return true;
  const seen = new Set<string>();
  for (const error of validate.errors ?? []) {
    const message = describeSchemaError(error);
    if (!message || seen.has(message)) continue;
    seen.add(message);
    errors.push({ file, message });
  }
  return false;
}

// ---------------------------------------------------------------------------
// Outils

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(dir: string, file: string, errors: CatalogError[]): unknown {
  let text: string;
  try {
    text = readFileSync(join(dir, file), "utf8");
  } catch {
    errors.push({ file, message: "fichier introuvable ou illisible" });
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    errors.push({ file, message: `JSON invalide : ${(cause as Error).message}` });
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Vérifie la syntaxe d'un script avec `sh -n` ; rend le message d'erreur, ou undefined. */
function shellSyntaxError(path: string): string | undefined {
  const run = spawnSync("sh", ["-n", path], { encoding: "utf8" });
  if (run.error) return `impossible de lancer sh -n : ${run.error.message}`;
  if (run.status === 0) return undefined;
  return `script refusé par sh -n : ${(run.stderr || run.stdout || "").trim().split("\n")[0] ?? ""}`;
}

/**
 * Vérifie qu'une référence d'image est épinglée : digest sha256, ou tag qui
 * commence par un numéro de version précis (au moins majeur.mineur).
 * Rend le message d'erreur, ou undefined si l'image convient.
 */
export function imagePinError(image: string): string | undefined {
  if (image.trim() !== image || /\s/.test(image) || image === "") {
    return `image invalide ${show(image)}`;
  }
  const at = image.indexOf("@");
  if (at !== -1) {
    return /^sha256:[a-f0-9]{64}$/.test(image.slice(at + 1))
      ? undefined
      : `image ${show(image)} : digest invalide, attendu @sha256:<64 caractères hexadécimaux>`;
  }
  const lastSegment = image.slice(image.lastIndexOf("/") + 1);
  const colon = lastSegment.indexOf(":");
  if (colon === -1) {
    return `image ${show(image)} sans tag : épingler une version précise (exemple : nom:1.2.3) ou un digest`;
  }
  const tag = lastSegment.slice(colon + 1);
  if (FLOATING_TAGS.has(tag.toLowerCase())) {
    return `image ${show(image)} : le tag « ${tag} » n'est pas épinglé ; utiliser une version précise ou un digest`;
  }
  if (!/^v?\d+\.\d+/.test(tag)) {
    return `image ${show(image)} : le tag « ${tag} » n'est pas une version précise (au moins majeur.mineur, exemple : 17.2-alpine) ; sinon utiliser un digest`;
  }
  return undefined;
}

function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.map((option) => (isObject(option) ? String(option.value) : String(option)));
}

/** Vérifie que `default` a le type du paramètre ; rend le message d'erreur, ou undefined. */
function defaultError(parameter: JsonObject): string | undefined {
  const value = parameter.default;
  switch (parameter.type) {
    case "text":
    case "code":
    case "sql":
      return typeof value === "string" ? undefined : "default doit être une chaîne";
    case "boolean":
      return typeof value === "boolean" ? undefined : "default doit être un booléen";
    case "number": {
      if (typeof value !== "number") return "default doit être un nombre";
      if (typeof parameter.min === "number" && value < parameter.min) return `default (${value}) est inférieur à min (${parameter.min})`;
      if (typeof parameter.max === "number" && value > parameter.max) return `default (${value}) est supérieur à max (${parameter.max})`;
      return undefined;
    }
    case "choice": {
      const values = optionValues(parameter.options);
      return typeof value === "string" && values.includes(value)
        ? undefined
        : `default ${show(value)} ne fait pas partie des options (${values.join(", ")})`;
    }
    case "pairs":
      return isObject(value) && Object.values(value).every((item) => typeof item === "string")
        ? undefined
        : "default doit être un objet dont les valeurs sont des chaînes";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Règles croisées d'une fiche

function checkFiche(
  dir: string,
  folder: string,
  fiche: JsonObject,
  categoryIds: Set<string>,
  credentialFields: Map<string, Set<string>>,
  errors: CatalogError[],
): string | undefined {
  const file = `connectors/${folder}/fiche.json`;
  const fail = (message: string) => errors.push({ file, message });

  if (fiche.id !== folder) {
    fail(`id ${show(fiche.id)} différent du nom du dossier « ${folder} »`);
  }
  if (!categoryIds.has(String(fiche.category))) {
    fail(`catégorie inconnue ${show(fiche.category)} ; catégories de categories.json : ${[...categoryIds].join(", ")}`);
  }
  if (typeof fiche.image === "string") {
    const message = imagePinError(fiche.image);
    if (message) fail(message);
  }

  // Paramètres : clés uniques, default, options, showIf.
  const parameters = (fiche.parameters as JsonObject[]) ?? [];
  const byKey = new Map<string, JsonObject>();
  for (const parameter of parameters) {
    const key = String(parameter.key);
    if (byKey.has(key)) fail(`paramètre « ${key} » déclaré deux fois`);
    byKey.set(key, parameter);
  }
  for (const parameter of parameters) {
    const key = String(parameter.key);
    if (parameter.type === "choice") {
      const values = optionValues(parameter.options);
      if (new Set(values).size !== values.length) fail(`paramètre « ${key} » : options en double`);
    }
    if (typeof parameter.min === "number" && typeof parameter.max === "number" && parameter.min > parameter.max) {
      fail(`paramètre « ${key} » : min est supérieur à max`);
    }
    if ("default" in parameter) {
      const message = defaultError(parameter);
      if (message) fail(`paramètre « ${key} » : ${message}`);
    }
    if (isObject(parameter.showIf)) {
      for (const [target, expected] of Object.entries(parameter.showIf)) {
        const other = byKey.get(target);
        if (!other) {
          fail(`paramètre « ${key} » : showIf référence le paramètre « ${target} », qui n'existe pas`);
          continue;
        }
        if (target === key) {
          fail(`paramètre « ${key} » : showIf ne peut pas référencer le paramètre lui-même`);
          continue;
        }
        if (other.type === "choice") {
          const values = optionValues(other.options);
          for (const value of [expected].flat()) {
            if (!values.includes(String(value))) {
              fail(`paramètre « ${key} » : showIf attend ${show(value)}, qui n'est pas une option de « ${target} »`);
            }
          }
        }
      }
    }
  }

  // Identifiant : type connu, champs existants.
  const credential = fiche.credential;
  const credentialEnv: [string, string][] = [];
  if (isObject(credential)) {
    const fields = credentialFields.get(String(credential.type));
    if (!fields) {
      fail(`type d'identifiant inconnu ${show(credential.type)} ; types de credentials/ : ${[...credentialFields.keys()].join(", ")}`);
    }
    for (const [field, env] of Object.entries((credential.env as JsonObject) ?? {})) {
      if (fields && !fields.has(field)) {
        fail(`identifiant : le champ « ${field} » n'existe pas dans le type « ${String(credential.type)} » (champs : ${[...fields].join(", ")})`);
      }
      credentialEnv.push([`champ d'identifiant « ${field} »`, String(env)]);
    }
  }

  // Une variable d'environnement ne porte qu'une seule valeur.
  const owners = new Map<string, string>();
  const claim = (owner: string, env: unknown) => {
    if (typeof env !== "string") return;
    const previous = owners.get(env);
    if (previous) fail(`variable ${env} utilisée deux fois : ${previous} et ${owner}`);
    else owners.set(env, owner);
  };
  for (const parameter of parameters) claim(`paramètre « ${String(parameter.key)} »`, parameter.env);
  for (const [owner, env] of credentialEnv) claim(owner, env);

  // Sorties : clés uniques.
  const outputs = new Set<string>();
  for (const output of (fiche.outputs as JsonObject[]) ?? []) {
    const key = String(output.key);
    if (outputs.has(key)) fail(`sortie « ${key} » déclarée deux fois`);
    outputs.add(key);
  }

  // Connecteur « custom » : l'image vient d'un paramètre obligatoire.
  if (fiche.kind === "custom") {
    const image = byKey.get("image");
    if (!image || image.type !== "text" || image.required !== true) {
      fail("un connecteur « custom » doit avoir un paramètre « image » de type text, obligatoire");
    }
  }

  // Script : présent et syntaxiquement valide.
  if (typeof fiche.script === "string") {
    const path = join(dir, "connectors", folder, fiche.script);
    if (!existsSync(path) || isDirectory(path)) {
      fail(`script « ${fiche.script} » déclaré mais absent du dossier`);
      return undefined;
    }
    const message = shellSyntaxError(path);
    if (message) errors.push({ file: `connectors/${folder}/${fiche.script}`, message });
    return readFileSync(path, "utf8");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Catalogue

/**
 * Valide le catalogue situé dans `dir` (categories.json, credentials/,
 * connectors/, lib/). Ne modifie rien ; rend les erreurs et les données lues.
 */
export function validateCatalog(dir: string): ValidationResult {
  const root = resolve(dir);
  const schemas = loadValidators();
  const errors: CatalogError[] = [];
  const catalog: CatalogData = { categories: [], credentials: [], connectors: [] };

  // Catégories.
  const categoryIds = new Set<string>();
  const categoriesDoc = readJson(root, "categories.json", errors);
  if (categoriesDoc !== undefined && checkSchema(schemas.categories, categoriesDoc, "categories.json", errors)) {
    const orders = new Set<number>();
    for (const category of (categoriesDoc as { categories: JsonObject[] }).categories) {
      const id = String(category.id);
      if (categoryIds.has(id)) errors.push({ file: "categories.json", message: `catégorie « ${id} » déclarée deux fois` });
      if (orders.has(category.order as number)) {
        errors.push({ file: "categories.json", message: `catégorie « ${id} » : order ${String(category.order)} déjà utilisé` });
      }
      categoryIds.add(id);
      orders.add(category.order as number);
      catalog.categories.push(category);
    }
  }

  // Types d'identifiants.
  const credentialFields = new Map<string, Set<string>>();
  const credentialsDir = join(root, "credentials");
  if (isDirectory(credentialsDir)) {
    for (const name of readdirSync(credentialsDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = `credentials/${name}`;
      const doc = readJson(root, file, errors);
      if (doc === undefined || !checkSchema(schemas.credential, doc, file, errors)) continue;
      const credential = doc as JsonObject;
      const type = String(credential.type);
      if (`${type}.json` !== name) {
        errors.push({ file, message: `type ${show(type)} différent du nom du fichier « ${name} »` });
      }
      const keys = new Set<string>();
      for (const field of credential.fields as JsonObject[]) {
        const key = String(field.key);
        if (keys.has(key)) errors.push({ file, message: `champ « ${key} » déclaré deux fois` });
        keys.add(key);
        if ("default" in field) {
          if (field.kind === "secret") {
            errors.push({ file, message: `champ « ${key} » : un secret ne peut pas avoir de valeur par défaut` });
          } else {
            const expected = field.kind === "text" ? "string" : String(field.kind);
            if (typeof field.default !== expected) {
              errors.push({ file, message: `champ « ${key} » : default doit être de type ${expected}` });
            }
          }
        }
      }
      credentialFields.set(type, keys);
      catalog.credentials.push(credential);
    }
  }

  // Connecteurs.
  const connectorsDir = join(root, "connectors");
  const seenIds = new Map<string, string>();
  if (isDirectory(connectorsDir)) {
    for (const folder of readdirSync(connectorsDir).sort()) {
      if (!isDirectory(join(connectorsDir, folder))) continue;
      const file = `connectors/${folder}/fiche.json`;
      if (!existsSync(join(root, file))) {
        errors.push({ file, message: "fiche.json manquant dans le dossier du connecteur" });
        continue;
      }
      const doc = readJson(root, file, errors);
      if (doc === undefined) continue;
      if (!checkSchema(schemas.fiche, doc, file, errors)) {
        // Structure invalide : les règles croisées ne sont appliquées que sur ce qui est sûr.
        if (isObject(doc) && typeof doc.id === "string" && doc.id !== folder) {
          errors.push({ file, message: `id ${show(doc.id)} différent du nom du dossier « ${folder} »` });
        }
        if (isObject(doc) && typeof doc.image === "string") {
          const message = imagePinError(doc.image);
          if (message) errors.push({ file, message });
        }
        continue;
      }
      const fiche = doc as JsonObject;
      const id = String(fiche.id);
      const previous = seenIds.get(id);
      if (previous) errors.push({ file, message: `id « ${id} » déjà utilisé par ${previous}` });
      else seenIds.set(id, file);
      const scriptContent = checkFiche(root, folder, fiche, categoryIds, credentialFields, errors);
      catalog.connectors.push(scriptContent === undefined ? { dir: folder, fiche } : { dir: folder, fiche, scriptContent });
    }
  }

  // Aide shell commune.
  const lib = join(root, "lib", "poad-step.sh");
  if (existsSync(lib)) {
    const message = shellSyntaxError(lib);
    if (message) errors.push({ file: "lib/poad-step.sh", message });
  }

  return { errors, catalog };
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? join(import.meta.dir, ".."));
  const { errors, catalog } = validateCatalog(dir);
  for (const error of errors) console.error(`${error.file}: ${error.message}`);
  if (errors.length > 0) {
    console.error(`\n${errors.length} erreur(s) dans le catalogue.`);
    process.exit(1);
  }
  console.log(
    `Catalogue valide : ${catalog.connectors.length} connecteur(s), ${catalog.credentials.length} type(s) d'identifiant, ${catalog.categories.length} catégorie(s).`,
  );
}
