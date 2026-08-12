# ptr1 最終試験結果

## 実装

- `done.sh`が既存のcommit済みevidence本文を、証跡記述子と同時にLattice 0.59.0の`--test-result`へ渡すようにした。
- 通常worktreeとpull型の隔離worktreeは同じ経路を使い、room API、store直書き、別台帳、新しい入力様式は追加していない。
- 作業者はevidenceと同じ最終試験結果を監査担当へ渡し、監査担当が再試験せずcloseする規範を配布テンプレートへ反映した。
- Peertableの配布版を0.3.10へ更新した。

## 試験結果

- `bash -n skill/templates/done.sh`: green
- `node experiments/done-receipt-gate-repro.mjs`: 31 / 31 green
  - 通常worktreeのevidence本文と`test_result`が一致
  - pull型の隔離worktreeでもevidence本文と`test_result`が一致
  - 一時入力fileは成功後に残らない
  - 既存のreceipt、landing、再試行、明示PLANの挙動を維持
- `node experiments/current-owner-fix-repro.mjs`: green
- `node experiments/team-generated-assets-upgrade-repro.mjs`: 4 cases green
- 変更したshell / JavaScriptの構文検査: green
- `PEERTABLE_URL= node room/client.mjs diagnostics`: ready
  - version consistency: 0.3.10 / 0.3.10
  - bin integrity: pass
  - Node runtime: pass
  - skill bundle 22 files: pass
- `git diff --check`: green

## 公開・導入後確認

- release commit: `24c6a3f5a815`
- npm: `peertable@0.3.10`を公開
- registry shasum: `a3f0730603466438f3953fdd9e7503a9f34a164f`
- registry integrity: `sha512-0QQ8oIo94HpAGw+Xxnkt0fgnrKXyHlbVozd+jz5TrOmr2S9/jV0HrCoA0vkMiMzKQLvLMH6nri6BpxncDmsnrg==`
- tag: `v0.3.10`をoriginへpush
- global install: `/opt/homebrew/lib/node_modules/peertable`が0.3.10
- installed `peertable-client diagnostics`: ready、必須22 filesを確認
- installed packageから使い捨てのLattice併用卓を生成し、生成された`.team/scripts/done.sh`で`todo done`を実行
- `todo show`でevidence descriptorと`test_result`を同時取得し、`test_result`がevidence本文とbyte単位で一致
- 一時入力`.ev-s1.json`と`.test-result-smoke-s1.md`は完了後に残らない
- smoke用project・bare remote・bridge sessionは確認後に撤去済み

## 自己監査

公開契約`lattice.todo_test_result.v1`へ薄く結線するだけの差分であり、計画が禁止したroom API変更、試験結果の自動生成・採点、別台帳、単独円卓モード変更は含まない。監査担当へ渡した最終結果とLatticeへ残す本文は、同じcommit済みevidenceを入力にするため二重の正本にならない。
