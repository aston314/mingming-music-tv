#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OUT="$ROOT/android/app/src/main/jniLibs"
NDK_HOME=${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}
if [ -z "$NDK_HOME" ] && [ -n "${ANDROID_HOME:-}" ]; then
  NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
fi
if [ -z "$NDK_HOME" ] || [ ! -d "$NDK_HOME" ]; then
  echo "ANDROID_NDK_HOME is required to build Android Go binaries" >&2
  exit 2
fi
case "$(uname -s)" in
  Linux) DEFAULT_HOST_TAG=linux-x86_64 ;;
  Darwin) DEFAULT_HOST_TAG=darwin-x86_64 ;;
  *) echo "unsupported NDK host" >&2; exit 2 ;;
esac
HOST_TAG=${ANDROID_NDK_HOST_TAG:-$DEFAULT_HOST_TAG}
API=${ANDROID_API_LEVEL:-$(python3 -c 'import json;print(json.load(open("app.json"))["minSdk"])')}
CORE_VERSION=${MINGMING_CORE_VERSION:-$(python3 -c 'import json;print(json.load(open("app.json"))["versionName"]+"-dev")')}
for ABI in $(python3 -c 'import json;print(" ".join(json.load(open("app.json"))["abis"]))'); do
  case "$ABI" in
    arm64-v8a) GOARCH=arm64; GOARM=; TARGET=aarch64-linux-android ;;
    armeabi-v7a) GOARCH=arm; GOARM=7; TARGET=armv7a-linux-androideabi ;;
    x86_64) GOARCH=amd64; GOARM=; TARGET=x86_64-linux-android ;;
    *) echo "unsupported Android ABI: $ABI" >&2; exit 2 ;;
  esac
  CC="$NDK_HOME/toolchains/llvm/prebuilt/$HOST_TAG/bin/${TARGET}${API}-clang"
  if [ ! -x "$CC" ]; then echo "missing Android compiler: $CC" >&2; exit 2; fi
  mkdir -p "$OUT/$ABI"
  CGO_ENABLED=1 GOOS=android GOARCH="$GOARCH" GOARM="$GOARM" CC="$CC" go build -trimpath -buildmode=pie -ldflags "-s -w -X main.buildVersion=$CORE_VERSION" -o "$OUT/$ABI/libmingmingmusic.so" ./core/cmd/mingmingmusic
done
