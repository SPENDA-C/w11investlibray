# 公開までの手順

**上から順にやれば公開できる。** どの画面で何を入力するかまで書いてある。

コマンドの意味や、詰まったときの切り分けは [`DEPLOY.md`](./DEPLOY.md) を引く。
こちらは順路、あちらは辞書。

---

## 全体像

作業は 3 本に分かれる。**A だけ終われば LP は公開できる**（＝先行登録の受付を開始できる）。
B はダッシュボードを動かす作業で、A の後でよい。C は急がない。

```
A. LP を公開する           ← ここまでで先行登録の受付が始まる
      ↓
B. ダッシュボードを動かす   ← 自分だけが見る画面
      ↓
C. 会員公開の判断           ← J-Quants の回答待ち。数か月かかってもよい
```

### 順序で 1 箇所だけ、間違えると面倒になるところ

**Cloudflare Access（B5）は、手動パイプライン（B4）の後に掛ける。**

Access は Worker の**手前**（Cloudflare のエッジ）で止める仕組みなので、
掛けた瞬間から `curl` でアプリ側の URL を叩けなくなる。
先に掛けてしまうと、初回のパイプラインを手で回す方法が無くなる。

Cron（平日 19:30）は HTTP のエッジを通らず Worker を直接起動するので、
**Access の影響を受けない。** 一度手で回しておけば、あとは自動で回る。

---

## チェックリスト

```
トラック A — LP を公開する
  [ ] A0  リポジトリを手元に用意する   ← 以降はすべてこの中で打つ
  [ ] A1  wrangler にログインする
  [ ] A2  D1 を作り、npm run set:db-id で id を書き込む
  [ ] A3  R2 を有効化してバケットを作る
  [ ] A4  マイグレーションを本番の D1 に流す
  [x] A5  運営者名・所在地・連絡先を書く   ← 記入済み。preflight が未記入を止める
  [ ] A6  preflight を通してデプロイする
  [ ] A7  ドメインで開けることを確認する（diagnose）
  [ ] A8  WAF のレート制限を 1 本入れる
  [ ] A9  自分で先行登録して、保存されることを確認する

トラック B — ダッシュボードを動かす
  [ ] B1  J-Quants の API キーを Secret に登録する（--env production！）
  [ ] B2  疎通を確認し、プラン情報を DATA-SOURCES.md に記録する
  [ ] B3  過去データを入れる（バックフィル）
  [ ] B4  日次パイプラインを手で 1 回回す       ← Access より前
  [ ] B5  Cloudflare Access を app ホストにだけ掛ける
  [ ] B6  Team domain と AUD を wrangler.toml に貼って再デプロイ
  [ ] B7  画面上部の赤い警告が消えたことを確認する

トラック C — 会員公開の判断
  [ ] C1  J-Quants に再配信の可否を問い合わせる
  [ ] C2  回答を DATA-SOURCES.md に記録する
  [ ] C3  可なら MEMBER_SIGNUP_ENABLED を true にする
```

---

> **どのコマンドも、リポジトリの中で打つ。**
> `npm run …` はカレントディレクトリの `package.json` を見るので、
> 外で打つと `npm error ENOENT … package.json` で全部落ちる。
>
> **コード枠は行ごとに貼る。** この文書のコード枠には説明を混ぜていないが、
> チャットなどからコピーするときは行末の `#` に注意する——
> **zsh は対話中 `#` をコメントとして扱わない**（既定で
> `INTERACTIVE_COMMENTS` が無効）。`npm run waitlist  # 説明` を貼ると
> `Unknown arguments: #, 説明` になる。
>
> **`…に本物のキー` のような穴埋めは、必ず置き換えてから実行する。**

---

# トラック A — LP を公開する

## A0. リポジトリを手元に用意する

**ここを飛ばすと A2・A4・A6 がまとめて失敗する。**

```powershell
cd ~\Documents
git clone https://github.com/spenda-agency/w11investlibray.git
cd w11investlibray
npm install
npm test
```

bash なら `cd ~/Documents` 以降は同じ。

| | |
|---|---|
| 必要なもの | Git、**Node.js 22 以上**（`node -v` で確認） |
| ブランチ | 指定は要らない。既定が作業ブランチになっている |
| `npm test` を置く理由 | **ネットワークも API キーも不要**で 230 件走る。ここが通れば、clone と Node の版は問題ない。`npm run deploy` で初めて気づくより早い |

**以降のコマンドはすべてこの `w11investlibray` の中で打つ。**
プロンプトが `PS C:\Users\…\w11investlibray>` になっていることを確かめる。

### 別の PC で続きをやるとき

**2 つだけ、clone しても付いてこないものがある。**

| | なぜ付いてこないか | どうするか |
|---|---|---|
| `wrangler` のログイン | 認証情報は PC ごと | `npx wrangler login` |
| `database_id` | **git に入れていない**（`wrangler.toml` はプレースホルダのまま） | `npm run set:db-id -- <uuid>` |

`database_id` を忘れると、`npm run deploy` が
`database_id が未設定（プレースホルダのまま）` で止まる。
uuid が分からなくなったら引き直せる:

```bash
npx wrangler d1 list
```

Cloudflare 側に置いたもの（Secret・D1 のデータ・R2・WAF・Cron）は
アカウントに紐づくので、**PC を変えても消えない。**
入れ直すのは上の 2 つだけ。

