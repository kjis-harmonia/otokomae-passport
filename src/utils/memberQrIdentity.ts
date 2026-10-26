/** QRは既存会員の氏名の更新元にしない。通信失敗時に登録へフォールバックしない。 */
export async function resolveMemberQr<T extends { customer: { name: string } | null }>(
  userId: string,
  qrName: string,
  requireExisting: boolean,
  api: { lookup: (id: string) => Promise<T>; register: (id: string, name: string) => Promise<T> },
): Promise<T> {
  let context = await api.lookup(userId)
  if (!context.customer) {
    if (requireExisting) throw new Error('会員情報を確認できませんでした。')
    context = await api.register(userId, qrName)
  }
  if (!context.customer) throw new Error('会員情報を確認できませんでした。')
  return context
}
