// いつもの人たち（11/8 慶一郎さん：アプリの持ち主と、実際に施術を受ける人を分ける）
//   ・本人とお連れ様（3名まで）を、会員の記録（サーバー）に登録する。お連れ様は番号（id）で見分ける（同じお名前でも混ざらない・機種変更しても消えない）
//   ・それぞれ「いつものメニュー」と「メンテナンスカットの可否」（その方が対象メニューの施術を終えてから14日以内）を持つ
//   ・端末には写しだけ（getUsualMembers はすぐ返したいので）。正しいのはサーバー
import { callCustomerRpc } from '../../utils/customerSession'
import { getStoredValue, setStoredValue } from '../../utils/storage'

export const USUAL_MEMBERS_KEY = 'ginjiro_usual_members'
export const MAX_COMPANIONS = 3

/** 施術を受ける人。id が null なら会員本人 */
export interface Person {
  id: string | null
  name: string
  is_owner: boolean
  menu_code: string | null
  menu_name: string | null
  /** いつものメニューがメンテナンスカットの対象か */
  menu_maintenance: boolean
  wants_maintenance: boolean
  /** その方が対象メニューの施術を終えてから14日以内（メンテナンスカットを予約できる） */
  maintenance_ok: boolean
  days_left: number | null
}
export interface People { owner: Person | null; companions: Person[] }

/** 端末の写し（お連れ様だけ） */
export interface UsualMember { name: string; menuCode: string; id?: string }

export function getUsualMembers(): UsualMember[] {
  const v = getStoredValue<unknown>(USUAL_MEMBERS_KEY, [])
  return Array.isArray(v) ? v.filter((x): x is UsualMember => !!x && typeof x.name === 'string' && typeof x.menuCode === 'string').slice(0, MAX_COMPANIONS) : []
}

export function isUsualMember(name: string): boolean {
  return getUsualMembers().some(m => m.name === name.trim())
}

function remember(p: People): People {
  try {
    setStoredValue(USUAL_MEMBERS_KEY, p.companions.filter(c => c.id).map(c => ({ id: c.id!, name: c.name, menuCode: c.menu_code ?? '' })))
  } catch { /* 写しが書けなくてもサーバーにはある */ }
  return p
}

function normalize(raw: unknown): People {
  const r = (raw ?? {}) as Partial<People>
  return { owner: r.owner ?? null, companions: Array.isArray(r.companions) ? r.companions : [] }
}

/** 本人とお連れ様（サーバーから読み直す） */
export async function fetchPeople(): Promise<People> {
  let p = normalize(await callCustomerRpc<unknown>('customer_people'))
  // 11/8 より前にこの端末だけに覚えた「いつものメンバー」（番号なし）は、会員の記録へ移す（3名まで）
  const legacy = getUsualMembers().filter(m => !m.id && !p.companions.some(c => c.name.trim() === m.name.trim()))
  for (const m of legacy) {
    if (p.companions.length >= MAX_COMPANIONS) break
    try {
      const r = await callCustomerRpc<{ people: unknown }>('customer_save_companion',
        { p_id: null, p_name: m.name.trim(), p_menu_code: m.menuCode || null, p_wants_maintenance: false })
      p = normalize(r.people)
    } catch { /* 移せなかった方は端末の写しから消える（サーバーが正しい） */ }
  }
  return remember(p)
}

/** お連れ様を登録・変更する（id が null なら追加）。失敗は RpcError（name_exists・too_many・bad_name） */
export async function saveCompanion(id: string | null, name: string, menuCode: string | null, wantsMaintenance = false): Promise<People> {
  const r = await callCustomerRpc<{ people: unknown }>('customer_save_companion',
    { p_id: id, p_name: name.trim(), p_menu_code: menuCode, p_wants_maintenance: wantsMaintenance })
  return remember(normalize(r.people))
}

export async function removeCompanion(id: string): Promise<People> {
  const r = await callCustomerRpc<{ people: unknown }>('customer_remove_companion', { p_id: id })
  return remember(normalize(r.people))
}

/** 本人のいつものにメンテナンスカットを足す・外す（いつものメニューの登録が先） */
export async function setOwnerMaintenance(wants: boolean): Promise<People> {
  const r = await callCustomerRpc<{ people: unknown }>('customer_set_usual_maintenance', { p_wants: wants })
  return remember(normalize(r.people))
}

/** お連れ様として登録する（同じお名前がいればメニューを変える）。登録できなければ false */
export async function addUsualMember(m: UsualMember): Promise<boolean> {
  try { return !!(await companionIdFor(m.name, m.menuCode)) } catch { return false }
}

/** お連れ様の予約の前に：お名前から登録済みの番号。まだなら登録して番号を返す（3名を超えるなど登録できなければ null） */
export async function companionIdFor(name: string, menuCode: string): Promise<string | null> {
  const n = name.trim()
  if (!n) return null
  try {
    let people = await fetchPeople()
    let hit = people.companions.find(c => c.name.trim() === n)
    if (!hit) {
      people = await saveCompanion(null, n, menuCode)
      hit = people.companions.find(c => c.name.trim() === n)
    }
    return hit?.id ?? null
  } catch { return null }
}
