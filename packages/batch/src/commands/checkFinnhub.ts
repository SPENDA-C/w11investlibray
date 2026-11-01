import { Finnhub, CANDIDATE_EARNINGS_PATH, finnhubHint } from '../finnhub.js';
import { reasonFrom } from './check.js';

/**
 * Finnhub が実際に何を返すかを表示する。
 *
 * **これの出力が、決算カレンダーを繋ぐ唯一の根拠になる。**
 * 経路も項目名も、ここで通ったものだけを `docs/DATA-SOURCES.md` に
 * 日付つきで記録してからコードに書く。
 *
 * `check:datasource`（J-Quants 用）と同じ考え方。違うのは、
 * **日本株が取れるかどうかもここで決まる**こと。取れなければ
 * 日本株は別のソースを探すことになる。
 */

/** 配列でも `{earningsCalendar: [...]}` でも、中の配列を取り出す。 */
export function rowsOf(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body === null || typeof body !== 'object') return [];
  for (const v of Object.values(body as Record<string, unknown>)) {
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}

/** 1 本ぶんの確認結果を出す。戻り値は「取れたか」。 */
async function probeOne(
  client: Finnhub,
  label: string,
  path: string,
  params: Record<string, string>,
): Promise<boolean> {
  const { status, body } = await client.probe(path, params);
  const q = Object.entries(params)
    .filter(([k]) => k !== 'token')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const shown = q === '' ? path : `${path}?${q}`;

  if (status !== 200) {
    console.log(`✗ ${label.padEnd(10)} ${shown}  HTTP ${status}`);
    const reason = reasonFrom(body);
    if (reason !== '') console.log(`    → ${reason}`);
    const hint = finnhubHint(status, body);
    if (hint !== '') console.log(hint);
    return false;
  }

  const rows = rowsOf(body);
  console.log(`✓ ${label.padEnd(10)} ${shown}  ${rows.length} 件`);
  const first = rows[0];
  if (first !== undefined) {
    console.log(`    実際の項目名: ${Object.keys(first).join(', ')}`);
    // 1 件まるごと見せる。**日付の書式と、銘柄コードの綴りが要点。**
    // 日本株なら 7203.T のような接尾辞が付くはずで、その形を見ないと
    // symbol_id への対応づけが書けない。
    console.log(`    1 件目: ${JSON.stringify(first).slice(0, 300)}`);
  } else {
    console.log('    200 だが 0 件。期間か銘柄の指定を変えて試す');
  }
  return rows.length > 0;
}

export async function runCheckFinnhub(o: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly from: string;
  readonly to: string;
  /** 既定の候補以外も試したいとき。 */
  readonly paths: readonly string[];
  /** 日本株が取れるか確かめる銘柄（既定 7203.T）。 */
  readonly jpSymbol: string;
}): Promise<number> {
  const client = new Finnhub(o.apiKey, o.baseUrl);
  console.log(`Finnhub 疎通確認  base=${o.baseUrl}  ${o.from} 〜 ${o.to}\n`);

  const paths = o.paths.length > 0 ? o.paths : [CANDIDATE_EARNINGS_PATH];
  let anyOk = false;

  console.log('--- 決算カレンダー（全体）---');
  for (const path of paths) {
    if (await probeOne(client, '全体', path, { from: o.from, to: o.to })) anyOk = true;
  }

  // **日本株が取れるかは、ここで決まる。** 取れなければ日本株は
  // 別のソースを探すことになるので、必ず確かめる。
  console.log('\n--- 日本株が取れるか ---');
  for (const path of paths) {
    await probeOne(client, '日本株', path, { from: o.from, to: o.to, symbol: o.jpSymbol });
  }

  console.log(`
出力の読み方
  - ✓ の「実際の項目名」と「1 件目」を docs/DATA-SOURCES.md に貼ること。
    **これが決算カレンダーを繋ぐ唯一の根拠になる。**
  - 見るべきは 3 つ:
      1. 発表日の項目名と書式（YYYY-MM-DD か、他の形か）
      2. 寄前・引後の別があるか（hour / time など）
      3. **銘柄コードの綴り。** 日本株が 7203.T なのか別の形か
  - 「日本株が取れるか」が 0 件なら、日本株は Finnhub では賄えない。
    そのときは別のソースを探す（決算カレンダーだけ分けることになる）。
  - 経路が違うようなら --path で別の綴りを試す。**推測をコードに書かない。**`);

  return anyOk ? 0 : 1;
}
