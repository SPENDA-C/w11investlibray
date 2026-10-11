import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, recentWeekday, resolveRule, runBacktestCommand, insertStatements, q, runCheck, reasonFrom, keyHint, parseRows, parseSheetTimestamp, isStale, assembleSheetSync, splitByBytes, chunkPath, DEFAULT_MAX_BYTES, assembleBackfill, priceInsertStatements } from '../.build/cli.mjs';

test('引数の解析 — 値ありとフラグのみを区別する', () => {
  const a = parseArgs(['backfill', '--from', '2026-01-01', '--to', '2026-02-01', '--verbose']);
  assert.equal(a.command, 'backfill');
  assert.equal(a.flags.from, '2026-01-01');
  assert.equal(a.flags.to, '2026-02-01');
  assert.equal(a.flags.verbose, 'true');
});

test('引数の解析 — コマンドが無ければ空文字', () => {
  assert.equal(parseArgs([]).command, '');
});

test('直近の平日 — 土日を飛ばす', () => {
  // 2026-08-27 は木曜。3 営業日前は月曜 2026-08-24。
  assert.equal(recentWeekday(new Date('2026-08-27T00:00:00Z'), 3), '2026-08-24');
  // 月曜から 1 営業日前は金曜
  assert.equal(recentWeekday(new Date('2026-08-24T00:00:00Z'), 1), '2026-08-21');
});

test('ルール名の解決', () => {
  assert.equal(resolveRule('golden-cross').id, 'golden-cross-v1');
  assert.equal(resolveRule('score-75').id, 'score-threshold-75');
  assert.throws(() => resolveRule('nope'), /不明なルール/);
});

test('SQL リテラル — クォートをエスケープする', () => {
  assert.equal(q("O'Brien"), "'O''Brien'");
  assert.equal(q(null), 'NULL');
  assert.equal(q(undefined), 'NULL');
  assert.equal(q(12.5), '12.5');
  assert.equal(q(NaN), 'NULL', '数値でない値を SQL に埋め込まない');
  assert.equal(q(Infinity), 'NULL');
});

test('INSERT 文は 1 文が大きくなりすぎないよう分割される', () => {
  const rows = Array.from({ length: 450 }, (_, i) => [`JP.${i}`, '2026-01-01', i]);
  const stmts = insertStatements('prices_daily', ['symbol_id', 'date', 'close'], rows, {
    conflictTarget: 'symbol_id, date',
    rowsPerStatement: 200,
  });
  assert.equal(stmts.length, 3);
  assert.match(stmts[0], /ON CONFLICT \(symbol_id, date\) DO NOTHING/);
  // 全行が残っている
  const total = stmts.reduce((a, s) => a + (s.match(/\('JP\./g) ?? []).length, 0);
  assert.equal(total, 450);
});

test('INSERT 文 — 行が無ければ何も出さない', () => {
  assert.deepEqual(insertStatements('t', ['a'], []), []);
});

test('バックテストが通しで走り、D1 用の SQL を書き出す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bt-'));
  const input = join(dir, 'prices.json');
  const out = join(dir, 'backtest.sql');

  // 上昇 → 下降のトレンドを持つ 400 本
  const bars = [];
  let price = 1000;
  const start = new Date('2024-01-01T00:00:00Z');
  for (let i = 0; i < 400; i += 1) {
    price += (i < 240 ? 1.5 : -1.2) + Math.sin(i / 9) * 5;
    const close = Math.max(1, Math.round(price * 10) / 10);
    const d = new Date(start.getTime() + i * 86400000);
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: close * 0.999,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 100000 + Math.round(Math.sin(i / 4) * 20000),
      adjustmentFactor: 1,
    });
  }
  await writeFile(input, JSON.stringify({ 'JP.72030': bars, 'JP.67580': bars }), 'utf8');

  const code = await runBacktestCommand({
    input,
    out,
    ruleName: 'golden-cross',
    universe: 'TEST',
    costPerSide: 0.001,
    maxHoldBars: 60,
  });
  assert.equal(code, 0);

  const sql = await readFile(out, 'utf8');
  assert.match(sql, /INSERT INTO backtest_runs/);
  assert.match(sql, /INSERT INTO backtest_stats/);
  assert.match(sql, /golden-cross-v1/);
});

