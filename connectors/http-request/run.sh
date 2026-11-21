#!/bin/sh
# Connecteur http-request : fait une requête HTTP et rend { status, headers, body }.
#
# Tout arrive par des variables d'environnement (voir fiche.json). Rien n'est
# interpolé dans une ligne de commande : la requête est décrite dans un fichier
# de configuration curl, le corps est lu dans un fichier.
# L'image n'a pas jq : le JSON est lu et écrit avec od et awk.
set -eu

# shellcheck disable=SC1090,SC1091
. "${POAD_LIB:-/poad/poad-step.sh}"

BODY_LIMIT=262144 # 256 Kio : au-delà, le corps rendu est tronqué

tmp=$(mktemp -d "${POAD_WORKDIR:-/tmp}/http.XXXXXX" 2>/dev/null) || tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

nl='
'
cr=$(printf '\r')

has_line_break() {
  case "$1" in
    *"$nl"* | *"$cr"*) return 0 ;;
  esac
  return 1
}

# Échappe une valeur pour une chaîne entre guillemets d'un fichier de configuration curl.
cfg_quote() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Ajoute un en-tête à la configuration curl, après l'avoir vérifié.
add_header() {
  case "$1" in
    "" | *[!A-Za-z0-9_.-]*) poad_fail "Nom d'en-tête invalide : « $1 »." ;;
  esac
  if has_line_break "$2"; then
    poad_fail "La valeur de l'en-tête « $1 » contient un saut de ligne."
  fi
  if [ -n "$2" ]; then
    printf 'header = "%s: %s"\n' "$1" "$(cfg_quote "$2")" >>"$cfg"
  else
    printf 'header = "%s;"\n' "$1" >>"$cfg"
  fi
  if [ "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" = "content-type" ]; then
    has_content_type=1
  fi
}

# --- Paramètres -------------------------------------------------------------

url=${HTTP_URL:-}
method=${HTTP_METHOD:-GET}
save_as=${HTTP_SAVE_AS:-}

if [ -z "$url" ]; then
  poad_fail "Le paramètre « url » est obligatoire."
fi
case "$url" in
  http://* | https://*) ;;
  *) poad_fail "L'adresse doit commencer par http:// ou https://." ;;
esac
if has_line_break "$url"; then
  poad_fail "L'adresse contient un saut de ligne."
fi
case "$method" in
  GET | POST | PUT | PATCH | DELETE) ;;
  *) poad_fail "Méthode non prise en charge : « $method »." ;;
esac
case "$save_as" in
  "") ;;
  .* | *[!A-Za-z0-9._-]*) poad_fail "Nom de fichier invalide : « $save_as » (lettres, chiffres, point, tiret, souligné)." ;;
esac

# --- Configuration curl -----------------------------------------------------

cfg="$tmp/curl.cfg"
has_content_type=0
{
  printf 'url = "%s"\n' "$(cfg_quote "$url")"
  printf 'globoff\n'
  printf 'proto = "=http,https"\n'
  printf 'proto-redir = "=http,https"\n'
  printf 'connect-timeout = 15\n'
  printf 'max-time = 270\n'
  printf 'silent\n'
  printf 'show-error\n'
} >"$cfg"

if [ "${HTTP_FOLLOW_REDIRECTS:-false}" = "true" ]; then
  printf 'location\nmax-redirs = 5\n' >>"$cfg"
fi

