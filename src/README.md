## MediaPipe Tasks PoC — 包括的ランドマーク検出（オプション）

- 機能: 手・顔に加え、Holistic（包括: 顔/手/ポーズ）検出を任意で有効化できる。
- 実装: `@mediapipe/tasks-vision` の Hand/Face/Holistic Landmarker を利用。

### 使い方

1) 依存関係を導入

```
npm i
```

2) モデルを取得（初回のみ）

```
npm run models
```

3) アプリ起動

```
npm start
```

4) 右ペイン 設定

- 「ホリスティック検出」を ON にすると、`public/assets/holistic_landmarker.task` が存在する場合は Holistic 検出を優先する。
- 「顔トラッキング」を ON にすると、通常検出時（Holistic OFF/未配置）でも FaceLandmarker を併用する。

### モデル配置について

- 既定配置先: `public/assets`
- 取得スクリプト: `scripts/fetch_models.sh`
  - Hand: `hand_landmarker.task`
  - Face: `face_landmarker.task`
  - Holistic: `holistic_landmarker.task`

Holistic モデルが未配置または未対応の場合は、自動的に従来の Hand + (任意で Face) 構成で動作する。

### 3Dプレビュー（画像×深度→擬似立体）

- 概要: 画像と深度マップ（16bit PNG想定）を Three.js の `displacementMap` として適用し、擬似的な立体効果を表示する。
- 手順:
  1) 右ペイン「3Dプレビュー」で「画像選択」を実行（ローカル画像を `public/generated/input` にコピー）。
  2) 「深度生成（DAv2）」を実行（`scripts/depth/generate_depth.py` が起動し、`public/generated/depth` に 16bit PNG を出力）。
     - 初期状態ではフォールバック変換（輝度→16bit拡張）を実行。
     - Depth Anything V2 を導入後、スクリプト内の TODO を実装すれば真の深度推論が可能。
  3) 「3D表示切替」でビューワを表示。顔トラッキングON時は顔の姿勢に応じてカメラが追従。

#### Depth Anything V2 導入メモ（例）

- 推奨: PyTorch (MPS) + DAv2 の推論コードをユーザ環境に導入し、`scripts/depth/generate_depth.py` の `try_depth_anything_v2` で呼び出す。
- 依存: `torch`, `Pillow`, `numpy` など。
- 出力: 16bit PNG（`I;16`）推奨。

##### 直接推論の使い方（本実装）

- コマンド引数/環境変数:
  - `--device` or `DAV2_DEVICE`: `mps`/`cuda`/`cpu`/`auto`（既定: auto）
  - `--weights` or `DAV2_WEIGHTS`: TorchScript/PT 重みパス（指定時は直接ロードを試行）
  - `--backend` or `DAV2_BACKEND`: `auto`/`dav2`/`fallback`（既定: auto）
  - `--max-size` or `DAV2_MAX_SIZE`: 長辺の最大ピクセル（0で無制限）
  - `--normalize` or `DAV2_NORM`: `minmax`/`none`（保存時の正規化）

- 実装順序:
  1) `pip install torch pillow numpy` を導入。
  2) 重みファイル（TorchScript推奨）を用意し、`--weights <path>` を指定して「深度生成（DAv2）」を実行。
  3) 代替として `scripts/depth/dav2_runner.py` が `depth_anything_v2`/`depth_anything` の外部実装を探索し、存在すればそれを使用する。
  4) 最短経路: 用意済みアダプタ `scripts.depth.user_dav2:infer` を使う。
     - `pip install depth_anything_v2` 後に `export DAV2_CALL=scripts.depth.user_dav2:infer`
     - 必要に応じ `export DAV2_DEVICE=auto` `export DAV2_MAX_SIZE=1024` を併用。

##### venvのPythonを使用させる

- Electronからの実行に venv のPythonを使うため、アプリ起動前に以下を推奨:
  - `export PYTHON=$(which python)`（または `python3`）。または `VIRTUAL_ENV/bin/python` を自動検出するよう対応済み。
  - `npm start`
