#!/bin/sh
# poad-step.sh — aide commune aux étapes de flow poad.
#
# À sourcer en tête de script :   . /poad/poad-step.sh
#
# Script POSIX sh (aucun bashisme) : il doit tourner tel quel avec dash,
# busybox ash, bash --posix... Il a besoin de `od` et `awk` (POSIX) et de
# `curl` ou, à défaut, de `wget`.
#
# Fonctions fournies :
#   poad_output <json>          envoie le résultat { "output": <json> }
#   poad_output_file <chemin>   idem, le JSON du résultat est lu dans un fichier
#   poad_fail <message>         envoie { "error": { "message": … } } et sort en 1
#   poad_file <chemin> [nom]    dépose un fichier produit par l'étape
#   poad_json_string [texte]    écrit le texte sous forme de chaîne JSON
#                               (sans argument : lit l'entrée standard)
#
# Le moteur fournit POAD_STEP_URL (adresse de rappel de l'étape) et
# POAD_STEP_TOKEN (jeton à usage unique). Rien de ce qui est écrit sur
# stdout/stderr n'est un résultat : c'est le journal de l'étape.

_poad_log() {
  printf 'poad-step: %s\n' "$*" >&2
}

# Vérifie que le moteur a bien fourni l'adresse de rappel et le jeton.
_poad_check_env() {
  if [ -z "${POAD_STEP_URL:-}" ]; then
    _poad_log "variable POAD_STEP_URL manquante : impossible de rendre le résultat à poad"
    return 2
  fi
  if [ -z "${POAD_STEP_TOKEN:-}" ]; then
    _poad_log "variable POAD_STEP_TOKEN manquante : impossible de rendre le résultat à poad"
    return 2
  fi
  return 0
}

# Crée un fichier temporaire et écrit son chemin.
_poad_mktemp() {
  mktemp "${TMPDIR:-/tmp}/poad.XXXXXX" 2>/dev/null ||
    mktemp "${POAD_WORKDIR:-.}/poad.XXXXXX"
}

# poad_json_string [texte]
# Écrit le texte sous forme de chaîne JSON, guillemets compris, sans jq.
# Le texte passe par `od` : le résultat est de l'ASCII pur, quels que soient
# les octets reçus. Guillemets, antislash et caractères de contrôle sont
# échappés, les caractères non ASCII sont écrits en \uXXXX, et un octet qui
# n'est pas de l'UTF-8 valide devient �.
poad_json_string() {
  if [ "$#" -gt 0 ]; then
    printf '%s' "$1"
  else
    cat
  fi | od -An -v -tx1 | LC_ALL=C awk '
    BEGIN {
      for (i = 0; i < 256; i++) dec[sprintf("%02x", i)] = i
      for (i = 32; i < 127; i++) chr[i] = sprintf("%c", i)
      chr[34] = "\\\""
      chr[92] = "\\\\"
      chr[8] = "\\b"
      chr[9] = "\\t"
      chr[10] = "\\n"
      chr[12] = "\\f"
      chr[13] = "\\r"
      need = 0
      printf "%s", "\""
    }
    # Écrit un point de code.
    function emit(cp,   c) {
      if (cp in chr) {
        printf "%s", chr[cp]
      } else if (cp < 65536) {
        printf "%s%04x", "\\u", cp
      } else {
        c = cp - 65536
        printf "%s%04x%s%04x", "\\u", 55296 + int(c / 1024), "\\u", 56320 + c % 1024
      }
    }
    # Avale un octet : décodage UTF-8 strict.
    function byte(b) {
      if (need > 0) {
        if (b >= lo && b <= hi) {
          cp = cp * 64 + b - 128
          lo = 128
          hi = 191
          need--
          if (need == 0) emit(cp)
          return
        }
        need = 0
        printf "%s", "\\ufffd"
      }
      if (b < 128) {
        emit(b)
      } else if (b >= 194 && b <= 223) {
        cp = b - 192; need = 1; lo = 128; hi = 191
      } else if (b >= 224 && b <= 239) {
        cp = b - 224; need = 2
        lo = (b == 224) ? 160 : 128
        hi = (b == 237) ? 159 : 191
      } else if (b >= 240 && b <= 244) {
        cp = b - 240; need = 3
        lo = (b == 240) ? 144 : 128
        hi = (b == 244) ? 143 : 191
      } else {
        printf "%s", "\\ufffd"
      }
    }
    { for (f = 1; f <= NF; f++) byte(dec[$f]) }
    END {
      if (need > 0) printf "%s", "\\ufffd"
      printf "%s", "\""
    }
  '
}

