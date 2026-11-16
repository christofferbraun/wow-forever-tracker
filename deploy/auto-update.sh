#!/usr/bin/env bash
# Pulls new commits on main from GitHub and redeploys with docker compose.
#
# Run every couple of minutes by the wow-forever-update systemd timer
# (install it with: sudo deploy/install-auto-update.sh), or by hand:
#   deploy/auto-update.sh            deploy only if there's something new
#   FORCE=1 deploy/auto-update.sh    rebuild even if nothing changed
#
# A failed build leaves the running container untouched. That commit isn't retried
# on every tick; the next push (or FORCE=1) tries again.

set -euo pipefail

# Everything lives in main() so bash has read the whole script before running it:
# the pull below can rewrite this very file.
main() {
  local repo branch state deployed failed head status
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  branch="${BRANCH:-main}"
  state="$repo/.git/auto-update"
  cd "$repo"
  mkdir -p "$state"

  # One run at a time (a slow build must not overlap the next timer tick).
  exec 9>"$state/lock"
  if ! flock -n 9; then
    echo "Another update is still running; skipping this one."
    return 0
  fi

  git fetch --quiet origin "$branch"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ]; then
    local old
    old="$(git rev-parse HEAD)"
    if ! git merge --ff-only --quiet "origin/$branch"; then
      echo "Can't fast-forward to origin/$branch. Files were edited or committed on this server;" >&2
      echo "run 'git status' in $repo and sort it out by hand. Nothing was deployed." >&2
      return 1
    fi
    echo "Pulled $(git rev-parse --short "$old")..$(git rev-parse --short HEAD):"
    git log --oneline --no-decorate "$old..HEAD" | sed 's/^/  /'
  fi

  head="$(git rev-parse HEAD)"
  deployed="$(cat "$state/deployed" 2>/dev/null || true)"
  failed="$(cat "$state/failed" 2>/dev/null || true)"

  if [ "${FORCE:-0}" = 1 ]; then
    echo "Rebuilding $(git rev-parse --short HEAD) (FORCE=1)."
  elif [ "$head" = "$deployed" ] || [ "$head" = "$failed" ]; then
    return 0
  elif [ -n "$deployed" ] && git cat-file -e "$deployed^{commit}" 2>/dev/null \
    && ! git diff --name-only "$deployed" "$head" | grep -qvE '^(README\.md|LICENSE|deploy/)'; then
    # Only docs or these deploy scripts changed: the running app is already current.
    echo "Only docs/deploy files changed; no rebuild needed."
    echo "$head" > "$state/deployed"
    return 0
  fi

  echo "Rebuilding and restarting…"
  if ! docker compose up -d --build --remove-orphans; then
    echo "$head" > "$state/failed"
    echo "Build or start failed for $(git rev-parse --short HEAD); the previous version keeps running." >&2
    return 1
  fi
  # The previous build's image is now untagged; don't let them pile up.
  docker image prune -f >/dev/null || true

  status=unknown
  for _ in $(seq 1 45); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' wow-forever-app 2>/dev/null || echo missing)"
    if [ "$status" = healthy ]; then
      echo "$head" > "$state/deployed"
      rm -f "$state/failed"
      echo "Deployed $(git rev-parse --short HEAD); the app is healthy."
      return 0
    fi
    sleep 2
  done
  echo "$head" > "$state/failed"
  echo "The app isn't healthy 90 s after deploying (status: $status). Check: docker compose logs app" >&2
  return 1
}

main "$@"
exit
