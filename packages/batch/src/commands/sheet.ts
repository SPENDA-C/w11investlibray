import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Sheets, parseServiceAccount } from '../sheets.js';
import { insertStatements } from '../sql.js';

/**
 * Google スプレッドシート（GOOGLEFINANCE）から現在値を取り込む。
 *
 * **なぜシートを経由するのか。** GOOGLEFINANCE は表計算の数式で、
 * API が存在しない。シートそのものが取得層になる。Google に
 * 市場データの取得をやらせて、こちらは読むだけ、という構造。
 *
 * **取れなかった行を通さないのが、このコマンドの半分の仕事。**
 * 対応していないティッカーは C 列が `#N/A` になる。これを 0 や欠測として
 * 受けると、**取れていないことが画面から消える。** 必ず弾いて、
 * どの行が駄目かを行番号付きで出す。
 */

/** シートの列。**production とテストで同じものを使う。** */
const COL = { symbolId: 0, gfTicker: 1, price: 2, asOf: 3, currency: 4 } as const;

/** 既定の読み取り範囲。E 列（通貨の上書き）まで含める。 */
export const DEFAULT_RANGE = 'A1:E';

/**
 * 受け付ける市場。**ここに無い名前空間は弾く。**
 * `0001_init.sql` の `symbols.market` と揃えてある。
 */
const MARKET_CURRENCY: Readonly<Record<string, string | null>> = {
  JP: 'JPY',
  US: 'USD',
  // FX と暗号資産は通貨ペアなので、符号の後ろ 3 文字が建値通貨になる
  // （USDJPY なら JPY、BTCUSD なら USD）。
  FX: null,
  CRYPTO: null,
};

export interface SheetRow {
  readonly symbolId: string;
  readonly market: string;
  readonly code: string;
  readonly gfTicker: string;
  readonly price: number;
  readonly currency: string;
}

export interface BadRow {
  /** シート上の行番号（1 始まり・ヘッダ込み）。人がシートを直すのに要る。 */
  readonly line: number;
  readonly symbolId: string;
  readonly gfTicker: string;
  /** C 列の生の文字列。`#N/A` などをそのまま残す。 */
  readonly raw: string;
  readonly why: string;
}

/**
 * `symbol_id` から建値通貨を決める。
 *
 * `US.NVDA` → USD、`JP.72030` → JPY、`FX.USDJPY` → JPY、`CRYPTO.BTCUSD` → USD。
 * 決まらなければ `null`（呼び出し側が E 列を要求する）。
 */
export function currencyFor(symbolId: string): string | null {
  const [market = '', code = ''] = splitSymbolId(symbolId);
  if (!(market in MARKET_CURRENCY)) return null;
  const fixed = MARKET_CURRENCY[market];
  if (fixed !== null && fixed !== undefined) return fixed;
  // 通貨ペア。後ろ 3 文字。
  return /^[A-Z]{6}$/.test(code) ? code.slice(3) : null;
}

function splitSymbolId(symbolId: string): [string, string] | [] {
  const m = /^([A-Z]+)\.([A-Z0-9][A-Z0-9._-]*)$/.exec(symbolId);
  return m === null ? [] : [m[1] as string, m[2] as string];
}

/**
 * 数値として読む。桁区切り・通貨記号・空白は落とす。
 *
 * **`#N/A` や `#ERROR!` は読めない値として扱う**（0 にしない）。
 */
function toPrice(raw: string): number | null {
  const cleaned = raw.replace(/[\s,¥$€£]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** シートの値を、良い行と駄目な行に分ける。ヘッダ（1 行目）は飛ばす。 */
export function parseRows(values: readonly (readonly string[])[]): {
  ok: SheetRow[];
  bad: BadRow[];
} {
  const ok: SheetRow[] = [];
  const bad: BadRow[] = [];

  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] ?? [];
    const line = i + 1;
    const symbolId = (row[COL.symbolId] ?? '').trim().toUpperCase();
    const gfTicker = (row[COL.gfTicker] ?? '').trim();
    const raw = (row[COL.price] ?? '').trim();
    const override = (row[COL.currency] ?? '').trim().toUpperCase();

    // **空行は不良として数えない。** シートの末尾には必ず空行が続く。
    if (symbolId === '' && gfTicker === '' && raw === '') continue;

    const parts = splitSymbolId(symbolId);
    if (parts.length === 0 || !(parts[0] in MARKET_CURRENCY)) {
      bad.push({
        line,
        symbolId,
        gfTicker,
        raw,
        why: `symbol_id の形が違う（${Object.keys(MARKET_CURRENCY).join(' / ')} のどれかで始める）`,
      });
      continue;
    }
    if (gfTicker === '') {
      bad.push({ line, symbolId, gfTicker, raw, why: 'B 列（gf_ticker）が空' });
      continue;
    }

    const price = toPrice(raw);
    if (price === null) {
      bad.push({
        line,
        symbolId,
        gfTicker,
        raw,
        why: raw === '' ? 'C 列が空（数式が入っていない）' : 'GOOGLEFINANCE が値を返していない',
      });
      continue;
    }

    const currency = override !== '' ? override : currencyFor(symbolId);
    if (currency === null) {
      bad.push({ line, symbolId, gfTicker, raw, why: '通貨が決まらない。E 列に書く' });
      continue;
    }

    const [market, code] = parts as [string, string];
    ok.push({ symbolId, market, code, gfTicker, price, currency });
  }

  return { ok, bad };
}

