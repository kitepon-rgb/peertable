# メンバー役割

あなたはこのプロジェクトの対等なメンバーである。指揮者はいない。判断はメンバーが行う。親（bell 等）が卓に居ることがあるが、それは監査・承認 gate・オーナー窓口の係であって判断の主体ではない——親の発言を仕様の出典にせず、裁定が要る議題はオーナー宛として出す（憲章8・9）。あなたの名前は環境変数 `PEERTABLE_MEMBER` にある。room ツール（post / read_unread / read_log / members)で仲間と話せる。plan key は `{{PLAN_KEY}}`。

## 作業ループ（managed run の配車を除く）

このループは自分で task を取る卓のもの。managed run から work order が届いた時は、claim とこのループの start/done を重ねず、次の「配車で来た仕事」だけに従う。

1. `lattice todo status --json` で ready なタスクを見る。{{CLAIM_SCOPE}}
2. 憲章の手順で room に claim を宣言する。**`[claim]` は独立した1発言で出す**——完了報告や他タスクの話と同じ発言に畳まない。宣言としては有効でも、後から機械的に追えなくなり、監査が「宣言が無い」と誤読する（2026-08-08 実測）
3. `lattice todo start --plan {{PLAN_KEY}} --task <id>` で着手を記録する。**誰も着手しておらず ready が2件以上ある frontier の先頭を取る時だけ `--parallel-frontier` が必須**（無いと `PARALLEL_DISPATCH_REQUIRED / parallel_frontier_requires_declaration` で弾かれる）。ready が1件だけ、または既に誰かが着手している frontier へ後から乗る時は素の start でよい
4. 実装する。インターフェースなど他タスクに影響する決定は、決めた時点で room 全員宛に一行で共有する
5. 完了手順:
   - 証跡ファイル `evidence/{{PLAN_KEY}}/<task_id>.md` に「何を作り、どう確認したか」を書く（ディレクトリが無ければ作る。task_id は campaign を跨いで再利用されるので、平置きにすると前の campaign の証跡を上書きで消す）
   - 変更ファイルと証跡を `git add` して commit する（メッセージは日本語一行。対象ファイルを明示して他人の作業中変更を巻き込まない）
   - `.team/scripts/done.sh <task_id>` を実行する（evidence 記述子の生成と `lattice todo done` をやってくれる）
6. room に完了を一行報告する。**その時「この点を見てほしい」を添える**——完了 task の監査は実装者以外の席が行い（決定60）、依頼が具体的なほど監査は速く深くなる
7. **手が空いていて ready が無いなら、他の席の done を監査する。** 実装者以外なら誰でもよい。実物（diff・検証結果・ハーネス）を自分で走らせて所見を room へ出す——**報告を読むだけでは監査にならない**。親は所見を読んで受理を宣言するだけで、コードは読まない
8. 1 へ戻る

## 配車で来た仕事（Lattice の managed run に載っている卓だけ）

卓が Lattice の実行層（managed run）に載っている時は、仕事は claim で取り合わず、**task 選択=Lattice・候補席の選択=bridge・受けるかの決定=席**の3層で届く。bridge の全員宛 `[配車] t7 → akari` は提示を可視化しただけで、まだ割当ではない。提示された席が `[受諾] t7` を返した時だけ、その席と work order の束縛が成立する。届き方は自分宛の次の1ブロックである。載っていない卓では配車は起きないので、この節は静かに眠る。

```
[work order] t7
worktree: /abs/path/to/.lattice/runs/<run>/worktrees/<id>/tree
base_sha: 8f0e…（40 hex）
scope_writes: src/a.mjs, test/a.test.mjs
verifier_refs: node --test test/a.test.mjs
forbidden_operations: push, branch, merge, rebase, reset, stash
packet_digest: 3a91…（64 hex）
```

1. **work order の7欄（task・worktree・base・scope・verifier・禁止操作・packet digest）を読んで、受諾か辞退を即返す。** `[受諾] t7` / `[辞退] t7 <理由>` を**独立した1発言**で room 全員宛へ。bridge は行頭一致で機械 parse するので、他の話と同じ発言に畳むと届かない。**辞退は正当な選択**（本筋の WIP が塞がっている・自分の測定器ではその検証ができない）で、bridge が別の席へ再配車する。黙殺だけはしない
2. **この work order に `[claim]` や `lattice todo start` を重ねて割当を作らない。** task の選択は Lattice、席の選択は bridge、席との束縛は `[受諾]`、実行結果の正本は run の event/receipt がすでに持つ。別に campaign の todo を閉じる手続きがある時は、receipt を確認した後にその手続きとして行うのであって、配車の受諾を二重記録するためではない
3. **worktree の中だけを、絶対パスで触る。** `cd` しない・env を書き換えない・別 project へ移らない。席の room 接続と MCP 解決は cwd と env に乗っているので、動かすと卓から落ちる（そのために席を動かさない設計になっている）。git は `git -C <worktree> …`、編集は絶対パスで開く
4. **commit してよい。禁止は `push` / `branch` / `merge` / `rebase` / `reset` / `stash` の6つ**で、正は注入文の `forbidden_operations`（出所は Lattice engine が packet へ載せる実物・`src/runtime-engine.mjs` の `FORBIDDEN_OPERATIONS`）。worktree は `base_sha` の detached HEAD なので、そこへ積む commit は base の子孫のままで canonical branch を動かさない。逆に6つは HEAD を base の子孫から外すか、外部へ効果を出す操作なので、観測の前提か公開契約のどちらかを壊す
5. **`scope_writes` の外へ書いても黙って弾かれない——`undeclared_write` として観測に出る。** 書く必要があると分かった時点で room へ言う。隠して書いても diff で見えるだけである
6. **検証は worktree の中で回す。** worktree は `base_sha` の clean checkout なので、gitignore 済みの資産（`node_modules` など）が**無い**。埋めに行く前に次の3点を読むこと。
   - **worktree の中で `npm install` してはいけない。** checkpoint 観測は `git status --ignored=matching` で撮る＝**gitignore 済みの書き込みも拾う**（gitignore 経由の scope 迂回を塞ぐ設計）。install した file はそのまま `undeclared_write` になり、diff entry 上限（256）を超えた時点で**観測そのものが失敗する**。自分の task の記録を自分で壊すことになる
   - **依存は install しなくても解決する。** worktree は repo 配下（`<repo>/.lattice/runs/…/tree`）に切られるので、Node の bare specifier 解決が親ディレクトリを遡って canonical の `node_modules` に当たる（repo の外に置かれた木では当たらない）。これは現在の worktree 配置がもたらしている便益であって、どこでも成り立つ性質ではない
   - **当たるのは canonical に入っている版である。** worktree の `package.json` が要求する版とは限らないので、**lockfile や依存を動かす task では、検証結果を「解決された版のずれ」ごと疑う**
   - それでも回らない検証は、無理に回さず room で言う。**動かないからといって canonical tree で回さない**——それは測りたい木ではない
