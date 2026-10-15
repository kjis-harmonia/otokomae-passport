// SB が使うスタッフ RPC の共通処理（Staging 版では POS を除いた同じ中身を持つ。SB の画面はここからだけ読む）
export { callStaffRpc, expectRpcResult, RpcError } from '../utils/staffSession'
