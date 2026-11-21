// Tests du catalogue : le catalogue réel est valide, les fiches invalides
// sont refusées avec un message explicite, l'index est déterministe, et
// lib/poad-step.sh parle bien le contrat d'exécution à un vrai serveur HTTP.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildCatalog } from "../scripts/build-index.ts";
import { imagePinError, validateCatalog } from "../scripts/validate.ts";

const ROOT = resolve(import.meta.dir, "..");
const LIB = join(ROOT, "lib", "poad-step.sh");

const scratch = mkdtempSync(join(tmpdir(), "poad-connectors-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Catalogue réel

describe("catalogue réel", () => {
  test("est valide", () => {
    const { errors, catalog } = validateCatalog(ROOT);
    expect(errors).toEqual([]);
    expect(catalog.connectors.map((connector) => connector.dir)).toEqual(["custom-image", "http-request", "mediainfo", "postgres"]);
    expect(catalog.credentials.map((credential) => credential.type)).toEqual(["api-key", "http-header", "mysql", "postgres", "s3", "sftp"]);
  });

  test("les catégories sont celles de la palette, dans l'ordre", () => {
    const { catalog } = validateCatalog(ROOT);
    const sorted = [...catalog.categories].sort((a, b) => Number(a.order) - Number(b.order));
    expect(sorted.map((category) => category.id)).toEqual(["trigger", "logic", "code", "internet", "database", "file", "video", "geo", "ai"]);
  });

  test("seul custom-image n'a pas d'image", () => {
    const { catalog } = validateCatalog(ROOT);
    const withoutImage = catalog.connectors.filter((connector) => connector.fiche.image === null);
    expect(withoutImage.map((connector) => connector.dir)).toEqual(["custom-image"]);
  });

  test("l'index est déterministe et embarque les scripts", () => {
    const first = buildCatalog(ROOT);
    const second = buildCatalog(ROOT);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.version).toBe(1);
    expect(first.connectors.map((connector) => connector.id)).toEqual(["custom-image", "http-request", "mediainfo", "postgres"]);
    const http = first.connectors.find((connector) => connector.id === "http-request");
    expect(String(http?.scriptContent)).toContain("poad_output_file");
    const custom = first.connectors.find((connector) => connector.id === "custom-image");
    expect(custom && "scriptContent" in custom).toBe(false);
    expect(first.lib["poad-step.sh"]).toContain("poad_fail()");
  });
});

// ---------------------------------------------------------------------------
// Fiches invalides, construites dans un dossier temporaire

type Fiche = Record<string, any>;

function baseFiche(): Fiche {
  return {
    id: "demo",
    version: "1.0.0",
    name: "Démo",
    description: "Connecteur de test.",
    category: "internet",
    image: "curlimages/curl:8.11.1",
    parameters: [
      { key: "url", label: "Adresse", type: "text", required: true, env: "DEMO_URL" },
      { key: "method", label: "Méthode", type: "choice", options: ["GET", "POST"], default: "GET", env: "DEMO_METHOD" },
      { key: "body", label: "Corps", type: "code", language: "json", env: "DEMO_BODY", showIf: { method: ["POST"] } },
    ],
    credential: { type: "http-header", required: false, env: { name: "DEMO_AUTH_NAME", value: "DEMO_AUTH_VALUE" } },
    outputs: [{ key: "status", type: "number", description: "Code HTTP" }],
    resources: { cpu: 0.5, memory: "256Mi" },
    timeout: 60,
  };
}

let counter = 0;

/** Crée un catalogue temporaire avec une seule fiche et rend les messages d'erreur. */
function errorsFor(mutate: (fiche: Fiche) => void, options: { folder?: string; files?: Record<string, string> } = {}): string[] {
  const dir = join(scratch, `cas-${++counter}`);
  const folder = options.folder ?? "demo";
  mkdirSync(join(dir, "connectors", folder), { recursive: true });
  cpSync(join(ROOT, "categories.json"), join(dir, "categories.json"));
  cpSync(join(ROOT, "credentials"), join(dir, "credentials"), { recursive: true });
  const fiche = baseFiche();
  mutate(fiche);
  writeFileSync(join(dir, "connectors", folder, "fiche.json"), JSON.stringify(fiche, null, 2));
  for (const [name, content] of Object.entries(options.files ?? {})) {
    writeFileSync(join(dir, "connectors", folder, name), content);
  }
  return validateCatalog(dir).errors.map((error) => `${error.file}: ${error.message}`);
}

describe("fiches invalides", () => {
  test("la fiche de base est valide", () => {
    expect(errorsFor(() => {})).toEqual([]);
  });

  const cases: [string, (fiche: Fiche) => void, RegExp][] = [
    ["image latest", (f) => (f.image = "curlimages/curl:latest"), /le tag « latest » n'est pas épinglé/],
    ["image sans tag", (f) => (f.image = "curlimages/curl"), /sans tag/],
    ["image sans tag derrière un registre avec port", (f) => (f.image = "registre.local:5000/outils/curl"), /sans tag/],
    ["image au tag trop vague", (f) => (f.image = "postgres:17"), /n'est pas une version précise/],
    ["image absente", (f) => delete f.image, /champ obligatoire manquant « image »/],
    ["image null sans kind custom", (f) => (f.image = null), /seul un connecteur de kind « custom »/],
    ["variable POAD_X", (f) => (f.parameters[0].env = "POAD_X"), /parameters\[0\]\.env : .*préfixe POAD_ est réservé/],
    ["variable PATH", (f) => (f.parameters[0].env = "PATH"), /parameters\[0\]\.env : nom de variable interdit/],
    ["variable LD_PRELOAD dans l'identifiant", (f) => (f.credential.env.value = "LD_PRELOAD"), /credential\.env\.value : nom de variable interdit/],
    ["variable en minuscules", (f) => (f.parameters[0].env = "demo_url"), /nom de variable invalide/],
    ["paramètre sans variable", (f) => delete f.parameters[0].env, /parameters\[0\] : champ obligatoire manquant « env »/],
    ["deux paramètres sur la même variable", (f) => (f.parameters[1].env = "DEMO_URL"), /variable DEMO_URL utilisée deux fois : paramètre « url » et paramètre « method »/],
    [
      "un paramètre et un champ d'identifiant sur la même variable",
      (f) => (f.credential.env.value = "DEMO_URL"),
      /variable DEMO_URL utilisée deux fois : paramètre « url » et champ d'identifiant « value »/,
    ],
    ["catégorie inconnue", (f) => (f.category = "cuisine"), /catégorie inconnue "cuisine"/],
    ["showIf sur une clé absente", (f) => (f.parameters[2].showIf = { verbe: ["POST"] }), /showIf référence le paramètre « verbe », qui n'existe pas/],
    ["showIf sur une valeur hors options", (f) => (f.parameters[2].showIf = { method: ["TRACE"] }), /"TRACE", qui n'est pas une option de « method »/],
    ["default hors options", (f) => (f.parameters[1].default = "TRACE"), /default "TRACE" ne fait pas partie des options/],
    ["default du mauvais type", (f) => (f.parameters[0].default = 12), /paramètre « url » : default doit être une chaîne/],
    [
      "default hors bornes",
      (f) => f.parameters.push({ key: "n", label: "N", type: "number", min: 1, max: 5, default: 9, env: "DEMO_N" }),
      /default \(9\) est supérieur à max \(5\)/,
    ],
    ["choice sans options", (f) => delete f.parameters[1].options, /parameters\[1\] : champ obligatoire manquant « options »/],
    ["version non semver", (f) => (f.version = "1.0"), /version invalide : semver strict/],
    ["version avec préfixe v", (f) => (f.version = "v1.0.0"), /version invalide : semver strict/],
    ["clé inconnue dans la fiche", (f) => (f.entrypoint = ["sh"]), /clé inconnue « entrypoint »/],
    ["clé inconnue dans un paramètre", (f) => (f.parameters[0].secret = true), /parameters\[0\] : clé inconnue.*« secret »/],
    ["options sur un paramètre text", (f) => (f.parameters[0].options = ["a"]), /parameters\[0\] : clé inconnue.*« options »/],
    ["type de paramètre inconnu", (f) => (f.parameters[0].type = "date"), /parameters\[0\]\.type : valeur non permise "date"/],
    ["identifiant d'un type inconnu", (f) => (f.credential.type = "oracle"), /type d'identifiant inconnu "oracle"/],
    ["champ d'identifiant inexistant", (f) => (f.credential.env = { token: "DEMO_TOKEN" }), /le champ « token » n'existe pas dans le type « http-header »/],
    ["id mal formé", (f) => (f.id = "Demo_1"), /id invalide/],
    ["paramètre déclaré deux fois", (f) => (f.parameters[1].key = "url"), /paramètre « url » déclaré deux fois/],
    ["mémoire mal écrite", (f) => (f.resources.memory = "256MB"), /memory invalide/],
    ["script déclaré mais absent", (f) => (f.script = "run.sh"), /script « run\.sh » déclaré mais absent/],
    ["script hors du dossier", (f) => (f.script = "../autre/run.sh"), /script invalide : simple nom de fichier/],
    ["custom avec une image", (f) => ((f.kind = "custom"), delete f.credential), /"image" doit valoir null/],
  ];

  for (const [name, mutate, expected] of cases) {
    test(name, () => {
      const errors = errorsFor(mutate);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join("\n")).toMatch(expected);
      expect(errors.every((error) => error.startsWith("connectors/demo/fiche.json: "))).toBe(true);
    });
  }

  test("id différent du dossier", () => {
    const errors = errorsFor((f) => (f.id = "autre"));
    expect(errors.join("\n")).toMatch(/id "autre" différent du nom du dossier « demo »/);
  });

  test("dossier sans fiche", () => {
    const dir = join(scratch, `cas-${++counter}`);
    mkdirSync(join(dir, "connectors", "vide"), { recursive: true });
    cpSync(join(ROOT, "categories.json"), join(dir, "categories.json"));
    const errors = validateCatalog(dir).errors;
    expect(errors).toEqual([{ file: "connectors/vide/fiche.json", message: "fiche.json manquant dans le dossier du connecteur" }]);
  });

  test("script à la syntaxe invalide", () => {
    const errors = errorsFor((f) => (f.script = "run.sh"), { files: { "run.sh": "#!/bin/sh\nif true; then\necho oubli du fi\n" } });
    expect(errors.join("\n")).toMatch(/connectors\/demo\/run\.sh: script refusé par sh -n/);
  });

  test("script valide accepté", () => {
    expect(errorsFor((f) => (f.script = "run.sh"), { files: { "run.sh": "#!/bin/sh\necho bonjour\n" } })).toEqual([]);
  });

  test("le cas custom sans image est accepté, et lui seul", () => {
    const custom = (f: Fiche) => {
      f.kind = "custom";
      f.image = null;
      delete f.credential;
      f.parameters = [{ key: "image", label: "Image", type: "text", required: true }];
    };
    expect(errorsFor(custom)).toEqual([]);
    expect(errorsFor((f) => (custom(f), (f.script = "run.sh"))).join("\n")).toMatch(/« custom » ne peut pas déclarer de script/);
    expect(errorsFor((f) => (custom(f), (f.parameters[0].env = "DEMO_IMAGE"))).join("\n")).toMatch(/pas de variable « env »/);
    expect(errorsFor((f) => (custom(f), (f.parameters = []))).join("\n")).toMatch(/doit avoir un paramètre « image »/);
  });
});

describe("imagePinError", () => {
  test("accepte les images épinglées", () => {
    for (const image of [
      "curlimages/curl:8.11.1",
      "postgres:17.2-alpine",
      "alpine:3.20.3",
      "ghcr.io/org/outil:v1.4.2",
      "registre.local:5000/outils/curl:8.11.1",
      `alpine@sha256:${"a".repeat(64)}`,
      `alpine:3.20.3@sha256:${"0".repeat(64)}`,
    ]) {
      expect(imagePinError(image)).toBeUndefined();
    }
  });

  test("refuse les images mouvantes", () => {
    for (const image of ["alpine", "alpine:latest", "alpine:LATEST", "alpine:3", "alpine:edge", "node:lts-alpine", "alpine@sha256:abc", "alpine: 3.20", ""]) {
      expect(imagePinError(image)).toBeString();
    }
  });
});

// ---------------------------------------------------------------------------
// Scripts shell

describe("scripts shell", () => {
  const scripts = [LIB, ...readdirSync(join(ROOT, "connectors")).map((id) => join(ROOT, "connectors", id, "run.sh"))].filter((path) =>
    Bun.file(path).size > 0,
  );

  test("passent sh -n", () => {
    expect(scripts.length).toBeGreaterThanOrEqual(4);
    for (const script of scripts) {
      const run = Bun.spawnSync(["sh", "-n", script]);
      expect(`${script}: ${run.stderr.toString()}`).toBe(`${script}: `);
      expect(run.exitCode).toBe(0);
    }
  });

  test.skipIf(!Bun.which("shellcheck"))("passent shellcheck -s sh", () => {
    const run = Bun.spawnSync(["shellcheck", "-s", "sh", ...scripts]);
    expect(run.stdout.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// lib/poad-step.sh face à un vrai serveur HTTP

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

describe("lib/poad-step.sh", () => {
  const requests: Recorded[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let stepUrl = "";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          contentType: request.headers.get("content-type"),
          body: await request.text(),
        });
        if (url.pathname.includes("/steps/refuse/")) return new Response("jeton refusé", { status: 401 });
        return Response.json({ ok: true });
      },
    });
    stepUrl = `http://127.0.0.1:${server.port}/flows/v1/steps/step-42`;
  });

  afterAll(() => server.stop(true));

  /** Exécute un bout de script qui source la bibliothèque (asynchrone : le serveur vit dans ce processus). */
  async function sh(script: string, env: Record<string, string | undefined> = {}, args: string[] = []) {
    const base: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      TMPDIR: scratch,
      POAD_LIB: LIB,
      POAD_STEP_URL: stepUrl,
      POAD_STEP_TOKEN: "jeton-test",
      ...env,
    };
    const clean = Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const child = Bun.spawn(["sh", "-c", `. "$POAD_LIB"; ${script}`, "sh", ...args], { env: clean, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  }

  test("poad_output envoie le résultat", async () => {
    requests.length = 0;
    const run = await sh('poad_output "{\\"a\\":1}"');
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/flows/v1/steps/step-42/result");
    expect(request.authorization).toBe("Bearer jeton-test");
    expect(request.contentType).toBe("application/json");
    expect(JSON.parse(request.body)).toEqual({ output: { a: 1 } });
  });

  test("poad_fail envoie un message correctement échappé et sort en 1", async () => {
    requests.length = 0;
    const message = 'Échec "grave" : chemin C:\\temp\\x\nligne 2\tavec tabulation, accents éà€ et 😀';
    const run = await sh('poad_fail "$1"; echo jamais atteint', {}, [message]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Échec");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/flows/v1/steps/step-42/result");
    expect(request.authorization).toBe("Bearer jeton-test");
    expect(JSON.parse(request.body)).toEqual({ error: { message } });
  });

  test("poad_file dépose un fichier par PUT", async () => {
    requests.length = 0;
    const file = join(scratch, "rapport final.csv");
    writeFileSync(file, "a;b\n1;2\n");
    const run = await sh('poad_file "$1" rapport.csv && poad_file "$2"', {}, [file, LIB]);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "PUT /flows/v1/steps/step-42/files/rapport.csv",
      "PUT /flows/v1/steps/step-42/files/poad-step.sh",
    ]);
    expect(requests[0]!.authorization).toBe("Bearer jeton-test");
    expect(requests[0]!.body).toBe("a;b\n1;2\n");
  });

  test("poad_file refuse un nom dangereux", async () => {
    requests.length = 0;
    const run = await sh('poad_file "$1" "../etc/passwd"', {}, [LIB]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("nom de fichier refusé");
    expect(requests).toHaveLength(0);
  });

  test("échoue clairement sans POAD_STEP_URL ou POAD_STEP_TOKEN", async () => {
    requests.length = 0;
    const noUrl = await sh('poad_output "{}"', { POAD_STEP_URL: undefined });
    expect(noUrl.exitCode).not.toBe(0);
    expect(noUrl.stderr).toContain("POAD_STEP_URL manquante");
    const noToken = await sh('poad_output "{}"', { POAD_STEP_TOKEN: "" });
    expect(noToken.exitCode).not.toBe(0);
    expect(noToken.stderr).toContain("POAD_STEP_TOKEN manquante");
    const fail = await sh('poad_fail "oups"', { POAD_STEP_TOKEN: undefined });
    expect(fail.exitCode).toBe(1);
    expect(fail.stderr).toContain("POAD_STEP_TOKEN manquante");
    expect(requests).toHaveLength(0);
  });

  test("signale un refus de poad", async () => {
    const run = await sh('poad_output "{}"', { POAD_STEP_URL: stepUrl.replace("step-42", "refuse") });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("poad a répondu 401");
  });

  test("poad_json_string échappe n'importe quel texte", async () => {
    const samples = ["", "simple", 'guillemets " et antislash \\ et /', "ligne 1\nligne 2\r\n\tfin", "contrôle \u0001\u001f\u007f", "accents éàç€ 日本語 😀", "  espaces  "];
    for (const sample of samples) {
      const run = await sh('poad_json_string "$1"', {}, [sample]);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toMatch(/^"[\x20-\x7e]*"$/);
      expect(JSON.parse(run.stdout)).toBe(sample);
    }
    const stdin = await sh("printf 'a\\377\"b' | poad_json_string");
    expect(JSON.parse(stdin.stdout)).toBe('a\ufffd"b');
  });
});