---

## A1. wrangler にログインする

```powershell
npx wrangler login
npx wrangler whoami
```

ブラウザが開いて Cloudflare の認証に飛ぶ。許可すると端末に戻る。

**ドメインを置いているアカウントでログインすること。** 別アカウントだと
デプロイは通るのにルートが一致せず、ドメインが 404 になる。

> **Windows では、リポジトリの中で実行する。** ホームディレクトリで走らせると
> `Application Data` の権限エラーになることがある。

---

## A2. D1 を作り、`database_id` を 2 箇所に貼る

**Windows ではこちら。** 出力に出る `database_id` をコピーして渡す。

```powershell
npx wrangler d1 create invest-db
npm run set:db-id -- 'a1b2c3d4-5e6f-7890-abcd-ef1234567890'
```

bash ならパイプで繋げる（出力から id を拾う）。

```bash
npx wrangler d1 create invest-db | npm run set:db-id
```

> **PowerShell でパイプにしない。** npm の cmd シムを挟むと標準入力が
> 渡ってこないことがある。その場合スクリプトは 3 秒で諦めて
> 「引数で渡すこと」と言って終わる（固まりはしない）。

### `A database with that name already exists` と出たら

**作り直さない。既にあるものの id を引く。**

```powershell
npx wrangler d1 list
npx wrangler d1 info invest-db
```

出てきた uuid を `set:db-id` に渡す。`d1 create` は一度成功していれば
DB が残っているので、**このエラーは「もう作ってある」という意味**でしかない。

> パイプに繋いだ `d1 create` が npm 側のエラーで落ちた場合、
> **DB は作られていて id だけが失われている。** 上の 2 つで引き直せる。

`set:db-id` に渡すのは**実際の uuid**（`a1b2c3d4-5e6f-7890-abcd-ef1234567890`
のような 36 文字）。プレースホルダの文字列をそのまま渡すと
`✗ UUID が見つからない` と言って、**何も書かずに止まる**。

```
✓ database_id を 2 箇所に書き込んだ: a1b2c3d4-5e6f-7890-abcd-ef1234567890
    次は npm run db:migrate:remote -w @invest/worker
```

**貼り先が 2 箇所あるのでスクリプトにしてある。**

| 行 | 場所 | 何に使われるか |
|---|---|---|
| 31 行目付近 | `[[d1_databases]]` | `wrangler dev` / `db:migrate:local` |
| 103 行目付近 | `[[env.production.d1_databases]]` | **本番** |

`preflight` が見ているのは本番側だけなので、**既定側の打ち間違いは黙って通る。**
手で 2 回写す作業をなくしてある。同じ id をもう一度渡しても何も起きない（冪等）。
UUID が 2 個以上見つかったら、**書かずに止まる**。

---

## A3. R2 を有効化して、バケットを作る

**先にダッシュボードで R2 を有効化する。** ここを飛ばすと次のエラーになる。

```
✘ [ERROR] Please enable R2 through the Cloudflare Dashboard. [code: 10042]
```

```
dash.cloudflare.com → 左メニュー R2 → 有効化（規約に同意）
```

Workers Paid に入っていれば支払い情報は登録済みなので、同意だけで済むはず。
有効化したら:

```powershell
npx wrangler r2 bucket create invest-snapshots
```

**なぜ Phase 1 でも要るのか。** 日次パイプラインの最後の工程
（`dailyPipeline.ts` の `writeSnapshot`）が、その日のランキングを R2 に置く。
画面はまずここを読むので、D1 が重いときでもトップページが返る。
この工程は `try` の中にあるので、**バケットが無いとパイプライン全体が
失敗扱いになる**（トラック B4 で効いてくる）。

トラック A（LP の公開）では中身を使わないが、`wrangler.toml` に
バインディングがあるので、**バケットが無いと deploy が通らない。**

---

## A4. マイグレーションを本番の D1 に流す

```powershell
npm run db:migrate:remote -w @invest/worker
```

`0001_init.sql`（17 テーブル）と `0002_waitlist.sql`（先行登録）が順に適用される。
このスクリプトには `--env production` が入っているので、本番の D1 を指す。

