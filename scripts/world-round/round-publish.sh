#!/bin/zsh
# Publish a world round (SYDNEY_ROUND=<dir>; STOP_AFTER_R2=1 / SKIP_R2=1 split the run): DEPLOY.md §B steps 4-5, changed bytes only.
#   1. R2: every changed key (tiles, regions, hexes, far layer, landmarks, collision), brotli, immutable.
#   2. Prove a sample from outside.
#   3. Box: the server's sidecars + collision + far layer + landmarks, no --delete, no regions, no glb.
#   4. Pivots: local index/root + cdn block with an empty except list; .br/.zst made here; box last.
#   5. Restart, health, prove the pivot from outside.
set -u
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
MAIN=/Volumes/underbelly/Code/sydrunner
R=${SYDNEY_ROUND:?set SYDNEY_ROUND=<round dir under data/scratch>}
W=$MAIN/client/public/world
SSHOPT="ssh -i $HOME/.ssh/sydney_deploy -o BatchMode=yes -o ServerAliveInterval=30"
BOX=root@oxford-tractor.bnr.la
CDN=https://world.3rp.uk
SITE=https://sydrunner.3rp.uk
die() { echo "ABORT: $*"; exit 1; }
cd $MAIN
echo "publish start $(date)"

# --- 1. R2
if [ "${SKIP_R2:-0}" != 1 ]; then
bun run scripts/world-round/r2-upload.ts $W $R/publish-keys.txt $R/r2-results.jsonl 12 > $R/r2-upload.log 2>&1
echo "r2 upload rc=$? $(date)"
tail -3 $R/r2-upload.log
fi
# every key must have a success row
python3 - <<PY || die "R2 upload incomplete"
import sys
keys=set(l.strip() for l in open('$R/publish-keys.txt') if l.strip())
ok=set()
for l in open('$R/r2-results.jsonl'):
    p=l.split()
    if len(p)>=3 and p[0]=='OK' and p[2] in ('200','201'): ok.add(p[1])
missing=keys-ok
print(f"R2: {len(ok)} ok, {len(missing)} missing of {len(keys)}")
if missing:
    print('\n'.join(sorted(missing)[:20])); sys.exit(1)
PY

# --- 2. Prove three objects from outside: a tile, a region, the landmark file.
for k in $(grep -m1 '^tiles/.*\.glb$' $R/publish-keys.txt) $(grep -m1 '^regions/' $R/publish-keys.txt) landmarks.glb; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: br' "$CDN/$k")
  local_md5=$(md5 -q "$W/$k")
  remote_md5=$(curl -s -H 'Accept-Encoding: br' "$CDN/$k" | brotli -d 2>/dev/null | md5 -q)
  echo "probe $k http=$code local=$local_md5 remote=$remote_md5"
  [ "$code" = 200 ] || die "CDN probe failed for $k"
  [ "$local_md5" = "$remote_md5" ] || die "CDN bytes differ for $k"
done

[ "${STOP_AFTER_R2:-0}" = 1 ] && { echo "R2_DONE $(date)"; exit 0; }

# --- 3. Box: sidecars, collision, far layer, landmarks. Never --delete, never regions, never .glb tiles.
grep -vE '^(index|root)\.json$' $R/box-files.txt > $R/box-files-nopivot.txt
rsync -a --partial --files-from=$R/box-files-nopivot.txt -e "$SSHOPT" $W/ $BOX:/opt/sydney/dist/world/ || die "box rsync failed"
# stale precompressed sidecars beside anything we just replaced: delete them (Caddy serves the sidecar, never the file)
ssh -i $HOME/.ssh/sydney_deploy -o BatchMode=yes $BOX "cd /opt/sydney/dist/world && while read f; do rm -f \"\$f.br\" \"\$f.zst\"; done" < $R/box-files-nopivot.txt
# fresh sidecars for the top-level files a client may still fetch from the origin
mkdir -p $R/pivots
for f in far.bin far-terrain.bin far-water.bin landmarks.glb; do
  brotli -f -q 9 -o $R/pivots/$f.br $W/$f; zstd -f -q -19 -o $R/pivots/$f.zst $W/$f
done

# --- 4. Pivots with the cdn block re-stamped, except list empty (the round carries everything).
python3 - <<PY || die "pivot stamping failed"
import json
for name in ('index.json','root.json'):
    d=json.load(open('$W/'+name))
    d['cdn']={'base':'$CDN','except':[]}
    json.dump(d, open('$R/pivots/'+name,'w'), separators=(',',':'))
    print(name, 'built', d['built'], 'cdn', d['cdn'])
PY
for f in index.json root.json; do
  brotli -f -q 9 -o $R/pivots/$f.br $R/pivots/$f; zstd -f -q -19 -o $R/pivots/$f.zst $R/pivots/$f
done
# R2 copies of the pivots, no-cache
for f in index.json root.json; do
  npx wrangler@latest r2 object put "sydrunner-world/$f" --file $R/pivots/$f --remote --content-type application/json --cache-control "no-cache" >/dev/null 2>&1 || die "pivot $f to R2 failed"
done
rsync -a -e "$SSHOPT" $R/pivots/ $BOX:/opt/sydney/dist/world/ || die "pivot rsync failed"
ssh -i $HOME/.ssh/sydney_deploy -o BatchMode=yes $BOX 'chown -R root:root /opt/sydney/dist/world && systemctl restart sydney' || die "restart failed"

# --- 5. Gate
ok=0; for i in $(seq 1 48); do sleep 5; curl -sf $SITE/health >/dev/null 2>&1 && { ok=1; break; }; done
[ "$ok" = 1 ] || die "no /health after restart"
echo "health: $(curl -s $SITE/health | grep -oE '"(ok|protocol)":[a-z0-9]+' | tr '\n' ' ')"
echo "origin index: $(curl -s -H 'Accept-Encoding: br' $SITE/world/index.json | brotli -d 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["built"], d.get("cdn"))')"
echo "cdn index:    $(curl -s $CDN/index.json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["built"], d.get("cdn"))')"
echo "PUBLISH_DONE $(date)"