test('バックテストの出力は実スキーマに投入できる', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'bt2-'));
  const input = join(dir, 'p.json');
  const out = join(dir, 'b.sql');

  const bars = [];
  let price = 500;
  for (let i = 0; i < 300; i += 1) {
    price += 1 + Math.sin(i / 7) * 4;
    const close = Math.round(price * 10) / 10;
    const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000);
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: close, high: close * 1.02, low: close * 0.98, close,
      volume: 50000, adjustmentFactor: 1,
    });
  }
  await writeFile(input, JSON.stringify({ 'JP.72030': bars }), 'utf8');
  await runBacktestCommand({ input, out, ruleName: 'score-70', universe: 'TEST', costPerSide: 0.001, maxHoldBars: 40 });

  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../../../migrations/0001_init.sql', import.meta.url), 'utf8'));
  // symbols への外部キーがあるので先に入れておく
  db.exec(`INSERT INTO symbols (symbol_id, market, code, name, currency, updated_at)
           VALUES ('JP.72030','JP','72030','テスト','JPY','2026-01-01')`);
  db.exec(await readFile(out, 'utf8'));

  const runs = db.prepare('SELECT * FROM backtest_runs').all();
  assert.equal(runs.length, 1);
  const stats = db.prepare('SELECT * FROM backtest_stats').all();
  assert.equal(stats.length, 1);
  assert.equal(typeof stats[0].trades, 'number');
});

test('入力が少なすぎる銘柄は黙って飛ばす', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bt3-'));
  const input = join(dir, 'p.json');
  const out = join(dir, 'b.sql');
  await writeFile(input, JSON.stringify({ 'JP.00010': [{ date: '2024-01-01', open: 1, high: 1, low: 1, close: 1, volume: 1, adjustmentFactor: 1 }] }), 'utf8');
  const code = await runBacktestCommand({ input, out, ruleName: 'golden-cross', universe: 'TEST', costPerSide: 0, maxHoldBars: 60 });
  assert.equal(code, 0);
  const sql = await readFile(out, 'utf8');
  assert.ok(!sql.includes('INSERT INTO backtest_trades'), '取引が無ければ trades は書かない');
});

// ---- check の診断 -----------------------------------------------------------
//
// **状態コードだけ見て本文を捨てていた。** 全 403 を「契約プランの範囲外」と
// 誤診し、しかも終了コードは 0 だった。真因は経路が V1 のままだったこと
// （API Gateway は経路に一致しないと 403 を返す）。本文には
// 「endpoint does not exist」と書いてあったのに、それを表示していなかった。

/** console.log を捕まえて、出力と戻り値の両方を見る。 */
async function captureCheck(responses) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = await runCheck('dummy-key', 'https://api.example.test/v2', '2026-09-01',
      async (path) => responses[path] ?? { status: 500, body: { message: '未定義の経路' } });
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

// V2 の経路。V1 の名前（/listed/info など）ではない。
const ALL_PATHS = ['/equities/master', '/equities/bars/daily', '/markets/calendar'];

test('check — API が返した理由をそのまま出す', async () => {
  // **ここが今回いちばん効く。** 実際に返ってきたのはこの本文で、
  // これを表示していれば一度で原因に辿り着けた。
  const { out } = await captureCheck(
    Object.fromEntries(ALL_PATHS.map((p) => [p, {
      status: 403, body: { message: 'The requested endpoint does not exist.' },
    }])),
  );
  assert.match(out, /The requested endpoint does not exist\./);
});

test('check — 全部 403 なら「プランの範囲外」とは言わない', async () => {
  const { code, out } = await captureCheck(
    Object.fromEntries(ALL_PATHS.map((p) => [p, { status: 403, body: { message: 'forbidden' } }])),
  );
  assert.match(out, /契約プランの範囲外ではない/);
  assert.match(out, /経路が間違っている/, '真因（経路違い）を筆頭に挙げていない');
  assert.match(out, /endpoint does not exist/, '見分け方を書いていない');
  // 1 本ごとに「（契約プランの範囲外の可能性）」と断定していた行は、もう出さない
  assert.ok(!out.includes('（契約プランの範囲外の可能性）'), '1 本ごとに断定している');
  assert.equal(code, 1, '必要な 3 本が取れないのに成功で返している');
});