確認（PowerShell は行継続がバッククォート `` ` ``。1 行で書いてもよい）:

```powershell
cd packages\worker
npx wrangler d1 execute invest-db --remote --env production --command "SELECT name FROM sqlite_master WHERE type='table'"
cd ..\..
```

`waitlist` が一覧にあること。無ければ `0002` が流れていない。

---

## A5. 運営者名・所在地・連絡先 — **記入済み**

LP は公開した瞬間からメールアドレスを集め始める。
**誰が集めているのかが分からない状態で集めてはいけない。**

入っている内容:

| 場所 | 内容 |
|---|---|
| `/privacy` の「事業者」 | 株式会社SPENDA（代表取締役 伊藤潤平）／ 東京都荒川区東日暮里 5-50-5 日暮里ラングウッド 3F ／ contact@spenda-c.com |
| LP のフッター | 運営: 株式会社SPENDA ／ お問い合わせ: contact@spenda-c.com |

**所在地に「東京都」を補ってある。** 登記上の表記と違っていれば
`packages/worker/src/routes/lp.ts` の `privacyPage()` を直すこと。

### 空に戻したら deploy が止まる

`scripts/preflight.mjs` が `src/routes/lp.ts` と `src/ui/lp.ts` を読み、
`を記入` が残っていたら**エラーで `npm run deploy` を中断する**。
逃げ道（環境変数で無効化）は作っていない。

```bash
grep -rn 'を記入' packages/worker/src/
```

> **保存期間と解除方法は文案を入れてある。** いまのコードが実際に
> やっていることに合わせた文面なので、そのままで筋が通っている。
> ただし**運用を変えたら直すこと**——たとえば解除リンクを付けずに
> 配信を始めるなら、「メールに記載の解除方法」という記述が嘘になる。
>
> 個人情報保護法上、取得する主体の名称と連絡先は本人が知り得る状態に
> 置く必要がある。**最終的な判断は事業者側で確認すること。**
> ここに書いてあるのは実装上の所在であって、法務のお墨付きではない。

---

## A6. preflight を通してデプロイする

```bash
npm run preflight
```

`✓ デプロイ前チェック通過（警告 1 件）` になれば進んでよい。
警告は「Access が未設定」で、これは B5 で消える。**止める必要はない。**

まだ `✗` が出るなら、そこに直し方が書いてある。

```bash
npm run deploy
```

これは `preflight` → `wrangler deploy --env production` の順に走る。
**`--env production` が要る**（付け忘れるとルートの無い Worker が上がり、
ドメインに反応しない）。`npm run deploy` を使っていれば自動で付く。

### Cron が登録されたかを確かめる

デプロイは **ルート → Cron の順**に進む。Cron の登録だけが失敗すると
`Trigger configuration ... was only partially updated` と出て、
**ルートは張られたのに定期実行が動かない**という中途半端な状態になる。

```
dash.cloudflare.com → Workers & Pages → w11-invest-library-production
  → Settings → Triggers → Cron Triggers
```

2 本（`30 10 * * 1-5` と `0 22 * * 1-5`）が並んでいること。

> 曜日に `0` を書くと Cloudflare が `invalid cron string [code: 10100]` で
> 拒否する。`preflight` が先に止めるようにしてあるが、
> **一度この状態でデプロイすると Cron だけ空のまま残る。**
> その場合は直して `npm run deploy` をやり直せば揃う。

#### `You need a workers.dev subdomain … [code: 10063]` が出たとき

```
- You need a workers.dev subdomain in order to proceed. Please go to the
  dashboard and open the Workers menu. [code: 10063]
```

**アカウントがまだ一度も Workers の画面を開いていない**という意味。
Cloudflare のアカウントには `<好きな名前>.workers.dev` というサブドメインが
1 つ紐づくが、これは初回にダッシュボードを開いたときに発行される。
**Cron の登録 API がその存在を前提にしている**ので、
Cron を workers.dev で使うつもりが無くても弾かれる。

直し方——ダッシュボードを一度開くだけ。

```
dash.cloudflare.com → 左メニュー Compute (Workers)
  → サブドメイン名を決める画面が出るので、好きな名前で確定する
```

そのあと `npm run deploy` をやり直す。ルートは張り直しになるだけで害は無い。

> **`wrangler.toml` の `workers_dev` は `false` のままにすること。**
> 名前が同じなので紛らわしいが、別のものを指している。
>
> | | 何か | どうする |
> |---|---|---|
> | アカウントの workers.dev サブドメイン | アカウントに 1 つ付く名前。Cron の登録に要る | **発行する** |
> | `wrangler.toml` の `workers_dev = true` | **この Worker をその URL でも公開する**設定 | **触らない** |
>
> Access はゾーンのホスト名にしか掛からないので、後者を有効にすると
> ダッシュボードが認証なしで開く。`preflight` とテストが止めるようにしてある。
> **サブドメインを発行しても、`workers_dev = false` ならこの Worker は
> そこに出ない。**

---

## A7. ドメインで開けることを確認する

DNS の A レコードは設定済みのはず（`@` と `app`、どちらも
IPv4 `192.0.2.1`、**プロキシ オン**）。まだなら `DEPLOY.md` の手順 5 を見る。

**まとめて見るならこれ 1 本。** Windows でも bash でも同じ。

```
npm run diagnose
```

URL は `wrangler.toml` の `LP_HOSTNAME` / `APP_HOSTNAME` から組む。
OS を見て `.ps1` と `.sh` を選ぶ。**`cd` も環境変数の設定も要らない。**

> 別のホストを見たいときだけ、環境変数で上書きする。
> **PowerShell では `LP_URL=… コマンド` の形は動かない**
> （`用語 'LP_URL=…' は認識されません`）。`$env:名前="値"` を**先の行で**置く。
>
> ```powershell
> $env:LP_URL="http://localhost:8787/lp"
> $env:APP_URL="http://localhost:8787"
> npm run diagnose
> ```

疎通だけでなく、**ホストを分けた目的が守れているか**を見る。

| 節 | 見ているもの |
|---|---|
| [1] | LP が開いていること。CSP に書体の読み込み先が入っていること |
| **[2]** | **ランキング・スクリーナー・先行登録の一覧と CSV が、LP 側で 404 になること** |
| [3] | ダッシュボードが 200 で開かないこと（302 = Access、401 = Worker 認証） |
| [4] | 日次パイプラインの鮮度 |

この段階では [3] が「Access のログインへ飛ぶ」にならず、[4] は
「まだ 1 度も成功していない」になる。**どちらも A の時点では正しい**
（B5 と B4 で解消する）。

手で見るなら（**bash の書き方**。PowerShell では `curl` が
`Invoke-WebRequest` の別名になり、`grep` も無いので動かない。
Windows で同じことをするなら `curl.exe -sI … | Select-String 'HTTP/|cf-ray'`）:

```bash
curl -sI https://goldencross-incomegains.com/ | grep -iE 'HTTP/|cf-ray'
```

| 見えるもの | 意味 |
|---|---|
| `cf-ray:` がある | Cloudflare のエッジを通っている |
| `HTTP/2 200` | Worker が応答している |
| `HTTP/2 522` / `523` | **プロキシが灰色雲になっている。** オレンジ雲に直す |
| 名前が引けない | DNS レコードが無い |

ブラウザで `https://goldencross-incomegains.com/` を開いて、LP が出ることを確認する。

