/**
 * **D1 のトークン権限を測る。** `npm run check:d1token`。
 *
 * 足した理由。`wrangler d1 execute --remote --file` が
 * `Authentication error [code: 10000]` で落ちたとき、wrangler の
 * メッセージは「権限を確認してください」としか言わない。
 * **どの権限が足りないのかも、そもそも権限の問題なのかも分からない。**
 *
 * 当てずっぽうで「D1:Edit を足してください」と案内すると、違ったときに
 * 一往復無駄になる（このリポジトリで何度もやった失敗）。なので
 * **実際に API を叩いて、どこまで通るかを測る。**
 *
 * 測る経路は 3 つ。`--file` が使うのは 3 つ目だけ。
 *
 *   1. GET  /accounts/{a}/d1/database          一覧（D1 の読み）
 *   2. POST /accounts/{a}/d1/database/{db}/query   問い合わせ（`--command` の経路）
 *   3. POST /accounts/{a}/d1/database/{db}/import  取り込み（`--file` の経路）
 *
 * 3 は `action: "init"` だけ送る。**データベースの中身は変えない**
 * （アップロード先の URL を返すだけで、SQL をまだ送っていない）。
 *
 * **トークンの値は一切出力しない。** 出すのは長さと種類だけ。
 */

import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';

/** `wrangler.toml` から本番の `database_id` を取る。TOML を丸ごと解釈しない。 */
export function readDatabaseId(config) {
  const lines = config.split(/\r?\n/);
  let inProd = false;
  let fallback = '';
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inProd = t === '[[env.production.d1_databases]]';
      continue;
    }
    const m = /^database_id\s*=\s*"([^"]*)"/.exec(t);
    if (m === null) continue;
    if (inProd) return m[1];
    if (fallback === '') fallback = m[1];
  }
  return fallback;
}

/**
 * トークンの見た目だけを言う。**値は返さない。**
 *
 * 2026 年 4 月に前置きが入った（`cfat_` = アカウント、`cfut_` = ユーザー）。
 * この 2 つの違いが効く場面があるので、種類は見える形にしておく。
 */
export function tokenShape(token) {
  if (typeof token !== 'string' || token === '') return { kind: 'なし', length: 0 };
  const length = token.length;
  if (token.startsWith('cfat_')) return { kind: 'アカウント API トークン (cfat_)', length };
  if (token.startsWith('cfut_')) return { kind: 'ユーザー API トークン (cfut_)', length };
  if (token.startsWith('cfk_')) return { kind: 'ユーザー API キー (cfk_)', length };
  if (/^[0-9a-f]{37}$/i.test(token)) return { kind: 'グローバル API キー', length };
  if (/^[A-Za-z0-9_-]{40}$/.test(token)) return { kind: '前置き無しの旧トークン', length };
  return { kind: '不明', length };
}

/**
 * トークンを編集する画面の URL。**種類で場所が違う。**
 *
 * アカウント所有のトークン（`cfat_`）は、**プロフィール側の一覧に出てこない。**
 * 実際にこれで外した案内をして、探させてしまった。wrangler も
 * アカウント側の URL を出している（`dash.cloudflare.com/{account}/api-tokens`）。
 */
export function tokenPageUrl(kind, accountId = '') {
  if (typeof kind === 'string' && kind.includes('アカウント API トークン')) {
    return accountId === ''
      ? 'https://dash.cloudflare.com/ → 対象のアカウント → 管理 → アカウント API トークン'
      : `https://dash.cloudflare.com/${accountId}/api-tokens`;
  }
  return 'https://dash.cloudflare.com/profile/api-tokens';
}

/**
 * 3 つの結果から、次にやることを 1 つに決める。
 *
 * **測った事実の外に出ない。** 分からないときは分からないと言う。
 */
