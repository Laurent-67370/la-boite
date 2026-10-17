#!/usr/bin/env bash
# scripts/offsite.sh — copie hors du VPS de la sauvegarde la plus récente, CHIFFRÉE avec age.
#
# Variables (fichier d'environnement en 0600, jamais dans le dépôt — voir deploy/offsite.env.example) :
#   LA_BOITE_BACKUP_DIR   dossier des sauvegardes locales (défaut /var/backups/la-boite)
#   OFFSITE_AGE_RECIPIENT clé PUBLIQUE age (age1…) ; la clé privée ne doit PAS être sur ce serveur
#   OFFSITE_URL           ftp://hote (FTPS explicite, TLS imposé) ou file:///chemin (tests)
#   OFFSITE_USER          identifiant FTPS
#   LFTP_PASSWORD         mot de passe FTPS (lu par lftp --env-password : jamais visible dans ps)
#   OFFSITE_DIR           dossier distant (défaut la-boite)
#   OFFSITE_KEEP          nombre de copies gardées à distance (défaut 7)
#
# Étapes : tar | age → fichier .age local ; envoi sous un nom .part puis renommage (pas de copie
# partielle visible) ; relecture et comparaison SHA-256 ; rotation distante ; nettoyage local.
set -euo pipefail

BACKUP_DIR="${LA_BOITE_BACKUP_DIR:-/var/backups/la-boite}"
REMOTE_DIR="${OFFSITE_DIR:-la-boite}"
KEEP="${OFFSITE_KEEP:-7}"
: "${OFFSITE_AGE_RECIPIENT:?clé publique age manquante (OFFSITE_AGE_RECIPIENT)}"
: "${OFFSITE_URL:?destination manquante (OFFSITE_URL)}"
[[ "$OFFSITE_AGE_RECIPIENT" == age1* ]] || { echo "OFFSITE_AGE_RECIPIENT doit être une clé publique age1…" >&2; exit 2; }
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || { echo "OFFSITE_KEEP doit être un entier ≥ 1" >&2; exit 2; }

latest="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'la-boite-*' -printf '%f\n' | sort | tail -n 1)"
[[ -n "$latest" ]] || { echo "Aucune sauvegarde dans $BACKUP_DIR" >&2; exit 1; }
[[ -f "$BACKUP_DIR/$latest/manifest.json" ]] || { echo "Sauvegarde incomplète : $latest" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
file="$latest.tar.gz.age"
tar -C "$BACKUP_DIR/$latest" -czf - . | age -r "$OFFSITE_AGE_RECIPIENT" -o "$work/$file"
sum="$(sha256sum "$work/$file" | cut -d' ' -f1)"

lftp_run() {
  local auth=()
  if [[ -n "${OFFSITE_USER:-}" ]]; then auth=(--env-password -u "$OFFSITE_USER"); fi
  lftp "${auth[@]}" -e "set cmd:fail-exit true; set net:max-retries 3; set net:timeout 30; \
    set ftp:ssl-force true; set ftp:ssl-protect-data true; set ssl:verify-certificate true; $1; bye" "$OFFSITE_URL"
}

# Envoi atomique puis relecture
lftp_run "mkdir -pf $REMOTE_DIR; cd $REMOTE_DIR; put $work/$file -o $file.part; mv $file.part $file; get $file -o $work/check.age"
[[ "$(sha256sum "$work/check.age" | cut -d' ' -f1)" == "$sum" ]] || { echo "Relecture distante : SHA-256 différent" >&2; exit 1; }

# Rotation distante : on garde les $KEEP plus récentes (les noms se trient chronologiquement)
mapfile -t remote < <(lftp_run "cd $REMOTE_DIR; cls -1 la-boite-*.tar.gz.age" 2>/dev/null | sed 's#.*/##' | sort)
removed=0
if (( ${#remote[@]} > KEEP )); then
  for old in "${remote[@]:0:${#remote[@]}-KEEP}"; do
    lftp_run "cd $REMOTE_DIR; rm $old"
    removed=$((removed + 1))
  done
fi
echo "Copie distante $file ($(stat -c %s "$work/$file") octets, sha256 ${sum:0:12}…) vérifiée ; $removed ancienne(s) supprimée(s), $KEEP gardée(s) au plus."
