#!/usr/bin/env bash
# Stores the Microsoft Entra sign-in settings in SSM Parameter Store.
# Values are read interactively and passed to AWS via a private temp file, so they never
# appear in shell history, process arguments, or this repository.
set -euo pipefail

REGION="${AWS_REGION:-eu-west-1}"
PREFIX="${PARAMETER_PREFIX:-/video}"

current() {
  aws ssm get-parameter --region "$REGION" --name "$PREFIX/$1" --query Parameter.Value --output text 2>/dev/null || true
}

put() { # name type value
  # The value goes through a private temp file (not argv) so it never shows up in `ps`.
  local input
  input="$(umask 077; mktemp)"
  NAME="$PREFIX/$1" TYPE="$2" VALUE="$3" node -e '
    process.stdout.write(JSON.stringify({ Name: process.env.NAME, Type: process.env.TYPE, Value: process.env.VALUE, Overwrite: true }));
  ' > "$input"
  if ! aws ssm put-parameter --region "$REGION" --cli-input-json "file://$input" >/dev/null; then
    rm -f "$input"
    echo "Failed to save $PREFIX/$1" >&2
    exit 1
  fi
  rm -f "$input"
  echo "  saved $PREFIX/$1 ($2)"
}

prompt() { # var label default
  local value
  read -r -p "$2${3:+ [$3]}: " value
  printf -v "$1" '%s' "${value:-$3}"
}

echo "Microsoft Entra settings for video.dliu.com (region $REGION)."
echo "In the app registration, add the Web redirect URI: https://video.dliu.com/auth/callback"
echo "Press Enter to keep the value shown in brackets."
prompt TENANT_ID "Directory (tenant) ID" "$(current entra-tenant-id)"
prompt CLIENT_ID "Application (client) ID" "$(current entra-client-id)"
read -r -s -p "Client secret VALUE (hidden; Enter to keep current): " CLIENT_SECRET; echo

[[ -n "$TENANT_ID" && -n "$CLIENT_ID" ]] || { echo "Tenant ID and client ID are required." >&2; exit 1; }

put entra-tenant-id String "$TENANT_ID"
put entra-client-id String "$CLIENT_ID"
if [[ -n "$CLIENT_SECRET" ]]; then
  put entra-client-secret SecureString "$CLIENT_SECRET"
elif [[ -z "$(aws ssm get-parameter --region "$REGION" --name "$PREFIX/entra-client-secret" --query Parameter.Name --output text 2>/dev/null || true)" ]]; then
  echo "No client secret stored yet; run again and enter it." >&2
  exit 1
fi
echo "Done. The app picks up changes within 5 minutes."
