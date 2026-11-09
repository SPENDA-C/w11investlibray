# デプロイ後の点検（PowerShell 版）。**LP とアプリを別ホストに分けた構成を前提にしている。**
#
#   .\scripts\diagnose.ps1
#   $env:LP_URL = "https://goldencross-incomegains.com"
#   $env:APP_URL = "https://app.goldencross-incomegains.com"
#   .\scripts\diagnose.ps1
#
# 見ているのは疎通だけではない。**ホストを分けた目的が守れているか**を見る。
#   - 市場データと先行登録の一覧が、公開側から取れないこと
#   - ダッシュボードが、認証なしで開かないこと
#
# **Windows PowerShell 5.1 でも動く。** Invoke-WebRequest の -SkipHttpErrorCheck は
# PowerShell 7 で追加された引数で、5.1 には無い。使うと全 URL が例外になり、
# 全項目が 0 になる（実際にそうなった）。5.1 は Windows に最初から入っている版なので、
# ここを既定と考える。
#
# このファイルは UTF-8 BOM 付きで保存すること。
# BOM が無いと PowerShell 5.1 が Shift-JIS として読み、日本語が化けて構文が壊れる。
# packages/worker/test/scripts.test.mjs がこれを検査している。

$ErrorActionPreference = "Continue"
$LpUrl  = if ($env:LP_URL)  { $env:LP_URL.TrimEnd('/') }  else { "http://localhost:8787/lp" }
$AppUrl = if ($env:APP_URL) { $env:APP_URL.TrimEnd('/') } else { "http://localhost:8787" }

# 本番（https の実ドメイン）かローカルかで、期待値が変わる項目がある。
#   - sitemap.xml は絶対 URL を作れないローカルでは 404 を返す（設計どおり）
#   - Access はローカルには掛からないので、アプリ側が 200 でも正しい
$mode = if ($LpUrl -like "https://*") { "prod" } else { "local" }

Write-Host "LP  : $LpUrl"
Write-Host "アプリ: $AppUrl"
Write-Host "モード: $mode"
Write-Host ""

$failed = 0

