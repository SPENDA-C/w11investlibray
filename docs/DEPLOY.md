# デプロイ手順と、うまくいかないときの切り分け

> **初めて公開するなら、まず [`GO-LIVE.md`](./GO-LIVE.md) を見ること。**
> あちらが「上から順にやれば公開できる」一本道の手順書。
> こちらは**辞書**——個々のコマンドの意味と、詰まったときの切り分けを引く。

---

## 0. その前に

**`docs/DATA-SOURCES.md` の「再配信の可否」が未解決のうちは、
`MEMBER_SIGNUP_ENABLED` を `true` にしないこと。**
Phase 1 は Cloudflare Access で自分 / 社内のみに限定して運用する。

---

## 1. 必要なもの

| | |
|---|---|
| Cloudflare アカウント | **Workers Paid（$5/月）を前提**にしている。無料枠でも日次は回るが、バックフィルで D1 の行数上限に当たる |
| J-Quants の API キー | [J-Quants ダッシュボード](https://jpx-jquants.com/) |
| Node.js 22 以上 | |

> **Windows で作業する場合**
> `wrangler` は必ずリポジトリ内で実行する。ホームディレクトリで走らせると
> `Application Data` の権限エラーになる。

---

## 2. まずローカルで動かす（アカウント不要）

```bash
npm install
npm run typecheck
npm test                                   # ネットワーク不要
npm run db:migrate:local -w @invest/worker
npm run db:seed:local -w @invest/worker
npm run dev
```

`http://localhost:8787/` を開く。サンプルデータなので画面上部に警告が出る。

---

## 3. Cloudflare の資源を作る

**R2 は先にダッシュボードで有効化する。**
していないと `Please enable R2 through the Cloudflare Dashboard [code: 10042]`
で止まる（dash.cloudflare.com → 左メニュー R2 → 有効化）。

```bash
cd packages/worker

npx wrangler d1 create invest-db
npx wrangler r2 bucket create invest-snapshots
```

R2 は Phase 1 でも要る。日次パイプラインの最後の工程（`writeSnapshot`）が
その日のランキングを R2 に置き、画面はまずそこを読む。この工程は `try` の中に
あるので、**バケットが無いとパイプライン全体が失敗扱いになる。**

**出力された `database_id` を `wrangler.toml` の 2 箇所に書き込む。**

```bash
npx wrangler d1 create invest-db | npm run set:db-id
# 手で渡すなら（出力をまるごと貼ってもよい）
npm run set:db-id -- 'a1b2c3d4-5e6f-7890-abcd-ef1234567890'
```

| 場所 | 何のためか |
|---|---|
| `[[d1_databases]]`（既定） | `wrangler dev` / `db:migrate:local` |
| `[[env.production.d1_databases]]` | **本番。`preflight` が見ているのはこちらだけ** |

既定側を忘れても `preflight` は止まらないので、スクリプトが両方に書く。
同じ id を再度渡しても何も起きない（冪等）。UUID が 2 個以上あれば書かずに止まる。

```bash
npm run db:migrate:remote -w @invest/worker   # 0001 と 0002 を順に適用する
```

このスクリプトには `--env production` が入っている（本番の D1 を指すため）。

---

## 4. Secret を登録する

**`wrangler.toml` に API キーを書かないこと。**

```bash
npx wrangler secret put JQUANTS_API_KEY --env production
# Phase 1b で使う
# npx wrangler secret put ANTHROPIC_API_KEY --env production

npx wrangler secret list --env production      # 入ったか確認
```

### **`--env production` を落とさないこと**

`name = "w11-invest-library"` に `[env.production]` を足した構成なので、
`wrangler deploy --env production` が上げる Worker の名前は
**`w11-invest-library-production`** になる（`[env.production]` に `name` の
上書きを置いていないため、環境名が接尾辞として付く）。

**Secret は Worker ごとに分かれている。** `--env` を付けずに登録すると
`w11-invest-library`——誰も使っていないほう——に入る。

症状が分かりにくい。**デプロイは成功するのに、パイプラインだけが
`JQUANTS_API_KEY が未設定` で落ち続ける。** `wrangler secret list --env production`
が空なら、これ。

### キーを更新したとき

**J-Quants のキーは独立したコピーが 3 箇所にある。**
1 つ更新しても、残りは古いキーを持ったまま黙って動き続ける。

| | 誰が読むか | 更新の方法 | 古いままだとどうなるか |
|---|---|---|---|
| 手元の `export JQUANTS_API_KEY` | `check:datasource`・手元の backfill | シェルで export し直す | その場で 403 |
| Cloudflare Worker の secret | **毎日 6:15 の Cron** | `npx wrangler secret put JQUANTS_API_KEY --env production` | **静かに失敗し続ける** |
| GitHub Actions の secret | バックフィルのワークフロー | Settings → Secrets and variables → Actions | ワークフローが 403 で落ちる |

**危ないのは 2 つめ。** Actions は即落ちるので気付くが、Worker の secret が
古いと **Cron が毎朝失敗するだけで、誰も見ていなければ気付かない。**
画面が古くなって初めて分かる。**キーを回したら必ず 3 つとも入れ直すこと。**

> `wrangler secret list` は**名前しか出さない**。中身が新しいかどうかは
> 表示されないので、「入っているように見える」で判断できない。
> **迷ったら入れ直す**（同じ値を入れても害はない）。

更新したら 1 つずつ確かめる:

```bash
npm run check:datasource
curl.exe -X POST "https://app.goldencross-incomegains.com/api/run-pipeline"
```

Actions は 1 営業日ぶん（`from` = `to`）を `apply` off で空回しすれば足りる。

---

## 5. デプロイする

**経路は 2 つある。中身は同じ。**

| | いつ走るか |
|---|---|
| GitHub Actions（`.github/workflows/deploy.yml`） | `claude/stock-screening-ai-library-35qwmk` に push したとき。Actions タブから手動実行もできる |
| 手元 | `npm run deploy` |

どちらも `scripts/preflight.mjs` → `wrangler deploy --env production` を
同じ順で走らせる。**ワークフロー側に条件を書き足さないこと**——
2 箇所に分かれるとずれる。チェックを足すなら preflight に足す。

> **`docs/` と `*.md` だけの変更では自動デプロイは走らない。**
> Worker の中身が変わらないため。LP の文面は
> `packages/worker/src/ui/lp.ts` にあるので、こちらは走る。

> **Actions は型チェック・テスト・seed 検証を通してからデプロイする。**
> 落ちたら本番には出ない。

手元から出すとき:

```bash
npm run deploy          # preflight → wrangler deploy --env production
```

`npm run deploy` は先に `scripts/preflight.mjs` を走らせる。
`database_id` がプレースホルダのままなど、**デプロイ前に気づける失敗**を
分かりやすいメッセージで止める。単体でも走らせられる。

```bash
npm run preflight
```

`wrangler.toml` は 2 段構成になっている。

| | |
|---|---|
| 既定 | ルート無し・ホスト名は空。**ローカル開発用** |
| `[env.production]` | 実ドメインのルートとホスト名 |

**必ず `--env production` を付けること。** 付け忘れるとルートの無い
Worker が上がり、ドメインに反応しない。`npm run deploy` がそれを含んでいる。

### vars は `wrangler.toml` が正。ダッシュボードで入れると消える

`[env.production.vars]`（`CF_ACCESS_TEAM_DOMAIN`・`CF_ACCESS_AUD`・
`MEMBER_SIGNUP_ENABLED` など）は、**デプロイのたびにファイルの内容で
上書きされる。** Cloudflare のダッシュボードで直接書き換えても、
次のデプロイで元に戻る。

**自動デプロイが入ったので、これは push のたびに起きる。**
Access の値をダッシュボードだけに入れると、次に私がコードを直した瞬間に
**ダッシュボードが無防備な状態に戻る。** 手順 9 で取った 2 つの値は
必ず `wrangler.toml` に貼ること。

**Secret（`JQUANTS_API_KEY` など）は別扱いで、デプロイでは消えない。**
上書きされるのは vars だけ。

### DNS — A レコードは必要。ただし IP の中身は使われない

「レコードの追加」で **タイプ `A`、IPv4 アドレス `192.0.2.1`、プロキシ オン**
を 2 本作る。

| 名前 | タイプ | IPv4 アドレス | プロキシ |
|---|---|---|---|
| `@` | A | `192.0.2.1` | **オン（オレンジ雲）** |
| `app` | A | `192.0.2.1` | **オン（オレンジ雲）** |

**なぜ必要か。** この構成は Workers の「ルート」方式
（`wrangler.toml` の `pattern` + `zone_name`）。ルートが一致するのは
リクエストが Cloudflare のエッジに届いてから。DNS レコードが無いと
そもそも名前が引けず、エッジに届かないのでルートが一致しない。

**なぜ IP は何でもよいか。** Worker はオリジンへ行く前に応答するので、
レコードの指す先は使われない。`192.0.2.1` は RFC 5737 の
ドキュメント用予約アドレスで、実在のホストを指さない。
`AAAA` に `100::` を入れる流儀も同じ理由で使える。

**プロキシは必ずオンにすること。** 灰色雲（DNS のみ）だと
Cloudflare を素通りして `192.0.2.1` へ行こうとし、Worker が動かない。
Cloudflare Access も同じ理由でプロキシ有効が前提になる。

`www` を使う場合は `www` も同じ要領で足し、`wrangler.toml` の
コメントアウトしてある 3 本目のルートを有効にする。Worker が apex へ 301 で寄せる。

> **別のやり方**: Workers の「カスタムドメイン」を使うと Cloudflare が
> DNS を自動で作るので、A レコードを手で足す必要がなくなる。
> ただし現在の設定はルート方式で、テストもそれ前提で書いてある。
> A レコードを 2 本足すほうが早い。

#### 通ったかの確認

```bash
curl -sI https://goldencross-incomegains.com/ | grep -iE 'HTTP/|cf-ray|server'
```

`cf-ray` ヘッダが付いていれば Cloudflare を通っている。
`HTTP/2 200` なら Worker が応答している。

### workers.dev を有効にしないこと

`workers_dev = false` にしてある。**戻さないこと。**
Cloudflare Access はゾーンのホスト名に紐づくので、`*.workers.dev` から来た
リクエストには適用されない。有効にすると、その URL でダッシュボードが
認証なしに開く。`site.ts` も想定外のホストには 404 を返すが、
そもそも口を開けないのが本筋。

**ただし「アカウントの workers.dev サブドメイン」は別物で、こちらは要る。**
アカウントに 1 つ付く名前のことで、Cron の登録 API がその存在を前提にしている。
発行しても `workers_dev = false` ならこの Worker がそこに出ることはない。
→ 「Cron だけ登録されない」を見る。

### 公開の書き込み口を守る

`POST /api/waitlist` は認証なしで受ける唯一の書き込み口。
コード側でハニーポット・同意必須・日次上限を入れてあるが、
**本気の濫用対策は Cloudflare 側で行う。**

Security → WAF → Rate limiting rules で、
`goldencross-incomegains.com/api/waitlist` に対して「同一 IP から 10 分あたり 5 リクエスト」
程度の規則を 1 本入れる。

---

## 6. 疎通を確かめる

```bash
export JQUANTS_API_KEY="..."
npm run check:datasource
```

契約プラン・取得可能な範囲・**API が実際に返した項目名**が出る。
結果を `docs/DATA-SOURCES.md` に日付付きで貼ること。

続けて Worker 側:

```bash
LP_URL=https://goldencross-incomegains.com \
APP_URL=https://app.goldencross-incomegains.com \
  ./scripts/diagnose.sh
```

Windows では `.\scripts\diagnose.ps1`（`.sh` は PowerShell では動かない）。
`$env:LP_URL` と `$env:APP_URL` を先に設定する。

**LP とアプリの 2 つを渡す。** ホストを分けてあるので、片方だけでは判断できない。
省略するとローカル（`wrangler dev`）の既定
——LP が `http://localhost:8787/lp`、アプリが `http://localhost:8787`——になる。

疎通のほかに、**ホストを分けた目的が守れているか**を見ている。

| 節 | 見ているもの |
|---|---|
| [1] | LP が開いていること。CSP に `fonts.googleapis.com` が入っていること |
| **[2]** | **ランキング・スクリーナー・先行登録の一覧と CSV が、LP 側で 404 になること** |
| [3] | ダッシュボードが 200 で開かないこと（302 = Access、401 = Worker 認証） |
| [4] | 日次パイプラインの鮮度（LP 側の `/api/health` を読む） |

`workers_dev = false` なので `*.workers.dev` の URL は存在しない。必ず実ドメインを入れる。

**手順 9（Access）の前後で結果が変わる。** 前は [3] が「200 = 誰でも見られる」、
後は「302 = Access のログインへ飛んでいる」。**両方の時点で走らせて、
[3] が切り替わることを確かめる**のがいちばん確実な Access の確認方法。

---

## 7. 過去データを入れる

日次パイプラインは「今日の 1 日ぶん」しか取らない。
指標には過去 300 営業日が要るので、最初に 1 度だけバックフィルする。

```bash
export JQUANTS_API_KEY="..."
npm run build -w @invest/batch --silent
node packages/batch/.build/cli.mjs backfill --from 2024-09-02 --to 2026-09-04
```

> **node を直接呼ぶ。** `npm run backfill -- --from …` の args は script 文字列の
> **末尾に連結される**ので、script が入れ子だと内側の npm が `--from` を
> 自分のオプションとして食う。実際それで落ちた（`--from と --to は必須。`）。

**出力は 1 本ではない。** 5 MB ずつ `out/backfill-001.sql` … と連番で分かれる
（`wrangler d1 execute --file` に大きなファイルを渡せないため）。
**連番の順に流すこと**——`market_calendar` / `symbols` の INSERT が
`prices_daily` より先に来る必要がある（外部キー）:

```bash
cd packages/worker
for f in $(ls ../../out/backfill-*.sql | sort); do
  echo "適用: $f"
  npx wrangler d1 execute invest-db --remote --env production --file="$f"
done
cd ../..
```

**`--env production` を落とさないこと。** 付けないと wrangler は既定の
`[[d1_databases]]` を見に行く。本番を指しているのは
`[[env.production.d1_databases]]` のほう。

GitHub Actions から回すのが楽（`.github/workflows/backfill.yml`）。連番の適用も
向こうがやる。`JQUANTS_API_KEY` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を
リポジトリの Secrets に登録しておく。**これらは手元とも Cloudflare とも別のコピー**
（下の「キーを更新したとき」）。

見積もりと実測は `docs/GO-LIVE.md` の B3 にある。

**Worker ではなくここで回す理由**: 500 銘柄 × 10 年 ≒ 122 万行あり、
取得だけで約 2,450 リクエストになる。Worker の実行時間にも
D1 の 1 日あたりの書き込み上限にも収まらない。

---

## 8. 日次パイプラインを 1 回動かす

```bash
curl -X POST "https://app.goldencross-incomegains.com/api/run-pipeline"
```

`?force=1` で成功済みの日も走り直す。`?date=YYYY-MM-DD` で日付を指定できる。

以降は Cron が平日 19:30 JST（取りこぼしは翌 07:00 JST）に自動で走る。

> **この curl は手順 9（Access）より前にやること。** Access を掛けると
> エッジで止められて叩けなくなる。Cron は影響を受けないので、
> 1 回通しておけばあとは自動で回る。

---

## 9. Cloudflare Access をかける

**ここをやるまで、ダッシュボードはだれでも見られる。**
未設定のうちは画面上部に赤い警告が出るので、消えていることを確認する。

**Access は `app.goldencross-incomegains.com` にだけ掛ける。** LP 側に掛けると
先行登録が誰にも見えなくなる。

1. Cloudflare ダッシュボード → Zero Trust → Access → Applications
2. Self-hosted アプリケーションを追加し、**アプリ側のホスト**（`app.goldencross-incomegains.com`）を指定
3. ポリシーで自分のメールアドレスを許可
4. アプリケーションの **Audience (AUD) タグ**をコピー
5. `wrangler.toml` の **`[env.production.vars]`** にある
   `CF_ACCESS_TEAM_DOMAIN`（`xxx.cloudflareaccess.com`）と
   `CF_ACCESS_AUD` に設定して `npm run deploy`

### **Access は Worker の「手前」に立つ**

ここを取り違えると 2 箇所でつまずく。

Access はエッジで止めるので、`index.ts` の中で認証を外している経路にも
**届く前に**割り込む。アプリケーションの Path を空にしてある
（＝ホスト全体が対象）ので、app ホストの全パスが対象になる。

| 経路 | Access を掛けるとどうなるか | どうするか |
|---|---|---|
| `GET /api/health`（app 側） | ログイン画面になる。監視から叩けない | **監視は LP ホストの `/api/health` を向ける。** 中身は同じで、そのために生やしてある |
| `POST /api/run-pipeline` | curl で叩けない | **Access を掛ける前に 1 回回す**（手順 8）。それ以降は Cron に任せる |
| **Cron（平日 19:30 / 翌 07:00）** | **影響なし** | Cron は HTTP のエッジを通らず Worker を直接起動する。設定は不要 |

```bash
# 監視に登録するのはこちら（Access の外）
curl -s https://goldencross-incomegains.com/api/health
```

公開後にどうしても手で回したくなったら、Zero Trust → Access → Service Auth で
サービストークンを発行し、`CF-Access-Client-Id` / `CF-Access-Client-Secret`
ヘッダを付けて叩く。**Cron が動いているなら要らない。**

`/api/health` は内部の数字を返さない。最後に成功した日付と遅れ日数だけ。

---

## 集めた先行登録を見る

`https://app.goldencross-incomegains.com/waitlist`（Access の後ろ）。
件数と一覧が出て、`/api/waitlist.csv` で書き出せる。

**メールアドレスは個人情報。** 公開側（LP のホスト）には口を開けていない。
書き出したファイルの取り扱いに注意すること。

CSV は Excel で開ける形（UTF-8 BOM 付き）にしてあり、
`=` で始まる値には `'` を前置している（表計算ソフトが数式として
実行するのを防ぐため）。

---

## 保安ヘッダー

`src/headers.ts` が全レスポンスに CSP・`nosniff`・`Referrer-Policy`・
`X-Frame-Options`・HSTS を付けている。Cloudflare 側で重ねて設定する必要はない。

**`script-src 'none'`** にしてある。この画面に JavaScript が 1 行も無いため。
`npm test` がこれを固定しているので、スクリプトを足すとテストが落ちる。

---

## うまくいかないとき

### ローカルで LP しか開けない

`wrangler.toml` の**既定側**にルートやホスト名を書いてしまっている。
`wrangler dev` は `[[routes]]` があると 1 本目のホスト名を模擬して
リクエストを組み立てるため、`localhost` に投げても LP のホストとして届く
（`Host:` ヘッダでは変えられない）。ルートとホスト名は
`[env.production]` にだけ置くこと。`npm test` がこれを検査している。

### ドメインに反応しない / 404 が返る

- `--env production` を付けずにデプロイした → `npm run deploy` を使う
- DNS レコードがプロキシ無効（灰色雲）→ オレンジ雲にする
- ホスト名の綴りが `[env.production.vars]` と `[[env.production.routes]]` で
  食い違っている → `npm test` が検出する

### Cron だけ登録されない

デプロイは**ルート → Cron の順**に進むので、Cron だけ失敗すると
`Trigger configuration ... was only partially updated` になる。
**ルートは張られている**（ドメインは開く）が、定期実行が動かない。

| メッセージ | 原因 | 直し方 |
|---|---|---|
| `invalid cron string [code: 10100]` | 曜日に `0` を書いた | `preflight` が止める。`wrangler.toml` の `crons` を直す |
| `You need a workers.dev subdomain … [code: 10063]` | **アカウントの** workers.dev サブドメインが未発行 | `dash.cloudflare.com` → Compute (Workers) を一度開く |

10063 は `wrangler.toml` の `workers_dev` とは無関係。**`false` のままでよい**
（→「workers.dev を有効にしないこと」）。どちらも直したあと
`npm run deploy` をやり直せば揃う。

### 先行登録が保存されない

`0002_waitlist.sql` が適用されていない。`npm run db:migrate:remote` をやり直す。

```bash
npx wrangler d1 execute invest-db --remote \
  --command "SELECT COUNT(*) FROM waitlist"
```

### 画面に「データがありません」と出る

日次パイプラインが 1 度も成功していない。

```bash
# LP ホスト側。Access の外なので、掛けたあとも叩ける
curl "https://goldencross-incomegains.com/api/health"
```

`lastSuccessDate` が `null` なら、手順 7 と 8 をやる。

### `/api/run-pipeline` が 400 を返す

`JQUANTS_API_KEY` が未登録。手順 4。

### パイプラインは成功するのにスコアが 0 件

過去データが足りていない。指標が意味を持つ最低 30 営業日ぶんが必要で、
それ未満の銘柄は候補に出さない仕様。手順 7 のバックフィルをやる。

### 「項目 "close" が見つからない」で落ちる

J-Quants の項目名が変わった。`npm run check:datasource` が
**実際に返ってきた項目名**を表示するので、それを
`wrangler.toml` の `JQUANTS_FIELD_ALIASES` に入れる。コードを直さずに復旧できる。

```toml
JQUANTS_FIELD_ALIASES = '{"close":["ClosingPrice"],"volume":["TradedVolume"]}'
```

恒久対応として `packages/worker/src/connectors/jquants.ts` と
`packages/batch/src/jquants.ts` の `FIELD_ALIASES` にも足しておく。

### `/api/health` が `stale` を返す

Cron が動いていないか、途中で失敗している。

```bash
cd packages/worker
npx wrangler tail
npx wrangler d1 execute invest-db --remote \
  --command "SELECT * FROM job_runs ORDER BY target_date DESC LIMIT 5"
```

`job_runs.error` に失敗の理由が残っている。

### `403` が返る（画面・API）

Cloudflare Access のポリシーに自分が入っていないか、`CF_ACCESS_AUD` が
別のアプリケーションのものになっている。手順 9 の 4 をやり直す。

### J-Quants が `403` を返す

**Cloudflare の 403 とは無関係。** 本文に理由が書いてあるので、そこで分ける:

| 本文 | 意味 | 直すところ |
|---|---|---|
| `The incoming api key is invalid or expired` | キーが効いていない | 上の「キーを更新したとき」の 3 箇所 |
| `The requested endpoint does not exist` | **経路が違う。キーは無関係** | `JP_PATHS`（`packages/batch/src/jquants.ts`） |

この 2 つは同じ状態コードで返るので、**本文を読まずにキーを疑うと遠回りする。**
実際、経路違いを「契約プランの範囲外」と誤診して、プランを上げてキーを
2 度発行し直すまで気付かなかった。いまは `check:datasource` も backfill も
本文と「次にどこを触るか」を出す。

**範囲外の日付は 403 ではなく 400。** そちらは API が範囲そのものを教えてくれる
（`Your subscription covers the following dates: ...`）。

### Windows で `.ps1` の日本語が化ける

BOM が落ちている。UTF-8 BOM 付きで保存し直す。
`npm test` がこれを検査しているので、まずテストを走らせること。
