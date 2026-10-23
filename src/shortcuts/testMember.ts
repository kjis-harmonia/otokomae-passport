// Explicit Staging-only signup. Never replace an existing authenticated member.
export interface PendingMember { userId: string; name: string }
export interface MemberDependencies {
  projectUrl: string
  session(): string | null
  canStore(): boolean
  pending(): PendingMember | null
  rememberPending(member: PendingMember | null): void
  rememberSession(userId: string, session: string): void
  rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>
}
export async function prepareStagingTestMember(name: string, deps: MemberDependencies): Promise<string> {
  if(deps.projectUrl!=='https://kfufxzmucjljjouzpumi.supabase.co')throw Error('検証用会員はStagingでのみ作成できます。')
  if(!deps.canStore())throw Error('このブラウザーでは会員情報を保存できません。通常のブラウザーで開いてください。')
  let session=deps.session()
  let pending=deps.pending()
  if(session&&!pending)return session
  const trimmed=name.trim()
  if(!session){
    if(!trimmed||trimmed.length>40)throw Error('検証用の表示名を40文字以内で入力してください。')
    const member=await deps.rpc('customer_register',{p_name:trimmed,p_has_visited_before:true})
    if(typeof member.user_id!=='string'||typeof member.session!=='string'||member.session.length<32)throw Error('検証用会員を作成できませんでした。')
    deps.rememberSession(member.user_id,member.session)
    if(deps.session()!==member.session)throw Error('会員情報を保存できませんでした。この画面を閉じずにお試しください。')
    session=member.session
    pending={userId:member.user_id,name:trimmed}
    deps.rememberPending(pending)
  }
  if(pending){
    // This dummy phone is only for the newly created, explicitly labelled test identity.
    await deps.rpc('customer_set_contact',{p_session:session,p_name:pending.name,p_phone:'09000000000'})
    deps.rememberPending(null)
  }
  return session
}
