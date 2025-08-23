"""
Depth Anything V2 ランナー（任意導入の外部実装を呼び出すアダプタ）

infer(image_path, device='mps', weights=None) -> np.ndarray[H,W] float32 を提供する。

実装ポリシー:
- ここでは代表的な実装パターンを試す。
- 環境に depth_anything_v2 / depth_anything 等のモジュールが存在する場合、それを利用。
- 無い場合は例外を投げる（generate_depth.py 側でフォールバック）。
"""
from typing import Optional

def infer(image_path: str, device: str = 'mps', weights: Optional[str] = None):
    import importlib
    import numpy as np
    from PIL import Image

    # 候補1: depth_anything_v2 パッケージ（仮API）
    try:
        dav2 = importlib.import_module('depth_anything_v2')
        # 期待API: DepthAnythingV2(weights=..., device=...).predict(np.ndarray HWC RGB)->float32[H,W]
        if hasattr(dav2, 'DepthAnythingV2'):
            model = dav2.DepthAnythingV2(weights=weights, device=device)
            img = Image.open(image_path).convert('RGB')
            arr = np.asarray(img).astype('float32') / 255.0
            depth = model.predict(arr)
            return depth
    except Exception as e:
        # 次の候補へ
        pass

    # 候補2: depth_anything（V1）互換（あれば代替的に使用）
    try:
        da = importlib.import_module('depth_anything')
        if hasattr(da, 'DepthAnything'):
            model = da.DepthAnything(device=device)
            img = Image.open(image_path).convert('RGB')
            arr = np.asarray(img).astype('float32') / 255.0
            depth = model.predict(arr)
            return depth
    except Exception:
        pass

    raise RuntimeError('利用可能なDepth Anything (V2/V1) 実装が見つからない')

