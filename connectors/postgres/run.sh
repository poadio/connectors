#!/bin/sh
# Connecteur postgres : exécute une requête SQL avec psql et rend { rows, row_count, truncated }.
#
# La connexion vient de l'identifiant (PGHOST, PGPORT, PGDATABASE, PGUSER,
# PGPASSWORD, PGSSLMODE), que psql lit lui-même. Le SQL est écrit dans un
# fichier et passé par `psql -f` : il n'apparaît jamais dans une ligne de commande.
#
# Mode « rows » (défaut) : la requête est enveloppée dans une CTE,
#     WITH poad_q AS ( <requête> ), poad_l AS (SELECT * FROM poad_q LIMIT n) SELECT json_agg(...)
# ce qui donne les lignes en JSON sans dépendre de jq. Limites :
#   - une seule instruction, qui rend des lignes : SELECT, VALUES, ou
#     INSERT / UPDATE / DELETE ... RETURNING ;
#   - pas de « WITH ... INSERT/UPDATE/DELETE » (PostgreSQL n'accepte une CTE
#     qui modifie des données qu'au premier niveau) ;
#   - un commentaire après le point-virgule final fait échouer l'enveloppe ;
#   - le résultat entier tient en mémoire : max_rows le borne.
# Mode « execute » : le script SQL est exécuté tel quel, dans une transaction
# (plusieurs instructions, DDL...), et ne rend aucune ligne.
set -eu

# shellcheck disable=SC1090,SC1091
. "${POAD_LIB:-/poad/poad-step.sh}"

tmp=$(mktemp -d "${POAD_WORKDIR:-/tmp}/pg.XXXXXX" 2>/dev/null) || tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mode=${PG_MODE:-rows}
max_rows=${PG_MAX_ROWS:-1000}

if [ -z "${PG_SQL:-}" ]; then
  poad_fail "Le paramètre « sql » est obligatoire."
fi
case "$max_rows" in
  "" | *[!0-9]* | 0*) poad_fail "Le paramètre « max_rows » doit être un entier positif." ;;
esac
if [ "${#max_rows}" -gt 7 ]; then
  poad_fail "Le paramètre « max_rows » est trop grand."
fi
if [ -z "${PGHOST:-}" ]; then
  poad_fail "Identifiant PostgreSQL manquant : hôte non renseigné."
fi

# Un champ facultatif laissé vide ne doit pas masquer la valeur par défaut de psql.
[ -n "${PGPORT:-}" ] || unset PGPORT
[ -n "${PGSSLMODE:-}" ] || unset PGSSLMODE
PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-15}
PGAPPNAME=poad-flow
export PGCONNECT_TIMEOUT PGAPPNAME

# Rend le message d'erreur de psql sans le préfixe « psql:fichier:ligne: ».
psql_error() {
  sed -e 's/^psql:[^ ]*: //' "$tmp/err" | head -n 5
}

printf '%s' "$PG_SQL" >"$tmp/user.sql"

case "$mode" in
  rows)
    {
      printf 'WITH poad_q AS (\n'
      # La requête, sans blancs ni point-virgule finals.
      sed -e ':a' -e '$!{' -e 'N' -e 'ba' -e '}' -e 's/[[:space:]]*;*[[:space:]]*$//' "$tmp/user.sql"
      printf '\n),\npoad_l AS (SELECT * FROM poad_q LIMIT %s)\n' "$max_rows"
      printf 'SELECT json_build_object(\n'
      printf "  'rows', coalesce((SELECT json_agg(poad_l) FROM poad_l), '[]'::json),\n"
      printf "  'row_count', (SELECT count(*) FROM poad_l),\n"
      printf "  'truncated', (SELECT count(*) FROM poad_q) > %s\n" "$max_rows"
      printf ')::text;\n'
    } >"$tmp/query.sql"
    if ! psql -X -q -At -v ON_ERROR_STOP=1 -f "$tmp/query.sql" >"$tmp/out.json" 2>"$tmp/err"; then
      poad_fail "La requête a échoué : $(psql_error)"
    fi
    if [ ! -s "$tmp/out.json" ]; then
      poad_fail "La requête n'a rien rendu."
    fi
    ;;
  execute)
    if ! psql -X -q -1 -v ON_ERROR_STOP=1 -f "$tmp/user.sql" 2>"$tmp/err"; then
      poad_fail "Le script SQL a échoué : $(psql_error)"
    fi
    printf '{"rows":[],"row_count":0,"truncated":false}' >"$tmp/out.json"
    ;;
  *)
    poad_fail "Mode inconnu : « $mode »."
    ;;
esac

poad_output_file "$tmp/out.json"
