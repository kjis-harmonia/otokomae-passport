// 券の大理石（10/29 慶一郎さん：会員証の白い大理石と同じ世界観で、券ごとに色を持たせる。画像は慶一郎さん提供）。
//   明るいところでも金・白の文字が読めるように、上から少し暗くする（左の文字側を濃く）

export type MarbleColor = 'black' | 'red' | 'green' | 'blue'

const IMAGE: Record<MarbleColor, string> = {
  black: '/images/tickets/marble-black.webp',
  red:   '/images/tickets/marble-red.webp',
  green: '/images/tickets/marble-green.webp',
  blue:  '/images/tickets/marble-blue.webp',
}

/** 文字を読ませるための暗さ（明るい画像ほど濃く） */
const SHADE: Record<MarbleColor, [number, number]> = {
  black: [0.35, 0.15],
  red:   [0.62, 0.38],
  green: [0.62, 0.38],
  blue:  [0.62, 0.38],
}

export function marbleBackground(color: MarbleColor): string {
  const [left, right] = SHADE[color]
  return `linear-gradient(100deg, rgba(8,6,4,${left}) 0%, rgba(8,6,4,${(left + right) / 2}) 55%, rgba(8,6,4,${right}) 100%), url(${IMAGE[color]}) center / cover no-repeat, #0b0a09`
}
