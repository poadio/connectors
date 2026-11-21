// Produit dist/catalog.json : tout le catalogue en un seul fichier.
//
//   bun run scripts/build-index.ts
//
// La sortie est déterministe : catégories triées par `order`, types
// d'identifiants par `type`, connecteurs par `id`, aucun horodatage. Deux
// constructions du même dépôt donnent le même fichier, à l'octet près.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateCatalog, type CatalogError, type JsonObject } from "./validate.ts";

export interface CatalogIndex {
  version: 1;
  categories: JsonObject[];
  credentials: JsonObject[];
  /** Fiches, avec `scriptContent` quand la fiche déclare un script. */
  connectors: JsonObject[];
  /** Fichiers communs montés dans chaque conteneur (nom → contenu). */
  lib: Record<string, string>;
}

export class InvalidCatalogError extends Error {
  constructor(readonly errors: CatalogError[]) {
    super(`catalogue invalide : ${errors.length} erreur(s)`);
  }
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Construit l'index du catalogue situé dans `dir`. Lève InvalidCatalogError s'il est invalide. */
export function buildCatalog(dir: string): CatalogIndex {
  const { errors, catalog } = validateCatalog(dir);
  if (errors.length > 0) throw new InvalidCatalogError(errors);
  return {
    version: 1,
    categories: [...catalog.categories].sort((a, b) => Number(a.order) - Number(b.order)),
    credentials: [...catalog.credentials].sort((a, b) => byText(String(a.type), String(b.type))),
    connectors: [...catalog.connectors]
      .sort((a, b) => byText(String(a.fiche.id), String(b.fiche.id)))
      .map(({ fiche, scriptContent }) => (scriptContent === undefined ? { ...fiche } : { ...fiche, scriptContent })),
    lib: { "poad-step.sh": readFileSync(join(dir, "lib", "poad-step.sh"), "utf8") },
  };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  try {
    const index = buildCatalog(root);
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "catalog.json"), `${JSON.stringify(index, null, 2)}\n`);
    console.log(`dist/catalog.json écrit : ${index.connectors.length} connecteur(s).`);
  } catch (cause) {
    if (!(cause instanceof InvalidCatalogError)) throw cause;
    for (const error of cause.errors) console.error(`${error.file}: ${error.message}`);
    console.error(`\n${cause.message}`);
    process.exit(1);
  }
}
