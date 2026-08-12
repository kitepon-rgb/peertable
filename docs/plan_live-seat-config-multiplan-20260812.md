# Peertable 稼働席設定変更・複数PLAN campaign — 計画正本

本書は `live-seat-config-multiplan-20260812` campaign の計画正本である。Lattice store、room、
メンバー席は既存の `peertable-autonomy-runtime-20260811` campaign と共有する。同campaignの `t4` と
未commitの `experiments/autonomy-lifecycle-real-repro.mjs` は中断状態のまま保持し、本campaignから変更・
完了・破棄しない。本campaignはオーナーが明示した緊急割込みとして先行する。

## 1. 目的と優先順位

最優先で、Aiterm `0.24.0` の公開MCP tool `agent_configure(session_id, model?, reasoning_effort?)`を使い、
Peertableの稼働中Claude／Codex席のmodel／effortを、席・vendor session・会話contextを作り直さず変更
できるようにする。変更後はroom memberのmodel／effort表示を実際の設定へ同期し、履歴を残す。

次に、今回の運用で露呈した「1卓＝1 Lattice PLAN」と読める案内・生成物・実装上の束縛をすべて外す。
一つのroomと同じ長寿命メンバー群が、同じLattice store内の複数PLANを完全修飾して選択・着手・監査・
完了できる状態を正とする。

優先順位は固定する。Phase 1をpeer audit込みで完了するまでPhase 2の製品変更を開始しない。

## 2. 設計判断

#### 2.1 稼働席設定変更はAitermの公開契約だけを使う

Peertableはvendor TUIへ `/model`、`/effort`、選択キーを直接注入しない。Aitermの
`agent_configure`を呼ぶ薄い制御入口だけを所有する。

- 対象はAitermが管理する稼働中のClaude／Codex agent sessionだけ。
- `model`と`reasoning_effort`は片方だけでも同時でも指定できる。
- Peertableが行う外部境界の確認は、対象席がidleであること、Aiterm receiptが
  `aiterm.agent-configure-result.v1`でtargetと一致すること、room metadataの同期と読返しだけ。
- Aitermが返した失敗を再起動、直接tmux注入、別modelへのfallbackで隠さない。
- Aitermの未確認rollbackやinject挙動をPeertableの契約にしない。
- vendor変更は従来どおり再起動経路に残し、本campaignのlive configureへ混ぜない。

現在のPeertable席がAitermのmanaged-agent metadataから参照可能かは、実席focused testで確定する。
参照できない場合は、Aiterm本体を改造せず、Peertableの正規launchがAiterm公開launcherで管理席を作る
ために必要な最小adapterを本PLANへ改訂してから実装する。非公開stateの偽造やPTY直接操作で通さない。

#### 2.2 room memberの素性を動的設定へ同期する

現行`room/client.mjs`は起動時envの`PEERTABLE_MODEL`／`PEERTABLE_EFFORT`を登録するため、live変更後も
古い値を再登録しうる。成功receiptのtargetをroomへupsertするだけでは次回client登録に負ける。

Phase 1では、席を再起動せず、同じsessionの以後のroom登録でも新値が正になる単一の所有面を設ける。
変更履歴は成功receiptとroom metadataの読返しが揃った後だけ投稿する。metadata同期だけ失敗した場合は
「設定変更済み・表示同期失敗」を明示し、変更自体を失敗またはrollback済みに見せない。

#### 2.3 一つの卓は複数PLANを扱う

`setup-state.json.plan_key`と`PEERTABLE_PLAN`は、初回着任時の既定PLANと互換用の省略値に格下げする。
これらをclaim可能範囲や卓の所属PLAN数として解釈しない。Claude向け既存フィールド名は変更しない。

メンバーの操作対象は常に完全修飾した`<plan_key>/<task_id>`で扱う。

- `lattice todo status --json`の全PLAN横断`active_set`／`next_ready`を読む。
- roomのclaim・完了報告にはplan keyとtask idを両方含める。
- `todo start --plan <plan_key> --task <task_id>`を使う。
- 証跡は`evidence/<plan_key>/<task_id>.md`へ置く。
- `done.sh`は呼出しごとにPLANを明示できる形を正とし、環境変数は互換省略値としてだけ使う。
- pull run、receipt、landingは同じplanのrunだけを参照する。
- phase制限を使う場合はplan keyとphaseの組として表現し、別PLANを暗黙に禁止しない。
- capacityは全PLAN横断のactive／検証済みreadyを数える現行方針を維持する。