export function verdict({
  list, query, importInit, verify, workers, tokenUrl = tokenPageUrl(''),
}) {
  const ok = (r) => r !== undefined && r.status >= 200 && r.status < 300;

  // **届かなかったことを「権限が無い」と言わない。** status 0 は
  // 返事が来なかったという意味しかない。ここを混ぜると、回線が
  // 一度こけただけでトークンを作り直させることになる。
  if ([list, query, importInit].every((r) => r.status === 0)) {
    return {
      ok: false,
      text: `**Cloudflare の API に届いていない**（返事が来ていない）。
     これは権限の話ではないので、トークンをいじらない。
     回線か api.cloudflare.com への経路を見てから、もう一度測る。`,
    };
  }

  if (ok(importInit)) {
    return {
      ok: true,
      text: `取り込みの経路まで通った。**トークンの権限は足りている。**
     さっきの失敗が続くなら、原因は権限ではない。もう一度流して、
     違うメッセージが出ないか見る。`,
    };
  }

  // **D1 だけが通らないのか、トークン全体が効いていないのかを分ける。**
  // トークンの自己確認（verify）は権限が要らないので、これが通れば
  // 「トークンは有効で、このアカウントのものだ」が確定する。
  if (!ok(list) && !ok(query) && !ok(importInit) && (ok(verify) || ok(workers))) {
    const id = verify?.tokenId;
    return {
      ok: false,
      text: `**トークンもアカウント ID も効いている**（${
        ok(verify) ? 'トークンの自己確認' : 'Workers の一覧'
      }は通った）。**D1 だけが通らない。**

     権限を足したのに変わらないなら、理由は次のどちらか。上から確かめる。

       1. **GitHub の Secret が、編集したトークンと別物。**
          いま Actions が使っているトークンの ID は
            ${id === undefined ? '(取れなかった)' : id}
          これをダッシュボードのトークン一覧の ID と見比べる。
          違っていれば、編集したのは別のトークン。
          **デプロイは通るので、古いトークンでも気付けない。**

       2. 画面で保存できていない。チェックを入れただけで
          「続ける」「保存」まで進んでいないと反映されない。
          保存後の一覧で、そのトークンの権限に D1 が出るか見る。

     ${tokenUrl}`,
    };
  }

  if (!ok(list) && !ok(query)) {
    return {
      ok: false,
      text: `**D1 をまったく触れていない**（一覧も問い合わせも通らない）。
     トークンに D1 の権限が入っていない。デプロイが通るのは
     Workers の権限だけで足りるため。

     ${tokenUrl}
     → このトークンの「編集」
     → **アカウント全体**の権限ポリシー（「○○'s Account アカウント全体」と
        書いてある箱）を開く。**ゾーン側の箱ではない。**
     → 権限をひとつ足す: **D1** の **Write（編集）**
     → 保存。

     **「再生成」「ロール」は押さない。** 値が変わって GitHub の Secret が
     合わなくなる。権限を足すだけならトークンの値は変わらない。`,
    };
  }

  if (ok(query) && !ok(importInit)) {
    return {
      ok: false,
      text: `**問い合わせは通るのに、取り込みだけ弾かれている。**
     D1 の権限そのものは入っている。import だけが別の判定をしている。
     試す順に 2 つ:
       1. トークンに **アカウント → D1 → 編集** が入っているか見る
          （読み取りだけだと問い合わせが通って取り込みが落ちる）
          場所: ${tokenUrl}
       2. それでも同じなら、**ユーザー API トークン（cfut_）を作り直す。**
          アカウント API トークン（cfat_）が import で弾かれた報告がある。
          作る場所: https://dash.cloudflare.com/profile/api-tokens
          （アカウント所有ではなく、自分のプロフィール側で作る）`,
    };
  }

  return {
    ok: false,
    text: `一覧は通ったが、問い合わせと取り込みが通らない。
     トークンが **読み取りだけ**の可能性が高い。
     ${tokenUrl} で **アカウント / D1 / 編集** を足す。`,
  };
}

