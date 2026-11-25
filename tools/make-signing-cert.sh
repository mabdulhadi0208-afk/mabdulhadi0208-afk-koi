#!/bin/bash
# One-time setup so macOS keeps Koi's Accessibility permission across updates.
# Makes a self-signed code-signing certificate (valid 20 years) and stores it ONLY as two GitHub Actions secrets,
# KOI_CERT_P12 and KOI_CERT_PASSWORD. Every release is then signed with the same certificate, so its designated
# requirement never changes. Nothing is written into the repo: the key stays in ~/.koi-signing (keep it safe,
# never commit it) and in the secrets. Needs openssl and an authenticated gh. Run it once, from the repo:
#   bash tools/make-signing-cert.sh
# Losing the key later only means one more "re-add Koi in Accessibility" after the next update.
set -euo pipefail
REPO="${KOI_REPO:-mabdulhadi0208-afk/mabdulhadi0208-afk-koi}"
D="$HOME/.koi-signing"; mkdir -p "$D"; chmod 700 "$D"
if [ -f "$D/koi.p12" ]; then echo "$D/koi.p12 already exists; reusing it (delete it first to make a new one)"; else
  cat > "$D/koi.cnf" <<'CNF'
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=Koi Self-Signed Code Signing
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CNF
  openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -keyout "$D/koi.key" -out "$D/koi.crt" -config "$D/koi.cnf"
  openssl rand -hex 24 > "$D/password"; chmod 600 "$D/password" "$D/koi.key"
  # -legacy keeps the .p12 readable by macOS's security tool when this is OpenSSL 3; LibreSSL does not know it
  openssl pkcs12 -export -legacy -inkey "$D/koi.key" -in "$D/koi.crt" -name "Koi Self-Signed Code Signing" -out "$D/koi.p12" -passout "file:$D/password" 2>/dev/null \
    || openssl pkcs12 -export -inkey "$D/koi.key" -in "$D/koi.crt" -name "Koi Self-Signed Code Signing" -out "$D/koi.p12" -passout "file:$D/password"
  chmod 600 "$D/koi.p12"
fi
base64 < "$D/koi.p12" | tr -d '\n' | gh secret set KOI_CERT_P12 --repo "$REPO"
gh secret set KOI_CERT_PASSWORD --repo "$REPO" < "$D/password"
echo "Done. The next release is signed with the Koi certificate; after people re-add Koi once, updates keep the permission."