test('check — 3 本とも通れば成功で返る', async () => {
  // **レコードは `data` に入る。** 経路ごとに違うキーだったのは V1。
  const { code, out } = await captureCheck({
    '/equities/master': { status: 200, body: { data: [{ Code: '13010', CompanyName: 'テスト' }] } },
    '/equities/bars/daily': { status: 200, body: { data: [{ Code: '13010', C: 100 }] } },
    '/markets/calendar': { status: 200, body: { data: [{ Date: '2026-09-01' }] } },
  });
  assert.equal(code, 0);
  // 実際に返ってきた項目名を見せるのが、このコマンドの本来の仕事
  assert.match(out, /実際の項目名: Code, CompanyName/);
});

test('check — 財務は叩かない（V2 の経路が未確認なので推測しない）', async () => {
  // 当てずっぽうのパスを置いて 403 を眺めるのが、今回の遠回りそのものだった。
  const { out } = await captureCheck({
    '/equities/master': { status: 200, body: { data: [] } },
    '/equities/bars/daily': { status: 200, body: { data: [] } },
    '/markets/calendar': { status: 200, body: { data: [] } },
  });
  assert.ok(!out.includes('/fins/'), '未確認の経路を叩いている');
});

test('check — 必要な 3 本のどれかが落ちたら非 0 で終わる', async () => {
  const { code, out } = await captureCheck({
    '/equities/master': { status: 200, body: { data: [] } },
    '/equities/bars/daily': { status: 500, body: { message: 'boom' } },
    '/markets/calendar': { status: 200, body: { data: [] } },
  });
  assert.match(out, /\/equities\/bars\/daily が取れない/);
  assert.equal(code, 1);
});

test('reasonFrom — よくある形から 1 行を取り出す', () => {
  assert.equal(reasonFrom({ message: 'a' }), 'a');
  assert.equal(reasonFrom({ error: 'b' }), 'b');
  assert.equal(reasonFrom('生のテキスト'), '生のテキスト');
  // 見覚えのない形でも、何か出す（黙るより良い）
  assert.match(reasonFrom({ weird: 1 }), /weird/);
  assert.equal(reasonFrom(null), '');
  // 長すぎる本文は切る
  assert.equal(reasonFrom('x'.repeat(500)).length, 200);
});

// ---- 401 / 403 の行き先 -------------------------------------------------------
//
// **403 は 2 種類ある。** 経路が無い（前回これで 3 日溶かした）のと、
// キーが効いていない（今回）の。API 自身は理由を書いてくるので、
// そこから分岐して「次にどこを触るか」まで言う。
//
// キーは **3 箇所に別々のコピーがある**（手元 / Cloudflare / Actions）。
// 1 つ回すと残り 2 つが黙って古くなるので、案内は 3 つとも出す。

test('keyHint — 401 / 403 以外には何も足さない', () => {
  assert.equal(keyHint(200, { data: [] }), '');
  assert.equal(keyHint(400, { message: 'Your subscription covers ...' }), '');
  assert.equal(keyHint(429, {}), '');
  assert.equal(keyHint(500, {}), '');
});

test('keyHint — 経路が無い 403 は、キーではなく JP_PATHS へ誘導する', () => {
  const hint = keyHint(403, {
    message: 'The requested endpoint does not exist. Please check the URL, HTTP method, and API version',
  });
  assert.match(hint, /JP_PATHS/);
  // ここでキーの話を持ち出すと、また遠回りさせることになる
  assert.doesNotMatch(hint, /Actions/);
});

test('keyHint — キーが効いていない 403 は、置き場所 3 つを全部出す', () => {
  const hint = keyHint(403, { message: 'The incoming api key is invalid or expired.' });
  assert.match(hint, /JQUANTS_API_KEY/);
  assert.match(hint, /Cloudflare/);
  assert.match(hint, /Actions/);
  // このプロセスがどこから読んだのかを言う（3 つのうちどれを直すかの手がかり）
  assert.match(hint, /環境変数/);
});

test('keyHint — 401 もキー扱い', () => {
  assert.match(keyHint(401, {}), /Actions/);
});

