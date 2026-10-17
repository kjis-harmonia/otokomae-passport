// 本部 JOHNNY の舞台：球の大きさと位置（画面の文字の位置もこれに合わせる）
/** 球の大きさと位置（画面の文字の位置もこれに合わせる） */
export function stageLayout(W: number, H: number) {
  const small = W < 700
  const R = Math.max(40, Math.min(W * (small ? 0.27 : 0.2), H * (small ? 0.16 : 0.155), (H * (small ? 0.68 : 0.64) - 240) / 1.9))
  const cy = H * (small ? 0.32 : 0.36)
  return { R, cy, textTop: cy + R * 1.9 }
}
