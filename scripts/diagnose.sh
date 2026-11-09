#!/usr/bin/env bash
# デプロイ後の点検。**LP とアプリを別ホストに分けた構成を前提にしている。**
#
#   ./scripts/diagnose.sh                       # ローカル（wrangler dev）
#   LP_URL=https://goldencross-incomegains.com \
#   APP_URL=https://app.goldencross-incomegains.com ./scripts/diagnose.sh
#
# 見ているのは疎通だけではない。**ホストを分けた目的が守れているか**を見る。
#   - 市場データと先行登録の一覧が、公開側から取れないこと
#   - ダッシュボードが、認証なしで開かないこと
#
# ローカルの既定はパス振り分け（site.ts がホスト名未設定のときの挙動）。
set -uo pipefail

LP_URL="${LP_URL:-http://localhost:8787/lp}"
APP_URL="${APP_URL:-http://localhost:8787}"
LP_URL="${LP_URL%/}"
APP_URL="${APP_URL%/}"

# 本番（https の実ドメイン）かローカルかで、期待値が変わる項目がある。
#   - sitemap.xml は絶対 URL を作れないローカルでは 404 を返す（設計どおり）
#   - Access はローカルには掛からないので、アプリ側が 200 でも正しい
if [[ "${LP_URL}" == https://* ]]; then mode=prod; else mode=local; fi

echo "LP  : ${LP_URL}"
echo "アプリ: ${APP_URL}"
echo "モード: ${mode}"
echo

fail=0

status_of() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || echo '000'
}

# 状態コードを桁の揃う位置に出す（和文ラベルは桁が揃わないので後ろへ回す）
ok()   { printf '  ok   %3s  %s\n' "$1" "$2"; }
ng()   { printf '  NG   %3s  %s\n' "$1" "$2"; fail=1; }
skip() { printf '  --   %3s  %s\n' "$1" "$2"; }

# 期待どおりの状態コードが返ること
expect() {
  local label="$1" url="$2" want="$3" got
  got=$(status_of "${url}")
  if [[ "${got}" == "${want}" ]]; then ok "${got}" "${label}"
  else ng "${got}" "${label}（期待 ${want}）"; fi
}

# **apex の `/` はもうこの Worker のものではない。**
# goldencross-incomegains.com の `/` と記事は別リポジトリの Worker
# （w10cloudflare の apps/fxstock）が持っている。こちらが apex に
# 残しているのは /privacy・/api/waitlist・/api/health の 3 本だけなので、
# **その 3 本だけを見る。** `/` や robots.txt を見ても、向こうの Worker が
# 生きているかを確かめているだけになる。
echo '[1] この Worker が apex に残した経路が開いていること'
expect 'プライバシーポリシー' "${LP_URL}/privacy" '200'

# **/api/health は 200 とは限らない。** 更新が止まっていると 503 を返す
# （監視から失敗として見えるように、意図してそうしてある）。
# ここでは「応答すること」だけ見て、中身の判定は [4] に任せる。
health_status=$(status_of "${LP_URL}/api/health")
case "${health_status}" in
  200|503) ok "${health_status}" '監視用 /api/health（中身は [4]）' ;;
  *)       ng "${health_status}" '監視用 /api/health（期待 200 か 503）' ;;
esac

# robots.txt / sitemap.xml は **apex を持っている向こうの Worker の持ち物**。
# ローカル（LP_HOSTNAME が空）ではこちらが返すので、そのときだけ見る。
sitemap_status=$(status_of "${LP_URL}/sitemap.xml")
robots_status=$(status_of "${LP_URL}/robots.txt")
if [[ "${mode}" == prod ]]; then
  skip "${sitemap_status}" 'sitemap.xml — apex を持つ別の Worker の持ち物'
  skip "${robots_status}"  'robots.txt — 同上'
else
  skip "${sitemap_status}" 'sitemap.xml — ローカルでは 404 が正しい'
  [[ "${robots_status}" == '200' ]] \
    && ok "${robots_status}" 'robots.txt' \
    || ng "${robots_status}" 'robots.txt（期待 200）'
fi

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
signup_status=$(status_of "${LP_URL}/api/waitlist")
case "${signup_status}" in
  405) ok "${signup_status}" '先行登録の受け口が開いている' ;;
  403) ng "${signup_status}" '**先行登録の受け口が WAF に塞がれている**'
       echo '            → カスタムルールで /api/waitlist をブロックしていないか。'
       echo '              レート制限は「レート制限ルール」で作る（docs/GO-LIVE.md の A8）' ;;
  429) ng "${signup_status}" 'レート制限に当たっている（10 分待って再実行）' ;;
  404) ng "${signup_status}" '受け口が無い。LP 側のルーティングを確認する' ;;
  *)   ng "${signup_status}" '先行登録の受け口が想定外（期待 405）' ;;