#### 2.4 setupをやり直さずPLANを追加する

既にLattice併用で着卓済みなら、`lattice todo migrate`で新PLANを登録するたびにsetup／teardown／席再起動を
要求しない。既存のroom、メンバー、bridge、credential、`.mcp.json`をそのまま使う。

役割文書では`setup-state.json.plan_key`を「初回着任時の既定PLAN」と明記する。以後の優先PLANは
roomでのオーナー裁定とLattice正本から選び、別のPLAN一覧状態を新設せず、既定PLANの書換えも要求しない。

#### 2.5 互換性と非目標

- `setup.sh`の既存`plan_key`位置引数、`setup-state.json.plan_key`、`PEERTABLE_PLAN`、
  `change-effort.sh`は削除・改名しない。
- Claude向けroom DB fields、slash command、hook、transcript、baton、resume挙動を変更しない。
- Lattice、Aiterm、Claude Code、Codex CLI本体は改造しない。
- npm version bump、publish、本番deployは本campaignに含めない。
- 旧`t4`のハーネス修理と監査は本campaignに含めない。

#### 2.6 Codex席の起床bridgeは着席時の機械装備にする

Codex席を一席でも含む卓では、`wakeup-bridge`をAIの判断や親の手動復旧に委ねない。
`launch-seat.sh`がCodex席の着席を成功として返す前に、同じroomを監視するbridgeを冪等にensureし、
`.team/wakeup-bridge.json`のlive pidと`ready_at`を確認する。bridgeを準備できなければ、Codex席を
「room新着で起床可能な着席済み席」として成功扱いしない。

setup直後、席の増員後、同じroomへの再着席後のいずれも同じ機械契約を通る。通常運用で親や席が
`ensure-bridge.sh ... wakeup`を思い出して補う手順は持たない。外部process境界のtyped failureと
teardownによる停止は既存契約を維持する。

#### 2.7 監査専任席は機械可読な席役割にする

監査専任を着任briefやroomの口頭裁定だけで表現しない。席の正規launch入力、`.team/seats/<name>.json`、
room member metadataへ`worker`／`auditor`の席役割を機械可読に保持し、省略時は既存互換の`worker`とする。

`auditor`は実装・調査ToDoをclaimせず、具体的に依頼された完成候補の独立監査だけを担う。capacity投影では
実装worker数、ready reclaim候補、worker縮退候補から除外し、監査capacityとして別に残す。本campaignの
運用契約はSol監査専任を一席維持することであり、idleであることを理由に実装claimや退席を促さない。

## 3. Lattice工程

### c1 Aiterm公開面へのPeertable実席接続をfocused testで確定する

Phase 1。所有は本task用の新規`experiments/` harnessと証跡だけ。製品codeは変更しない。

Aiterm npm/global `0.24.0`、MCP `tools/list`の`agent_configure` schema、現在のPeertable実席descriptor／
Aiterm session一覧を実測する。現在の正規launchで作ったClaude／Codex席の`session_id`を
`agent_configure`へ渡せるか、同一session・同一contextを保ってmodel-only／effort-only／同時変更できるかを
fixtureと破棄可能な実席で測る。失敗時は原因を「Peertableのsession相関不足」「Aiterm公開契約の非対応」
「対象席busy」へ切り分け、原因未確定の製品修正へ進まない。

受入条件: 現在の実装境界と、Phase 1 product taskが使う正確なsession相関が証跡に固定される。

### c2 稼働席のmodel／effort変更とroom同期を実装する

Phase 1。依存: c1。所有: `skill/scripts/change-seat.sh`、必要な新規adapter、`room/client.mjs`、
`skill/scripts/launch-seat.sh`のうちc1で必要性が実証された最小箇所、Phase 1 focused harness。