// ---- シート取り込み ----------------------------------------------------------
//
// GOOGLEFINANCE は API を持たない表計算の数式なので、**シートが取得層になる。**
// 取れない銘柄は C 列が `#N/A` になる。そこを「0」や「欠測」として
// 通してしまうと、**取れていないことが画面から消える。** 必ず弾く。

const HEADER = ['symbol_id', 'gf_ticker', 'price', 'as_of'];

test('parseRows — 取れなかった行を良い行として通さない', () => {
  const { ok, bad } = parseRows([
    HEADER,
    ['US.NVDA', 'NASDAQ:NVDA', '188.42', '2026-10-11 12:34:56'],
    ['CRYPTO.BTCUSD', 'CURRENCY:BTCUSD', '#N/A', ''],
    ['US.SLV', 'NYSEARCA:SLV', '#ERROR!', ''],
  ]);
  assert.deepEqual(ok.map((r) => r.symbolId), ['US.NVDA']);
  assert.deepEqual(bad.map((r) => r.raw), ['#N/A', '#ERROR!']);
  // どの行かが分かること（シートを直すのは人間なので行番号が要る）
  assert.deepEqual(bad.map((r) => r.line), [3, 4]);
});

test('parseRows — 空の行は飛ばす。不良として数えない', () => {
  const { ok, bad } = parseRows([HEADER, ['', '', '', ''], ['   ', '', '', '']]);
  assert.equal(ok.length, 0);
  assert.equal(bad.length, 0);
});

test('parseRows — symbol_id の形を検査する', () => {
  const { ok, bad } = parseRows([
    HEADER,
    ['NVDA', 'NASDAQ:NVDA', '188.42', ''],          // 名前空間が無い
    ['XX.NVDA', 'NASDAQ:NVDA', '188.42', ''],       // 知らない市場
    ['US.NVDA', '', '188.42', ''],                  // ティッカーが無い
  ]);
  assert.equal(ok.length, 0);
  assert.equal(bad.length, 3);
});

test('parseRows — 通貨は symbol_id から決まる。E 列があれば優先する', () => {
  const { ok } = parseRows([
    [...HEADER, 'currency'],
    ['US.NVDA', 'NASDAQ:NVDA', '188.42', ''],
    ['JP.72030', 'TYO:7203', '2890', ''],
    ['FX.USDJPY', 'CURRENCY:USDJPY', '152.31', ''],
    ['CRYPTO.BTCUSD', 'CURRENCY:BTCUSD', '95000', ''],
    ['FX.EURJPY', 'CURRENCY:EURJPY', '165.2', '', 'JPY'],
  ]);
  assert.deepEqual(ok.map((r) => r.currency), ['USD', 'JPY', 'JPY', 'USD', 'JPY']);
});

test('parseRows — 桁区切りや通貨記号が付いていても数値として読む', () => {
  const { ok, bad } = parseRows([
    HEADER,
    ['CRYPTO.BTCUSD', 'CURRENCY:BTCUSD', '$95,432.10', ''],
  ]);
  assert.equal(bad.length, 0);
  assert.equal(ok[0].price, 95432.1);
});

// **=NOW() の読み方がいちばんずれやすい。**
// Sheets API は既定で表示文字列を返すので、書式とタイムゾーン次第で
// 見た目が変わる。シリアル値で返ってきたのを黙って受けると、
// 1899 年起点の日数を日付として解釈して何年もずれる。

test('parseSheetTimestamp — 文字列を指定したオフセットで解釈する', () => {
  assert.equal(parseSheetTimestamp('2026-10-11 12:34:56', '+09:00'), '2026-10-11T03:34:56.000Z');
  assert.equal(parseSheetTimestamp('2026-10-11T12:34:56', '+00:00'), '2026-10-11T12:34:56.000Z');
});

test('parseSheetTimestamp — シリアル値は黙って受けない', () => {
  // =NOW() のまま（TEXT で包み忘れ）だとこうなる。
  assert.throws(() => parseSheetTimestamp('46321.5243', '+09:00'), /TEXT/);
});

test('parseSheetTimestamp — 空と読めない文字列は落とす', () => {
  assert.throws(() => parseSheetTimestamp('', '+09:00'), /空/);
  assert.throws(() => parseSheetTimestamp('きのう', '+09:00'), /きのう/);
});

