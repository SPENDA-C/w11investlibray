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
