#!/bin/zsh
# A world round, start to BUILD_DONE: snapshot, pinned worktree, full middle-stage retile (SYDNEY_ROUND=<dir>).
set -u
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
MAIN=/Volumes/underbelly/Code/sydrunner
R=${SYDNEY_ROUND:?set SYDNEY_ROUND=<round dir under data/scratch>}
W=$MAIN/client/public/world
WT=$R/wt-round
SHA=$(git -C $MAIN rev-parse HEAD)
echo "round at $SHA  $(date)"
# 1. snapshot
mkdir -p $R/before
[ -d $R/before/tiles ] || { echo "snapshot tiles $(date)"; cp -R $W/tiles $R/before/tiles || { echo ABORT snapshot tiles; exit 1; }; }
[ -d $R/before/collision ] || cp -R $W/collision $R/before/collision
for f in far.bin far-cover.bin far-terrain.bin far-water.bin landmarks.glb index.json root.json street-names.bin suburbs.json; do cp $W/$f $R/before/ 2>/dev/null; done
[ -d $R/before/hexes ] || cp -R $W/hexes $R/before/hexes
[ -f $R/before/regions-before.json ] || {
  echo "hashing regions $(date)"
  (cd $W/regions && for f in *.bin; do printf '"%s":"%s",\n' "$f" "$(shasum -a 256 ./$f | cut -c1-64)"; done | sed '$ s/,$//' | { echo '{'; cat; echo '}'; }) > $R/before/regions-before.json
}
echo "snapshot done $(date): $(ls $R/before/tiles | wc -l) tile files"
# 2. pinned worktree, world symlinked in
git -C $MAIN worktree prune
[ -d $WT ] || git -C $MAIN worktree add --detach $WT $SHA >/dev/null 2>&1 || { echo ABORT worktree; exit 1; }
for l in node_modules client/node_modules server/node_modules data; do rm -rf $WT/$l; ln -s $MAIN/$l $WT/$l; done
rm -rf $WT/client/public/world; ln -s $W $WT/client/public/world
echo "worktree $WT ready $(date)"
# 3. build
cd $WT/pipeline
echo "build start $(date)"
uv run python -m sydney build --stage middle --retile --rebuild 2>&1
rc=$?
echo "build rc=$rc $(date)"
[ $rc -eq 0 ] && echo "BUILD_DONE $SHA" || echo "BUILD_FAILED $rc"
