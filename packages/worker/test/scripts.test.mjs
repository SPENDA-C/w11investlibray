import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { applyDatabaseId, extractDatabaseId } from '../../../scripts/set-database-id.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SCRIPTS_DIR = fileURLToPath(new URL('../../../scripts', import.meta.url));
const files = readdirSync(SCRIPTS_DIR);

test('.ps1 は UTF-8 BOM 付きで保存されている', () => {
  // PowerShell 5.1 は BOM が無いと Shift-JIS として読む。
  // 日本語コメントが化けて構文エラーになり、Windows でだけ動かなくなる。
  const ps1 = files.filter((f) => f.endsWith('.ps1'));
  assert.ok(ps1.length > 0, '.ps1 が 1 つも無い');
  for (const name of ps1) {
    const bytes = readFileSync(join(SCRIPTS_DIR, name));
    assert.deepEqual(
      [...bytes.subarray(0, 3)],
      [0xef, 0xbb, 0xbf],
      `${name} に UTF-8 BOM が無い`,
    );
  }
});

test('.ps1 の中身が UTF-8 として読める', () => {
  for (const name of files.filter((f) => f.endsWith('.ps1'))) {
    const text = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
    assert.ok(!text.includes('�'), `${name} に文字化けがある`);
  }
});

test('.sh は BOM を持たない（シェバンが壊れる）', () => {
  for (const name of files.filter((f) => f.endsWith('.sh'))) {
    const bytes = readFileSync(join(SCRIPTS_DIR, name));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} に BOM が付いている`);
    assert.equal(bytes.subarray(0, 2).toString(), '#!', `${name} がシェバンで始まっていない`);
  }
});

test('.sh は実行権限を持つ（git に記録された modeで見る）', () => {
  // **作業ツリーの権限を見てはいけない。** NTFS は POSIX の実行ビットを
  // 表現できないので、Windows では statSync が必ず 0 を返して落ちる。
  // 実際に Windows で落ちた——リポジトリは正しいのに、テストが間違っていた。
  //
  // 見るべきは **git が記録している mode**。他の人が checkout したときに
  // 実行できるかを決めているのはこちらで、これはどの OS でも同じ値が読める。
  let entries;
  try {
    entries = execFileSync('git', ['ls-files', '-s', '--', SCRIPTS_DIR], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return; // git が無い / checkout でない（tarball 展開など）。ここでは判定しない
  }

  const modes = new Map();
  for (const line of entries.split('\n')) {
    const m = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/.exec(line);
    if (m !== null) modes.set(m[2].split('/').pop(), m[1]);
  }
  assert.ok(modes.size > 0, 'git から scripts/ の mode を読めなかった');

  for (const name of files.filter((f) => f.endsWith('.sh'))) {
    assert.equal(
      modes.get(name),
      '100755',
      `${name} に実行権限が無い（git update-index --chmod=+x scripts/${name}）`,
    );
  }
});

test('.sh は set -u で未定義変数を検出する', () => {
  for (const name of files.filter((f) => f.endsWith('.sh'))) {
    const text = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
    assert.match(text, /^set -[eu]/m, `${name} に set -e / set -u が無い`);
  }
});

// ---- database_id の書き込み -------------------------------------------------

/** `wrangler d1 create invest-db` が実際に返す形。 */
const WRANGLER_OUTPUT = `
 ⛅️ wrangler 4.125.0
─────────────────────
✅ Successfully created DB 'invest-db' in region APAC
Created your new D1 database.

[[d1_databases]]
binding = "INVEST_DB"
database_name = "invest-db"
database_id = "a1b2c3d4-5e6f-7890-abcd-ef1234567890"
`;

test('wrangler の出力をまるごと渡しても id を拾う', () => {
  // 出力をコピーして貼るのが自然な操作なので、そこから拾えないと意味がない。
  const got = extractDatabaseId(WRANGLER_OUTPUT);
  assert.equal(got.ok, true);
  assert.equal(got.id, 'a1b2c3d4-5e6f-7890-abcd-ef1234567890');

  // id だけ渡しても同じ
  assert.equal(extractDatabaseId('  A1B2C3D4-5E6F-7890-ABCD-EF1234567890 ').id,
    'a1b2c3d4-5e6f-7890-abcd-ef1234567890', '大文字でも小文字に寄せる');
});

test('UUID が 2 種類あったら選ばない', () => {
  // 貼り間違いを黙って通すほうが害が大きい。
  const two = extractDatabaseId(
    'a1b2c3d4-5e6f-7890-abcd-ef1234567890 と 11111111-2222-3333-4444-555555555555',
  );
  assert.equal(two.ok, false);
  assert.match(two.reason, /2 個/);

  assert.equal(extractDatabaseId('id はまだ無い').ok, false);
});

test('database_id を 2 箇所とも書き換える', () => {
  // 既定側（wrangler dev 用）と [[env.production.d1_databases]] の両方。
  // preflight は本番側しか見ないので、既定側を取りこぼすと黙って通る。
  const config = readFileSync(
    fileURLToPath(new URL('../wrangler.toml', import.meta.url)),
    'utf8',
  );
  assert.equal(
    (config.match(/^\s*database_id\s*=/gm) ?? []).length,
    2,
    'wrangler.toml の database_id が 2 箇所でなくなっている',
  );

  const id = 'a1b2c3d4-5e6f-7890-abcd-ef1234567890';
  const { text, count, changed } = applyDatabaseId(config, id);
  assert.equal(count, 2);
  assert.equal(changed, true);
  assert.equal((text.match(new RegExp(id, 'g')) ?? []).length, 2);
  assert.ok(!text.includes('REPLACE_WITH'), 'プレースホルダが残っている');

  // 同じ id をもう一度当てても変わらない（冪等）
  assert.equal(applyDatabaseId(text, id).changed, false);
});

// ---- diagnose の 2 版がずれないこと ---------------------------------------

test('diagnose.sh と .ps1 が同じ経路を検査している', () => {
  // **片方だけ直して片方を忘れる**のが起きやすい。実際 .sh にモード判定を足した
  // ときに .ps1 へ入れ忘れ、/api/health の 503 を NG と報告する状態になっていた。
  const sh = readFileSync(join(SCRIPTS_DIR, 'diagnose.sh'), 'utf8');
  const ps = readFileSync(join(SCRIPTS_DIR, 'diagnose.ps1'), 'utf8');

  const paths = [
    '/api/ranking', '/screener', '/api/symbol/X',
    '/waitlist', '/api/waitlist.csv',        // ← 漏れるとメールアドレスが公開される
    '/robots.txt', '/sitemap.xml', '/api/health',
  ];
  for (const p of paths) {
    assert.ok(sh.includes(p), `diagnose.sh が ${p} を見ていない`);
    assert.ok(ps.includes(p), `diagnose.ps1 が ${p} を見ていない`);
  }

  // 本番／ローカルで期待値を変える仕組みが両方にあること
  for (const [name, text] of [['diagnose.sh', sh], ['diagnose.ps1', ps]]) {
    assert.match(text, /prod/, `${name} にモード判定が無い`);
    assert.match(text, /local/, `${name} にモード判定が無い`);
    assert.match(text, /503/, `${name} が /api/health の 503 を許していない`);
  }

  // **登録の受け口の検査。** `/api/waitlist` は `/api/waitlist.csv` の
  // 部分文字列なので、上の paths に足しても何も証明しない。
  // 判定そのものが 2 版に入っていることを見る。
  for (const [name, text] of [['diagnose.sh', sh], ['diagnose.ps1', ps]]) {
    assert.ok(text.includes('先行登録の受け口'), `${name} が登録の受け口を見ていない`);
    assert.match(text, /405/, `${name} が 405 を期待していない`);
    assert.match(text, /403/, `${name} が WAF ブロック（403）を切り分けていない`);
    assert.match(text, /429/, `${name} がレート制限（429）を切り分けていない`);
  }
});

test('diagnose.ps1 は PowerShell 7 専用の引数を使わない', () => {
  // -SkipHttpErrorCheck は PS7 で追加された。5.1（Windows 標準）では
  // 全 URL が例外になり、全項目 0 になる。実際にそうなった。
  const ps = readFileSync(join(SCRIPTS_DIR, 'diagnose.ps1'), 'utf8');
  const calls = ps
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))   // 説明のコメントは除く
    .join('\n');
  assert.ok(
    !calls.includes('-SkipHttpErrorCheck'),
    'PowerShell 5.1 に無い -SkipHttpErrorCheck を使っている',
  );
  // 5.1 が IE のエンジンに依存しないように
  assert.match(calls, /-UseBasicParsing/);
});

// ---- diagnose の [4] が /api/health の本文と噛み合っていること ---------------

test('diagnose の [4] が /api/health の実際の本文で分岐する', async () => {
  // **ここが一度も動いていなかった。** json() は JSON.stringify(…, null, 2) を
  // 通すので本文は `"status": "ok"`（コロンの後に空白）。diagnose 側は
  // 空白なしの `"status":"ok"` で突き合わせていて、どの分岐にも当たらず
  // **正常でも「更新が止まっている」と誤報していた**。
  //
  // 片側だけ固定しても再発する。3 つ揃えて初めて繋がる:
  //   (1) 本文の形  (2) 空白を落とす処理  (3) 突き合わせるパターン
  const { handler, JOB_NAME } = await import('../.build/worker.mjs');
  const { makeEnv } = await import('./helpers/d1.mjs');
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const health = async (env) =>
    (await (await handler.fetch(new Request('http://localhost:8787/api/health'), env, ctx)).text())
      .replace(/\s/g, '');

  // (1) まだ 1 度も走っていない
  assert.match(await health(makeEnv()), /"lastSuccessDate":null/);

  // (1) 直近で成功している
  const ok = makeEnv();
  const today = new Date().toISOString().slice(0, 10);
  await ok.INVEST_DB.prepare(
    `INSERT INTO job_runs (job, target_date, status, started_at, finished_at)
     VALUES (?1, ?2, 'ok', ?3, ?3)`,
  )
    .bind(JOB_NAME, today, `${today}T10:00:00.000Z`)
    .run();
  assert.match(await health(ok), /"status":"ok"/);

  // (2)(3) 両版が空白を落としてから、その形で突き合わせていること
  const sh = readFileSync(join(SCRIPTS_DIR, 'diagnose.sh'), 'utf8');
  const ps = readFileSync(join(SCRIPTS_DIR, 'diagnose.ps1'), 'utf8');
  assert.match(sh, /tr -d/, 'diagnose.sh が空白を落としていない');
  assert.match(ps, /-replace '\\s'/, 'diagnose.ps1 が空白を落としていない');
  for (const [name, text] of [['diagnose.sh', sh], ['diagnose.ps1', ps]]) {
    assert.ok(text.includes('"status":"ok"'), `${name} の分岐が本文の形と違う`);
    assert.ok(text.includes('"lastSuccessDate":null'), `${name} の分岐が本文の形と違う`);
  }
});

// ---- ルートの npm script（cd を要らなくするための入口） ---------------------

test('diagnose の URL を wrangler.toml から組み立てる', async () => {
  // **手で $env:LP_URL を打たせない。** 一度打ち間違えて
  // 「用語 'LP_URL=…' は認識されません」になった（bash の書き方を PowerShell へ）。
  // 値は wrangler.toml に既にある。写す作業そのものを無くす。
  const { buildUrls, readProdVar } = await import('../../../scripts/diagnose.mjs');
  const config = readFileSync(
    fileURLToPath(new URL('../wrangler.toml', import.meta.url)),
    'utf8',
  );

  const urls = buildUrls(config, {});
  assert.equal(urls.LP_URL, 'https://goldencross-incomegains.com');
  assert.equal(urls.APP_URL, 'https://app.goldencross-incomegains.com');

  // 環境変数が渡されていればそちらが勝つ（ローカルや検証環境を見るため）
  const overridden = buildUrls(config, { LP_URL: 'http://localhost:8787/lp' });
  assert.equal(overridden.LP_URL, 'http://localhost:8787/lp');
  assert.equal(overridden.APP_URL, 'https://app.goldencross-incomegains.com');

  // **既定側の同名キーを拾わないこと。** [env.production.vars] だけを見る。
  // 実ファイルの値に頼らず、作った設定で確かめる——Access を設定したら
  // CF_ACCESS_AUD が埋まって、このテストが落ちた。
  const fixture = [
    '[vars]',
    'SAMPLE = "既定側の値"',
    '',
    '[env.production.vars]',
    'SAMPLE = "本番側の値"',
    'EMPTY = ""',
    '',
    '[env.production.routes]',
    'SAMPLE = "セクション外"',
  ].join('\n');
  assert.equal(readProdVar(fixture, 'SAMPLE'), '本番側の値', '既定側を拾っている');
  assert.equal(readProdVar(fixture, 'EMPTY'), '', '空の値は空で返す');
  assert.equal(readProdVar(fixture, 'NO_SUCH_KEY'), '');
  assert.equal(readProdVar(config, 'NO_SUCH_KEY'), '');
});

test('set:access — 値の形で見分け、本番側だけに書く', async () => {
  // **「[env.production.vars] がどこか分からない」で止まった。**
  // database_id のときと同じ形で、貼り先を探す作業を無くす。
  const { extractAccess, applyToProdVars } = await import('../../../scripts/set-access.mjs');

  const aud = 'a'.repeat(64);
  // 順番を問わない。画面からまるごと貼っても拾う。
  assert.deepEqual(extractAccess(`team-x.cloudflareaccess.com ${aud}`), {
    aud,
    teamDomain: 'team-x.cloudflareaccess.com',
  });
  assert.deepEqual(extractAccess(`${aud} が AUD で、team-x.cloudflareaccess.com がチーム`), {
    aud,
    teamDomain: 'team-x.cloudflareaccess.com',
  });
  // 片方だけでもよい
  assert.deepEqual(extractAccess('weathered-frost-70c2.cloudflareaccess.com'), {
    aud: null,
    teamDomain: 'weathered-frost-70c2.cloudflareaccess.com',
  });
  // **32 桁は AUD ではない。** 拾ってしまうと間違った値で Access が通らなくなる。
  assert.equal(extractAccess('b'.repeat(32)).aud, null);
  assert.deepEqual(extractAccess('なにもない'), { aud: null, teamDomain: null });

  // **既定側を書き換えない。** 既定に値が入ると手元の wrangler dev で
  // JWT 検証が始まり、何も開けなくなる。
  const config = [
    '[vars]',
    'CF_ACCESS_AUD = ""',
    '',
    '[env.production.vars]',
    'CF_ACCESS_AUD = ""',
    '',
    '[env.production.routes]',
  ].join('\n');
  const res = applyToProdVars(config, 'CF_ACCESS_AUD', aud);
  assert.ok(res.ok);
  const lines = res.config.split('\n');
  assert.equal(lines[1], 'CF_ACCESS_AUD = ""', '既定側まで書き換えている');
  assert.equal(lines[4], `CF_ACCESS_AUD = "${aud}"`);

  // セクションが無ければ黙って成功しない
  assert.equal(applyToProdVars('[vars]\nX = ""', 'CF_ACCESS_AUD', aud).ok, false);
});

test('set:access — 「まだ空」は引数ではなくファイルの状態で判定する', async () => {
  // **誤報を出した。** 片方だけ渡したとき、渡さなかったほうを
  // 「まだ空」と言っていた。実際には既に入っていたので、
  // 設定が済んでいるのに済んでいないように見えた。
  const { emptyProdVars } = await import('../../../scripts/set-access.mjs');

  const filled = [
    '[vars]',
    'CF_ACCESS_TEAM_DOMAIN = ""',
    '',
    '[env.production.vars]',
    'CF_ACCESS_TEAM_DOMAIN = "team-x.cloudflareaccess.com"',
    `CF_ACCESS_AUD = "${'a'.repeat(64)}"`,
    '',
    '[env.production.routes]',
  ].join('\n');
  assert.deepEqual(emptyProdVars(filled, ['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD']), []);

  const half = filled.replace(`CF_ACCESS_AUD = "${'a'.repeat(64)}"`, 'CF_ACCESS_AUD = ""');
  assert.deepEqual(emptyProdVars(half, ['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD']), ['CF_ACCESS_AUD']);

  // **既定側が空でも、本番側が埋まっていれば空と言わない。**
  assert.deepEqual(emptyProdVars(filled, ['CF_ACCESS_TEAM_DOMAIN']), []);

  // 行が無い・セクションが無いときは空として扱う
  assert.deepEqual(emptyProdVars('[env.production.vars]\n', ['CF_ACCESS_AUD']), ['CF_ACCESS_AUD']);
  assert.deepEqual(emptyProdVars('[vars]\n', ['CF_ACCESS_AUD']), ['CF_ACCESS_AUD']);
});

test('diagnose が「手元が古い」ことを数えられる', async () => {
  // **pull を忘れたまま打って 4 回止まった。** Missing script や
  // 「フラグが効かない」として現れるので、原因に辿り着きにくい。
  // diagnose は本番を見るとき必ず叩くので、ここに出す。
  const { behindCount } = await import('../../../scripts/diagnose.mjs');

  const fake = (out) => (args) =>
    args[0] === 'rev-parse'
      ? { status: 0, stdout: 'claude/feature\n' }
      : { status: 0, stdout: out };

  assert.deepEqual(behindCount(fake('0\t3\n')), { ahead: 0, behind: 3, branch: 'claude/feature' });
  assert.deepEqual(behindCount(fake('2\t0\n')), { ahead: 2, behind: 0, branch: 'claude/feature' });

  // **git が無い・リポジトリでない・上流が無いときは黙る。**
  // 診断そのものを止めてはいけない。
  assert.equal(behindCount(() => ({ status: 128, stdout: '' })), null);
  assert.equal(
    behindCount((args) =>
      args[0] === 'rev-parse' ? { status: 0, stdout: 'HEAD\n' } : { status: 0, stdout: '0\t0\n' },
    ),
    null,
    'detached HEAD で止まっていない',
  );
  // 上流が無ければ rev-list が失敗する
  assert.equal(
    behindCount((args) =>
      args[0] === 'rev-parse' ? { status: 0, stdout: 'main\n' } : { status: 128, stdout: '' },
    ),
    null,
  );
});

test('ルートから cd 無しで診断と一覧が打てる', () => {
  // 同じ失敗を 5 回踏んだ: リポジトリの外・packages\worker の中・その中でもう一度 cd。
  // どれも「打つ場所」の問題だったので、打つ場所を 1 つに畳んだ。
  const root = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
  );
  assert.ok(root.scripts['diagnose'], 'ルートに diagnose が無い');
  assert.ok(root.scripts['waitlist'], 'ルートに waitlist が無い');

  const worker = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  );
  // **--env production を落とさないこと。** 落とすと既定の Worker の
  // D1 を見に行って「0 件」に見える。このリポジトリで一番ハマるところ。
  assert.match(worker.scripts['waitlist'], /--env production/);
  assert.match(worker.scripts['waitlist'], /--remote/);
});

// ---- D1 のトークン権限を測る -------------------------------------------------
//
// wrangler の `Authentication error [code: 10000]` は
// 「権限を確認してください」としか言わない。**どの権限が足りないのかを
// 推測で案内しない**ために、実際に測った結果だけから次の 1 手を決める。

test('check-d1-token — 本番の database_id を取る（既定側と取り違えない）', async () => {
  const { readDatabaseId } = await import('../../../scripts/check-d1-token.mjs');
  const toml = [
    '[[d1_databases]]',
    'binding = "INVEST_DB"',
    'database_id = "local-one"',
    '',
    '[[env.production.d1_databases]]',
    'binding = "INVEST_DB"',
    'database_id = "prod-one"',
  ].join('\n');
  assert.equal(readDatabaseId(toml), 'prod-one', '既定側の id を拾っている');
  assert.equal(readDatabaseId('[[d1_databases]]\ndatabase_id = "only"'), 'only');
  assert.equal(readDatabaseId(''), '');
});

test('check-d1-token — 実物の wrangler.toml から読める', async () => {
  const { readDatabaseId } = await import('../../../scripts/check-d1-token.mjs');
  const toml = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
  assert.match(readDatabaseId(toml), /^[0-9a-f-]{36}$/, 'database_id が読めていない');
});

test('check-d1-token — トークンの値を外に出さない', async () => {
  const { tokenShape } = await import('../../../scripts/check-d1-token.mjs');
  const secret = `cfat_${'S'.repeat(48)}`;
  const shape = tokenShape(secret);
  // **長さと種類だけ。** 値も先頭数文字も返さない。
  assert.equal(shape.length, 53);
  assert.match(shape.kind, /アカウント/);
  assert.ok(!JSON.stringify(shape).includes('SSSS'), 'トークンの中身が漏れている');

  assert.match(tokenShape(`cfut_${'x'.repeat(48)}`).kind, /ユーザー API トークン/);
  assert.match(tokenShape(`cfk_${'x'.repeat(48)}`).kind, /API キー/);
  assert.match(tokenShape('a'.repeat(37)).kind, /グローバル/);
  assert.equal(tokenShape('').kind, 'なし');
});

test('check-d1-token — 測った事実と食い違う案内をしない', async () => {
  const { verdict } = await import('../../../scripts/check-d1-token.mjs');
  const ok = { status: 200, code: '' };
  const ng = { status: 403, code: '10000: Authentication error' };

  // 3 つとも通る → 権限の問題ではない。「D1:Edit を足せ」と言わない。
  const fine = verdict({ list: ok, query: ok, importInit: ok });
  assert.equal(fine.ok, true);
  assert.ok(!/編集/.test(fine.text), '通っているのに権限を足させようとしている');

  // どれも通らない → D1 の権限が無い
  const none = verdict({ list: ng, query: ng, importInit: ng });
  assert.equal(none.ok, false);
  assert.match(none.text, /D1 の権限が入っていない/);

  // 問い合わせは通るのに取り込みだけ落ちる → 権限とトークンの種類の 2 択
  const importOnly = verdict({ list: ok, query: ok, importInit: ng });
  assert.equal(importOnly.ok, false);
  assert.match(importOnly.text, /取り込みだけ弾かれている/);
  assert.match(importOnly.text, /cfut_/, 'トークンの種類の線が案内に無い');

  // 読めるだけ → 編集を足す
  const readOnly = verdict({ list: ok, query: ng, importInit: ng });
  assert.match(readOnly.text, /読み取りだけ/);
});

test('check-d1-token — 取り込みの確認でデータベースを変えない', () => {
  // init しか送らない。SQL を送る段には進まない。
  const src = readFileSync(
    fileURLToPath(new URL('../../../scripts/check-d1-token.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(src, /action: 'init'/);
  for (const bad of ['ingest', 'DELETE', 'DROP', 'INSERT']) {
    assert.ok(!src.includes(bad), `確認のつもりで ${bad} を送っている`);
  }
});

test('D1 へ流し込む workflow は、落ちたら権限を測る', () => {
  // 失敗したときに wrangler のメッセージだけが残ると、原因が分からないまま
  // 当てずっぽうの往復になる（実際になった）。
  const dir = fileURLToPath(new URL('../../../.github/workflows', import.meta.url));
  for (const name of ['earnings.yml', 'quotes.yml', 'backfill.yml']) {
    const text = readFileSync(join(dir, name), 'utf8');
    assert.ok(text.includes('d1 execute'), `${name} が D1 に流していない`);
    assert.ok(
      text.includes('scripts/check-d1-token.mjs'),
      `${name} が落ちたときに権限を測っていない`,
    );
    assert.ok(text.includes('if: failure()'), `${name} の確認が失敗時に走らない`);
  }
});

test('check-d1-token — 届かなかっただけのときにトークンを疑わせない', async () => {
  // **スモークテストで見つけた自分のバグ。** 回線がこけて返事が
  // 来なかっただけなのに「権限が入っていない」と断定していた。
  // 誤診を無くすために足した仕組みが、誤診の出どころになっていた。
  const { verdict } = await import('../../../scripts/check-d1-token.mjs');
  const unreachable = { status: 0, code: '到達できない: fetch failed' };
  const v = verdict({ list: unreachable, query: unreachable, importInit: unreachable });
  assert.equal(v.ok, false);
  assert.match(v.text, /届いていない/);
  assert.ok(!/権限が入っていない/.test(v.text), '届かないのを権限のせいにしている');
  assert.ok(!/編集/.test(v.text), 'トークンをいじらせようとしている');
});

test('check-d1-token — トークンを編集する画面を種類で出し分ける', async () => {
  // **実際に外した案内。** アカウント所有のトークン（cfat_）は
  // プロフィール側の一覧に出てこないので、profile/api-tokens を案内すると
  // 「そのトークンが無い」と探させることになる。
  const { tokenPageUrl, tokenShape, verdict } = await import(
    '../../../scripts/check-d1-token.mjs'
  );
  const acct = 'a'.repeat(32);

  const forAccount = tokenPageUrl(tokenShape(`cfat_${'x'.repeat(48)}`).kind, acct);
  assert.equal(forAccount, `https://dash.cloudflare.com/${acct}/api-tokens`);
  assert.ok(!forAccount.includes('/profile/'), 'アカウント所有をプロフィール側に案内している');

  const forUser = tokenPageUrl(tokenShape(`cfut_${'x'.repeat(48)}`).kind, acct);
  assert.equal(forUser, 'https://dash.cloudflare.com/profile/api-tokens');

  // アカウント ID が無ければ URL をでっち上げない
  assert.ok(!tokenPageUrl('アカウント API トークン (cfat_)', '').startsWith('https://dash.cloudflare.com/a'));

  // 実測と同じ形（3 つとも落ちる）で、正しい画面を案内すること
  const ng = { status: 401, code: '10000: Authentication error' };
  const v = verdict({ list: ng, query: ng, importInit: ng, tokenUrl: forAccount });
  assert.ok(v.text.includes(forAccount), '案内に編集先が入っていない');
  assert.ok(!v.text.includes('/profile/'), 'プロフィール側を案内している');
});

