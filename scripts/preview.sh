#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
MODE=${MINGMING_PREVIEW_MODE:-real}
PORT=${MINGMING_PREVIEW_PORT:-0}
echo "明明音乐预览：mode=$MODE port=$PORT"
exec go run ./core/cmd/mingmingmusic -port "$PORT" -instance-id preview -fixture="$([ "$MODE" = fixture ] && echo true || echo false)"
