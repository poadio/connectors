#!/bin/sh
# Connecteur mediainfo : lit les caractéristiques d'un fichier audio ou vidéo.
#
# PROVISOIRE : faute d'image publique épinglée contenant mediainfo, l'outil est
# installé au démarrage avec apk dans alpine:3.20.3. L'étape a donc besoin du
# réseau, tourne en root, et la version de mediainfo est celle du dépôt Alpine
# 3.20 (24.04 au moment de l'écriture). À remplacer par une image dédiée.
set -eu

# shellcheck disable=SC1090,SC1091
. "${POAD_LIB:-/poad/poad-step.sh}"

tmp=$(mktemp -d "${POAD_WORKDIR:-/tmp}/media.XXXXXX" 2>/dev/null) || tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

url=${MEDIA_URL:-}
if [ -z "$url" ]; then
  poad_fail "Le paramètre « url » est obligatoire."
fi
case "$url" in
  http://* | https://*) ;;
  *) poad_fail "L'adresse doit commencer par http:// ou https://." ;;
esac

if ! command -v mediainfo >/dev/null 2>&1; then
  echo "installation de mediainfo (apk)"
  if ! apk add --no-cache mediainfo >"$tmp/apk.log" 2>&1; then
    poad_fail "Installation de mediainfo impossible : $(tail -n 3 "$tmp/apk.log")"
  fi
fi

# Rend une information de mediainfo pour la cible donnée (première piste seulement).
probe() {
  mediainfo "--Inform=$2" "$1" 2>/dev/null | head -n 1 | tr -d '\r'
}

# 1) Lecture directe de l'adresse : mediainfo ne télécharge que ce qu'il lui faut.
target=$url
container=$(probe "$target" 'General;%Format%\n')

# 2) À défaut (serveur sans requêtes partielles...), téléchargement complet.
if [ -z "$container" ]; then
  echo "lecture directe impossible, téléchargement du fichier"
  if ! wget -q -O "$tmp/input" -- "$url" 2>"$tmp/err"; then
    poad_fail "Téléchargement impossible : $(head -n 1 "$tmp/err")"
  fi
  target="$tmp/input"
  container=$(probe "$target" 'General;%Format%\n')
fi
if [ -z "$container" ]; then
  poad_fail "Fichier non reconnu : ni audio ni vidéo."
fi

duration_ms=$(probe "$target" 'General;%Duration%\n')
codec=$(probe "$target" 'Video;%Format%\n')
width=$(probe "$target" 'Video;%Width%\n')
height=$(probe "$target" 'Video;%Height%\n')
frame_rate=$(probe "$target" 'Video;%FrameRate%\n')
audio_codec=$(probe "$target" 'Audio;%Format%\n')

# Écrit un nombre JSON, ou null si la valeur n'en est pas un.
json_number() {
  case "$1" in
    "" | *[!0-9.]* | *.*.* | .* | *.) printf 'null' ;;
    *) printf '%s' "$1" | sed -e 's/^0*\([0-9]\)/\1/' ;;
  esac
}

# Écrit une chaîne JSON, ou null si la valeur est vide.
json_text() {
  if [ -n "$1" ]; then
    poad_json_string "$1"
  else
    printf 'null'
  fi
}

# Durée : mediainfo la donne en millisecondes, le résultat est en secondes.
case "$duration_ms" in
  "" | *[!0-9.]* | *.*.* | .* | *.) duration=null ;;
  *) duration=$(awk -v ms="$duration_ms" 'BEGIN { printf "%.3f", ms / 1000 }') ;;
esac

{
  printf '{"format":'
  json_text "$container"
  printf ',"duration":%s' "$duration"
  printf ',"codec":'
  json_text "$codec"
  printf ',"width":'
  json_number "$width"
  printf ',"height":'
  json_number "$height"
  printf ',"frame_rate":'
  json_number "$frame_rate"
  printf ',"audio_codec":'
  json_text "$audio_codec"
  printf '}'
} >"$tmp/out.json"

echo "format $container, durée ${duration}s, vidéo ${codec:-aucune} ${width:-?}x${height:-?}"
poad_output_file "$tmp/out.json"
