# peertable 0.3.2 release（campaign 末尾の npm patch release）

**task ではない**——§13 が定める campaign 末尾の手順で、bell の裁定（room [415]）により
**証跡のみを残す形 (B)** で記録する。`refit-deploy-20260808` の terminal-audit がこの証跡を参照する。

- **実行者**: ichika（room [404] で claim・rin [405] の譲渡により確定）
- **独立確認者**: rin（版数2箇所・pack files・公開後の install diagnostics）
- **前提**: ①haruka の push 17本着地（room [406]）②mio の t16 本番入替 ③kotoha の t15 配線追補と
  haruka の監査（bell [419] の (A) 最小形）④**0.3.2 前の4点**（下記）

## 0.3.2 前に入った4点（bell [476] が現在値・kotoha 実装）

| | 内容 | commit | 監査 |
| --- | --- | --- | --- |
| ① | `seat-status-bridge` の停止を SIGKILL まで昇格（wakeup-bridge と同型） | `e13aa05` | haruka [490] 受理相当 |
| ② | `teardown.sh` の `--stop` 失敗 guard（**両ブリッジ共通**・`[未実施]` 明示＋撤去続行） | `7a601a1` | haruka [490] 受理相当 |
| ③ | `POST /messages` の `body_required` 400 | `e13aa05` | rin（[482] 先着・所見待ち） |
| ④ | `SKILL.md:51` の空行1つ | `e13aa05` | — |

**②が入った経緯**: bell は当初 §11 送りと裁定したが（[470]）、kotoha [472] の
「**t6 の受入契約（各段の実施/未実施を1行ずつ・黙って中断しない）が条件付きで破れるのは、
発現確率で棚上げする性質ではない**」を採って (A) へ変更した（[475][476]）。
**発現条件の線（正規経路か異常系か）ではなく、出荷済み契約の穴かどうかで切った**という判断。

**③が本番へ届く面は npm ではない**: `deploy/compose.yaml` の image は
`peertable-room:20260809-4605744` に pin されている。**0.3.2 を publish しても、
MS-A2 で動いている room は古い server のまま**で、本文欠落が正本へ入る経路は開いたまま。
**塞がるのは mio の t16 入替の時だけ**（room [478]）。

## 手順と結果

### 0. bump 前の状態（下見）

**bump 後に初めて見ると、差分が版数由来かどうか判断できない**ので先に取った。

```
package.json      : 0.3.1
room/client.mjs:13: const MCP_VERSION = '0.3.1'
npm pack --dry-run: 23 ファイル / package 56.8 kB / unpacked 149.5 kB
  LICENSE / README.md / README.ja.md / package.json
  room/{client.mjs, Dockerfile, server.mjs}
  skill/SKILL.md / skill/scripts/*.{mjs,sh} 7本 / skill/templates/* 7本
  → `.lattice/` `.team/` `evidence/` `docs/` `experiments/` は**1つも入っていない**
```

### 1. 版数を2箇所とも上げる

```
package.json        0.3.1 → 0.3.2   （`npm version 0.3.2 --no-git-tag-version`）
room/client.mjs:13  MCP_VERSION '0.3.1' → '0.3.2'   （手で）
package-lock.json   0.3.1 → 0.3.2 ×2箇所（`npm version` の副産物・**room [518] で宣言を訂正した**）
```

**`package-lock.json` を入れる理由**: 外すと lockfile だけ 0.3.1 で取り残され、**決定45 が潰したのと同じ版数 drift を自分で作る**。
`files` の外なので tarball には入らない（pack が 23件のままなのが実物）。

**2箇所ある理由**: 決定45 が **drift 検出のために意図的に2つ目の版数源**（`room/client.mjs` の `MCP_VERSION`）を
置いている。`npm version` は `package.json` しか触らないので、**片方だけ上げると `version_consistency` が
fail して `not_ready` になる**——0.3.0 がまさにそれで欠陥版として出た（room [148]）。

### 2. bump 後・publish 前に手で diagnostics