CSP と書体も見ておく:

```bash
curl -sI https://goldencross-incomegains.com/ | grep -i content-security-policy
```

`fonts.googleapis.com` と `fonts.gstatic.com` が入っていること
（Noto Sans JP はこの 2 つから読んでいる。無いと書体が黙って落ちる）。

---

## A8. WAF のレート制限を 1 本入れる

`POST /api/waitlist` は**認証なしで受ける唯一の書き込み口**。
コード側にハニーポット・同意必須・1 日 500 件の上限は入れてあるが、
それは最後の砦であって、入口で削るのは Cloudflare 側の仕事。

### 画面の場所

```
dash.cloudflare.com
  → goldencross-incomegains.com を選ぶ
  → 左メニュー Security → WAF
  → Rate limiting rules タブ        ← **Custom rules ではない**
  → Create rule
```

> ### **「カスタムルール」と間違えないこと**
>
> 画面がよく似ていて、**間違えると `/api/waitlist` が 1 回目から
> 全部ブロックされる**（送信するとブロックページ = エラー 1020 が出る）。
> 一度これをやった。
>
> 見分け方——**「リクエスト数」と「期間」を入れる欄があるか。**
>
> | | カスタムルール | レート制限ルール |
> |---|---|---|
> | 一致条件の下 | すぐ「アクション」 | **「リクエスト数」「期間」がある** |
> | 一致数のプレビュー | 「最後の 24 時間」が出る | 出ない |
>
> アクションの直前に回数の欄が無ければ、まだカスタムルールの画面。
> タブを選び直す。間違えて保存してしまったら、**そのルールを消してから**
> レート制限ルールとして作り直す。
>
> `diagnose` はこれを検出する（`[1] 先行登録の受け口` が `NG 403` になる）。

### 入力する値

| 欄 | 入れる値 |
|---|---|
| Rule name | `waitlist-abuse` |
| **If incoming requests match** | Field `URI Path` / Operator `equals` / Value `/api/waitlist` |
| （＋ And で 1 行足す） | Field `Request Method` / Operator `equals` / Value `POST` |
| **With the same characteristics as** | `IP` |
| **When rate exceeds** — Requests | `5` |
| **When rate exceeds** — Period | `10 minutes` |
| **Then take action** | `Block` |
| Duration | `1 hour` |

Deploy を押す。

> **Period の選択肢はプランで変わる。** Free プランでは `10 seconds` と
> `1 minute` しか出ないことがある。その場合は
> **`1 minute` あたり `3` リクエスト**にする。趣旨は同じ。

### なぜ Method も見るのか

`GET /api/waitlist` は 405 を返すだけで、D1 に触らない。
Method を絞らないと、無害な GET でも枠を消費して、
正規の利用者の POST が巻き添えでブロックされる。

---

## A9. 自分で先行登録して、保存されることを確認する

ブラウザで LP を開き、自分のメールアドレスで実際に登録する。
**同意チェックを入れないと送信できない**ことも確認する（必須にしてある）。

D1 に入ったかを見る。**リポジトリの一番上で打つ**（`cd` は要らない）:

```
npm run waitlist
```

> `cd packages\worker` してから `npx wrangler d1 execute …` でも同じだが、
> **`--env production` を落とすと既定の Worker の D1 を見に行って
> 「0 件」に見える。** script に畳んであるので、そちらを使う。

| 見るところ | 期待 |
|---|---|
| `email` | **小文字**で入っている（正規化している） |
| `consented_at` | 空でない（同意した時刻） |
| `status` | `pending` |
| IP アドレス | **列が無い。** そもそも保存していない |

> **`app.〜/waitlist` の画面は、いまはまだ開かない。**
> `{"error":"Cloudflare Access が未設定のため停止中"}` が返る。
>
> Access（B5）を掛けるまでの間、アプリ側のホスト名を知っていれば
> 誰でも CSV を落とせてしまうため、**個人情報を返す 2 経路だけ
> 先に閉じてある**（`src/auth.ts` の `isUnprotectedProduction`）。
> B5・B6 が済めば開く。それまでは上の `d1 execute` で中身を見る。

**ここまでで LP は公開できる状態。** 告知して構わない。

---

# トラック B — ダッシュボードを動かす

## B1. J-Quants の API キーを Secret に登録する

```bash
cd packages/worker
npx wrangler secret put JQUANTS_API_KEY --env production
npx wrangler secret list --env production
cd ../..
```

（Windows は `cd packages\worker` … `cd ..\..`）

