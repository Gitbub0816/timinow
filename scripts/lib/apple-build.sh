#!/usr/bin/env bash
#
# Shared plumbing for the four scripts that drive xcodebuild:
#
#   scripts/build-mac-app.sh       macOS console -> /Applications
#   scripts/build-ios-app.sh       customer app  -> simulator
#   scripts/install-ios-device.sh  customer app  -> iPhone over USB-C
#   scripts/upload-testflight.sh   customer app  -> TestFlight
#
# Source it, do not run it:
#
#   . "$(dirname "$0")/lib/apple-build.sh"
#
# It exists because a silent terminal for ten minutes is indistinguishable
# from a hang, and the first customer-app build genuinely takes that long —
# Skip transpiles its whole stack before Xcode compiles anything. Four copies
# of that reasoning is four chances for one of them to drift.

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Matches the phase headings xcodebuild prints, plus anything that names an
# error. The skipstone plugin's own output is thousands of note: lines naming
# every transpiled file, which is the one phase that must NOT be echoed — so
# the heartbeat below covers that silence instead.
BUILD_FILTER='^(Skip |Compiling|Compile|Build|Ld |Link|CodeSign|Signing|Touch|Copy|Prepare|Resolve|Apply build tool|Process build tool|Create|Validate|Archive|Export|Upload|\*\* |error:|.*: error:)'

# The build does hang, not only go quiet: two xcodebuilds at once block on
# SwiftPM's shared lock with no message at all. So the heartbeat watches the
# log grow, and says so when it stops.
#
# Piped rather than followed with `tail -f`: in `a | b | c &` the shell reports
# only c's pid, so killing it would leave tail running after the script exits.
# stderr goes to /dev/null, and only stderr: the loop reports on stdout. The
# subshell spends its life blocked in `sleep`, so stopping it makes the shell
# announce "Terminated: 15 sleep 30" — which then lands in the middle of a
# build failure looking like one more thing that went wrong.
start_heartbeat() { # start_heartbeat LOGFILE
  ( log="$1"
    elapsed=0
    last_size=0
    stalled=0
    while true; do
      sleep 30
      elapsed=$(( elapsed + 30 ))
      size=$(wc -c < "$log" 2>/dev/null || echo 0)
      if [ "$size" -eq "$last_size" ]; then
        stalled=$(( stalled + 30 ))
      else
        stalled=0
        last_size="$size"
      fi
      if [ "$stalled" -ge 120 ]; then
        printf '\033[33m  Nothing written for %dm. Last line:\033[0m\n' "$(( stalled / 60 ))"
        printf '\033[2m    %s\033[0m\n' "$(tail -1 "$log" 2>/dev/null | cut -c1-100)"
        printf '\033[33m  If another xcodebuild or Xcode itself is open on this package, they are\033[0m\n'
        printf '\033[33m  sharing SwiftPM'"'"'s lock and this one waits forever. Check with:\033[0m\n'
        printf '\033[2m    ps -eo pid,etime,args | grep [x]codebuild\033[0m\n'
        stalled=0
      else
        printf '\033[2m  … still building (%dm%02ds)\033[0m\n' "$(( elapsed / 60 ))" "$(( elapsed % 60 ))"
      fi
    done ) 2>/dev/null &
  HEARTBEAT_PID=$!
}

stop_heartbeat() {
  if [ -n "${HEARTBEAT_PID:-}" ]; then
    # Children first. The subshell spends nearly all its life blocked in
    # `sleep`, and killing only the subshell leaves that sleep orphaned —
    # harmless, but it keeps the terminal's process list dirty for half a
    # minute after a build that has visibly finished.
    pkill -P "$HEARTBEAT_PID" 2>/dev/null || true
    kill "$HEARTBEAT_PID" 2>/dev/null || true
  fi
  HEARTBEAT_PID=""
}

# Run one xcodebuild, showing the phases and hiding the rest. xcodebuild's own
# exit status lands in BUILD_STATUS — not the filter's, which is 0 whenever the
# filter matched nothing at all.
#
# Reported through a variable rather than returned, deliberately. Returning it
# would make the call itself a failing command, and every caller runs under
# `set -e`, so a failed build would exit the script before it could summarise
# the log — the one moment the output actually matters.
run_build() { # run_build LOGFILE WORKDIR COMMAND...
  local log="$1" workdir="$2"
  shift 2
  set +e +o pipefail
  start_heartbeat "$log"
  ( cd "$workdir" && "$@" ) 2>&1 \
    | tee "$log" \
    | grep --line-buffered -E "$BUILD_FILTER" \
    | awk '{ if (length($0) > 110) $0 = substr($0, 1, 107) "..."; print "  " $0; fflush() }'
  BUILD_STATUS=${PIPESTATUS[0]}
  set -e -o pipefail
  stop_heartbeat
}