同一vendorのmodel／effort変更では再起動経路を廃止し、Aiterm`agent_configure`を呼ぶ。旧設定取得、busy保護、
同値no-op、receipt検証、room memberの動的素性同期、保存結果の読返し、履歴の順を実装する。
vendor変更だけは既存再起動経路を維持する。Aiterm失敗時に旧`leave-seat.sh`／`launch-seat.sh`へfallbackしない。

受入条件: Claude／Codex fixtureでmodel-only、effort-only、同時変更、no-op、busy、unsupported target、
Aiterm失敗、metadata同期失敗を正負で測り、対象sessionとcontextが維持される。

### c3 Phase 1を実Peertable席で往復確認し、案内を同期する

Phase 1。依存: c2。所有: Phase 1実席証跡、`skill/SKILL.md`、`skill/templates/member.md`、
`skill/templates/member-standalone.md`、`skill/templates/parent.md`の設定変更節だけ。

破棄可能なClaude席とCodex席で、初期設定→別model／effort→初期設定の往復を同一sessionで行う。
room member表示、履歴、会話context継続を実測する。別メンバーのpeer audit後にPhase 1を閉じる。

受入条件: 既存文書から「再起動」「contextを引き継がない」「exact effort DM」の旧案内が現行面に残らず、
実測済みのAiterm境界だけを説明する。

### m1 単一PLAN束縛の負例と複数PLAN契約をfocused harnessへ固定する

Phase 2。依存: c3。所有: 本task用の新規`experiments/` harnessと証跡だけ。

現行生成物が`{{PLAN_KEY}}`をstart・evidence・doneへ固定し、`setup-state.json.plan_key`と
`PEERTABLE_PLAN`を卓の所属PLANとして読ませる負例を固定する。同時にcapacity-advisorが全PLANを既に集計する
正例、Lattice storeが複数PLANを保持する正例を固定する。

受入条件: 修正前に「旧PLANがactiveのまま、同じ席が新PLANのtaskをstart・doneできない／案内されない」ことが
REDになり、修正対象がsetup・role・done・launch・案内のどこかを列挙できる。

### m2 setup・launch・roleを複数PLAN対応へする

Phase 2。依存: m1。所有: `skill/scripts/setup.sh`、`skill/scripts/launch-seat.sh`、
`skill/scripts/ensure-bridge.sh`、`skill/scripts/capacity-advisor.mjs`、`room/client.mjs`の席役割投影、
`skill/templates/member.md`、必要なrole生成・wakeup bridge・capacity focused harness。

単数planを既定値へ格下げし、作業ループを全PLAN横断statusと完全修飾taskへ変更する。生成済み席がsetupの
やり直しなしで新PLANを扱えること、phase制限がplan/phaseの組としてだけ効くこと、旧setup呼出しが引き続き
成立することを測る。加えてCodex席のlaunchがwakeup bridgeを必ず機械装備し、live pidと`ready_at`を
確認するまで着席成功を返さないこと、繰返しlaunch／増員でbridgeが一世代だけ維持されることを測る。
監査専任席はlaunchからroom metadata、seat identity、capacity投影まで同じ`auditor`役割を保持し、
実装claim・worker reclaim・worker縮退の対象に入らないことも正負で測る。

受入条件: 新PLAN追加にteardown、setup、席再起動、`setup-state.json.plan_key`の破壊的書換えを要求しない。
Codex席の着席成功後は`.team/wakeup-bridge.json`が必ず存在し、記録pidがlive、`ready_at`があり、roomの
明示宛DMで対象席が起床する。親や席による手動`ensure-bridge`を正常系の一部にしない。
Sol監査専任一席がidleでもworker向け`reclaim_idle`／`scale_down`を受けず、実装workerの必要数とは別に
監査capacityとして維持される。役割未指定の既存launchは`worker`として互換動作する。

### m3 done・証跡・run操作を呼出しPLANで束縛する

Phase 2。依存: m1。所有: `skill/templates/done.sh`、対応focused harness、必要な診断だけ。

`done.sh`へ呼出し単位のplan指定を追加し、明示値を正、`PEERTABLE_PLAN`を互換省略値とする。task show／done、
evidence path、active pull run、receipt gate、完了イベントのすべてが同じplan keyへ束縛されることを確認する。

受入条件: 別PLANに同じtask idが存在しても誤完了・誤証跡・誤receipt参照が起きず、旧呼出しも維持される。

