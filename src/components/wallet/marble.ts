// 券の大理石の模様（10/29 慶一郎さん：会員証の白い大理石と同じ世界観で、券ごとに色を持たせる）。
//   画像を使わず SVG で描く：斜めの細い筋を何本か引き、ノイズで曲げて流れと枝分かれを出す。下にぼんやりした雲。
//   同じ色・同じ seed なら毎回同じ模様（カードがちらつかない）。作った背景は覚えておく

export interface MarbleSpec { base: string; base2: string; vein: string; seed: number }

/** 黒（漢トク券）・赤（Welcome）・緑（再来店パーマ）・紺（ほかの割引券） */
export const MARBLE = {
  black:  { base: '#0b0a09', base2: '#1d1a16', vein: '#d9c49a', seed: 3 },
  bronze: { base: '#0c0a08', base2: '#1f1812', vein: '#cf9a6a', seed: 7 },
  silver: { base: '#0b0b0b', base2: '#1b1b1a', vein: '#d6d0c2', seed: 13 },
  red:    { base: '#2a060b', base2: '#4a0f17', vein: '#f0cf9a', seed: 11 },
  green:  { base: '#07201a', base2: '#12382d', vein: '#e2d3a8', seed: 5 },
  navy:   { base: '#0a1428', base2: '#17264a', vein: '#d8d0b8', seed: 9 },
} satisfies Record<string, MarbleSpec>

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

const cache = new Map<string, string>()

export function marbleBackground(m: MarbleSpec): string {
  const key = `${m.base}|${m.base2}|${m.vein}|${m.seed}`
  const hit = cache.get(key)
  if (hit) return hit
  const r = rng(m.seed), W = 600, H = 400
  const line = (w: number, o: number) => {
    const x0 = -100 + r() * 500, x1 = x0 + 260 + r() * 220
    const c1x = x0 + (r() - 0.3) * 300, c1y = 100 + r() * 80, c2x = x1 + (r() - 0.7) * 300, c2y = 220 + r() * 80
    return `<path d='M${x0 | 0} -40 C${c1x | 0} ${c1y | 0} ${c2x | 0} ${c2y | 0} ${x1 | 0} ${H + 40}' stroke-width='${w.toFixed(2)}' stroke-opacity='${o.toFixed(2)}'/>`
  }
  const main = Array.from({ length: 4 }, () => line(1 + r() * 1.4, 0.7 + r() * 0.25)).join('')
  const thin = Array.from({ length: 8 }, () => line(0.5 + r() * 0.5, 0.3 + r() * 0.3)).join('')
  const wide = Array.from({ length: 3 }, () => line(18 + r() * 26, 0.1)).join('')
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}' preserveAspectRatio='xMidYMid slice'>
<defs>
<linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${m.base2}'/><stop offset='0.55' stop-color='${m.base}'/><stop offset='1' stop-color='${m.base2}'/></linearGradient>
<filter id='w' x='-10%' y='-10%' width='120%' height='120%'><feTurbulence type='fractalNoise' baseFrequency='0.01 0.018' numOctaves='3' seed='${m.seed}' result='t'/><feDisplacementMap in='SourceGraphic' in2='t' scale='58' xChannelSelector='R' yChannelSelector='G'/></filter>
<filter id='s' x='-10%' y='-10%' width='120%' height='120%'><feTurbulence type='fractalNoise' baseFrequency='0.008 0.014' numOctaves='3' seed='${m.seed + 3}' result='t'/><feDisplacementMap in='SourceGraphic' in2='t' scale='90' xChannelSelector='R' yChannelSelector='G' result='d'/><feGaussianBlur in='d' stdDeviation='10'/></filter>
<filter id='c'><feTurbulence type='fractalNoise' baseFrequency='0.006 0.012' numOctaves='3' seed='${m.seed + 9}'/><feColorMatrix type='matrix' values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.6 -0.22'/></filter>
</defs>
<rect width='${W}' height='${H}' fill='url(#g)'/>
<rect width='${W}' height='${H}' filter='url(#c)' opacity='0.1'/>
<g fill='none' stroke='${m.vein}' filter='url(#s)'>${wide}</g>
<g fill='none' stroke='${m.vein}' stroke-linecap='round' filter='url(#w)'>${main}${thin}</g>
</svg>`
  const bg = `url("data:image/svg+xml,${encodeURIComponent(svg)}") center / cover no-repeat, ${m.base}`
  cache.set(key, bg)
  return bg
}