> ### Windows で `Assertion failed: … src\win\async.c` と出て落ちたら
>
> `wrangler secret put` は**対話プロンプトを出す**コマンドで、
> Windows の一部の端末では libuv がここで落ちる。wrangler のヘルプが
> 表示されて終わることもある。**登録できていないので、確認すること。**
>
> ```bash
> npx wrangler secret list --env production
> ```
>
> 落ちるなら、**ダッシュボードから入れる。** こちらは OS を問わない。
>
> ```
> dash.cloudflare.com → Workers & Pages → w11-invest-library-production
>   → Settings → Variables and Secrets → Add
>   Type: Secret / Name: JQUANTS_API_KEY / Value: （キー）
>   → Deploy
> ```
>
> **`w11-invest-library-production` を選ぶこと**（`-production` の付かない
> ほうではない）。理由は下と同じ。

### **`--env production` を落とさないこと**

ここが一番ハマる。`wrangler.toml` は `name = "w11-invest-library"` に
`[env.production]` を足した構成で、`[env.production]` に `name` の上書きが無い。
そのため `wrangler deploy --env production` が上げる Worker の名前は
**`w11-invest-library-production`**（環境名が接尾辞として付く）。

**Secret は Worker ごとに分かれている。** `--env` を付けずに登録すると
`w11-invest-library`——誰も使っていないほう——に入る。

症状が分かりにくい。**デプロイは成功するのに、パイプラインだけが
`JQUANTS_API_KEY が未設定` で落ち続ける。**

```bash
npx wrangler secret list --env production
```

`JQUANTS_API_KEY` が出ること。空なら、これ。

**`wrangler.toml` に API キーを書かないこと。** git に入る。

---

## B2. 疎通を確認し、プラン情報を記録する

**リポジトリの一番上で打つ。** `packages/worker` の中で打つと
`Missing script: "check:datasource"` になる（このスクリプトは
`@invest/batch` にあり、ルートが橋渡ししている）。

```bash
export JQUANTS_API_KEY="ここに本物のキー"
npm run check:datasource
```

> **B1 で登録したのとは別物。** B1 の Secret は Cloudflare 上の Worker が
> 使うもので、手元の端末からは読めない。このコマンドは手元で走るので、
> 環境変数として渡す必要がある。**同じキーを 2 か所に置くことになる。**
>
> `ここに本物のキー` を置き換えること。置き換え忘れると
> `JQUANTS_API_KEY に使えない文字が入っている` で止まる
> （キーは HTTP ヘッダーに入るので、全角文字を含められない）。

> ### ⚠ キーそのものを人に見せないこと
>
> 端末の出力を貼って相談するときは、**`export` の行を外す。**
> `check:datasource` の出力にキーは含めていないので、
> `npm run check:datasource` 以降だけを貼れば足りる。
>
> 一度でも見せてしまったら、**ダッシュボードで無効化して発行し直す。**
> `~/.zsh_history` にも残るので、そちらも消しておく。
> 入れ直す先は 2 か所（B1 の Secret と、手元の `export`）。

### 403 が返るとき

`check:datasource` は **API が返した理由をそのまま表示する**。
まずその「→」の行を読む。判断はそのあと。

| 出方 | 意味 |
|---|---|
| **全部 403** | プランの話ではない。`/equities/master` は最下位のプランでも通る。**まず経路を疑う**——「→」に `endpoint does not exist` とあれば URL が違う（API Gateway は経路に一致しないと 403 を返す）。次にキーの発行し直し、プラン変更の反映待ち |
| **一部だけ 403** | 「→」の行に理由が書いてある。プランの範囲外ならそう言ってくる |
| **必要な 3 本のどれかが落ちる** | `/equities/master`・`/equities/bars/daily`・`/markets/calendar`。ここが通らないとトラック B は進められない |

> **この 3 本が V2 の正しい経路。** V1 の名前（`/listed/info` など）で
> `/v2` に投げると全部 403 になり、「契約プランの範囲外」に見える。
> 一度これでプランを上げるところまで行った（`docs/DATA-SOURCES.md` §1 に経緯）。

契約プラン・取得できる期間・遅延・**API が実際に返した項目名**が出る。

出力を `docs/DATA-SOURCES.md` の §1 にある空欄に貼る:

```
確認日:            2026-XX-XX
プラン:            （出力から）
日足の遅延:        （出力から）
取得可能な期間:    （出力から）
```

**取得可能な期間は B3 のバックフィル範囲を決める。** プランによっては
10 年遡れず、`--from` を後ろにずらす必要がある。

> 項目名が変わっていて「項目 "close" が見つからない」で落ちた場合、
> このコマンドが**実際に返ってきた名前**を表示する。それを
> `wrangler.toml` の `JQUANTS_FIELD_ALIASES` に入れればコードを直さず復旧できる。
> 書き方は `DEPLOY.md` の「うまくいかないとき」にある。

---

## B3. 過去データを入れる（バックフィル）

日次パイプラインは「今日の 1 日ぶん」しか取らない。
指標が意味を持つには過去のぶんが要るので、**最初に 1 度だけ**まとめて入れる。

### どこまで遡るか

Light プランは **2021-09-05 以降**が取れる（`docs/DATA-SOURCES.md` §1）。
**推奨は 2 年**（`from` `2024-09-02` / `to` `2026-09-04`）。