test('check-d1-token — トークンの自己確認は 2 つの経路を試す', async () => {
  // **アカウント所有を /user/tokens/verify に投げると 1000: Invalid API Token。**
  // 有効なトークンを「無効」と誤診するので、経路を決めつけない。
  const { probeVerify } = await import('../../../scripts/check-d1-token.mjs');
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    const accountPath = url.includes('/accounts/');
    return {
      status: accountPath ? 200 : 400,
      json: async () =>
        accountPath
          ? { result: { id: 'tok-123', status: 'active' }, errors: [] }
          : { errors: [{ code: 1000, message: 'Invalid API Token' }] },
    };
  };
  const r = await probeVerify(fake, 'acct', {});
  assert.equal(r.status, 200);
  assert.equal(r.tokenId, 'tok-123');
  assert.equal(seen.length, 1, 'アカウント側で通ったのに user 側も叩いている');

  // 逆順（ユーザー所有）でも拾えること
  const seen2 = [];
  const userOnly = async (url) => {
    seen2.push(url);
    const accountPath = url.includes('/accounts/');
    return {
      status: accountPath ? 400 : 200,
      json: async () =>
        accountPath
          ? { errors: [{ code: 1000, message: 'Invalid API Token' }] }
          : { result: { id: 'tok-999', status: 'active' }, errors: [] },
    };
  };
  const r2 = await probeVerify(userOnly, 'acct', {});
  assert.equal(r2.tokenId, 'tok-999');
  assert.equal(seen2.length, 2, 'もう一方の経路を試していない');
});