async function probe(fetchImpl, label, url, init) {
  try {
    const res = await fetchImpl(url, init);
    let code = '';
    let extra = {};
    try {
      const body = await res.json();
      code = (body?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join(' / ');
      // verify の返り。**トークンの値ではない**（ダッシュボードにも出る識別子）。
      if (typeof body?.result?.id === 'string') {
        extra = { tokenId: body.result.id, tokenStatus: body.result.status ?? '' };
      }
    } catch {
      code = '(本文が JSON でない)';
    }
    return { label, status: res.status, code, extra };
  } catch (err) {
    return { label, status: 0, code: `到達できない: ${err.message}` };
  }
}

/**
 * トークン自身の確認。**権限が要らないので、通れば「トークンは有効で、
 * このアカウントのものだ」が確定する。** D1 が通らないのと切り分けられる。
 *
 * **経路が 2 つある。** アカウント所有（`cfat_`）は
 * `/accounts/{id}/tokens/verify`、ユーザー所有（`cfut_`）は
 * `/user/tokens/verify`。**どちらかを決めつけず、両方試す。**
 * （アカウント所有を `/user/...` に投げると `1000: Invalid API Token` が返り、
 * 有効なトークンを無効と誤診する。）
 *
 * 返す `tokenId` は**秘密ではない。** ダッシュボードの一覧にも出る識別子で、
 * 「Actions が使っているのはどのトークンか」を突き合わせるために出す。
 */
export async function probeVerify(fetchImpl, accountId, headers) {
  const paths = [
    `${API}/accounts/${accountId}/tokens/verify`,
    `${API}/user/tokens/verify`,
  ];
  let last = null;
  for (const url of paths) {
    const r = await probe(fetchImpl, '0. トークンの自己確認 (権限不要)', url, { headers });
    if (r.status >= 200 && r.status < 300) return { ...r, ...r.extra };
    last = r;
  }
  return last ?? { label: '0. トークンの自己確認 (権限不要)', status: 0, code: '' };
}

export async function run({ token, accountId, databaseId, fetchImpl = fetch }) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = `${API}/accounts/${accountId}/d1/database/${databaseId}`;

  const verify = await probeVerify(fetchImpl, accountId, headers);
  // D1 以外が通るかを見る。アカウント ID が違えばこれも落ちる。
  const workers = await probe(
    fetchImpl, '0b. Workers の一覧 (D1 以外)', `${API}/accounts/${accountId}/workers/scripts`,
    { headers },
  );

  const list = await probe(
    fetchImpl, '1. 一覧 (D1 の読み)', `${API}/accounts/${accountId}/d1/database`, { headers },
  );
  const query = await probe(fetchImpl, '2. 問い合わせ (--command の経路)', `${base}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql: 'SELECT 1' }),
  });
  // init だけ。SQL はまだ送らないので、**データベースの中身は変わらない。**
  const importInit = await probe(fetchImpl, '3. 取り込み (--file の経路)', `${base}/import`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'init', etag: '0'.repeat(32) }),
  });
  return { verify, workers, list, query, importInit };
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const config = readFileSync(
    fileURLToPath(new URL('../packages/worker/wrangler.toml', import.meta.url)),
    'utf8',
  );
  const databaseId = readDatabaseId(config);

  const shape = tokenShape(token);
  console.log(`D1 トークン権限の確認`);
  console.log(`  トークン: ${shape.kind} / ${shape.length} 文字（値は出さない）`);
  console.log(`  アカウント: ${accountId === '' ? '**未設定**' : `設定あり（${accountId.length} 文字）`}`);
  console.log(`  データベース: ${databaseId === '' ? '**wrangler.toml から読めない**' : databaseId}\n`);

  if (token === '' || accountId === '' || databaseId === '') {
    console.error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID が要る。');
    process.exitCode = 1;
    return;
  }

  const results = await run({ token, accountId, databaseId });
  for (const r of [results.verify, results.workers, results.list, results.query, results.importInit]) {
    const mark = r.status >= 200 && r.status < 300 ? '✓' : '✗';
    console.log(`${mark} ${r.label}  HTTP ${r.status}${r.code === '' ? '' : `  ${r.code}`}`);
  }
  if (results.verify.tokenId !== undefined) {
    // **秘密ではない。** ダッシュボードの一覧と突き合わせるために出す。
    console.log(
      `\n  いま使っているトークンの ID: ${results.verify.tokenId}` +
        `${results.verify.tokenStatus === '' ? '' : `（状態: ${results.verify.tokenStatus}）`}` +
        `\n  ダッシュボードのトークン一覧の ID と一致するか見る。`,
    );
  }

  const v = verdict({ ...results, tokenUrl: tokenPageUrl(shape.kind, accountId) });
  console.log(`\n${v.ok ? '→' : '→'} ${v.text}\n`);
  process.exitCode = v.ok ? 0 : 1;
}

// 直接呼ばれたときだけ走る（テストから import しても何も起きない）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