| | |
|---|---|
| スコアが出る条件 | 30 営業日（`dailyPipeline.ts:139`）。**1 年でも足りる** |
| 指標の質 | `LOOKBACK_BARS = 300`。300 本あれば 200 日線まで意味を持つ |
| バックテスト | 取引 30 回未満だと統計として結論を出せない。長いほど楽 |

**1 年（`from` `2025-09-02`）でも動く。** 時間や容量を惜しむならそれでよく、
**あとから古い期間を足せる**（`ON CONFLICT DO NOTHING` なので重ねても壊れない）。

範囲外の日付を指定すると **HTTP 400** で
`Your subscription covers the following dates: 2021-09-05 ~` が返る。
403（経路違い・権限）とは別物。

### GitHub Actions で回す（推奨）

リポジトリの Settings → Secrets and variables → Actions に 3 つ登録する:

| 名前 | どこで取るか |
|---|---|
| `JQUANTS_API_KEY` | J-Quants ダッシュボード |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → 右上のアイコン → API Tokens → Create Token → **Edit Cloudflare Workers** テンプレート |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com のドメイン概要ページ右下、または `npx wrangler whoami` |

> **ここの secret は独立したコピー。** 手元の `export` とも、
> B2 で `wrangler secret put` した Cloudflare 側とも別物で、
> **キーを更新しても自動では追随しない。** J-Quants のキーを回したら
> 3 箇所とも入れ直すこと（`docs/DEPLOY.md` の「キーを更新したとき」）。
>
> 古いままだと、ワークフローが最初の 1 リクエストで落ちる:
> `J-Quants /markets/calendar が 403: {"message": "The incoming api key is invalid or expired."}`

Actions タブ → 左の一覧から **「バックフィル」** → Run workflow。

| 入力欄 | 入れる値 |
|---|---|
| `from` | 開始日（`2024-01-01` など。B2 で分かった取得可能期間の範囲内で） |
| `to` | 終了日（前営業日でよい） |
| `apply` | **チェックを入れる** ← 既定は off。入れないと SQL を作るだけで D1 に流れない |

`apply` を off のまま回すと、生成された `backfill-*.sql` が Artifacts に
上がるだけで終わる。**初回は off で回して、ファイルの数と大きさを見ること。**
確認したうえで on にして回し直す。

### 何が書き出されるか

3 つのテーブルが、**この順**で出る:

| 順 | テーブル | 中身 |
|---|---|---|
| 1 | `market_calendar` | 営業日（`HolDiv` で休場を除いたもの） |
| 2 | `symbols` | **日足に出てきた銘柄すべて。** 名前と業種は `/equities/master` から |
| 3 | `prices_daily` | 日足 |

**順序が意味を持つ。** `prices_daily` は `symbols` を参照しているので
（`migrations/0001_init.sql:63`）、逆に流すと
`FOREIGN KEY constraint failed` で落ちる。

> 期間の途中で上場廃止になった銘柄は `/equities/master` に載らないが、
> **日足には出てくる**ので `symbols` にも最小行（名前＝コード）を作る。
> 作らないと、その銘柄の価格が外部キーで弾かれる。
> 名前は日次パイプラインが後から埋める（`ON CONFLICT DO UPDATE`）。

### 出力は連番のファイルに分かれる

日足は 1 営業日あたり約 4,200 行（全銘柄）返る。
**1 ファイルでは `wrangler d1 execute --file` に渡せない**ので、
5 MB ずつ `out/backfill-001.sql` … と分けて書く。

2 年ぶんの見込みは下の表。**推測ではなく、2026-09-05 に 2 営業日ぶんを
本番 D1 まで実際に流して測った値からの外挿**（`--from 2026-09-01 --to 2026-09-02`、8,409 行・67 クエリ・0.10 秒・1.93 MB）。

| | 2 年（約 490 営業日） |
|---|---|
| 日足 | 約 206 万行 |
| SQL | 約 170 MB / 34 本前後 |
| D1 のサイズ | 約 325 MB |
| D1 の書き込み行数 | 約 760 万 |
| 所要時間 | 30 分ほど |

**書き込み行数が論理行数の約 3.7 倍になる。** 索引ぶんが乗るため
（試走では 12,647 行の INSERT に対し 46,411 rows written）。
D1 の課金はこの行数で決まるので、先に知っておく。有料枠の月 5,000 万行には収まる。

**適用は必ず連番の順。** `market_calendar` の INSERT が `prices_daily` より
先に来る必要がある（外部キー）。ワークフローは `sort` して順に流すので、
Actions から回すぶんには意識しなくてよい。

**時間の大半は取得側。** 2 年で約 490 リクエスト（1 営業日 1 回）に対し、
適用は速い（試走では 5 MB・67 クエリが 0.10 秒）。
**途中で止まったらまず取得を疑う。** 失敗しても、失敗した番号から
再開してよい（重ねて流しても壊れない）。

### 手元で回す

```bash
export JQUANTS_API_KEY=本物のキー
npm run build -w @invest/batch --silent
node packages/batch/.build/cli.mjs backfill --from 2024-09-02 --to 2026-09-04
```

> **node を直接呼ぶ形を載せてある。** `npm run backfill -- --from …` でも
> 動くが、`npm run X -- args` の args は X の文字列の**末尾に連結される**ので、
> script が入れ子だと内側の npm が `--from` を自分のオプションとして食う。
> 実際それで落ちた（`--from と --to は必須。` と出て、値だけが位置引数に
> なっていた）。ルートの script 末尾に `--` を置いて直してあるが、
> **node 直呼びなら段が無いぶん壊れようがない。**