esac

csp=$(curl -sSI --max-time 15 "${LP_URL}/privacy" 2>/dev/null | tr -d '\r' | grep -i '^content-security-policy:' || true)
if [[ -z "${csp}" ]]; then
  echo '  NG   CSP ヘッダが無い'
  fail=1
elif [[ "${csp}" == *"fonts.googleapis.com"* ]]; then
  echo '  ok   CSP に書体の読み込み先が入っている'
else
  echo '  NG   CSP に fonts.googleapis.com が無い → Noto Sans JP が黙って落ちる'
  fail=1
fi
echo

echo '[2] apex から取れてはいけないもの'
# **ここがこの構成の要。** apex のルートを 1 本広げると漏れる。
# いまは 3 本の完全一致だけなので構造的に届かないが、
# `goldencross-incomegains.com/*` を足した瞬間に全部つながる。
expect 'ランキング（404 のはず）'   "${LP_URL}/api/ranking"       '404'
expect 'スクリーナー（404 のはず）' "${LP_URL}/screener"          '404'
expect '銘柄 API（404 のはず）'     "${LP_URL}/api/symbol/X"      '404'
expect '先行登録の一覧（404 のはず）' "${LP_URL}/waitlist"        '404'
expect '先行登録の CSV（404 のはず）' "${LP_URL}/api/waitlist.csv" '404'
echo

echo '[3] ダッシュボードが閉じていること'

# **Access を掛ける前でも、個人情報だけは閉じていること。**
# Worker 側が Access 未設定を検出して 503 を返す（src/auth.ts）。
# ここが 200 なら、ホスト名を知っている誰でもメールアドレスを落とせる。
for p in '/waitlist' '/api/waitlist.csv'; do
  s=$(status_of "${APP_URL}${p}")
  case "${s}" in
    200) ng   "${s}" "**${p} が開いている（メールアドレスが漏れる）**" ;;
    *)   ok   "${s}" "${p} は閉じている" ;;
  esac
done

app_status=$(status_of "${APP_URL}/")
case "${app_status}" in
  30[123578]) ok  "${app_status}" 'Cloudflare Access のログインへ飛んでいる' ;;
  401|403)    ok  "${app_status}" 'Worker 側で認証を要求している' ;;
  200)
    if [[ "${mode}" == prod ]]; then
      ng "${app_status}" '**ダッシュボードが誰でも見られる**'
      echo '            → Access が未設定（docs/GO-LIVE.md の B5）か、'
      echo '              workers_dev を true に戻していないか確認する'
    else
      skip "${app_status}" 'ローカルには Access が掛からない。本番で必ず確認すること'
    fi ;;
  *)          ng  "${app_status}" '想定外。ルートと DNS を確認する' ;;
esac
echo

echo '[4] パイプラインの鮮度'
# LP 側の /api/health を読む。Access の外なので、掛けたあとも読める。
health=$(curl -sS --max-time 15 "${LP_URL}/api/health" 2>/dev/null || echo '{}')
echo "  ${health}"

# **本文は整形された JSON**（json() が JSON.stringify(…, null, 2) を通す）。
# `"status": "ok"` のようにコロンの後に空白が入るので、
# 空白なしのパターンで突き合わせると**どの分岐にも当たらない**。
# 実際そうなっていて、正常でも「更新が止まっている」と誤報していた。
# 表示は整形のまま、判定だけ空白を落として行う。
compact=$(printf '%s' "${health}" | tr -d ' \n\r\t')
case "${compact}" in
  *'"status":"ok"'*)
    echo '  ok   直近の日次処理が成功している' ;;
  *'"lastSuccessDate":null'*)
    echo '  --   日次処理がまだ 1 度も成功していない'
    echo '       → LP だけ公開する段階ならこれで正しい。'
    echo '         ダッシュボードを動かすなら docs/GO-LIVE.md の B3 と B4' ;;
  *)
    echo '  NG   更新が止まっている（stale）'
    echo '       → npx wrangler tail --env production でログを見る'
    fail=1 ;;
esac
echo

if [[ "${fail}" -eq 0 ]]; then
  echo '結果: 問題なし'
else
  echo '結果: 上の NG を確認すること。詳細は docs/DEPLOY.md'
fi
exit "${fail}"
