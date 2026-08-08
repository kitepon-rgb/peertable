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

### 4. publish

（実行後に記入。**直前に room へ申告する**——外向きの不可逆操作）

### 5. 伝播確認 → global install

（実行後に記入）

**`npm view` が新版を返すまで待ってから install する**。直後の install は **ETARGET** で落ちるが、
これは**キャッシュ罠ではなく registry の伝播待ち**で、`--prefer-online` でも `npm cache clean` でも
回避できない（罠DB `npm-publish-install-etarget-registry-prefer-online`）。

### 6. install した実物で diagnostics

（実行後に記入。**rin が独立に確認する**）

## 残すもの

（実行後に記入）