test('isStale — 境界', () => {
  const now = '2026-10-11T12:00:00.000Z';
  assert.equal(isStale('2026-10-11T11:00:00.000Z', now, 24), false);
  assert.equal(isStale('2026-10-10T12:00:01.000Z', now, 24), false);
  assert.equal(isStale('2026-10-10T11:59:59.000Z', now, 24), true);
});

test('assembleSheetSync — symbols が quotes_snapshot より先に来る', () => {
  const { ok } = parseRows([HEADER, ['US.NVDA', 'NASDAQ:NVDA', '188.42', '']]);
  const sql = assembleSheetSync({
    rows: ok,
    asOf: '2026-10-11T03:34:56.000Z',
    fetchedAt: '2026-10-11T03:40:00.000Z',
  }).join('\n');
  const symbols = sql.indexOf('INSERT INTO symbols');
  const quotes = sql.indexOf('INSERT INTO quotes_snapshot');
  assert.ok(symbols >= 0 && quotes >= 0, '両方の INSERT があること');
  // 外部キーがあるので、逆だと FOREIGN KEY constraint failed で落ちる
  assert.ok(symbols < quotes, `symbols が先に来ていない: ${symbols} / ${quotes}`);
});

test('assembleSheetSync — 生成した SQL が実スキーマにそのまま通る', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { ok } = parseRows([
    HEADER,
    ['US.NVDA', 'NASDAQ:NVDA', '188.42', ''],
    ['FX.USDJPY', 'CURRENCY:USDJPY', '152.31', ''],
  ]);
  const sql = assembleSheetSync({
    rows: ok,
    asOf: '2026-10-11T03:34:56.000Z',
    fetchedAt: '2026-10-11T03:40:00.000Z',
  }).join('\n');

  const db = new DatabaseSync(':memory:');
  // **外部キーを有効にして確かめる。** quotes_snapshot は symbols を参照して
  // いるので、順序を間違えるとここで落ちる。切ったままだと素通りしてしまう。
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(await readFile(new URL('../../../migrations/0001_init.sql', import.meta.url), 'utf8'));
  db.exec(await readFile(new URL('../../../migrations/0003_quotes.sql', import.meta.url), 'utf8'));
  // **symbols を手で入れない。** 生成物だけで通ることを見る。
  db.exec(sql);

  // node:sqlite の行は null プロトタイプなので、deepEqual ではなく値で比べる。
  const rows = db
    .prepare('SELECT symbol_id, price, currency FROM quotes_snapshot ORDER BY symbol_id')
    .all()
    .map((r) => `${r.symbol_id} ${r.price} ${r.currency}`);
  assert.deepEqual(rows, ['FX.USDJPY 152.31 JPY', 'US.NVDA 188.42 USD']);

  // symbols 側も生成物だけで埋まっていること（名前はコードで代用する）。
  const sym = db.prepare("SELECT market, name FROM symbols WHERE symbol_id = 'FX.USDJPY'").get();
  assert.equal(sym.market, 'FX');
  assert.equal(sym.name, 'USDJPY');
});

// ---- backfill の分割 ---------------------------------------------------------
//
// **1 ファイルにまとめると流し込めない。** 日足は 1 日約 4,000 行返るので、
// 2 年で約 200 万行・約 180 MB になる。`wrangler d1 execute --file` に
// 渡せる大きさではない。容量で切って連番で書く。

test('backfill — 上限を超えたら次のファイルへ移る', () => {
  const stmts = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)];
  const chunks = splitByBytes(stmts, 250);
  assert.equal(chunks.length, 2, '250 バイトに 101 バイトの文は 2 つまで');
  assert.deepEqual(chunks[0], [stmts[0], stmts[1]]);
  assert.deepEqual(chunks[1], [stmts[2]]);
});

test('backfill — 順序を崩さない（外部キーが順序に依存している）', () => {
  // market_calendar → symbols → prices_daily の順で流れる必要がある。
  const stmts = ['-- header', 'INSERT INTO market_calendar …', 'INSERT INTO prices_daily …'];
  const flat = splitByBytes(stmts, 20).flat();
  assert.deepEqual(flat, stmts, '分割で並びが変わっている');
});

