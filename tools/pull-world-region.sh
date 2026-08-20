#!/usr/bin/env bash
#
# Pulls the region and entity files around a block coordinate out of the AMP-managed
# Minecraft server on games2 and into a local scratch directory.
#
#     tools/pull-world-region.sh <blockX> <blockZ> [regionRadius] [dest]
#     tools/pull-world-region.sh -3295 -2122 1
#
# The server process runs as user `amp` and /home/amp is 0700, so the files are read
# through a throwaway container: gerry is in the `docker` group, the daemon runs as
# root, and /home/amp goes in read-only. Nothing on the server is written except a
# temp directory that this script removes again.
#
# Run `/save-all flush` in game first — a chunk that has not been saved is a chunk
# this cannot see, and the failure is silent: the build simply comes back incomplete.
set -euo pipefail

HOST="${MC_HOST:-gerry@games2.geraldhofbauer.net}"
X="${1:?block x}"
Z="${2:?block z}"
R="${3:-1}"
DEST="${4:-scratch/world}"

# Floor division, not truncation: region -6.4 is region -7, and bash divides toward zero.
RX=$(( X >= 0 ? X / 512 : (X - 511) / 512 ))
RZ=$(( Z >= 0 ? Z / 512 : (Z - 511) / 512 ))

echo "block ($X, $Z) -> region ($RX, $RZ), radius $R  [$(( (2*R+1) * (2*R+1) )) regions]"

ssh "$HOST" bash -s -- "$RX" "$RZ" "$R" <<'REMOTE'
set -euo pipefail
RX=$1; RZ=$2; R=$3

rm -rf /tmp/mcclip
mkdir -p /tmp/mcclip

docker run --rm \
  -v /home/amp:/amp:ro \
  -v /tmp/mcclip:/out \
  alpine:latest sh -s -- "$RX" "$RZ" "$R" <<'INNER'
set -eu
RX=$1; RZ=$2; R=$3

props=$(find /amp/.ampdata/instances -maxdepth 4 -name server.properties | head -1)
[ -n "$props" ] || { echo "no server.properties under /amp/.ampdata/instances" >&2; exit 1; }
inst=$(dirname "$props")
level=$(sed -n 's/^level-name=//p' "$props" | tr -d '\r')
world="$inst/$level"
[ -d "$world/region" ] || { echo "no region/ in $world" >&2; exit 1; }

echo "instance: $inst"
echo "level:    $level"

mkdir -p /out/region /out/entities
for dx in $(seq $((0-R)) $R); do
  for dz in $(seq $((0-R)) $R); do
    f="r.$((RX+dx)).$((RZ+dz)).mca"
    for kind in region entities; do
      if [ -f "$world/$kind/$f" ]; then
        cp "$world/$kind/$f" "/out/$kind/$f"
        echo "  $kind/$f  $(stat -c%s "$world/$kind/$f") bytes"
      fi
    done
  done
done

cp "$props" /out/server.properties
ls "$inst/mods" > /out/server-mods.txt 2>/dev/null || true
[ -f "$world/level.dat" ] && cp "$world/level.dat" /out/level.dat

# Hand the files to gerry so the rsync back does not need the daemon again.
chown -R 1001:1001 /out
INNER
REMOTE

mkdir -p "$DEST"
rsync -a --info=stats1 "$HOST:/tmp/mcclip/" "$DEST/"
ssh "$HOST" 'rm -rf /tmp/mcclip'

echo
echo "-> $DEST"
find "$DEST" -type f -printf '   %-28p %10s\n' | sort