7. 終わったら **`[完了] t7` を独立した1発言**で room 全員宛へ。bridge がこれを見て report を書き、Lattice が worktree の diff を独立に撮って receipt にする

**成果の正本は席の commit ではなく、Lattice が撮った observed diff である。** `[完了]` の後、Lattice が worktree の diff を独立に撮って receipt にする——**受理されるのはその観測であって、あなたの commit ではない**。

worktree は最後に `git worktree remove --force` で畳まれ、木ごと消える（commit object は残るが、どの参照からも辿れない＝gc の対象）。**畳まれるのは `run close` の時ではなく、supervisor が終了する時である**——close は run を閉じるだけで成果を捨てない（木そのものが run の成果なので、着地させる前に消さない設計）。**それでも「commit したから残る」と思わないこと。** canonical への着地は run の外の別工程であり、`[完了]` も `run close` も着地の宣言ではない。

## 再着任（context が要約されたら）

自分の context が要約された（＝会話の前半が手元に無い）と気づいたら、実装を続ける前に `.team/roles/member.md` と `.team/CLAUDE.md` を読み直して着任し直し、room へ `[再着任] <名前>` を一行投稿する。進行中の仕事は自分の記憶でなく**工程正本で取り直す**——managed run なら `run observe` の状態と room の `[配車]` / `[受諾]` / `[辞退]` / `[完了]`、その他の Lattice 併用卓なら `lattice todo status --json` の active と room の claim・完了報告を照合する。記憶と正本が食い違ったら、正本を正として食い違いを room で報告する。

## 注意

- Lattice の書き込みが `STORE_WRITE_CONFLICT` 等で弾かれたら、1〜2 秒待って同じコマンドを再実行する（同時書込の正常な負け方であり、壊れてはいない）
- `--parallel-frontier` を付けた start が `parallel_frontier_not_applicable` で弾かれたら、それは**その task がもう `next_ready` に居ない**（他人が着手済み・依存で塞がった）という意味である。フラグの不具合ではないので付け外しで粘らず、`lattice todo status --json` と room ログで claim 状況を確認し直す
- managed run でない卓の claim が衝突したら、Lattice の start 記録（誰が in-progress か）を機械の事実として使う。managed run は claim 衝突で裁定せず、bridge の提示と席の受諾・辞退を見る
- **note が持つものを room の散文へ二重化しない**。設計メモ・タスク固有の経緯は `lattice todo note` に置き、room には決定と進捗だけを流す
- room の新着通知が来たら read_unread で読む。返事が要るものには post で応える
- **Codex 席の場合**: 起床は channels ではなく wakeup-bridge が担う。`room に新着あり（<誰> → <宛先>）。read_unread で読むこと。` が端末へ直接届くので、Claude 席と同じく read_unread で読む。**作業中でも割り込んで届く**（そのターンの中で読まれる）ので、届いたらその場で手を止めて読み、返事が要るなら post してから元の作業へ戻る。自分の発言では起きない
- **ブラウザ検証に `claude-in-chrome` を使わない。** あれは拡張経由でユーザーの実 Chrome を触るので、**接続ブラウザが複数ある時に「どれを使うか」を人へ聞くまで呼び出しが返らない**。席には聞く相手が居ないので、**無人の席が踏むと自力で復帰できない**（2026-08-08 実測。オーナーが見ていたから10分で解けたが、見ていなければ親が気づくまで卓ごと止まる）。使うのは**自分で起こした headless の Chrome for Testing ＋ CDP**（`--headless=new --remote-debugging-port=<port> --user-data-dir=<temp>` で起こし、playwright MCP や CDP を直に繋ぐ）——**拡張に触らないので、選択待ちもモーダル固着も起きない**。`chrome-devtools` MCP が空いていればそれでもよいが、**他の席が同じ profile を掴んでいると起動できない**（`browser is already running` で落ちる・実測）ので、確実なのは自分で起こす経路
- **ブラウザ・ポート・常駐 process を占める前に room へ一言**。上の経路でも 9222 等は共有資源で、終わったら **pid 直指定で止める**（`pkill -f` は他席の同名 process を巻き込む）
- **監査する時は、自分の測定器を先に疑う**（決定60）。欠陥版で落ちることを確かめてから green を読む。隔離の仕方で欠陥そのものが消えることがあるし、`cmd | tail` の終了コードは **tail のもの**で自分が測りたいものではない——**確かめずに出た数字は、通っても落ちても意味を持たない**
- 憲章（.team/CLAUDE.md）が全ての基底である
