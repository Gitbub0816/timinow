#!/usr/bin/env bash
#
# Verify timinow.pet resolves the way the Workers and Clerk need it to.
#
#   ./scripts/check-dns.sh
#
# A zone file cannot express Cloudflare's proxy toggle, and that toggle is the
# step most likely to be missed: the six Worker hostnames must be proxied, and
# the Clerk hostnames must not be. Both mistakes fail quietly — a grey-clouded
# Worker hostname simply does not answer, and an orange-clouded Clerk hostname
# breaks sign-in — so check rather than assume.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run with bash: bash scripts/check-dns.sh" >&2
  exit 1
fi

set -uo pipefail

DOMAIN="${1:-timinow.pet}"
FAILURES=0

green() { printf '  \033[32mok\033[0m      %s\n' "$*"; }
red()   { printf '  \033[31mFAIL\033[0m    %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
warn()  { printf '  \033[33m??\033[0m      %s\n' "$*"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# dig ships with macOS; nslookup is the fallback for a stripped-down Linux box.
if command -v dig >/dev/null 2>&1; then
  lookup() { dig +short "$2" "$1" @1.1.1.1 2>/dev/null; }
elif command -v nslookup >/dev/null 2>&1; then
  lookup() { nslookup -type="$2" "$1" 1.1.1.1 2>/dev/null | awk '/=/ {print $NF}'; }
else
  echo "Needs dig or nslookup. On macOS dig is already installed." >&2
  exit 1
fi

# Cloudflare's proxy returns its own anycast addresses, never the 100:: the zone
# file declares. Seeing 100:: come back is the signature of a record that was
# imported but never orange-clouded.
proxied() {
  local host="$1"
  local answer
  answer="$(lookup "$host" A; lookup "$host" AAAA)"
  if [ -z "$answer" ]; then
    red "$host does not resolve — record missing"
  elif printf '%s' "$answer" | grep -q '^100::$'; then
    red "$host resolves to 100:: — imported but not Proxied (orange cloud it)"
  else
    green "$host proxied"
  fi
}

dns_only_cname() {
  local host="$1" expect="$2"
  local answer
  answer="$(lookup "$host" CNAME | head -1)"
  if [ -z "$answer" ]; then
    warn "$host has no CNAME yet — add it from the Clerk dashboard"
  elif printf '%s' "$answer" | grep -qi "$expect"; then
    green "$host -> $answer"
  else
    red "$host -> $answer (expected something matching $expect; if it points at Cloudflare, it is proxied and must be DNS-only)"
  fi
}

head2 "Worker hostnames (must be Proxied)"
proxied "$DOMAIN"
for sub in www app providers admin voice; do proxied "$sub.$DOMAIN"; done

head2 "Clerk (must be DNS-only)"
dns_only_cname "clerk.$DOMAIN"          "clerk.services"
dns_only_cname "accounts.$DOMAIN"       "clerk.services"
dns_only_cname "clkmail.$DOMAIN"        "clerk.services"
dns_only_cname "clk._domainkey.$DOMAIN" "clerk.services"
dns_only_cname "clk2._domainkey.$DOMAIN" "clerk.services"

head2 "Mail policy"
spf="$(lookup "$DOMAIN" TXT | tr -d '"' | grep '^v=spf1' | head -1)"
[ -n "$spf" ] && green "SPF: $spf" || red "no SPF record — the domain can be spoofed"
dmarc="$(lookup "_dmarc.$DOMAIN" TXT | tr -d '"' | grep '^v=DMARC1' | head -1)"
[ -n "$dmarc" ] && green "DMARC: $dmarc" || red "no DMARC record"

head2 "Certificate authority"
caa="$(lookup "$DOMAIN" CAA)"
if [ -n "$caa" ]; then
  printf '%s' "$caa" | grep -q 'letsencrypt.org' \
    && green "CAA allows letsencrypt.org (Clerk needs it)" \
    || red "CAA is set but omits letsencrypt.org — Clerk cannot issue a certificate"
else
  warn "no CAA records (permitted, but any CA may then issue for this domain)"
fi

head2 "Live endpoints"
for host in "$DOMAIN" "providers.$DOMAIN" "admin.$DOMAIN" "voice.$DOMAIN"; do
  body="$(curl -fsS --max-time 10 "https://$host/api/health" 2>/dev/null)"
  if [ -n "$body" ]; then green "$host $body"; else red "$host /api/health did not answer"; fi
done

echo
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[1mDNS looks right.\033[0m\n'
else
  printf '\033[31m%s check(s) failed.\033[0m See dns/README.md.\n' "$FAILURES"
  exit 1
fi