```
$ PEERTABLE_URL= node room/client.mjs diagnostics
peertable 0.3.2 — ready
  pass  version_consistency: package.json と client.mjs がどちらも 0.3.2
  pass  bin_integrity / node_runtime(v26.5.1) / skill_bundle(必須15ファイル)
  not_applicable  room_reachability（PEERTABLE_URL 未設定）
```

**bump 前にも同じ gate を通してある**（room [503]・`0.3.1 — ready`）ので、
**ここが落ちたら原因は bump 以外に無い**と言える状態で通した。落ちていない。

`prepublishOnly` が gate として走るが、**先に手で通しておく**（publish で驚かないため）。
gate の形は `PEERTABLE_URL= node room/client.mjs diagnostics`——**空文字を渡して到達性判定を外し、
成果物自体の性質（version_consistency / bin_integrity / node_runtime / skill_bundle）だけを見る**。
`PEERTABLE_URL` が生きていると、**room が落ちているだけで publish が止まる**（room [154]）。

### 3. `npm pack --dry-run` で files を人が見る＋**untracked の混入を確かめる**

**bump 後（0.3.2）**:
```
version: 0.3.2 ／ filename: peertable-0.3.2.tgz
total files 23 ／ package 57.8 kB ／ unpacked 152.9 kB   ← bump 前と同一（版数は同じ文字数）
pack 対象パスの untracked: package.json と room/client.mjs の M（＝bump 分）だけ・untracked ゼロ
```

**2人で逆順に読んだ**（room [521]）。同じ人が同じ順序で読むと同じ見落とし方をするため:
- **ichika**: 「**入るべきものが在るか**」の側から（3回目・毎回この順で読んでいる）
- **kotoha**: 「**入ってはいけないものが無いか**」の側から＋**tarball を展開して中の `room/client.mjs` が
  0.3.2 か**（pack の一覧と `git diff` では見えない角度。`package.json` だけ上げて client が古いまま
  載ると 0.3.0 の再演になる）

**gate は tarball の中身を見ない**（room [160]）。`files` が5エントリに絞られていることが混入を防いでいる
のであって、gate が守っているわけではない。**ここは人が見る**。

**そして tarball は working tree から作られる**——**git 管理外（untracked）のファイルも混入する**
（罠DB `npm-publish-payload-working-tree-untracked-tarball…`・bell から伝達 room [455]）。
`files` の `skill/` は**丸ごと指定**なので、**`skill/` 配下に作業ファイルが残っていれば 0.3.2 に載る**。
`git status --untracked-files=no` 系の gate では検出できない。

**防御は2つ**: ①`pack --dry-run` の一覧を「**入るべきものが在るか**」だけでなく
「**入ってはいけないものが無いか**」の向きでも読む ②実行前に `git status --untracked-files=all` を
**pack 対象パスに限って**引く。

**bump 前の実測（`e13aa05` + `7a601a1` 着地後・0.3.1 のまま・room [489]）**:
```
HEAD: 7a601a1
$ git status --porcelain --untracked-files=all -- room/ skill/ package.json README.md README.ja.md LICENSE
（出力なし＝pack 対象パスに untracked ゼロ）
$ npm pack --dry-run → **23 ファイル** / package 57.8 kB / unpacked 152.9 kB
    skill/scripts/teardown.sh           6.4kB  ← ②guard（両ブリッジ分）で +0.8
    skill/scripts/seat-status-bridge.mjs 8.5kB ← ①SIGKILL 昇格で +0.4
    room/server.mjs                    25.5kB  ← ③body_required
  23件を1件ずつ見た: **.team/ ・ .lattice/ ・ evidence/ ・ docs/ ・ experiments/ ・ deploy/ は1つも無い**
repo 全体の untracked は .lattice/ ・ deploy/README.md ・ evidence/refit-deploy-20260808/ の3つで、
**どれも pack 対象パスの外**（`files` は LICENSE / README×2 / package.json / room/ / skill/ のみ）
```

