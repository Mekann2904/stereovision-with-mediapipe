#!/usr/bin/env python3
"""
Depth Anything V2 による深度推定（Mac MPS対応）

要件:
  - Python 3.9+
  - torch (MPS対応ビルド)
  - モデル: Depth Anything V2（ユーザ環境に配置）

使い方:
  python3 scripts/depth/generate_depth.py --input <image_path> --output <depth_png>

備考:
  - 本スクリプトは実環境のモデル導入が未済でも動くよう、フォールバックで
    8bitグレースケール→16bit拡張の疑似深度を出力可能。
  - 真のDAv2推論を行うには、ユーザ環境でモデル/依存関係を導入し、
    下の TODO 実装箇所を有効化すること。
"""

import argparse
import os
import sys
from typing import Optional

def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='入力画像パス')
    ap.add_argument('--output', required=True, help='出力16bit深度PNGパス')
    ap.add_argument('--backend', default=os.environ.get('DAV2_BACKEND', 'auto'), choices=['auto','dav2','fallback'], help='推論バックエンド選択')
    ap.add_argument('--weights', default=os.environ.get('DAV2_WEIGHTS'), help='DAv2重みファイル（TorchScript/PTなど）')
    ap.add_argument('--device', default=os.environ.get('DAV2_DEVICE','auto'), help='mps/cuda/cpu/auto')
    ap.add_argument('--max-size', type=int, default=int(os.environ.get('DAV2_MAX_SIZE','0')), help='長辺の最大ピクセル（0は無制限）')
    ap.add_argument('--normalize', default=os.environ.get('DAV2_NORM','minmax'), choices=['minmax','none'], help='深度正規化方法')
    return ap.parse_args()

def ensure_dir(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)

def _pick_device(requested: str) -> str:
    if requested and requested.lower() != 'auto':
        return requested.lower()
    try:
        import torch
        if torch.backends.mps.is_available():
            return 'mps'
        if torch.cuda.is_available():
            return 'cuda'
    except Exception:
        pass
    return 'cpu'


def _save_depth16(depth_float, outp: str, normalize: str = 'minmax'):
    import numpy as np
    from PIL import Image
    d = depth_float
    if normalize == 'minmax':
        dmin = float(np.nanmin(d))
        dmax = float(np.nanmax(d))
        if not (dmax > dmin):
            d = np.zeros_like(d, dtype=np.float32)
        else:
            d = (d - dmin) / (dmax - dmin)
    d = np.clip(d, 0.0, 1.0)
    d16 = (d * 65535.0 + 0.5).astype('uint16')
    # Pillow 13以降の非推奨を回避: dtype=uint16から自動でI;16が選ばれる
    img16 = Image.fromarray(d16)
    ensure_dir(outp)
    img16.save(outp, format='PNG')