test('check-d1-token — D1 だけ落ちるときにトークンの取り違えを疑わせる', async () => {
  // 権限を足したのに結果が変わらなかった。**トークンが有効で D1 だけ
  // 通らないなら、Actions が別のトークンを使っている線が残る。**
  // デプロイは通るので、古いトークンのままでも気付けない。
  const { verdict } = await import('../../../scripts/check-d1-token.mjs');
  const ng = { status: 401, code: '10000: Authentication error' };
  const v = verdict({
    verify: { status: 200, code: '', tokenId: 'tok-abc', tokenStatus: 'active' },
    workers: { status: 200, code: '' },
    list: ng, query: ng, importInit: ng,
    tokenUrl: 'https://dash.cloudflare.com/x/api-tokens',
  });
  assert.equal(v.ok, false);
  assert.match(v.text, /D1 だけが全部落ちている/);
  assert.match(v.text, /tok-abc/, 'どのトークンか突き合わせられない');
  assert.match(v.text, /保存/, '保存漏れの線が案内に無い');

  // トークンの自己確認まで落ちるなら、取り違えの話はしない
  const all = verdict({
    verify: ng, workers: ng, list: ng, query: ng, importInit: ng,
    tokenUrl: 'https://dash.cloudflare.com/x/api-tokens',
  });
  assert.ok(!/別物/.test(all.text), '確認できていないのに取り違えだと言っている');
  assert.match(all.text, /D1 の権限が入っていない/);
});

