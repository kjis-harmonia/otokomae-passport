# iPhone Shortcuts試作は顧客導線から廃止

キー発行・JSON設定・手動ショートカット作成は、店頭運用に負担が大きいため採用しない。
/shortcuts.html の既存リンクはJohnnyの予約画面へ移動する。

現在の導線と認証設計は [CUSTOMER_ONE_TAP.md](CUSTOMER_ONE_TAP.md) を参照。

すでに試作用に発行された連携キーの互換API customer-shortcuts は維持し、DBや既存のキーを無断で削除しない。
以前の履歴migration 20261017030847_customer_shortcuts はそのまま保持する。
本物のiPhoneウィジェットは、会員認証を内蔵したiPhoneアプリとして別途実装する。