# _poad_send <méthode> <adresse> <type de contenu> <fichier du corps>
# Envoie le fichier à poad avec le jeton de l'étape. Réussit sur une réponse 2xx.
_poad_send() {
  _poad_check_env || return 2
  if command -v curl >/dev/null 2>&1; then
    if [ "$1" = "PUT" ]; then
      _poad_code=$(curl -q -g -sS --retry 2 --connect-timeout 15 \
        -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer ${POAD_STEP_TOKEN}" \
        -H "Content-Type: $3" \
        -T "$4" "$2") || {
        _poad_log "appel $1 $2 impossible"
        return 1
      }
    else
      _poad_code=$(curl -q -g -sS --retry 2 --connect-timeout 15 --max-time 120 \
        -o /dev/null -w '%{http_code}' -X "$1" \
        -H "Authorization: Bearer ${POAD_STEP_TOKEN}" \
        -H "Content-Type: $3" \
        --data-binary "@$4" "$2") || {
        _poad_log "appel $1 $2 impossible"
        return 1
      }
    fi
    case "$_poad_code" in
      2??) return 0 ;;
    esac
    _poad_log "poad a répondu $_poad_code à $1 $2"
    return 1
  fi
  if command -v wget >/dev/null 2>&1; then
    if [ "$1" = "POST" ]; then
      wget -q -O /dev/null \
        --header "Authorization: Bearer ${POAD_STEP_TOKEN}" \
        --header "Content-Type: $3" \
        --post-file "$4" "$2" || {
        _poad_log "appel $1 $2 refusé ou impossible (wget)"
        return 1
      }
      return 0
    fi
    # Le wget de busybox ne connaît que GET et POST : --method demande GNU wget.
    wget -q -O /dev/null \
      --header "Authorization: Bearer ${POAD_STEP_TOKEN}" \
      --header "Content-Type: $3" \
      --method="$1" --body-file="$4" "$2" || {
      _poad_log "appel $1 $2 impossible : ce wget ne sait peut-être pas faire $1, utilisez une image qui contient curl"
      return 1
    }
    return 0
  fi
  _poad_log "ni curl ni wget dans cette image : impossible de joindre poad"
  return 1
}

# poad_output_file <chemin>
# Envoie le résultat de l'étape ; le fichier contient la valeur JSON de "output".
poad_output_file() {
  if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    _poad_log "usage : poad_output_file <fichier json>"
    return 2
  fi
  _poad_check_env || return 2
  _poad_body=$(_poad_mktemp) || {
    _poad_log "impossible de créer un fichier temporaire"
    return 1
  }
  {
    printf '{"output":'
    cat "$1"
    printf '}'
  } >"$_poad_body"
  _poad_rc=0
  _poad_send POST "${POAD_STEP_URL%/}/result" "application/json" "$_poad_body" || _poad_rc=$?
  rm -f "$_poad_body"
  return "$_poad_rc"
}

# poad_output <json>
# Envoie le résultat de l'étape ; <json> est la valeur JSON de "output".
poad_output() {
  if [ "$#" -ne 1 ]; then
    _poad_log "usage : poad_output <json>"
    return 2
  fi
  _poad_check_env || return 2
  _poad_value=$(_poad_mktemp) || {
    _poad_log "impossible de créer un fichier temporaire"
    return 1
  }
  printf '%s' "$1" >"$_poad_value"
  _poad_out_rc=0
  poad_output_file "$_poad_value" || _poad_out_rc=$?
  rm -f "$_poad_value"
  return "$_poad_out_rc"
}

# poad_fail <message>
# Écrit le message dans le journal, l'envoie à poad comme erreur de l'étape,
# puis termine le script avec le code 1.
poad_fail() {
  _poad_msg=${1:-"échec de l'étape"}
  printf 'erreur : %s\n' "$_poad_msg" >&2
  if _poad_check_env; then
    _poad_err=$(_poad_mktemp) || _poad_err=""
    if [ -n "$_poad_err" ]; then
      {
        printf '{"error":{"message":'
        poad_json_string "$_poad_msg"
        printf '}}'
      } >"$_poad_err"
      _poad_send POST "${POAD_STEP_URL%/}/result" "application/json" "$_poad_err" ||
        _poad_log "l'erreur n'a pas pu être transmise à poad"
      rm -f "$_poad_err"
    else
      _poad_log "impossible de créer un fichier temporaire : erreur non transmise"
    fi
  fi
  exit 1
}

# poad_file <chemin> [nom]
# Dépose un fichier produit par l'étape. Le nom par défaut est celui du fichier.
poad_file() {
  if [ "$#" -lt 1 ] || [ ! -f "$1" ]; then
    _poad_log "usage : poad_file <chemin> [nom] (fichier introuvable : ${1:-})"
    return 2
  fi
  _poad_name=${2:-$(basename "$1")}
  case "$_poad_name" in
    "" | .* | *[!A-Za-z0-9._-]*)
      _poad_log "nom de fichier refusé : « $_poad_name » (lettres, chiffres, point, tiret, souligné ; pas de point initial)"
      return 2
      ;;
  esac
  _poad_send PUT "${POAD_STEP_URL%/}/files/$_poad_name" "application/octet-stream" "$1"
}