test('backfill — 収まるなら 1 ファイル', () => {
  const chunks = splitByBytes(['x', 'y'], DEFAULT_MAX_BYTES);
  assert.equal(chunks.length, 1);
});

test('backfill — 1 文が上限を超えても割らない（SQL が壊れる）', () => {
  const huge = 'z'.repeat(500);
  const chunks = splitByBytes([huge], 10);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0][0], huge);
});

test('backfill — 空なら 0 ファイル', () => {
  assert.deepEqual(splitByBytes([], 100), []);
});

test('backfill — ファイル名はゼロ埋めで、sort が適用順になる', () => {
  // **ここを外すと外部キーで落ちる。** backfill-10.sql が backfill-2.sql の
  // 前に並ぶと、prices_daily が market_calendar より先に流れる。
  const names = [1, 2, 10, 11].map((i) => chunkPath('out/backfill.sql', i));
  assert.deepEqual(names, [
    'out/backfill-001.sql',
    'out/backfill-002.sql',
    'out/backfill-010.sql',
    'out/backfill-011.sql',
  ]);
  assert.deepEqual([...names].sort(), names, 'sort の順が適用順と一致しない');

  // .sql が付いていない接頭辞でも同じ
  assert.equal(chunkPath('out/backfill', 3), 'out/backfill-003.sql');
});

test('backfill — マルチバイトをバイト数で数える', () => {
  // 日本語のコメント行が入る。文字数で数えると上限を超える。
  const jp = 'あ'.repeat(10); // 30 バイト
  const chunks = splitByBytes([jp, jp], 40);
  assert.equal(chunks.length, 2, 'バイト数ではなく文字数で数えている');
});

// ---- npm から引数が届くか -----------------------------------------------------
//
// **parseArgs の単体テストは通っていた。壊れていたのはその手前。**
// `npm run X -- args` の args は X の文字列の末尾に連結されるので、
// script が入れ子になっていると内側の npm が `--from` を自分のオプションと
// して食う。フラグ名が消えて値だけが流れ、B3 が最初の 1 歩で落ちた:
//
//   > npm run cli --silent -- backfill 2024-09-02 2026-09-04 out/backfill.sql
//   --from と --to は必須。
//
// ここは npm を実際に起動しないと確かめようがない。遅いが置く。