test('check-d1-token — D1 の全滅を権限不足と決めつけない', async () => {
  // **自分の論理の誤り。** 「D1 の 3 経路すべてが落ちる ⇒ 権限が無い」と
  // 断定したが、**トークンの種類が D1 に対応していない場合も同じ形で全滅する。**
  // 見分けの付かない signature を片方だと決めつけて、一往復無駄にした。
  const { verdict, tokenShape } = await import('../../../scripts/check-d1-token.mjs');
  const ng = { status: 401, code: '10000: Authentication error' };
  const base = {
    verify: { status: 200, code: '', tokenId: 'tok-abc', tokenStatus: 'active' },
    workers: { status: 200, code: '' },
    list: ng, query: ng, importInit: ng,
    tokenUrl: 'https://dash.cloudflare.com/x/api-tokens',
  };

  // アカウント所有（cfat_）なら、種類の線を**最初に**出す
  const acct = verdict({ ...base, tokenKind: tokenShape(`cfat_${'x'.repeat(48)}`).kind });
  assert.match(acct.text, /アカウント所有トークン（cfat_）が D1 に通らない/);
  assert.match(acct.text, /cfut_/, 'ユーザートークンで切り分ける案内が無い');
  assert.ok(
    acct.text.indexOf('cfat_）が D1 に通らない') < acct.text.indexOf('Secret が、編集した'),
    '一番疑わしい線が後ろに回っている',
  );
  assert.ok(!/権限が入っていない/.test(acct.text), 'まだ権限不足と断定している');

  // ユーザー所有（cfut_）なら、その線は出さない（作り直す先が同じになる）
  const user = verdict({ ...base, tokenKind: tokenShape(`cfut_${'x'.repeat(48)}`).kind });
  assert.ok(!/cfat_）が D1 に通らない/.test(user.text), '関係ない線を出している');
  assert.match(user.text, /Secret が、編集した/);
});

