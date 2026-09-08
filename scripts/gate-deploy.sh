#!/bin/zsh
# Gate and deploy the main checkout's HEAD: DEPLOY.md §A as one script that
# aborts on the first red light.
#
# Why a script and not the runbook: the runbook was run by hand forty times
# in one week and the two slips it produced were both "carried on past the
# gate" -- once a crash-looping server was shipped because the chain printed
# the gate and kept going (memory: deploy-chain-must-abort-on-the-boot-gate).
# The other trap this exists to avoid is building in the main checkout, whose
# `client/public/world` is the real 16 GB world that `vite build` would copy
# into `dist`; so every build happens in a throwaway worktree of the exact
# commit, with the world symlink absent and everything else symlinked in.
#
# Usage:  scripts/gate-deploy.sh > deploy.log 2>&1
# Prints `DEPLOY_DONE <sha>` as its last line on success; anything else is a
# failure, and the last lines say which step.
#
# Env: SYDNEY_SCRATCH (where the worktree and gate state go; defaults to a
# sibling of the repo), SYDNEY_GATE_PORT (8799).

set -u
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"

MAIN="$(cd "$(dirname "$0")/.." && pwd)"
S="${SYDNEY_SCRATCH:-$MAIN/../sydrunner-deploy-scratch}"
PORT="${SYDNEY_GATE_PORT:-8799}"
WT="$S/wt-deploy"
SSHOPT="ssh -i $HOME/.ssh/sydney_deploy -o BatchMode=yes -o ServerAliveInterval=30"
BOX=root@oxford-tractor.bnr.la
SITE=https://sydrunner.3rp.uk

die() { echo "ABORT: $*"; exit 1; }
mkdir -p "$S"

SHA=$(git -C "$MAIN" rev-parse HEAD) || die "not a git checkout"
echo "deploying $SHA"

# --- 0. A worktree of exactly this commit, with the world ABSENT.
git -C "$MAIN" worktree prune
rm -rf "$WT"
git -C "$MAIN" worktree add --detach -f "$WT" "$SHA" >/dev/null 2>&1 || die "worktree add failed"
for l in node_modules client/node_modules server/node_modules data; do
  rm -rf "$WT/$l"; ln -s "$MAIN/$l" "$WT/$l"
done
rm -rf "$WT/client/public/world"
[ -e "$WT/client/public/world" ] && die "world still present in the build worktree"

# --- 1. Typecheck both ends.
(cd "$WT" && npm run typecheck >/dev/null 2>&1) || die "typecheck failed"
echo "typecheck ok"

# --- 2. Boot gate: the server refuses to start on a failed self-check
#        (process.exit(1)), so "health answers" is the gate.
if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is already listening; kill it by pid first"
fi
mkdir -p "$S/state-gate"
(cd "$WT" && SYDNEY_PORT="$PORT" SYDNEY_STATE_DIR="$S/state-gate" \
   SYDNEY_WORLD="$MAIN/client/public/world" \
   bun run server/index.ts > "$S/gate-boot.log" 2>&1 &)
ok=0
for i in $(seq 1 60); do
  sleep 5
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
  if grep -qE "self-check(s)? fail|FAIL" "$S/gate-boot.log" 2>/dev/null; then break; fi
  if ! lsof -tiTCP:"$PORT" >/dev/null 2>&1 && grep -qE "error|Error" "$S/gate-boot.log" 2>/dev/null && [ "$i" -gt 6 ]; then break; fi
done
pids=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
[ -n "$pids" ] && kill $pids 2>/dev/null
if [ "$ok" != 1 ]; then
  echo "--- gate-boot.log (tail)"; tail -20 "$S/gate-boot.log"
  die "boot gate failed"
fi
grep -q "self-checks pass" "$S/gate-boot.log" || die "boot answered health without the self-check line"
echo "gate passed"

# --- 3. Build and precompress, in the worktree.
(cd "$WT/client" && npm run build 2>&1 | grep -E "built in|error" ) || true
[ -f "$WT/client/dist/index.html" ] || die "vite build produced no dist"
LOCAL_JS=$(grep -oE "index-[A-Za-z0-9_-]+\.js" "$WT/client/dist/index.html" | head -1)
sh "$WT/scripts/precompress-dist.sh" 2>&1 | tail -1

# --- 4. Ship. rsync never touches world/ (that is the world publish, §B)
#        and never touches SYDNEY_STATE_DIR on the box.
rsync -a --partial --delete --exclude 'world/' -e "$SSHOPT" "$WT/client/dist/" "$BOX:/opt/sydney/dist/" || die "dist rsync failed"
rsync -az --partial --delete -e "$SSHOPT" "$WT/client/src/" "$BOX:/opt/sydney/client/src/" || die "client/src rsync failed"
rsync -az --partial --delete --exclude node_modules -e "$SSHOPT" "$WT/server/" "$BOX:/opt/sydney/server/" || die "server rsync failed"
ssh -i "$HOME/.ssh/sydney_deploy" -o BatchMode=yes "$BOX" 'chown -R root:root /opt/sydney && systemctl restart sydney' || die "restart failed"

# --- 5. Gate the box on /health, then prove the bundle the site serves is ours.
ok=0
for i in $(seq 1 48); do
  sleep 5
  if curl -sf "$SITE/health" >/dev/null 2>&1; then ok=1; break; fi
done
[ "$ok" = 1 ] || die "the box never answered /health after restart"
echo "health 200 after restart: $(curl -s "$SITE/health" | grep -oE '"protocol":[0-9]+')"
LIVE_JS=$(curl -s "$SITE/" | grep -oE "index-[A-Za-z0-9_-]+\.js" | head -1)
echo "bundle local=$LOCAL_JS live=$LIVE_JS"
[ "$LOCAL_JS" = "$LIVE_JS" ] || die "the site serves a different bundle than the one built"

# --- 6. Push, and say so.
git -C "$MAIN" push -q origin HEAD:main && echo "pushed" || echo "push failed (deploy is live regardless)"
echo "DEPLOY_DONE $SHA"