function Get-Status {
    param([string]$Url)
    try {
        # -UseBasicParsing: 5.1 が IE のエンジンに依存するのを避ける
        # -MaximumRedirection 0: 3xx を例外にして、Access の転送を捕まえる
        $res = Invoke-WebRequest -Uri $Url -Method GET -TimeoutSec 15 `
            -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
        return [int]$res.StatusCode
    } catch {
        # 5.1 は 3xx/4xx/5xx を例外にする。応答があるなら状態コードを取り出す。
        # 5.1 は HttpStatusCode、7 は int。どちらも [int] で通る。
        $r = $_.Exception.Response
        if ($r -and $r.StatusCode) { return [int]$r.StatusCode }
        return 0   # 接続そのものが失敗（名前が引けない・到達しない）
    }
}

# 状態コードを桁の揃う位置に出す（和文ラベルは桁が揃わないので後ろへ回す）
function Write-Ok   { param($Code, $Label) Write-Host ("  ok   {0,3}  {1}" -f $Code, $Label) }
function Write-Ng   { param($Code, $Label) Write-Host ("  NG   {0,3}  {1}" -f $Code, $Label); $script:failed = 1 }
function Write-Skip { param($Code, $Label) Write-Host ("  --   {0,3}  {1}" -f $Code, $Label) }

function Test-Status {
    param([string]$Label, [string]$Url, [int]$Expect)
    $got = Get-Status $Url
    if ($got -eq $Expect) { Write-Ok $got $Label }
    else { Write-Ng $got "$Label（期待 $Expect）" }
}

Write-Host "[1] LP が開いていること"
# apex の `/` はもうこの Worker のものではない（diagnose.sh と同じ理由）。
Test-Status "プライバシーポリシー" "$LpUrl/privacy" 200

# **/api/health は 200 とは限らない。** 更新が止まっていると 503 を返す
# （監視から失敗として見えるように、意図してそうしてある）。
# ここでは「応答すること」だけ見て、中身の判定は [4] に任せる。
$healthStatus = Get-Status "$LpUrl/api/health"
if ($healthStatus -eq 200 -or $healthStatus -eq 503) {
    Write-Ok $healthStatus "監視用 /api/health（中身は [4]）"
} else {
    Write-Ng $healthStatus "監視用 /api/health（期待 200 か 503）"
}

# robots.txt / sitemap.xml は apex を持っている別の Worker の持ち物。
$robotsStatus = Get-Status "$LpUrl/robots.txt"
$sitemapStatus = Get-Status "$LpUrl/sitemap.xml"
if ($mode -eq "prod") {
    Write-Skip $sitemapStatus "sitemap.xml — apex を持つ別の Worker の持ち物"
    Write-Skip $robotsStatus "robots.txt — 同上"
} else {
    Write-Skip $sitemapStatus "sitemap.xml — ローカルでは 404 が正しい"
    if ($robotsStatus -eq 200) { Write-Ok $robotsStatus "robots.txt" }
    else { Write-Ng $robotsStatus "robots.txt（期待 200）" }
}

# **先行登録の受け口が edge で塞がれていないこと。**
# LP の唯一の目的がここなのに、塞がっていても画面は正常に出る。
# 気付くのは「登録が 1 件も入らない」と分かってからで、
# それまでに来た人はブロックページを見て帰る。実際 WAF の設定を
# 取り違えて（レート制限のつもりがカスタムルール）1 回目から
# 全部ブロックしていたことがある。
#
# **GET で叩く。** POST すると本番の D1 にゴミが入る。
# Worker まで届いていれば 405（POST で送信すること）が返るので、
# 入口が生きていることはそれで分かる。
# なおレート制限を入れてあると、この 1 回が持ち分を消費する
# （5 回 / 10 分）。短時間に何度も走らせると自分が 429 に当たる。
$signupStatus = Get-Status "$LpUrl/api/waitlist"
if ($signupStatus -eq 405) {
    Write-Ok $signupStatus "先行登録の受け口が開いている"
} elseif ($signupStatus -eq 403) {
    Write-Ng $signupStatus "**先行登録の受け口が WAF に塞がれている**"
    Write-Host "            → カスタムルールで /api/waitlist をブロックしていないか。"
    Write-Host "              レート制限は「レート制限ルール」で作る（docs/GO-LIVE.md の A8）"
} elseif ($signupStatus -eq 429) {
    Write-Ng $signupStatus "レート制限に当たっている（10 分待って再実行）"
} elseif ($signupStatus -eq 404) {
    Write-Ng $signupStatus "受け口が無い。LP 側のルーティングを確認する"
} else {
    Write-Ng $signupStatus "先行登録の受け口が想定外（期待 405）"
}

$csp = $null
try {
    $head = Invoke-WebRequest -Uri "$LpUrl/privacy" -Method GET -TimeoutSec 15 `
        -UseBasicParsing -ErrorAction Stop
    $csp = $head.Headers["Content-Security-Policy"]
} catch {
    # エラー応答でもヘッダは読める（5.1 は例外側に入る）
    $r = $_.Exception.Response
    if ($r) { try { $csp = $r.Headers["Content-Security-Policy"] } catch { } }
}
if (-not $csp) {
    Write-Host "  NG   CSP ヘッダが無い（またはページを取得できなかった）"
    $failed = 1
} elseif ($csp -like "*fonts.googleapis.com*") {
    Write-Host "  ok   CSP に書体の読み込み先が入っている"
} else {
    Write-Host "  NG   CSP に fonts.googleapis.com が無い → Noto Sans JP が黙って落ちる"
    $failed = 1
}
Write-Host ""

Write-Host "[2] LP から取れてはいけないもの"
# **ここがこの構成の要。** LP 側のルーティングに 1 行足すと漏れる。
Test-Status "ランキング（404 のはず）"     "$LpUrl/api/ranking"       404
Test-Status "スクリーナー（404 のはず）"   "$LpUrl/screener"          404
Test-Status "銘柄 API（404 のはず）"       "$LpUrl/api/symbol/X"      404
Test-Status "先行登録の一覧（404 のはず）" "$LpUrl/waitlist"          404
Test-Status "先行登録の CSV（404 のはず）" "$LpUrl/api/waitlist.csv"  404
Write-Host ""

Write-Host "[3] ダッシュボードが閉じていること"

# **Access を掛ける前でも、個人情報だけは閉じていること。**
# Worker 側が Access 未設定を検出して 503 を返す（src/auth.ts）。
# ここが 200 なら、ホスト名を知っている誰でもメールアドレスを落とせる。
foreach ($p in @("/waitlist", "/api/waitlist.csv")) {
    $s = Get-Status "$AppUrl$p"
    if ($s -eq 200) {
        Write-Ng $s "**$p が開いている（メールアドレスが漏れる）**"
    } else {
        Write-Ok $s "$p は閉じている"
    }
}

$appStatus = Get-Status "$AppUrl/"
if ($appStatus -ge 301 -and $appStatus -le 308) {
    Write-Ok $appStatus "Cloudflare Access のログインへ飛んでいる"
} elseif ($appStatus -eq 401 -or $appStatus -eq 403) {
    Write-Ok $appStatus "Worker 側で認証を要求している"
} elseif ($appStatus -eq 200) {
    if ($mode -eq "prod") {
        Write-Ng $appStatus "**ダッシュボードが誰でも見られる**"
        Write-Host "            → Access が未設定（docs/GO-LIVE.md の B5）か、"
        Write-Host "              workers_dev を true に戻していないか確認する"
    } else {
        Write-Skip $appStatus "ローカルには Access が掛からない。本番で必ず確認すること"
    }
} else {
    Write-Ng $appStatus "想定外。ルートと DNS を確認する"
}
Write-Host ""

Write-Host "[4] パイプラインの鮮度"
# LP 側の /api/health を読む。Access の外なので、掛けたあとも読める。
# **/api/health は更新が止まっていると 503 を返す。** 5.1 ではそれが例外になるので、
# 例外側からも本文を取り出す。ここで本文が取れないと [4] の判定ができない。
$health = "{}"
try {
    $health = (Invoke-WebRequest -Uri "$LpUrl/api/health" -Method GET -TimeoutSec 15 `
        -UseBasicParsing -ErrorAction Stop).Content
} catch {
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $health = $_.ErrorDetails.Message          # PowerShell 7 はここに本文が入る
    } else {
        $r = $_.Exception.Response                 # Windows PowerShell 5.1
        if ($r) {
            try {
                $sr = New-Object System.IO.StreamReader($r.GetResponseStream())
                $health = $sr.ReadToEnd()
                $sr.Close()
            } catch { }
        }
    }
}
Write-Host "  $health"

# **本文は整形された JSON**（json() が JSON.stringify(…, null, 2) を通す）。
# `"status": "ok"` のようにコロンの後に空白が入るので、
# 空白なしのパターンで突き合わせると**どの分岐にも当たらない**。
# 実際そうなっていて、正常でも「更新が止まっている」と誤報していた。
# 表示は整形のまま、判定だけ空白を落として行う。
$compact = $health -replace '\s', ''
if ($compact -like '*"status":"ok"*') {
    Write-Host "  ok   直近の日次処理が成功している"
} elseif ($compact -like '*"lastSuccessDate":null*') {
    Write-Host "  --   日次処理がまだ 1 度も成功していない"
    Write-Host "       → LP だけ公開する段階ならこれで正しい。"
    Write-Host "         ダッシュボードを動かすなら docs/GO-LIVE.md の B3 と B4"
} else {
    Write-Host "  NG   更新が止まっている（stale）"
    Write-Host "       → npx wrangler tail --env production でログを見る"
    $failed = 1
}
Write-Host ""

if ($failed -eq 0) {
    Write-Host "結果: 問題なし"
} else {
    Write-Host "結果: 上の NG を確認すること。詳細は docs/DEPLOY.md"
}
exit $failed
