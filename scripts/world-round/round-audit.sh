#!/bin/zsh
# Audit a world round after its build: DEPLOY.md section B step 2 as one script (SYDNEY_ROUND=<dir>). Every step logs; the summary at the end is the gate.
set -u
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
MAIN=/Volumes/underbelly/Code/sydrunner
R=${SYDNEY_ROUND:?set SYDNEY_ROUND=<round dir under data/scratch>}
W=$MAIN/client/public/world
WT=$R/wt-round
L=$R/audit
mkdir -p $L
echo "audit start $(date)"
cd $WT/pipeline
run() { local name=$1; shift; echo "== $name $(date)"; "$@" > $L/$name.log 2>&1; echo "$name rc=$?"; }
run hex-pack uv run python -m sydney hex-pack
[ $W/far-cover.bin -ot $W/far.bin ] && run far-cover uv run python -m sydney far-cover
run station-clear-audit uv run python -m sydney station-clear-audit
run collision-fit-audit uv run python -m sydney collision-fit-audit
run rail-veg-audit uv run python -m sydney rail-veg-audit
run fence-road-audit uv run python -m sydney fence-road-audit
run landmark-audit uv run python -m sydney landmark-audit
run lane-audit uv run python -m sydney lane-audit
run terrain-audit uv run python -m sydney terrain-audit
# terrain byte-diff against the snapshot
echo "== terrain diff $(date)"
: > $L/terr-changed.txt
for f in $R/before/tiles/*.terr.bin; do b=$(basename $f); cmp -s $f $W/tiles/$b || echo $b >> $L/terr-changed.txt; done
echo "terr changed: $(wc -l < $L/terr-changed.txt) of $(ls $R/before/tiles/*.terr.bin | wc -l)"
# region bundles that changed (hash)
echo "== regions diff $(date)"
(cd $W/regions && for f in *.bin; do printf '"%s":"%s",\n' "$f" "$(shasum -a 256 ./$f | cut -c1-64)"; done | sed '$ s/,$//' | { echo '{'; cat; echo '}'; }) > $R/regions-after.json
python3 - <<PY
import json
a=json.load(open('$R/before/regions-before.json')); b=json.load(open('$R/regions-after.json'))
ch=[k for k in b if a.get(k)!=b[k]]; print(f"regions changed: {len(ch)} of {len(b)}; new: {len(set(b)-set(a))}; gone: {len(set(a)-set(b))}")
open('$L/regions-changed.txt','w').write('\n'.join(sorted(ch))+'\n')
PY
cd $MAIN
run undrawn-solids bun run server/undrawn-solids-check.ts
run overpass-clearance bun run server/overpass-clearance-check.ts
run clash-check bun run server/clash-check.ts
# rail against the new terrain
cd $WT/pipeline
run rail-bake uv run python -m sydney rail-bake
run rail-audit uv run python -m sydney rail-audit
cd $MAIN
run chatswood-check bun run server/chatswood-check.ts
run underground-check bun run server/underground-check.ts
# --- the publish lists: every changed object for R2, and the server's files for the box
echo "== publish lists $(date)"
ls $W/tiles > $L/tiles-after.txt; ls $R/before/tiles > $L/tiles-before.txt
comm -12 $L/tiles-before.txt $L/tiles-after.txt | xargs -P 8 -I{} sh -c 'cmp -s "'$R'/before/tiles/{}" "'$W'/tiles/{}" || echo {}' > $L/tiles-changed.txt
comm -13 $L/tiles-before.txt $L/tiles-after.txt > $L/tiles-new.txt
comm -23 $L/tiles-before.txt $L/tiles-after.txt > $L/tiles-gone.txt
{ sed 's#^#tiles/#' $L/tiles-changed.txt; sed 's#^#tiles/#' $L/tiles-new.txt; sed 's#^#regions/#' $L/regions-changed.txt;
  for f in $W/hexes/*; do b=$(basename $f); cmp -s $R/before/hexes/$b $f || echo "hexes/$b"; done;
  for f in $W/collision/*; do b=$(basename $f); cmp -s $R/before/collision/$b $f || echo "collision/$b"; done;
  for f in far.bin far-cover.bin far-terrain.bin far-water.bin landmarks.glb street-names.bin suburbs.json; do cmp -s $R/before/$f $W/$f || echo $f; done; } | sort -u > $R/publish-keys.txt
{ grep -E "^tiles/.*\.(lanes|terr|pow|cars)\.bin$" $R/publish-keys.txt; grep -E "^collision/" $R/publish-keys.txt; grep -vE "^(tiles|regions|hexes|collision)/" $R/publish-keys.txt; echo root.json; echo index.json; } | sort -u > $R/box-files.txt
echo "publish keys: $(wc -l < $R/publish-keys.txt); box files: $(wc -l < $R/box-files.txt); tiles changed $(wc -l < $L/tiles-changed.txt) new $(wc -l < $L/tiles-new.txt) gone $(wc -l < $L/tiles-gone.txt)"
echo "== summary $(date)"
for f in $L/*.log; do n=$(basename $f .log); tail -1 $f | cut -c1-160 | sed "s/^/$n: /"; done
echo "AUDIT_DONE $(date)"
