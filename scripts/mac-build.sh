#!/usr/bin/env bash
# Build and install Interface without deleting a bundle used by a running app.
# --install-only reuses dist/mac-arm64/Interface.app and verifies it again.
set -euo pipefail

fail() { printf 'mac-build: %s\n' "$*" >&2; exit 1; }
install_only=false
case "${1:-}" in
  '') ;;
  --install-only) install_only=true; shift ;;
  -h|--help) printf '%s\n' 'Usage: bash scripts/mac-build.sh [--install-only]'; exit 0 ;;
  *) fail "Unknown option: $1" ;;
esac
(($# == 0)) || fail 'Unexpected arguments.'
[[ "$(uname -s)" == Darwin ]] || fail 'Run this installer on macOS.'
[[ "$(uname -m)" == arm64 ]] || fail 'This build targets Apple Silicon; use an arm64 shell.'

script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$script_root"
source_app="$script_root/dist/mac-arm64/Interface.app"
installed_app='/Applications/Interface.app'
installed_main="$installed_app/Contents/MacOS/Interface"
source_main="$source_app/Contents/MacOS/Interface"
lock_dir='/Applications/.Interface-install.lock'
stage_dir=''
backup_dir=''
backup_app=''

# Match the full main executable, not helpers or another similarly named app.
main_pids() {
  local executable=$1 processes
  processes=$(ps -axww -o pid=,comm=) || fail 'Could not inspect running applications.'
  awk -v executable="$executable" '
    { pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); if ($0 == executable) print pid }
  ' <<< "$processes"
}

# A failed process query is treated conservatively: retain the old bundle.
pids_running() {
  local ids=$1 pid result
  for pid in $ids; do
    if ps -p "$pid" -o pid= >/dev/null 2>&1; then return 0; else result=$?; fi
    [[ "$result" == 1 ]] || return 0
  done
  return 1
}

for tool in ditto codesign lipo ps awk mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required macOS tool is missing: $tool"
done
[[ ! -L "$installed_app" && ! -L "$source_app" ]] || fail 'App bundle paths must not be symlinks.'
[[ ! -e "$installed_app" || -d "$installed_app" ]] || fail 'The installation path exists but is not an app directory.'

# Avoid rebuilding a bundle from which someone launched a development copy.
source_pids=$(main_pids "$source_main")
if [[ "$install_only" == false ]]; then
  [[ -z "$source_pids" ]] || fail 'The dist app is running. Quit that copy before rebuilding; it has been left untouched.'
  xcode-select -p >/dev/null 2>&1 || fail 'Install Xcode Command Line Tools before building.'
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || fail 'Node.js and npm are required to build.'
  node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22 || major===22 && minor>=12 ? 0 : 1)' || fail 'Use Node.js 22.12 or newer.'
  npm ci
  npm run typecheck
  npm test
  npm run dist:mac # Includes npm run build, followed by ARM64 packaging.
fi

[[ -d "$source_app" && -x "$source_main" ]] || fail 'Missing dist/mac-arm64/Interface.app; run a full build first.'
codesign --verify --deep --strict --verbose=2 "$source_app" || fail 'The build did not pass code-signature verification.'
architectures=$(lipo -archs "$source_main") || fail 'Could not inspect the app architecture.'
[[ " $architectures " == *' arm64 '* ]] || fail 'The built executable does not contain arm64 code.'
mkdir "$lock_dir" 2>/dev/null || fail "Another installation may be in progress. Inspect $lock_dir before retrying."

cleanup() {
  local result=$?
  trap - EXIT
  # An unsuccessful final rename leaves the destination empty. Restore the
  # preserved bundle; never overwrite a destination created by another process.
  if [[ -n "$backup_app" && -d "$backup_app" && ! -e "$installed_app" && ! -L "$installed_app" ]]; then
    if mv -- "$backup_app" "$installed_app"; then
      printf 'Restored the previous app at %s.\n' "$installed_app" >&2
    else
      printf 'Restore failed; the previous app is preserved at %s.\n' "$backup_app" >&2
    fi
  fi
  [[ -z "$stage_dir" || ! -d "$stage_dir" ]] || rm -rf -- "$stage_dir"
  if [[ -n "$backup_dir" && ! -e "$backup_app" ]]; then rmdir -- "$backup_dir" 2>/dev/null || true; fi
  rmdir -- "$lock_dir" 2>/dev/null || true
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Stage on the destination filesystem so the final move is a rename.
stage_dir=$(mktemp -d '/Applications/.Interface-stage.XXXXXX')
stage_app="$stage_dir/Interface.app"
ditto "$source_app" "$stage_app"
codesign --verify --deep --strict --verbose=2 "$stage_app" || fail 'The staged app did not pass code-signature verification.'

previous_pids=$(main_pids "$installed_main")
if [[ -d "$installed_app" ]]; then
  backup_dir=$(mktemp -d '/private/tmp/Interface-previous.XXXXXX')
  backup_app="$backup_dir/Interface.previous"
  mv -- "$installed_app" "$backup_app"
  # Catch a process launched between the first snapshot and the move.
  previous_pids="$previous_pids"$'\n'"$(main_pids "$installed_main")"
fi

mv -- "$stage_app" "$installed_app" || fail 'Installing the staged app failed; restoring the previous bundle.'
if ! codesign --verify --deep --strict --verbose=2 "$installed_app"; then
  mv -- "$installed_app" "$stage_app" || fail "Final verification failed. The previous app remains at $backup_app; inspect both copies before restoring."
  fail 'Final verification failed; restoring the previous bundle.'
fi
printf 'Installed and verified %s.\n' "$installed_app"

running=false
if [[ -n "$backup_app" ]]; then
  if pids_running "$previous_pids"; then
    running=true
    printf 'The running app is preserved at %s.\n' "$backup_app"
  else
    rm -rf -- "$backup_app"
    rmdir -- "$backup_dir"
    backup_app=''
    backup_dir=''
  fi
elif pids_running "$previous_pids"; then
  running=true
fi

# Remove the duplicate Spotlight bundle, preserving it elsewhere if someone
# launched the build copy while installation was in progress.
source_pids=$(main_pids "$source_main")
if pids_running "$source_pids"; then
  source_backup_dir=$(mktemp -d '/private/tmp/Interface-build-running.XXXXXX')
  source_backup_app="$source_backup_dir/Interface.previous"
  mv -- "$source_app" "$source_backup_app"
  running=true
  printf 'The running build copy is preserved at %s.\n' "$source_backup_app"
else
  rm -rf -- "$source_app"
fi
printf 'Removed the duplicate app bundle from dist/mac-arm64.\n'

current_pids=$(main_pids "$installed_main")
if [[ "$running" == true ]] || pids_running "$current_pids"; then
  printf '%s\n' 'Quit Interface with Cmd+Q, then reopen /Applications/Interface.app to use the update.'
  printf '%s\n' 'Keep any printed backup until the old process has exited; no background cleanup was scheduled.'
else
  printf '%s\n' 'Open /Applications/Interface.app when ready.'
fi
