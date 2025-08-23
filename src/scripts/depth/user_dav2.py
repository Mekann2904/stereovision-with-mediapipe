"""
ユーザ向け DAv2 アダプタ（DAV2_CALL=scripts.depth.user_dav2:infer で使用）

優先: depth_anything_v2.dpt.DepthAnythingV2 の公式クラスを直接使用。
fallback: depth_anything (V1) の代表APIを試行。
"""
from typing import Optional


def _pick_device(requested: str) -> str:
    if requested and requested.lower() != 'auto':
        return requested.lower()
    try:
        import torch
        if torch.cuda.is_available():
            return 'cuda'
        if torch.backends.mps.is_available():
            return 'mps'
    except Exception:
        pass
    return 'cpu'


def infer(image_path: str, device: str = 'auto', weights: Optional[str] = None):
    import importlib
    import os
    import numpy as np
    import torch
    import cv2

    dev = _pick_device(device)

    # 候補1: depth_anything_v2 の公式クラスをそのまま使う
    try:
        dpt = importlib.import_module('depth_anything_v2.dpt')
        Cls = getattr(dpt, 'DepthAnythingV2')
        model = Cls(encoder='vitl')
        model = model.to(dev)
        model.eval()

        # 任意の重みロード（TorchScript/PTのstate_dict想定）
        if weights and os.path.isfile(weights):
            try:
                ckpt = torch.load(weights, map_location=dev)
                if isinstance(ckpt, dict):
                    # 代表的なキーの候補を試行
                    for key in ('state_dict', 'model', 'weights', 'params'):
                        if key in ckpt:
                            ckpt = ckpt[key]
                            break
                    if isinstance(ckpt, dict):
                        model.load_state_dict(ckpt, strict=False)
                elif hasattr(ckpt, 'state_dict'):
                    model.load_state_dict(ckpt.state_dict(), strict=False)
            except Exception:
                # 重みが合わない場合はそのまま（精度は担保されない）
                pass

        # 画像読み込み（BGR）
        raw = cv2.imread(image_path, cv2.IMREAD_COLOR)
        if raw is None:
            raise RuntimeError('画像を読み込めない: ' + image_path)
        # DepthAnythingV2.infer_image が内部でデバイスを再決定するため、
        # 事前にモデルをdevへ移動しておけば概ね一致する。
        with torch.no_grad():
            depth = model.infer_image(raw, input_size=518)
        return np.asarray(depth, dtype=np.float32)
    except Exception:
        pass

    # 候補2: depth_anything（V1）
    try:
        da = importlib.import_module('depth_anything')
        if hasattr(da, 'DepthAnything'):
            m = da.DepthAnything(device=dev)
            if hasattr(m, 'predict'):
                import PIL.Image as Image
                img = Image.open(image_path).convert('RGB')
                arr = np.asarray(img).astype('float32') / 255.0
                return np.asarray(m.predict(arr), dtype=np.float32)
        if hasattr(da, 'infer') and callable(da.infer):
            import PIL.Image as Image
            img = Image.open(image_path).convert('RGB')
            arr = np.asarray(img).astype('float32') / 255.0
            return np.asarray(da.infer(arr, device=dev), dtype=np.float32)
    except Exception:
        pass

    raise RuntimeError('depth_anything_v2.dpt/ depth_anything の適合APIが見つからない')