# En-têtes : objet JSON { "Nom": "valeur" } décodé par awk en lignes nom / valeur.
if [ -n "${HTTP_HEADERS:-}" ]; then
  HTTP_HEADERS="$HTTP_HEADERS" awk '
    function fail(message) { print "ERR " message; exit 2 }
    function skip_ws() { while (i <= n && index(" \t\r\n", substr(s, i, 1)) > 0) i++ }
    function hex(d) { return index("0123456789abcdef", tolower(d)) - 1 }
    function read_string(   out, c, e, code, k, d) {
      if (substr(s, i, 1) != "\"") fail("chaîne attendue en position " i)
      i++
      out = ""
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\"") { i++; return out }
        if (c == "\n" || c == "\r") fail("saut de ligne dans un nom ou une valeur")
        if (c != "\\") { out = out c; i++; continue }
        e = substr(s, i + 1, 1)
        i += 2
        if (e == "\"" || e == "\\" || e == "/") out = out e
        else if (e == "t") out = out "\t"
        else if (e == "u") {
          code = 0
          for (k = 0; k < 4; k++) {
            d = hex(substr(s, i + k, 1))
            if (d < 0 || i + k > n) fail("séquence \\u invalide")
            code = code * 16 + d
          }
          i += 4
          if (code < 32 || code > 126) fail("séquence \\u hors ASCII imprimable : écrire le caractère directement")
          out = out sprintf("%c", code)
        }
        else fail("échappement non permis dans un en-tête")
      }
      fail("chaîne non terminée")
    }
    BEGIN {
      s = ENVIRON["HTTP_HEADERS"]
      n = length(s)
      i = 1
      skip_ws()
      if (substr(s, i, 1) != "{") fail("objet JSON attendu, par exemple {\"Accept\": \"application/json\"}")
      i++
      skip_ws()
      if (substr(s, i, 1) == "}") { i++ }
      else {
        while (1) {
          skip_ws()
          name = read_string()
          skip_ws()
          if (substr(s, i, 1) != ":") fail("« : » attendu après le nom " name)
          i++
          skip_ws()
          if (substr(s, i, 1) == "\"") value = read_string()
          else {
            value = ""
            while (i <= n && index(",} \t\r\n", substr(s, i, 1)) == 0) { value = value substr(s, i, 1); i++ }
            if (value !~ /^(true|false|-?[0-9][0-9.eE+-]*)$/) fail("la valeur de " name " doit être une chaîne")
          }
          print name
          print value
          skip_ws()
          c = substr(s, i, 1)
          i++
          if (c == "}") break
          if (c != ",") fail("« , » ou « } » attendu")
        }
      }
      skip_ws()
      if (i <= n) fail("texte inattendu après la fin")
    }
  ' >"$tmp/pairs" || poad_fail "Paramètre « headers » invalide : $(tail -n 1 "$tmp/pairs" | sed -e 's/^ERR //')"

  while IFS= read -r header_name && IFS= read -r header_value; do
    add_header "$header_name" "$header_value"
  done <"$tmp/pairs"
fi

# En-tête d'authentification de l'identifiant, facultatif.
if [ -n "${HTTP_AUTH_VALUE:-}" ]; then
  add_header "${HTTP_AUTH_HEADER:-Authorization}" "$HTTP_AUTH_VALUE"
fi

# Corps de la requête, lu dans un fichier.
has_body=0
case "$method" in
  POST | PUT | PATCH)
    if [ -n "${HTTP_BODY:-}" ]; then
      has_body=1
      printf '%s' "$HTTP_BODY" >"$tmp/request-body"
      printf 'data-binary = "@%s"\n' "$(cfg_quote "$tmp/request-body")" >>"$cfg"
      if [ "$has_content_type" -eq 0 ]; then
        printf 'header = "Content-Type: application/json"\n' >>"$cfg"
      fi
    fi
    ;;
esac
# Sans « request », curl choisit GET, ou POST s'il y a un corps.
if [ "$method" != "GET" ] && { [ "$method" != "POST" ] || [ "$has_body" -eq 0 ]; }; then
  printf 'request = "%s"\n' "$method" >>"$cfg"
fi

# --- Requête ----------------------------------------------------------------

echo "$method $url"
: >"$tmp/body"
curl_rc=0
curl -q -K "$cfg" -D "$tmp/headers" -o "$tmp/body" -w '%{http_code}' >"$tmp/status" 2>"$tmp/err" || curl_rc=$?
if [ "$curl_rc" -ne 0 ]; then
  poad_fail "Requête impossible : $(head -n 1 "$tmp/err" | sed -e 's/^curl: ([0-9]*) //')"