### m4 複数PLANの案内と運用正典を同期する

Phase 2。依存: m2、m3。所有: `skill/SKILL.md`、`skill/templates/parent.md`、`docs/plan.md`、
README日英の該当箇所、案内整合focused harness。

「plan keyは…」「指定なしはplan全体」「この卓のclaim範囲」という単数所属表現を、既定PLANと完全修飾操作の
説明へ置き換える。setupは卓をLattice storeへ接続する操作であり、PLAN追加のたびに行う操作ではないと明記する。
WIP規則は実行優先順位であって、room／席／Lattice storeのPLAN収容数制限ではないことも明記する。

受入条件: 現行案内だけを読んだAIが「新PLANにはteardown／別卓が必要」と解釈する文面が残らない。

### i1 旧t4を保持した同一円卓で新PLANを完了できることを統合実測する

Phase 3。依存: m4。所有: 本task用の統合harnessと
`evidence/live-seat-config-multiplan-20260812/i1.md`だけ。旧`t4`所有fileは変更しない。

`peertable-autonomy-runtime-20260811/t4`をin-progress、既存pull runと未commit差分を保持したまま、同じroom・
同じメンバー席が本PLANのtaskを完全修飾で選択・start・監査・doneする。途中で一席のmodel／effortを
Aiterm経由で変更し、同一contextのまま作業継続する。新PLAN完了後も旧`t4`と差分が元の状態で残ることを確認する。

受入条件: teardown、setup、席再起動なしで二つのPLANへ到達でき、片方の完了が他方のtask／run／evidenceを
変更しない。別メンバーのpeer auditを経て完了する。

### g1 関連回帰・pack・Lattice整合・pushを閉じる

Phase 3。依存: i1。所有: campaign最終証跡だけ。product codeは変更しない。

Phase 1／2のfocused testを確認後に関連回帰を一度だけ実行する。`PEERTABLE_URL= node room/client.mjs diagnostics`、
`npm pack --dry-run`、`lattice todo verify`、本PLANのtask状態、room peer audit、git diff／statusを照合する。
本campaign対象だけをpathspecでcommitし、fetch後に未push祖先がすべて受理済みであることを確認して通常pushする。
publish／deployは行わない。

## 4. 依存グラフと並列化

```text
c1 focused境界
  -> c2 live設定変更実装
  -> c3 実席往復・Phase 1受入
  -> m1 単一PLAN負例
       -> m2 setup/launch/role ─┐
       -> m3 done/evidence/run ─┴-> m4 案内・正典
                                  -> i1 同一卓複数PLAN実測
                                  -> g1 最終gate
```

Phase 1は同じ設定変更線を触るため直列化する。Phase 2のm2とm3だけは書込pathが分離するので並列候補とし、
Lattice independenceが非交差と検証した場合だけ同時実行する。m4以降は直列である。

## 5. F / A / Hと検証

- F: Aiterm公開receiptとPeertable session相関、context維持、room metadataの真実性、完全修飾PLAN境界、
  旧PLANを変更しない統合受入。親が契約を固定し、円卓の別席監査を必須にする。
- A: focused harness、adapter／script／role／docsの仕様固定実装。正式着席した円卓メンバーが担当する。
- H: なし。npm publish、本番deploy、force、履歴改変は本PLAN外。

通し試験は各taskのfocused RED／GREENとpeer auditが揃った後、g1で一度だけ行う。失敗した場合は失敗機能の
局所再現へ戻り、原因確定前にproduct codeを変更しない。

## 6. 完了条件

1. c1〜g1が別席peer auditを経てdoneである。
2. Claude／Codexのmodel／effort変更がAiterm公開面で同一session・contextを維持して実測済みである。
3. room memberのmodel／effortと変更履歴が実設定に一致する。
4. 同じroom・席・Lattice storeが複数PLANを完全修飾して扱い、setupや再起動を要求しない。
5. 旧`t4`、既存pull run、未commit差分が本campaign開始時の中断状態で保持される。
6. 関連回帰、diagnostics、pack dry-run、Lattice verifyがgreenである。
7. 本campaign対象commitがmainへ着地し、通常push済みである。