/**
 * D 列の時刻を解釈する。
 *
 * **ここがいちばんずれやすい。** Sheets API は既定で表示文字列を返すので、
 * `=NOW()` の見た目はシートの書式とタイムゾーンで変わる。書式によっては
 * シリアル値（1899-12-30 からの日数）で返り、**黙って受けると何年もずれる。**
 * だから数値に見えるものは受け取らず、`=TEXT(NOW(),…)` を使えと言う。
 *
 * タイムゾーンは推測しない。`offset`（`+09:00` など）で明示する。
 */
export function parseSheetTimestamp(text: string, offset: string): string {
  const t = text.trim();
  if (t === '') {
    throw new Error(
      'D 列（as_of）が空。シートに =TEXT(NOW(),"yyyy-mm-dd hh:mm:ss") を入れること。\n' +
        '  これが無いと、値がいつのものか分からない。',
    );
  }
  if (/^\d+(\.\d+)?$/.test(t)) {
    throw new Error(
      `D 列がシリアル値で返っている（${t}）。\n` +
        '  =NOW() をそのまま置くとこうなる。=TEXT(NOW(),"yyyy-mm-dd hh:mm:ss") に直すこと。\n' +
        '  数値のまま日付として解釈すると何年もずれるので、ここでは受け取らない。',
    );
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m === null) {
    throw new Error(
      `D 列の時刻が読めない（${t}）。\n` +
        '  =TEXT(NOW(),"yyyy-mm-dd hh:mm:ss") の形にすること。',
    );
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${offset}`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`D 列の時刻が読めない（${t} / オフセット ${offset}）`);
  return new Date(ms).toISOString();
}

/**
 * 古すぎる値か。
 *
 * **GOOGLEFINANCE はシートが再計算されないと止まる。** そのまま取り込み続けると
 * 画面には数字が並んだまま中身が凍る——Cron が 1 か月静かに落ちていたのと同じ形。
 */
export function isStale(asOf: string, now: string, maxAgeHours: number): boolean {
  return Date.parse(now) - Date.parse(asOf) > maxAgeHours * 3600 * 1000;
}

/** `symbols` の INSERT。**名前は分からないのでコードで埋める**（backfill と同じ方針）。 */
export function symbolStatements(rows: readonly SheetRow[], now: string): string[] {
  const seen = new Map<string, SheetRow>();
  for (const r of rows) if (!seen.has(r.symbolId)) seen.set(r.symbolId, r);
  const values = [...seen.values()]
    .sort((a, b) => (a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0))
    .map((r) => [r.symbolId, r.market, r.code, r.code, r.currency, now] as const);
  return insertStatements(
    'symbols',
    ['symbol_id', 'market', 'code', 'name', 'currency', 'updated_at'],
    values,
    { conflictTarget: 'symbol_id' },
  );
}

/** `quotes_snapshot` の INSERT。 */
export function quoteStatements(
  rows: readonly SheetRow[],
  asOf: string,
  fetchedAt: string,
): string[] {
  const values = rows.map(
    (r) => [r.symbolId, asOf, r.price, r.currency, 'googlefinance', fetchedAt] as const,
  );
  return insertStatements(
    'quotes_snapshot',
    ['symbol_id', 'as_of', 'price', 'currency', 'source', 'fetched_at'],
    values,
    { conflictTarget: 'symbol_id, as_of' },
  );
}

/**
 * 流し込む .sql を組み立てる。
 *
 * **順序が意味を持つ。** `quotes_snapshot` は `symbols` を参照しているので
 * （`migrations/0003_quotes.sql`）、逆に流すと
 * `FOREIGN KEY constraint failed` で落ちる。
 */
export function assembleSheetSync(input: {
  readonly rows: readonly SheetRow[];
  readonly asOf: string;
  readonly fetchedAt: string;
}): string[] {
  return [
    `-- GOOGLEFINANCE 取り込み  as_of=${input.asOf}  rows=${input.rows.length}`,
    `-- 生成: ${input.fetchedAt}`,
    ...symbolStatements(input.rows, input.fetchedAt),
    ...quoteStatements(input.rows, input.asOf, input.fetchedAt),
  ];
}

interface SheetOptions {
  readonly serviceAccountJson: string;
  readonly sheetId: string;
  readonly range: string;
  readonly tzOffset: string;
}

async function read(o: SheetOptions): Promise<string[][]> {
  const sheets = new Sheets(parseServiceAccount(o.serviceAccountJson));
  return sheets.values(o.sheetId, o.range);
}

/**
 * 疎通と中身の確認。**実物が何を返したかをそのまま表示する。**
 *
 * 金・銀や暗号資産で何が取れるかは、推測ではなくこの出力で決める。
 * 通ったティッカーを `docs/DATA-SOURCES.md` に日付付きで記録すること。
 */
export async function runCheckSheet(o: SheetOptions): Promise<number> {
  console.log(`シート確認  id=${o.sheetId}  range=${o.range}  tz=${o.tzOffset}\n`);
  const values = await read(o);
  if (values.length === 0) {
    console.error('値が 1 行も返らなかった。範囲名かシートの中身を確認する。');
    return 1;
  }

  const { ok, bad } = parseRows(values);
  for (const r of ok) {
    console.log(`✓ ${r.symbolId.padEnd(16)} ${r.gfTicker.padEnd(20)} ${r.price} ${r.currency}`);
  }
  for (const r of bad) {
    console.log(`✗ ${r.symbolId.padEnd(16)} ${r.gfTicker.padEnd(20)} ${r.raw || '(空)'}`);
    console.log(`    行 ${r.line}: ${r.why}`);
  }

  console.log(`\n取れた ${ok.length} / 取れなかった ${bad.length}`);

  // 時刻は失敗しても止めない。check は「見るためのコマンド」なので、
  // 時刻が読めないことも含めて表示して終わる。
  const asOfRaw = values[1]?.[COL.asOf] ?? '';
  try {
    const asOf = parseSheetTimestamp(asOfRaw, o.tzOffset);
    const now = new Date().toISOString();
    console.log(`as_of  ${asOf}（${o.tzOffset} として解釈）`);
    if (isStale(asOf, now, 24)) {
      console.log('  ⚠ 24 時間より古い。シートが再計算されていない可能性がある。');
    }
  } catch (err) {
    console.log(`as_of  読めない: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`
出力の読み方
  - ✗ の行は **取り込まない。** 0 や欠測として通すと、取れていないことが画面から消える
  - 取れなかったティッカーは別の書き方を試す（例: 金・銀は現物ではなく ETF の
    NYSEARCA:GLD / NYSEARCA:SLV）
  - 通った組み合わせを docs/DATA-SOURCES.md の §5 に日付付きで記録すること`);

  return bad.length === 0 ? 0 : 1;
}

