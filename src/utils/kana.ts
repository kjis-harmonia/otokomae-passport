// フリガナ（11/21）：SB で漢字の名前が読めないスタッフさんのために、お客様の読みをカタカナで持つ

/** ひらがな・半角カナを全角カタカナに。空白は1つにそろえる */
export const toKatakana = (v: string) => v.normalize('NFKC').replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/\s+/g, ' ').trim()

/** カタカナ（と空白・ー・・）だけか。漢字・英字が混じっていたら false */
export const isKana = (v: string) => /^[ァ-ヶー・ ]+$/.test(v) && v.length <= 40