# The last twenty distinct errors, which is invariably where the cause is.
summarise_failure() { # summarise_failure LOGFILE
  echo >&2
  # Each error WITH the note: lines under it. Swift explains "ambiguous use of
  # X" by listing the competing declarations in notes directly beneath the
  # error, and "cannot convert" the same way. Grepping for error: alone leaves
  # the one line that cannot be acted on and discards the answer — which is how
  # you end up guessing at a diagnosis the compiler already printed.
  awk '
    /: error:/        { print; keep = 1; want = 0; next }
    # A note names a competing declaration; the indented line under it is the
    # signature, which is the part worth reading. Joined into one line so the
    # pair survives the de-duplication below — Xcode repeats each diagnostic
    # once per target.
    keep && /: note:/ { pending = $0; want = 1; next }
    # The echoed source line and its caret sit between the error and its notes,
    # and both are indented. Treating them as the end of the diagnostic drops
    # every note that follows.
    keep && want && /^[[:space:]]/ { sub(/^[[:space:]]+/, ""); print pending "  " $0; want = 0; next }
    keep && /^[[:space:]]/ { next }
    /Error Domain/    { print; keep = 0; next }
    { keep = 0 }
  ' "$1" | awk '!seen[$0]++' | head -40 | copy_and_show >&2
}

# Print, and put the same text on the clipboard. Pasting a failure back is the
# whole feedback loop here, and selecting it out of a scrolled terminal is the
# part that goes wrong — a truncated paste costs a round trip.
copy_and_show() {
  if command -v pbcopy >/dev/null 2>&1; then
    tee /tmp/timi-last-failure.txt
    pbcopy < /tmp/timi-last-failure.txt
    printf '\033[2m  (copied to the clipboard — paste it as-is)\033[0m\n'
  else
    cat
  fi
}

# The team id is the OU of the Apple Development certificate. The name in
# parentheses on the certificate is the individual, not the team, so reading it
# from there gives a value that looks right and signs nothing.
# Where it came from lands in RESOLVED_TEAM_SOURCE, for the caller to print:
# "team ABCDE12345" alone is not much help when it is the wrong one.
resolve_team() { # resolve_team [LOCAL_XCCONFIG]
  local config="${1:-}" team=""
  RESOLVED_TEAM_SOURCE=""
  if [ -n "$config" ] && [ -f "$config" ]; then
    team="$(awk -F'=' '/^[[:space:]]*DEVELOPMENT_TEAM/ { gsub(/[[:space:]]/, "", $2); print $2 }' "$config")"
    [ -n "$team" ] && RESOLVED_TEAM_SOURCE="$config"
  fi
  if [ -z "$team" ]; then
    team="$(security find-certificate -c "Apple Development" -p 2>/dev/null \
      | openssl x509 -noout -subject 2>/dev/null \
      | tr ',/' '\n\n' | awk -F'=' '/OU=/ { gsub(/[[:space:]]/, "", $2); print $2; exit }')"
    [ -n "$team" ] && RESOLVED_TEAM_SOURCE="the Apple Development certificate in your login keychain"
  fi
  printf '%s' "$team"
}

# Maps and turn-by-turn are only compiled in when a Mapbox downloads token is
# configured, because the Mapbox SDKs are binary dependencies fetched over
# authenticated HTTP. Without it you get the fallback — a ranked clinic list,
# no live map — which is far too easy to mistake for a bug, so say which build
# this is rather than leaving it to be noticed.
select_mapbox() {
  if grep -q "api.mapbox.com" "$HOME/.netrc" 2>/dev/null; then
    export TIMI_MAPBOX=1
    echo "  downloads token found — building with the map and turn-by-turn"
  else
    warn "  No api.mapbox.com entry in ~/.netrc, so this build takes the"
    warn "  non-Mapbox fallback: a ranked clinic list, no live map, no navigation."
    dim  "  ./scripts/bootstrap.sh <your-env-file> writes that entry for you."
  fi
}