書き出したファイルの一覧と、流し込むコマンドが最後に表示される。
**連番の順に流すこと:**

```bash
cd packages/worker
for f in $(ls ../../out/backfill-*.sql | sort); do
  echo "適用: $f"
  npx wrangler d1 execute invest-db --remote --env production --file="$f"
done
cd ../..
```

ここでも **`--env production` が要る**（B1 と同じ理由。付けないと既定の
`[[d1_databases]]` を見に行く）。

**Worker で回さない理由**は、行数と実行時間の両方。2 年で約 206 万行、
取得だけで約 490 リクエストになる。

---

## B4. 日次パイプラインを手で 1 回回す ← **Access より前**

**Windows ではこちら。`.exe` を忘れないこと。**

```powershell
curl.exe -X POST "https://app.goldencross-incomegains.com/api/run-pipeline"
```

> **`curl` だけだと落ちる。** PowerShell の `curl` は `Invoke-WebRequest` の
> 別名で、`-X` という引数を持たない
> （`パラメーター名 'X' に一致するパラメーターが見つかりません`）。
> `curl.exe` と書けば本物の curl が呼ばれる（Windows 10 1803 以降に同梱）。
>
> PowerShell だけで書くならこう:
>
> ```powershell
> Invoke-RestMethod -Method Post -Uri "https://app.goldencross-incomegains.com/api/run-pipeline"
> ```

bash なら:

```bash
curl -X POST "https://app.goldencross-incomegains.com/api/run-pipeline"
```

| クエリ | 意味 |
|---|---|
| `?force=1` | 成功済みの日でも走り直す |
| `?date=YYYY-MM-DD` | 日付を指定する |

確認は diagnose に任せる（OS を問わない）:

```
npm run diagnose
```

`[4]` が `ok 直近の日次処理が成功している` になれば通っている。

ブラウザで `https://app.goldencross-incomegains.com/` を開くと候補が並ぶ。
**この時点ではまだ誰でも見られる**（画面上部に赤い警告が出ている）。次で閉じる。

> **スコアが 0 件のとき**は過去データが足りていない。指標が意味を持つには
> 最低 30 営業日ぶんが要り、それ未満の銘柄は候補に出さない仕様。B3 に戻る。

---

## B5. Cloudflare Access を app ホストにだけ掛ける

### **LP ホストには絶対に掛けない**

掛けると先行登録フォームが誰にも見えなくなり、集客が止まる。
**Subdomain 欄が `app` になっていることを、保存前に必ず確認すること。**

### 画面の場所

```
dash.cloudflare.com
  → 左サイドバー Zero Trust（別画面 one.dash.cloudflare.com に飛ぶ）
  → （初回のみ）チーム名を決める
  → Access → Applications → Add an application → Self-hosted
```

**初回だけチーム名を聞かれる。** ここで決めた名前がそのまま
`<チーム名>.cloudflareaccess.com` になり、あとで `CF_ACCESS_TEAM_DOMAIN` に貼る。
プランは Free（50 ユーザーまで）で足りる。

### アプリケーションの設定

| 欄 | 入れる値 |
|---|---|
| Application name | `invest-dashboard` |
| Session Duration | `24 hours` 程度 |
| **Subdomain** | `app` ← **ここを空にすると LP まで閉じる** |
| **Domain** | `goldencross-incomegains.com` |
| Path | **空のまま**（ホスト全体を対象にする） |

### ポリシー

Next を押すとポリシーの画面になる。

| 欄 | 入れる値 |
|---|---|
| Policy name | `運営者のみ` |
| Action | `Allow` |
| Include | Selector `Emails` → Value に自分のメールアドレス |

ログイン方法は既定の **One-time PIN** でよい（アクセス時にメールへ 6 桁が届く）。
Google などを使いたい場合は Zero Trust → Settings → Authentication で足す。

Save する。

---

## B6. Team domain と AUD を貼って再デプロイ

### 取ってくる値は 2 つ

| 変数 | どこにあるか | 形（照合の基準） |
|---|---|---|
| `CF_ACCESS_AUD` | Access → Applications → `invest-dashboard` を開く → Overview の **Application Audience (AUD) Tag** | **64 桁の 16 進数** |
| `CF_ACCESS_TEAM_DOMAIN` | Zero Trust → Settings → General の **Team domain** | **`.cloudflareaccess.com` で終わる** |

> コンソールの文言や階層は変わることがある。迷ったら**値の形**で見分ける。
> 64 桁の 16 進数が AUD、`.cloudflareaccess.com` で終わるのが Team domain。

### 貼る場所

`packages/worker/wrangler.toml` の **`[env.production.vars]`**（126〜127 行目付近）。
**既定側ではなく本番側**に入れること。

```toml
CF_ACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"
CF_ACCESS_AUD = "a1b2c3...（64 桁）"
```

> **ここに貼るのは手順ではなく前提。** `[env.production.vars]` は
> デプロイのたびにこのファイルの内容で上書きされる。Cloudflare の
> ダッシュボードで直接入れても、**次のデプロイで空に戻る**——
> つまりダッシュボードが無防備な状態に戻る。
>
> 自動デプロイ（`.github/workflows/deploy.yml`）が入っているので、
> これは **push のたびに起きる。** ファイルに貼ること。