fi
status=$(cat "$tmp/status")
case "$status" in
  [1-5][0-9][0-9]) ;;
  *) poad_fail "Réponse HTTP illisible (code « $status »)." ;;
esac
size=$(wc -c <"$tmp/body" | tr -d ' ')
echo "réponse $status, $size octet(s)"

# --- En-têtes de la réponse -------------------------------------------------
# Seul le dernier bloc compte (après redirections) ; les noms sont mis en
# minuscules, les en-têtes répétés sont réunis par une virgule, et tout octet
# non ASCII est retiré.
[ -f "$tmp/headers" ] || : >"$tmp/headers"
tr -cd '\11\12\40-\176' <"$tmp/headers" | awk '
  function esc(s,   k, c, out) {
    out = ""
    for (k = 1; k <= length(s); k++) {
      c = substr(s, k, 1)
      if (c == "\\" || c == "\"") out = out "\\" c
      else if (c == "\t") out = out " "
      else out = out c
    }
    return out
  }
  /^HTTP\// { count = 0; split("", value); next }
  {
    p = index($0, ":")
    if (p < 2) next
    name = tolower(substr($0, 1, p - 1))
    v = substr($0, p + 1)
    sub(/^[ \t]+/, "", v)
    sub(/[ \t]+$/, "", v)
    if (name in value) value[name] = value[name] ", " v
    else { order[++count] = name; value[name] = v }
  }
  END {
    printf "{"
    for (k = 1; k <= count; k++) printf "%s\"%s\":\"%s\"", (k > 1 ? "," : ""), esc(order[k]), esc(value[order[k]])
    printf "}"
  }