/** 取り込み。D1 へ流し込む .sql を書き出す。 */
export async function runSheetSync(
  o: SheetOptions & { readonly out: string; readonly maxAgeHours: number },
): Promise<number> {
  const values = await read(o);
  const { ok, bad } = parseRows(values);

  // **取れなかった行があっても止めない。** 1 銘柄の都合で全部が止まるほうが困る。
  // ただし黙って捨てない。
  for (const r of bad) {
    console.error(`取り込まない  行 ${r.line}  ${r.symbolId || '(空)'}  ${r.raw || '(空)'}  ${r.why}`);
  }
  if (ok.length === 0) {
    console.error('取り込める行が 1 つも無い。');
    return 1;
  }

  const asOf = parseSheetTimestamp(values[1]?.[COL.asOf] ?? '', o.tzOffset);
  const now = new Date().toISOString();
  if (isStale(asOf, now, o.maxAgeHours)) {
    // **ここで止めるのが大事。** 古い値を入れ続けると、画面には数字が
    // 並んだまま中身が凍る。落ちていることが見えるほうがいい。
    console.error(
      `シートの as_of が古い（${asOf}）。${o.maxAgeHours} 時間より前。\n` +
        '  シートを開いて再計算させるか、--max-age-hours を見直す。\n' +
        '  古い値をそのまま取り込まないために、ここで止めている。',
    );
    return 1;
  }

  const sql = assembleSheetSync({ rows: ok, asOf, fetchedAt: now }).join('\n\n');
  await mkdir(dirname(o.out), { recursive: true });
  await writeFile(o.out, `${sql}\n`, 'utf8');

  console.log(`${ok.length} 行を書き出した: ${o.out}`);
  console.log(`as_of ${asOf}`);
  console.log(`
流し込む:
  cd packages/worker
  npx wrangler d1 execute invest-db --remote --env production --file=../../${o.out}`);
  return 0;
}