**測る時点を「監査した HEAD」に合わせた**理由: guard は `teardown.sh` にしか触らないので
`room/server.mjs` の測り直しは技術的には不要に見えるが、**「監査した HEAD と出荷する HEAD が同じ」と
言えるかどうかは別の性質**。この卓は同日中に「参照先が実在しない hash」で2回もつれている（room [487]）。

**`room/server.mjs` の UI が生きているかを別途 gate した**（room [483]）: 同ファイルは同日に
t10（mio）・t14（haruka）・`e13aa05`（kotoha）と3人が触っており、**t14 で「UI テンプレート内の `'\n'` が
配信 JS の SyntaxError になり Web UI が丸ごと死ぬ・console にも何も出ない」**を実際に踏んでいる。
使い捨て server から配信 HTML を引いて `<script>` を抜き、`node --check` → **rc=0**（9684B）。

### 3.5 **publish の前に tarball の実物を install して動かす**（手順に無かった分・room [525]）

6段目（公開後に registry から install して diagnostics）は **publish の後**なので、
そこで初めて欠陥が出ても取り消せない。同じ検査を **publish の前に1回**やっておけば、
6段目に残るのは **registry 由来の問題（伝播・改変）だけ**になる。

```
$ npm pack --pack-destination <scratch>   → peertable-0.3.2.tgz（57,809 bytes）
$ npm install --prefix <隔離先> <その tgz> → added 94 packages（global を汚さない）
$ PEERTABLE_URL= node <隔離先>/…/peertable/room/client.mjs diagnostics
  peertable 0.3.2 — ready（version_consistency / bin_integrity / node_runtime / skill_bundle）
```

**`skill_bundle` の15ファイルが tarball 経由で揃った**＝`files` の `skill/` 指定が実際に中身を運んでいる。

### 4. commit → push → 祖先確認

```
$ git status --porcelain（commit 前に目で見る）
   M deploy/compose.yaml   ← mio の作業中。触らない
   M package-lock.json / M package.json / M room/client.mjs / ?? evidence/…   ← 私の4つ
$ git add package.json package-lock.json room/client.mjs evidence/refit-deploy-20260808/
$ git diff --cached --name-only → 上の4つだけ（mio の deploy/ が居ないことを確認してから commit）

commit 825bc55「0.3.2へbumpする」 4 files changed, 151 insertions(+), 4 deletions(-)
$ git push origin main → 7a601a1..825bc55 ／ 未push 0本 ／ main...origin/main 0 0
$ git merge-base --is-ancestor 825bc55 origin/main → 祖先 ✓（publish 対象）
$                          7a601a1 origin/main → 祖先 ✓（出荷する木）
```

**独立確認**: rin が `825bc55` の実 diff を読み、宣言どおり4ファイル・版数4箇所すべて
0.3.1→0.3.2・`deploy/` は入っていないことを確認（room [529]）。

### 5. publish

**直前に room で宣言してから叩いた**（room [542][546]）——外向きの不可逆操作なので、
「今から叩く」が append-only の正本に残っている状態にしてから実行する。
mio の本番入替（room が数秒落ちる窓）と重なっていたため、彼女の「上がった」[541] を待った。

```
$ npm publish
  name: peertable ／ version: 0.3.2 ／ 23 files ／ 57.8 kB ／ unpacked 152.9 kB
  shasum: e5fe9c03d8a0da5e6c895288271ce38dc103406b
  Publishing to https://registry.npmjs.org/ with tag latest and default access
  + peertable@0.3.2
```

### 6. 伝播確認 → registry から install → 実物で diagnostics

**`npm view` が新版を返すまで待ってから install する**。直後の install は **ETARGET** で落ちるが、
これは**キャッシュ罠ではなく registry の伝播待ち**で、`--prefer-online` でも `npm cache clean` でも
回避できない（罠DB `npm-publish-install-etarget-registry-prefer-online`）。
**今回は1回目の照会で 0.3.2 が返り、ETARGET は出なかった**。