' >"$tmp/headers.json"
content_type=$(tr -cd '\11\12\40-\176' <"$tmp/headers" | awk '
  /^HTTP\// { v = "" }
  tolower($0) ~ /^content-type:/ { v = tolower($0) }
  END { print v }
')

# --- Échec sur code d'erreur ------------------------------------------------

if [ "$status" -ge 400 ] && [ "${HTTP_FAIL_ON_ERROR:-true}" != "false" ]; then
  excerpt=$(head -c 300 "$tmp/body" | tr -cd '\11\12\40-\176')
  if [ -n "$excerpt" ]; then
    poad_fail "La requête a répondu $status : $excerpt"
  fi
  poad_fail "La requête a répondu $status."
fi

# --- Résultat ---------------------------------------------------------------

out="$tmp/out.json"
{
  printf '{"status":%s,"headers":' "$status"
  cat "$tmp/headers.json"
  printf ',"body_size":%s' "$size"
} >"$out"

if [ -n "$save_as" ]; then
  # Le corps part en fichier, entier : il n'est pas recopié dans le résultat.
  poad_file "$tmp/body" "$save_as" || poad_fail "Le fichier « $save_as » n'a pas pu être déposé."
  {
    printf ',"body":null,"body_truncated":false,"file":'
    poad_json_string "$save_as"
    printf '}'
  } >>"$out"
elif [ "$(tr -d '\000' <"$tmp/body" | wc -c | tr -d ' ')" != "$size" ]; then
  # Octets nuls : contenu binaire, non rendu comme texte.
  echo "corps binaire : non rendu (utiliser « save_as » pour le récupérer en fichier)"
  printf ',"body":null,"body_truncated":false,"body_binary":true}' >>"$out"
else
  truncated=false
  if [ "$size" -gt "$BODY_LIMIT" ]; then
    truncated=true
    head -c "$BODY_LIMIT" "$tmp/body" >"$tmp/body.cut"
  else
    cp "$tmp/body" "$tmp/body.cut"
  fi
  {
    printf ',"body_truncated":%s,"body":' "$truncated"
    poad_json_string <"$tmp/body.cut"
  } >>"$out"

  # body_json : seulement si la réponse se dit JSON, est entière, et est
  # réellement du JSON en UTF-8 valide (vérifié octet par octet).
  is_json=0
  case "$content_type" in
    *json*)
      if [ "$truncated" = "false" ] && [ "$size" -gt 0 ]; then
        if od -An -v -tx1 "$tmp/body" | LC_ALL=C awk '
          BEGIN {
            for (i = 0; i < 256; i++) dec[sprintf("%02x", i)] = i
            for (i = 1; i < 128; i++) chr[i] = sprintf("%c", i)
            state = "value"; depth = 0; stack = ""; need = 0; ok = 1
          }
          function bad() { ok = 0; exit 1 }
          function push(kind) { stack = stack kind; depth++; if (depth > 256) bad() }
          function pop() { depth--; stack = substr(stack, 1, depth) }
          function value_done() { state = (depth == 0) ? "end" : "after" }
          function close_token() {
            if (state == "number") {
              if (token !~ /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/) bad()
              value_done()
            } else if (state == "literal") {
              if (token != "true" && token != "false" && token != "null") bad()
              value_done()
            }
          }
          function byte(b,   top) {
            if (state == "string") {
              if (need > 0) {
                if (b < lo || b > hi) bad()
                lo = 128; hi = 191; need--
                return
              }
              if (b == 34) { if (is_key) state = "colon"; else value_done(); return }
              if (b == 92) { state = "escape"; return }
              if (b < 32) bad()
              if (b < 128) return
              if (b >= 194 && b <= 223) { need = 1; lo = 128; hi = 191 }
              else if (b >= 224 && b <= 239) { need = 2; lo = (b == 224) ? 160 : 128; hi = (b == 237) ? 159 : 191 }
              else if (b >= 240 && b <= 244) { need = 3; lo = (b == 240) ? 144 : 128; hi = (b == 244) ? 143 : 191 }
              else bad()
              return
            }
            if (state == "escape") {
              if (b == 117) { state = "hex"; hex_count = 0; return }
              if (b < 128 && index("\"\\/bfnrt", chr[b]) > 0) { state = "string"; return }
              bad()
            }
            if (state == "hex") {
              if (b >= 128 || index("0123456789abcdefABCDEF", chr[b]) == 0) bad()
              hex_count++
              if (hex_count == 4) state = "string"
              return
            }
            if (state == "number") {
              if (b < 128 && index("0123456789+-.eE", chr[b]) > 0) { token = token chr[b]; return }
              close_token()
            } else if (state == "literal") {
              if (b >= 97 && b <= 122) { token = token chr[b]; return }
              close_token()
            }
            if (b == 32 || b == 9 || b == 10 || b == 13) return
            if (state == "value" || state == "first-value") {
              if (b == 93 && state == "first-value") { pop(); value_done(); return }
              if (b == 34) { state = "string"; is_key = 0; return }
              if (b == 123) { push("o"); state = "first-key"; return }
              if (b == 91) { push("a"); state = "first-value"; return }
              if (b == 45 || (b >= 48 && b <= 57)) { state = "number"; token = chr[b]; return }
              if (b >= 97 && b <= 122) { state = "literal"; token = chr[b]; return }
              bad()
            }
            if (state == "key" || state == "first-key") {
              if (b == 125 && state == "first-key") { pop(); value_done(); return }
              if (b == 34) { state = "string"; is_key = 1; return }
              bad()
            }
            if (state == "colon") {
              if (b == 58) { state = "value"; return }
              bad()
            }
            if (state == "after") {
              top = substr(stack, depth, 1)
              if (b == 44) { state = (top == "o") ? "key" : "value"; return }
              if (b == 125 && top == "o") { pop(); value_done(); return }
              if (b == 93 && top == "a") { pop(); value_done(); return }
              bad()
            }
            bad()
          }
          { for (f = 1; f <= NF; f++) byte(dec[$f]) }
          END {
            if (!ok) exit 1
            close_token()
            if (state != "end") exit 1
          }
        '; then
          is_json=1
        fi
      fi
      ;;
  esac
  if [ "$is_json" -eq 1 ]; then
    {
      printf ',"body_json":'
      cat "$tmp/body"
    } >>"$out"
  fi
  printf '}' >>"$out"
fi

poad_output_file "$out"