// ---- マイグレーションを本番に当てる ------------------------------------------
//
// 決算カレンダーの取り込みが `no such table: earnings_calendar` で落ちた。
// 0003 / 0004 を本番に当てていなかった。**気付く方法が無かった**ので、
// 当て漏れが起きにくい形に寄せる。

test('マイグレーションは何度流しても壊れない', () => {
  // migrate.yml は 0001 から全部を毎回流す。**途中から当てる判断をしない**
  // （どこまで当たっているかを人間が覚えておく形にしない）。
  // それが成り立つのは、すべての CREATE が IF NOT EXISTS だから。
  const dir = fileURLToPath(new URL('../../../migrations', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0, 'migrations/ が空');

  for (const name of files) {
    const sql = readFileSync(join(dir, name), 'utf8');
    for (const m of sql.matchAll(/^\s*CREATE\s+(TABLE|INDEX|VIEW|TRIGGER)\b(.*)$/gim)) {
      assert.match(
        m[0],
        /IF NOT EXISTS/i,
        `${name} の「${m[0].trim()}」に IF NOT EXISTS が無い。2 回目で落ちる`,
      );
    }
    // 2 回流すと値が重複するものを置かない
    for (const bad of [/^\s*INSERT\s/im, /^\s*ALTER\s/im]) {
      assert.ok(!bad.test(sql), `${name} に流し直せない文がある`);
    }
  }
});

test('db:migrate:remote が migrations/ を取りこぼさない', () => {
  // **一覧がハードコードしてある。** 連番を足したときに書き忘れると、
  // 本番にだけ当たらない表ができる（今回それで止まった）。
  const dir = fileURLToPath(new URL('../../../migrations', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const worker = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  );
  for (const key of ['db:migrate:local', 'db:migrate:remote']) {
    const cmd = worker.scripts[key];
    for (const f of files) {
      assert.ok(cmd.includes(f), `${key} が ${f} を流していない`);
    }
  }
  // 当てる順序も崩さない（外部キーがあるので 0001 が先）
  const order = files.map((f) => worker.scripts['db:migrate:remote'].indexOf(f));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '連番の順に流していない');
});

test('migrate.yml は一覧をハードコードしない', () => {
  // 書き忘れが起きない形にしておく。ファイルを足すだけで当たる。
  const yml = readFileSync(
    fileURLToPath(new URL('../../../.github/workflows/migrate.yml', import.meta.url)),
    'utf8',
  );
  assert.match(yml, /migrations\/\*\.sql/, 'glob で拾っていない');
  assert.match(yml, /sort/, '連番の順に並べていない');
  assert.match(yml, /--env production/, '本番の D1 を指していない');
  assert.ok(!/0004_earnings\.sql/.test(yml), 'ファイル名を個別に書いている');
});