反映は 2 通り。**コミットして push すれば Actions が出す**（推奨。
ファイルに入った状態が本番と一致する）。手元から出すなら:

```bash
npm run deploy
```

---

## B7. 赤い警告が消えたことを確認する

ブラウザのシークレットウィンドウで `https://app.goldencross-incomegains.com/` を開く。

| 期待 | |
|---|---|
| Access のログイン画面が出る | Access が効いている |
| メールを入れて PIN でログインできる | ポリシーに自分が入っている |
| **画面上部の赤い警告が消えている** | `CF_ACCESS_AUD` が正しく入り、Worker 側でも JWT を検証できている |

警告が残っているなら、`CF_ACCESS_AUD` が別のアプリケーションのものか、
`[env.production.vars]` ではなく既定側に貼っている。

**A7 の diagnose をもう一度**走らせると、[3] が
「Access のログインへ飛んでいる」に変わる。ここまでで全項目が ok になるはず。

LP 側が閉じていないことも確認する:

```bash
curl -sI https://goldencross-incomegains.com/ | head -1
```

### 掛けたあとの運用

| やりたいこと | どうするか |
|---|---|
| 死活監視 | **LP ホストの** `https://goldencross-incomegains.com/api/health` を叩く |
| 日次の実行 | **何もしなくてよい。** Cron は Access を通らない |
| 先行登録を見る | `https://app.goldencross-incomegains.com/waitlist`（Access の内側） |
| CSV で書き出す | 同画面の `/api/waitlist.csv`。Excel で開ける形（UTF-8 BOM 付き） |
| 手でパイプラインを回す | Zero Trust → Access → **Service Auth** でサービストークンを発行し、`CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダを付けて叩く。**Cron が動いているなら要らない** |

**書き出した CSV はメールアドレスの塊。** 置き場所と共有範囲に注意すること。

---

# トラック C — 会員公開の判断

`MEMBER_SIGNUP_ENABLED` を `true` にしてよいかは、**技術ではなく契約の問題**。
`docs/DATA-SOURCES.md` の §2 が埋まるまで開けない。

いまの読みは「**会員制（登録ユーザーへの提供）は第三者提供に当たる可能性が高い**」。
J-Quants の標準契約は自己利用が前提に見えるため、Phase 1 は Access で
自分・社内に限定して運用している。これは**推測なので、確認して置き換える。**

## C1. 問い合わせる

まず [jpx-jquants.com](https://jpx-jquants.com/) にログインし、
利用規約の「第三者提供」「再配信」「二次利用」に当たる条項を読む。
そこで判断がつかなければ、問い合わせフォームから聞く。

そのまま貼れる文面:

```
J-Quants API の利用範囲について確認させてください。

【契約情報】
  契約者名: （記入）
  プラン:   （記入）

【やりたいこと】
J-Quants API から取得した日足データをもとに、当方で算出した
テクニカル指標（RSI・MACD・移動平均・ATR など）およびスコア・判定結果を、
ログイン制のウェブ画面で登録ユーザーに表示することを検討しています。

【前提として想定していること】
  ・表示するのは当方で算出した派生値であり、取得した生データそのものを
    一覧表示・ダウンロードさせる機能は設けません
  ・株価の終値など生値を表示する場合も、1 銘柄ずつの参照に限り、
    バルクダウンロード機能は提供しません

【伺いたいこと】
  1. 上記の利用は、利用規約上の第三者提供に該当しますか
  2. 該当する場合、別途のご契約により可能になりますか
  3. 可能な場合、条件と費用の目安をご教示ください

お手数ですが、ご確認のほどよろしくお願いいたします。
```

## C2. 回答を記録する

`docs/DATA-SOURCES.md` の §2 にある記録欄を埋める。

```
確認日:      2026-XX-XX
確認方法:    問い合わせフォーム / 規約 第X条
回答:        （回答をそのまま）
結論:        会員公開 可 / 不可 / 別契約が必要
```

**日付と出典を必ず残すこと。** 規約は改定される。
「いつの時点の、どの条項に基づく判断か」が残っていないと、
半年後に同じ調査をやり直すことになる。

## C3. 可なら開ける

```toml
MEMBER_SIGNUP_ENABLED = "true"
```

`preflight` がここで警告を出す（「§2 が埋まっているか確認しろ」）。
埋めたうえで出る警告なので、無視して進んでよい。

**不可なら開けない。** Access で限定したまま運用を続ける。
先行登録で集めたアドレスは、公開できる形が決まってから使う。

---

## 困ったときの引き先

| 症状 | どこを見るか |
|---|---|
| ドメインが 404 / 522 | `DEPLOY.md`「ドメインに反応しない」 |
| 先行登録が保存されない | `DEPLOY.md`「先行登録が保存されない」 |
| 「データがありません」のまま | `DEPLOY.md`「画面に『データがありません』と出る」 |
| パイプラインは通るがスコアが 0 件 | `DEPLOY.md`「スコアが 0 件」 |
| 項目名で落ちる | `DEPLOY.md`「項目 "close" が見つからない」 |
| `/api/health` が `stale` | `DEPLOY.md`「`/api/health` が `stale` を返す」 |
| ローカルで LP しか開けない | `DEPLOY.md`「ローカルで LP しか開けない」 |

ログを直接見る:

```bash
cd packages/worker
npx wrangler tail --env production
```