```
$ npm view peertable version → 0.3.2（1回目の照会で伝播済み）
$ npm view peertable@0.3.2 dist.shasum → e5fe9c03d8a0da5e6c895288271ce38dc103406b
                          dist.unpackedSize → 152920

$ npm install --prefix <隔離先> peertable@0.3.2     ← local の tgz ではなく registry 指定
  降りてきた実物: package.json 0.3.2 ／ client.mjs:13 MCP_VERSION '0.3.2'
  diagnostics → peertable 0.3.2 — ready（4項目 pass）

$ npm install -g peertable@0.3.2                    ← 実運用の形
$ PEERTABLE_URL= peertable-client diagnostics → peertable 0.3.2 — ready（4項目 pass）
```

## shasum の鎖（haruka の提案・room [526]）

**「測った物 == 出した物 == 降りてきた物」を hash で繋ぐ**。新しい操作はゼロで、
**既にやる操作の出力を読むだけ**。

| | 何の数字か | 値 |
| --- | --- | --- |
| 1本目 | ichika が install して ready を取った物 | `e5fe9c03…` / 57,809 bytes |
| 1本目' | **haruka が独立に pack した物**（別 process・別 temp dir・別時刻） | **同一** |
| 2本目 | `npm publish` が出した物 | **同一** |
| 3本目 | `npm view peertable@0.3.2 dist.shasum` | **同一** |

**1本目' が効いている**: 私の自己確認は「同じ process が dry-run と実ファイルで同じ数字を出した」だが、
haruka のは「別の process が別の temp dir で別の時刻に pack して同じ bytes を得た」——
**pack が決定的である（＝publish が作り直しても同じ物になる）ことの独立した2点目**。
鎖は「違っていたら気づける」だが、これは「違わない理由がある」（haruka [530] の指摘で気づいた。
私は dry-run と実ファイルの一致を確認しただけのつもりで、自分が何を測ったのか取り違えていた）。

## pack を2人で逆順に読んだ（room [521][535][543]）

同じ人が同じ順序で読むと同じ見落とし方をする。**kotoha が設計した「入ってはいけないものの名前を
1つずつ探す」向き**を、**haruka が代走**して走らせた（kotoha は許可ダイアログで固着していた・後述）。

```
① .lattice/ .team/ evidence/ docs/ experiments/ deploy/ node_modules/ .env .log .git
   scratchpad .DS_Store .tgz → **全部「該当なし」**
② pack 対象パスの untracked ゼロ（repo 全体の untracked は .lattice/ 43件と deploy/README.md だけ・files の外）
③ [489] からの差はファイル数 23 のまま・57.8 kB のまま
④ tarball を展開して中の版数を読む → package.json 0.3.2 ／ client.mjs 0.3.2
```

**この角度は ichika も haruka も持っていなかった**——3回測って3回とも「入るべきものが在るか」の側から
読んでいた。kotoha が言語化しなければこの読みは存在していない。

## 残すもの

- **`peertable@0.3.2` が本番の room へ届いたわけではない**。MS-A2 の room は Docker image
  （mio が `peertable-room:20260809-7a601a1` へ入替済み）で、**npm と別の面**。
  `body_required` が本番に載ったのは `compose up -d` の瞬間であって、publish の瞬間ではない（room [478][541]）
- **戻し方は 0.3.3 を出すこと**。unpublish はしない
- **私は「出した本人」なので、私の測定は独立確認にならない**。3本目の照合と隔離導入の
  再測は rin が独立に行う（room [529]）
- **kotoha の①〜④の本人による再走は取れていない**——publish 直前に、彼女の席が
  `rm $SP/*.tgz`（変数が空なら `/*.tgz` に展開される）の安全確認ダイアログで固着したため。
  bell が `No` 側で解除。**参加者一覧はこの状態を `idle`（手が空いている）と表示していた**
  （`esc to interrupt` の不在を「ターンが終わった」としか読まない）。§11 送り・窓口 kotoha
