#!/usr/bin/env python3
"""
髪型のみ透明PNG生成スクリプト
=================================
各スタイル画像から「髪の毛だけ」の透明PNGを生成します。

インストール:
    pip install mediapipe rembg pillow numpy

使い方:
    cd otokomae-passport
    python scripts/extract_hair.py

出力:
    public/assets/hair/*.png  (12ファイル)
"""

import sys
import urllib.request
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

# ── 設定 ────────────────────────────────────────────────────────────────────────

MODEL_URL  = ('https://storage.googleapis.com/mediapipe-models/'
              'image_segmenter/selfie_multiclass_256x256/float32/1/'
              'selfie_multiclass_256x256.tflite')
MODEL_PATH = Path('selfie_multiclass_256x256.tflite')
HAIR_CAT   = 1   # selfie_multiclass: 0=背景 1=髪 2=体 3=顔 4=服

SRC_DIR = Path('public/assets')
OUT_DIR = Path('public/assets/hair')

# (元ファイル名, 出力ファイル名)
STYLES = [
    ('hero-nurepan.jpg',      'nurepan-hair.png'),
    ('hero-curl-iper.jpg',    'curl-iper-hair.png'),
    ('hero-natsu-niguro.jpg', 'natsu-niguro-hair.png'),
    ('hero-punch-perm.jpg',   'punch-perm-hair.png'),
    ('ginpara.png',           'ginpara-hair.png'),
    ('teitei-gari.png',       'teitei-hair.png'),
    ('gokudo-bozu.png',       'gokudo-hair.png'),
    ('showa-aiper.png',       'showa-aiper-hair.png'),
    ('rejent-punch.png',      'rejent-hair.png'),
    ('jamaican-afro.png',     'afro-hair.png'),
    ('spain-parm.jpeg',       'spain-parm-hair.png'),
    ('truck-yaro.png',        'truck-hair.png'),
]

# ── モデル自動ダウンロード ──────────────────────────────────────────────────────

def ensure_model() -> None:
    if MODEL_PATH.exists():
        return
    print(f'  モデルをダウンロード中...')
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    print(f'  → {MODEL_PATH} 保存完了')

# ── 髪マスク生成 (MediaPipe) ───────────────────────────────────────────────────

def segment_hair(img_rgb: np.ndarray, segmenter) -> np.ndarray:
    """
    RGB numpy配列 → 髪ピクセル bool マスク (H, W)
    """
    import mediapipe as mp
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_rgb)
    result  = segmenter.segment(mp_img)
    return result.category_mask.numpy_view() == HAIR_CAT

# ── マスクのソフト処理 ──────────────────────────────────────────────────────────

def soften_mask(mask_bool: np.ndarray, dilate_px: int = 4, blur_px: int = 6) -> np.ndarray:
    """
    髪マスクを少し膨張させてエッジをぼかす → 自然な境界に。
    """
    alpha = Image.fromarray((mask_bool * 255).astype(np.uint8), mode='L')
    # 少し膨張（髪の細部が取れているケースへの対処）
    alpha = alpha.filter(ImageFilter.MaxFilter(dilate_px * 2 + 1))
    # エッジをぼかしてなじませる
    alpha = alpha.filter(ImageFilter.GaussianBlur(blur_px))
    return np.array(alpha)

# ── メイン ─────────────────────────────────────────────────────────────────────

def main() -> None:
    print('=' * 50)
    print('  銀二郎 髪型PNG生成スクリプト')
    print('=' * 50)

    # rembg の準備（任意）
    use_rembg = False
    try:
        from rembg import remove as rembg_remove, new_session
        print('\n[rembg] 背景除去モデルを読み込み中...')
        rembg_session = new_session('u2net_human_seg')
        use_rembg = True
        print('[rembg] 準備完了 ✓')
    except ImportError:
        print('\n[警告] rembg が未インストールです。背景除去なしで続行します。')
        print('       より高品質にするには: pip install rembg')

    # MediaPipe の準備
    print('\n[MediaPipe] セグメンターを初期化中...')
    ensure_model()
    import mediapipe as mp
    from mediapipe.tasks.vision import ImageSegmenter

    options = mp.tasks.vision.ImageSegmenterOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        output_category_mask=True,
    )
    segmenter = ImageSegmenter.create_from_options(options)
    print('[MediaPipe] 準備完了 ✓')

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f'\n出力先: {OUT_DIR.resolve()}')
    print('-' * 50)

    ok = 0
    skip = 0
    for src_name, out_name in STYLES:
        src_path = SRC_DIR / src_name
        out_path = OUT_DIR / out_name

        if not src_path.exists():
            print(f'[スキップ] {src_name} が見つかりません')
            skip += 1
            continue

        print(f'処理中: {src_name}')
        img = Image.open(src_path).convert('RGBA')
        W, H = img.size

        # Step 1: rembg で背景を除去（クリーンな人物画像に）
        if use_rembg:
            cleaned_pil = rembg_remove(img, session=rembg_session)
            rgb_arr = np.array(cleaned_pil.convert('RGB'))
            base_alpha = np.array(cleaned_pil)[:, :, 3]   # rembg のアルファ
        else:
            rgb_arr   = np.array(img.convert('RGB'))
            base_alpha = np.full((H, W), 255, dtype=np.uint8)

        # Step 2: MediaPipe で髪ピクセルを検出
        hair_bool = segment_hair(rgb_arr, segmenter)

        detected = hair_bool.sum()
        pct      = detected / (W * H) * 100
        print(f'  髪ピクセル: {detected:,} ({pct:.1f}%)')

        if detected < 100:
            print(f'  [警告] 髪がほぼ検出されませんでした。ファイルを確認してください。')

        # Step 3: マスクをソフト処理
        hair_alpha = soften_mask(hair_bool, dilate_px=4, blur_px=5)

        # Step 4: rembg アルファ × 髪マスクを合成
        final_alpha = np.minimum(base_alpha, hair_alpha)

        # Step 5: RGBA で出力
        out_arr = np.array(img)            # 元の色情報を使用
        out_arr[:, :, 3] = final_alpha
        Image.fromarray(out_arr).save(out_path, 'PNG', optimize=True)

        size_kb = out_path.stat().st_size // 1024
        print(f'  → {out_name} ({size_kb} KB) ✓')
        ok += 1

    segmenter.close()

    print('-' * 50)
    print(f'\n完了: {ok} 件生成, {skip} 件スキップ')
    print(f'\n次のステップ:')
    print(f'  TryOnScreen.tsx の imageSrc を')
    print(f'  /assets/hair/*.png に変更してください。')
    print(f'  変更方法は Claude に「hairパスに更新して」と伝えればOKです。')

if __name__ == '__main__':
    main()
