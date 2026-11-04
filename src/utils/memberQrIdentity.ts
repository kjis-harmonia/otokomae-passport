/** QRは既存会員の氏名の更新元にしない。通信失敗時に登録へフォールバックしない。
 * 本人確認つきのQR（来店時の確認）でも、まだ会員でなければ登録する（11/4：お店で一度も読まれていないアプリの番号で止まっていた）。 */
export async function resolveMemberQr<T extends { customer: { name: string } | null }>(
  userId: string,
  qrName: string,
  api: { lookup: (id: string) => Promise<T>; register: (id: string, name: string) => Promise<T> },
): Promise<T> {
  let context = await api.lookup(userId)
  if (!context.customer) {
    context = await api.register(userId, qrName)
  }
  if (!context.customer) throw new Error('会員情報を確認できませんでした。')
  return context
}
