#!/usr/bin/env bash
# Commit explicit reviewed files and push the matching development branch.
set -euo pipefail

fail() { printf 'session-sync: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: bash scripts/session-sync.sh --branch mac|ubuntu --message "Commit message" -- file [file ...]'
}

branch=''
message=''
has_separator=false
while (($#)); do
  case "$1" in
    --branch) (($# >= 2)) || fail 'Missing --branch value.'; branch=$2; shift 2 ;;
    --message) (($# >= 2)) || fail 'Missing --message value.'; message=$2; shift 2 ;;
    --) has_separator=true; shift; break ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
done
[[ "$branch" == mac || "$branch" == ubuntu ]] || fail 'Choose --branch mac or --branch ubuntu.'
[[ -n "${message//[[:space:]]/}" ]] || fail 'Supply a nonempty --message.'
[[ "$has_separator" == true && $# -gt 0 ]] || fail 'List explicit files after --.'

for variable in GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES; do
  [[ -z "${!variable:-}" ]] || fail "Unset $variable before running this script."
done

script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$script_root"
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'This directory is not a Git checkout.'
[[ "$(cd -- "$repo_root" && pwd -P)" == "$script_root" ]] || fail 'The script must belong to the repository root being synced.'
[[ "$(git symbolic-ref --quiet --short HEAD)" == "$branch" ]] || fail "Check out $branch deliberately before syncing; no branch was changed."

valid_origin() {
  case "$1" in
    https://github.com/Masudali23/interface-agent-desktop|https://github.com/Masudali23/interface-agent-desktop.git|git@github.com:Masudali23/interface-agent-desktop|git@github.com:Masudali23/interface-agent-desktop.git|ssh://git@github.com/Masudali23/interface-agent-desktop|ssh://git@github.com/Masudali23/interface-agent-desktop.git) return 0 ;;
    *) return 1 ;;
  esac
}
origin_fetch=$(git remote get-url --all origin) || fail 'Missing origin remote.'
origin_push=$(git remote get-url --push --all origin) || fail 'Missing origin push remote.'
valid_origin "$origin_fetch" && valid_origin "$origin_push" || fail 'Origin must have one fetch URL and one push URL for Masudali23/interface-agent-desktop.'

for operation in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer BISECT_LOG; do
  [[ ! -e "$(git rev-parse --git-path "$operation")" ]] || fail "Finish the existing Git operation ($operation) first."
done
git diff --cached --quiet || fail 'The index already has staged changes; preserve them and ask their owner to finish first.'

files=("$@")
pathspecs=()
excluded_pathspecs=()
for file in "${files[@]}"; do
  [[ -n "$file" && "$file" != /* ]] || fail 'Paths must be explicit files relative to the repository root.'
  case "/$file/" in
    *'/../'*|*'/./'*|*'//'*) fail "Use a normalized repository-relative file path: $file" ;;
  esac
  [[ "$file" != .git && "$file" != .git/* ]] || fail 'Git metadata cannot be committed.'
  [[ ! -d "$file" || -L "$file" ]] || fail "Directories are not allowed; list individual files: $file"
  if git check-ignore --no-index --quiet -- "$file"; then
    fail "Ignored files cannot be published by this script: $file"
  else
    [[ $? == 1 ]] || fail "Could not check ignore rules for: $file"
  fi
  if [[ ! -f "$file" && ! -L "$file" ]]; then
    git ls-files --error-unmatch -- ":(literal)$file" >/dev/null 2>&1 || fail "File does not exist and is not a tracked deletion: $file"
  fi
  pathspecs+=(":(literal)$file")
  excluded_pathspecs+=(":(literal,exclude)$file")
done

trailer_pattern='^(co-authored-by|generated-by|assisted-by|ai-assisted-by):'
if grep -Ei "$trailer_pattern" <<< "$message" >/dev/null; then
  fail 'Commit messages must not contain co-author or AI attribution trailers.'
fi

export GIT_AUTHOR_NAME='Masudali23'
export GIT_AUTHOR_EMAIL='alimasud2023@gmail.com'
export GIT_COMMITTER_NAME='Masudali23'
export GIT_COMMITTER_EMAIL='alimasud2023@gmail.com'
identity='Masudali23 <alimasud2023@gmail.com>'
remote_ref="refs/remotes/origin/$branch"

git fetch --no-tags origin "refs/heads/$branch:$remote_ref"
git merge-base --is-ancestor "$remote_ref" HEAD || fail 'The local branch is behind or diverged. Integrate deliberately; local files were not changed.'

check_outgoing() {
  local tip=$1 recorded identities bodies
  identities=$(git log --format='%an <%ae>|%cn <%ce>' "$remote_ref..$tip") || fail 'Could not inspect outgoing commit identities.'
  if [[ -n "$identities" ]]; then
    while IFS= read -r recorded; do
      [[ "$recorded" == "$identity|$identity" ]] || fail 'An outgoing commit has a different author/committer. Preserve it and resolve explicitly before publishing.'
    done <<< "$identities"
  fi
  bodies=$(git log --format='%B' "$remote_ref..$tip") || fail 'Could not inspect outgoing commit messages.'
  if grep -Ei "$trailer_pattern" <<< "$bodies" >/dev/null; then
    fail 'An outgoing commit contains an attribution trailer. Preserve it and resolve explicitly before publishing.'
  fi
}
check_outgoing HEAD

printf 'Validating selected work for %s:\n' "$branch"
git status --short --untracked-files=all -- "${pathspecs[@]}"
git diff --stat -- "${pathspecs[@]}"
npm run typecheck
npm test
npm run build

[[ "$(git symbolic-ref --quiet --short HEAD)" == "$branch" ]] || fail 'The current branch changed during validation.'
git diff --cached --quiet || fail 'The index changed during validation; preserve those staged changes and coordinate with their owner.'
git add -- "${pathspecs[@]}"
git diff --cached --quiet && fail 'The selected files have no changes to commit.'
git -c user.name="$GIT_AUTHOR_NAME" -c user.email="$GIT_AUTHOR_EMAIL" commit --only -m "$message" -- "${pathspecs[@]}"
revision=$(git rev-parse HEAD)
check_outgoing "$revision"

git diff-tree --quiet --exit-code --root --no-renames -r "$revision" -- "${excluded_pathspecs[@]}" || fail 'Could not verify that the commit contains only selected files. The local commit is preserved; inspect it before pushing.'

[[ "$(git symbolic-ref --quiet --short HEAD)" == "$branch" ]] || fail "The branch changed after committing. Preserve and inspect $revision before publishing."
[[ "$(git remote get-url --push --all origin)" == "$origin_push" ]] || fail 'The push URL changed during validation; the local commit is preserved.'
git -c push.followTags=false -c remote.origin.mirror=false push origin "$revision:refs/heads/$branch" || fail "Push failed. Commit $revision remains local; inspect the remote before retrying a normal push."
printf 'Published %s to %s using %s.\n' "$revision" "$branch" "$identity"
