#!/bin/sh
# Renders every chapter (or those named) into the docs site: docs/public/videos/from-zero/<n>-<id>.mp4,
# and its poster (.jpg). The captions are in the picture. ~6 min per chapter on 4 cores.
set -e
cd "$(dirname "$0")/.."
OUT=../docs/public/videos/from-zero
mkdir -p "$OUT"
CHAPTERS=${*:-"1-kernel 2-boxes 3-firecracker 4-walls 5-risks"}
for c in $CHAPTERS; do
  npx remotion render src/index.ts "$c" "$OUT/$c.mp4" --codec=h264 --crf=26 --audio-bitrate=96k --log=error
  npx remotion still src/index.ts "$c" "$OUT/$c.jpg" --frame=40 --image-format=jpeg --jpeg-quality=82 --scale=0.5 --log=error
done