/** `npm run` を起動して、標準出力と標準エラーをまとめて返す。 */
function runNpm(args) {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  try {
    return execFileSync('npm', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, JQUANTS_API_KEY: '' },
    });
  } catch (err) {
    // 非 0 で終わるのは想定内（不明なルールで落とす）
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('npm 経由でもフラグ名が届く（ワークスペース内）', { timeout: 120_000 }, async () => {
  // --rule が消えると既定の golden-cross になり、この文言は出ない。
  // つまり「名前ごと届いている」ことの証拠になる。
  // **入力ファイルは実在させる。** 読み込みがルール解決より先なので、
  // 無いパスを渡すと ENOENT で止まり、--rule まで到達しない。
  const dir = await mkdtemp(join(tmpdir(), 'npmargs-'));
  const input = join(dir, 'empty.json');
  await writeFile(input, '{}', 'utf8');

  const out = runNpm([
    'run', 'backtest', '-w', '@invest/batch', '--silent', '--',
    '--input', input, '--rule', 'nope',
  ]);
  assert.match(out, /不明なルール: nope/, 'npm が --rule を食っている');
});

test('npm 経由でもフラグ名が届く（ワークスペースを跨いで）', { timeout: 120_000 }, () => {
  // **ここが実際に壊れていた経路。** ルートの script が
  // `npm run backfill -w @invest/batch` と入れ子になっていたため、
  // --from / --to / --out が名前ごと消えた。
  // ルートの script 末尾に `--` を置き、batch 側の leaf を node で
  // 終わらせることで直してある。
  //
  // 見分け方: 引数の検証を API キーより先に置いてあるので、
  //   フラグが届いた  → 「JQUANTS_API_KEY が未設定。」まで進む
  //   フラグが消えた  → 「--from と --to は必須。」で止まる
  // ネットワークにも本物のキーにも触らずに判定できる。
  const out = runNpm([
    'run', 'backfill', '--silent', '--', '--from', '2026-09-01', '--to', '2026-09-02',
  ]);
  assert.ok(
    !out.includes('--from と --to は必須'),
    `--from / --to が npm に食われている:\n${out}`,
  );
  assert.match(out, /JQUANTS_API_KEY が未設定/, 'フラグは届いたが、別の理由で止まっている');
});

// ---- backfill が実スキーマにそのまま流せること -------------------------------
//
// **prices_daily は symbols を参照している**（migrations/0001_init.sql:63）。
// symbols を書かずに流すと `FOREIGN KEY constraint failed` で落ちる。
// 実際、symbols を 1 行も書いていないまま「順序が大事」とだけ書いてあった。
// ここは実スキーマに流して確かめる——それでしか捕まらない。

/** 1 銘柄 1 日ぶんの価格行（列順は PRICE_COLUMNS と同じ）。 */
const price = (symbolId, date, close) =>
  [symbolId, date, close, close, close, close, 1000, close * 1000, 1];

test('backfill — 生成した SQL が実スキーマにそのまま通る', async () => {
  const { DatabaseSync } = await import('node:sqlite');

  const master = new Map([
    ['JP.72030', { code: '72030', name: 'トヨタ自動車', sector33: '輸送用機器', sector17: '自動車・輸送機' }],
  ]);
  // **JP.99990 は master に無い。** 期間の途中で上場廃止になった銘柄。
  // 価格はあるので symbols にも行が要る（無いと FK で落ちる）。
  const seen = new Map([['JP.72030', '72030'], ['JP.99990', '99990']]);

  const sql = assembleBackfill({
    from: '2026-09-01',
    to: '2026-09-02',
    tradingDays: ['2026-09-01', '2026-09-02'],
    seen,
    master,
    priceStatements: [
      ...priceInsertStatements([price('JP.72030', '2026-09-01', 3000), price('JP.99990', '2026-09-01', 500)]),
      ...priceInsertStatements([price('JP.72030', '2026-09-02', 3050)]),
    ],
    now: '2026-09-05T00:00:00.000Z',
  }).join('\n');

  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../../../migrations/0001_init.sql', import.meta.url), 'utf8'));
  // **symbols を手で入れない。** 生成物だけで通ることを見る。
  db.exec(sql);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prices_daily').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_calendar').get().n, 2);

  const toyota = db.prepare("SELECT name, sector33 FROM symbols WHERE symbol_id = 'JP.72030'").get();
  assert.equal(toyota.name, 'トヨタ自動車', 'master の名前を使っていない');
  assert.equal(toyota.sector33, '輸送用機器');

  // master に無い銘柄も行があり、名前はコードで埋まっている
  const gone = db.prepare("SELECT name, delisted_at FROM symbols WHERE symbol_id = 'JP.99990'").get();
  assert.equal(gone.name, '99990', 'master に無い銘柄の行が無い / 名前が空');
  assert.equal(gone.delisted_at, null, '廃止を推測で埋めている');
});

test('backfill — symbols の INSERT は prices_daily より前', () => {
  // 逆になると FOREIGN KEY constraint failed。連番ファイルに切るのは
  // このあとなので、ここでの並びがそのまま適用順になる。
  const sql = assembleBackfill({
    from: '2026-09-01', to: '2026-09-01',
    tradingDays: ['2026-09-01'],
    seen: new Map([['JP.72030', '72030']]),
    master: new Map(),
    priceStatements: priceInsertStatements([price('JP.72030', '2026-09-01', 3000)]),
    now: '2026-09-05T00:00:00.000Z',
  });
  const text = sql.join('\n');
  const symbolsAt = text.indexOf('INSERT INTO symbols');
  const pricesAt = text.indexOf('INSERT INTO prices_daily');
  const calendarAt = text.indexOf('INSERT INTO market_calendar');
  assert.ok(symbolsAt > 0 && pricesAt > 0 && calendarAt > 0, '3 つとも出ていない');
  assert.ok(calendarAt < symbolsAt, 'market_calendar が symbols より後');
  assert.ok(symbolsAt < pricesAt, 'symbols が prices_daily より後 — FK で落ちる');
});
