#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
ASSETS_DIR="$ROOT_DIR/public/assets"
mkdir -p "$ASSETS_DIR"

echo "[情報] モデルを $ASSETS_DIR にダウンロードする" 

download() {
  local url="$1"; local out="$2"; local name="$3"
  if [ -f "$out" ]; then
    echo "[スキップ] $name は既に存在する: $out"
    return 0
  fi
  echo "[取得] $name -> $out"
  curl -L --fail --retry 3 --retry-delay 1 -o "$out" "$url"
}

# MediaPipe Tasks モデル（Google Cloud Storage）
HAND_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
FACE_URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"

download "$HAND_URL"     "$ASSETS_DIR/hand_landmarker.task"      "Hand Landmarker"
download "$FACE_URL"     "$ASSETS_DIR/face_landmarker.task"      "Face Landmarker"

# Holistic は 'latest' を優先し、失敗時に既知の版へフォールバック
HOLISTIC_CANDIDATES=(
  "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task"
  "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/1/holistic_landmarker.task"
)

if [ ! -f "$ASSETS_DIR/holistic_landmarker.task" ]; then
  ok=0
  for u in "${HOLISTIC_CANDIDATES[@]}"; do
    echo "[試行] Holistic Landmarker: $u"
    if curl -L --fail --retry 3 --retry-delay 2 -o "$ASSETS_DIR/holistic_landmarker.task" "$u"; then
      echo "[取得] Holistic Landmarker -> $ASSETS_DIR/holistic_landmarker.task"
      ok=1
      break
    else
      echo "[警告] 取得失敗: $u"
    fi
  done
  if [ "$ok" -ne 1 ]; then
    echo "[エラー] Holistic Landmarker を取得できない。ネットワーク/URLを確認。" >&2
    exit 1
  fi
else
  echo "[スキップ] Holistic Landmarker は既に存在する: $ASSETS_DIR/holistic_landmarker.task"
fi

echo "[完了] モデル取得完了"