def try_depth_anything_v2(inp: str, outp: str, *, weights: Optional[str], device_req: str, max_size: int, normalize: str) -> bool:
    """Depth Anything V2 実装呼び出し（ユーザ実装領域）。
    - weights が指定されていれば TorchScript/PT を優先して読み込む。
    - それ以外は外部モジュールを試行（depth_anything_v2 / ローカルrunner）。
    """
    try:
        import importlib
        import numpy as np
        from PIL import Image
        import torch
        import torch.nn.functional as F

        device = _pick_device(device_req)

        # 1) TorchScript/PT 直接読み込み
        if weights and os.path.isfile(weights):
            try:
                model = None
                try:
                    model = torch.jit.load(weights, map_location=device)
                except Exception:
                    ckpt = torch.load(weights, map_location=device)
                    # 想定: {'model': state_dict or scripted}
                    if hasattr(ckpt, 'state_dict'):
                        # モデル定義不明のためロード不可
                        model = None
                    elif isinstance(ckpt, dict) and 'model' in ckpt and hasattr(ckpt['model'], 'eval'):
                        model = ckpt['model']
                if model is None:
                    raise RuntimeError('重みファイルを直接ロードできない（TorchScript推奨）')
                model.eval()

                img = Image.open(inp).convert('RGB')
                w, h = img.size
                if max_size and max(w, h) > max_size:
                    scale = max_size / float(max(w, h))
                    img = img.resize((int(w*scale), int(h*scale)), Image.BICUBIC)
                    w, h = img.size
                arr = np.asarray(img).astype('float32') / 255.0
                t = torch.from_numpy(arr).permute(2,0,1).unsqueeze(0).to(device)
                with torch.no_grad():
                    out = model(t)
                    if isinstance(out, (list, tuple)):
                        out = out[0]
                    # 期待形状: [1,1,H,W] or [1,H,W]
                    if out.dim() == 3:
                        out = out.unsqueeze(1)
                    out = F.interpolate(out, size=(h, w), mode='bilinear', align_corners=False)
                    depth = out.squeeze().detach().float().cpu().numpy()
                _save_depth16(depth, outp, normalize)
                return True
            except Exception as e:
                sys.stderr.write(f"[dav2] 重み読込/推論失敗: {e}\n")

        # 2) ユーザ指定モジュール: 環境変数 DAV2_CALL="module:function"
        dav2_call = os.environ.get('DAV2_CALL')
        if dav2_call and ':' in dav2_call:
            mod_name, fn_name = dav2_call.split(':', 1)
            try:
                mod = importlib.import_module(mod_name)
                fn = getattr(mod, fn_name)
                depth = fn(inp, device=device, weights=weights)  # 期待: np.float32 [H,W]
                depth = np.asarray(depth, dtype=np.float32)
                _save_depth16(depth, outp, normalize)
                return True
            except Exception as e:
                sys.stderr.write(f"[dav2] {mod_name}.{fn_name} 失敗: {e}\n")

        # 3) 外部モジュール（depth_anything_v2 / ローカルrunner）
        candidates = [
            ('scripts.depth.dav2_runner', 'infer'),
            ('depth_anything_v2', 'infer'),
            ('depth_anything', 'infer'),
        ]
        for mod_name, fn_name in candidates:
            try:
                mod = importlib.import_module(mod_name)
                fn = getattr(mod, fn_name, None)
                if callable(fn):
                    depth = fn(inp, device=device, weights=weights)  # 期待: np.float32 [H,W] 0..1 or 未正規化
                    if depth is None:
                        continue
                    depth = np.asarray(depth, dtype=np.float32)
                    _save_depth16(depth, outp, normalize)
                    return True
            except Exception as e:
                sys.stderr.write(f"[dav2] {mod_name}.{fn_name} 失敗: {e}\n")

        return False
    except Exception as e:
        sys.stderr.write(f"[depth-anything] 未実装/失敗: {e}\n")
        return False

def fallback_make_fake_depth(inp, outp):
    """依存が無い環境向けの簡易フォールバック。
    入力画像をL（輝度）で読み、[0..255]を[0..65535]に拡張して16bit PNG出力。
    Pillow が無い場合は失敗。
    """
    try:
        from PIL import Image
        import numpy as np
    except Exception as e:
        sys.stderr.write('[fallback] Pillow/Numpyが未導入。pipでインストールするか、本格推論を構築。\n')
        return False
    try:
        img = Image.open(inp).convert('L')  # 8bit
        arr8 = np.array(img, dtype=np.uint8)
        arr16 = (arr8.astype(np.uint16) << 8) | arr8  # 0..255 -> 0..65535 拡張
        # Pillow 13以降の非推奨回避: dtype=uint16から自動で I;16 が選択される
        img16 = Image.fromarray(arr16)
        ensure_dir(outp)
        img16.save(outp, format='PNG')
        return True
    except Exception as e:
        sys.stderr.write(f'[fallback] 変換失敗: {e}\n')
        return False

def main():
    args = parse_args()
    inp = os.path.abspath(args.input)
    outp = os.path.abspath(args.output)

    # パッケージ解決のため、リポジトリルートをsys.pathに追加
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

    if not os.path.isfile(inp):
        sys.stderr.write('入力画像が存在しない\n')
        return 2

    backend = (args.backend or 'auto').lower()

    # 優先: 真の深度推論（ユーザ実装）
    if backend in ('auto','dav2') and try_depth_anything_v2(inp, outp, weights=args.weights, device_req=args.device, max_size=args.max_size, normalize=args.normalize):
        print('[info] Depth Anything V2 による深度PNGを出力')
        return 0

    # フォールバック: 疑似深度
    ok = backend != 'dav2' and fallback_make_fake_depth(inp, outp)
    if ok:
        print('[info] フォールバック深度PNG（L→16bit拡張）を出力')
        return 0
    else:
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
