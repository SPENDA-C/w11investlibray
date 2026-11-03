import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Finnhub, finnhubHint } from '../finnhub.js';
import { insertStatements } from '../sql.js';
import { reasonFrom } from './check.js';

/**
 * Finnhub の決算カレンダーを取り込み、D1 用の .sql を書き出す。
 *
 * **項目名は実測（2026-11-03）に基づく。** `check-finnhub` が返したのはこれ:
 *
 *   symbol, date, hour, quarter, year,
 *   epsEstimate, epsActual, revenueEstimate, revenueActual
 *
 * 例: {"symbol":"AI","date":"2026-12-03","hour":"","quarter":2,"year":2027,…}
 *
 * **使うのは最初の 5 つだけ。** 予実（eps / revenue）は決算カレンダーには
 * 要らないし、保存すれば再配信の論点が増える。日付と銘柄に絞る。
 *
 * **米国株のみ。** 日本株（7203.T）は 403 で
 * 「You don't have access to this resource」——契約プランの範囲外だった。
 */

/** `/calendar/earnings` の経路。**実測で通ったもの。** */
export const EARNINGS_PATH = '/calendar/earnings';

export interface EarningsRow {
  readonly symbolId: string;
  readonly code: string;
  readonly announceDate: string;
  readonly session: string | null;
  readonly fiscalPeriod: string | null;
}

export interface SkippedRow {
  readonly raw: string;
  readonly why: string;
}

/**
 * Finnhub の `hour` を `session` に移す。
 *
 * **確かめた値は空文字だけ。** bmo / amc / dmh は Finnhub が使うと
 * されている値だが、この目で見ていない。見ていない綴りを「引け後」と
 * 決めつけると、画面に嘘が出る。**知らない綴りは null にして、
 * 取り込みのたびに集計を出す**（下の `tallyHours`）。
 */
export function toSession(hour: unknown): string | null {
  if (typeof hour !== 'string') return null;
  switch (hour.trim().toLowerCase()) {
    case 'bmo':
      return 'before';
    case 'amc':
      return 'after';
    case 'dmh':
      return 'during';
    default:
      return null;
  }
}

/** 見かけた `hour` の綴りを数える。**未知の値に気付くため。** */
export function tallyHours(rows: readonly Record<string, unknown>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const h = typeof r['hour'] === 'string' ? r['hour'] : '(文字列でない)';
    const key = h === '' ? '(空)' : h;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * API の行を、保存できる形に直す。
 *
 * **読めない行は落とす。** 日付が欠けている行を「今日」で埋めるような
 * ことはしない。カレンダーに嘘の日付が並ぶほうが害が大きい。
 */
export function parseEarnings(
  rows: readonly Record<string, unknown>[],
  market = 'US',
): { ok: EarningsRow[]; skipped: SkippedRow[] } {
  const ok: EarningsRow[] = [];
  const skipped: SkippedRow[] = [];

  for (const r of rows) {
    const symbol = typeof r['symbol'] === 'string' ? r['symbol'].trim().toUpperCase() : '';
    const date = typeof r['date'] === 'string' ? r['date'].trim() : '';

    if (symbol === '') {
      skipped.push({ raw: JSON.stringify(r).slice(0, 120), why: 'symbol が無い' });
      continue;
    }
    if (!DATE.test(date)) {
      skipped.push({ raw: JSON.stringify(r).slice(0, 120), why: `date の形が違う（${date || '空'}）` });
      continue;
    }
    // 名前空間の規則を壊す綴りは入れない（symbols の主キーになる）。
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(symbol)) {
      skipped.push({ raw: JSON.stringify(r).slice(0, 120), why: `symbol の綴りが扱えない（${symbol}）` });
      continue;
    }

    const year = typeof r['year'] === 'number' ? r['year'] : null;
    const quarter = typeof r['quarter'] === 'number' ? r['quarter'] : null;

    ok.push({
      symbolId: `${market}.${symbol}`,
      code: symbol,
      announceDate: date,
      session: toSession(r['hour']),
      fiscalPeriod: year !== null && quarter !== null ? `${year}Q${quarter}` : null,
    });
  }

  return { ok, skipped };
}

/** `symbols` の INSERT。**名前は分からないのでコードで埋める**（backfill と同じ方針）。 */
export function symbolStatements(rows: readonly EarningsRow[], market: string, now: string): string[] {
  const seen = new Map<string, EarningsRow>();
  for (const r of rows) if (!seen.has(r.symbolId)) seen.set(r.symbolId, r);
  const values = [...seen.values()]
    .sort((a, b) => (a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0))
    .map((r) => [r.symbolId, market, r.code, r.code, market === 'JP' ? 'JPY' : 'USD', now] as const);
  return insertStatements(
    'symbols',
    ['symbol_id', 'market', 'code', 'name', 'currency', 'updated_at'],
    values,
    { conflictTarget: 'symbol_id' },
  );
}

/** `earnings_calendar` の INSERT。 */
export function earningsStatements(rows: readonly EarningsRow[], now: string): string[] {
  // 同じ銘柄・同じ日が複数回来ることがある（四半期が跨る境目など）。
  // 主キーは (symbol_id, announce_date, source) なので、先に畳む。
  const seen = new Map<string, EarningsRow>();
  for (const r of rows) {
    const key = `${r.symbolId}\u0000${r.announceDate}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  const values = [...seen.values()].map(
    (r) => [r.symbolId, r.announceDate, r.session, r.fiscalPeriod, 'finnhub', 0, now] as const,
  );
  return insertStatements(
    'earnings_calendar',
    ['symbol_id', 'announce_date', 'session', 'fiscal_period', 'source', 'confirmed', 'fetched_at'],
    values,
    { conflictTarget: 'symbol_id, announce_date, source' },
  );
}

/**
 * 流し込む .sql を組み立てる。
 *
 * **順序が意味を持つ。** `earnings_calendar` は `symbols` を参照している
 * （`migrations/0004_earnings.sql`）ので、逆に流すと
 * `FOREIGN KEY constraint failed` で落ちる。
 */
export function assembleEarnings(input: {
  readonly rows: readonly EarningsRow[];
  readonly market: string;
  readonly from: string;
  readonly to: string;
  readonly now: string;
}): string[] {
  return [
    `-- Finnhub 決算カレンダー  ${input.from} 〜 ${input.to}  ${input.market}  ${input.rows.length} 件`,
    `-- 生成: ${input.now}`,
    ...symbolStatements(input.rows, input.market, input.now),
    ...earningsStatements(input.rows, input.now),
  ];
}

export async function runEarnings(o: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly from: string;
  readonly to: string;
  readonly market: string;
  readonly out: string;
}): Promise<number> {
  const client = new Finnhub(o.apiKey, o.baseUrl);
  console.log(`Finnhub 決算カレンダー  ${o.from} 〜 ${o.to}  market=${o.market}`);

  const { status, body } = await client.probe(EARNINGS_PATH, { from: o.from, to: o.to });
  if (status !== 200) {
    console.error(`✗ ${EARNINGS_PATH} が HTTP ${status}`);
    const reason = reasonFrom(body);
    if (reason !== '') console.error(`    → ${reason}`);
    const hint = finnhubHint(status, body);
    if (hint !== '') console.error(hint);
    return 1;
  }

  const raw = (body as { earningsCalendar?: unknown }).earningsCalendar;
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  if (list.length === 0) {
    // **0 件を成功にしない。** 取れていないのに「終わった」と言うと、
    // 画面が空のまま誰も気付かない。
    console.error('0 件。期間か経路を見直す（応答の形が変わった可能性もある）。');
    console.error(`応答のキー: ${Object.keys(body as object).join(', ')}`);
    return 1;
  }

  // **見かけた hour の綴りを必ず出す。** bmo / amc / dmh を目で
  // 確かめていないので、未知の綴りが来ていないかを毎回見る。
  const hours = [...tallyHours(list).entries()].sort((a, b) => b[1] - a[1]);
  console.log(`hour の内訳: ${hours.map(([h, n]) => `${h}=${n}`).join(', ')}`);

  const { ok, skipped } = parseEarnings(list, o.market);
  for (const s of skipped.slice(0, 20)) console.error(`取り込まない: ${s.why}  ${s.raw}`);
  if (skipped.length > 20) console.error(`…ほか ${skipped.length - 20} 件`);

  if (ok.length === 0) {
    console.error('取り込める行が 1 つも無い。');
    return 1;
  }

  const now = new Date().toISOString();
  const sql = assembleEarnings({ rows: ok, market: o.market, from: o.from, to: o.to, now }).join('\n\n');
  await mkdir(dirname(o.out), { recursive: true });
  await writeFile(o.out, `${sql}\n`, 'utf8');

  console.log(`${ok.length} 件を書き出した（読めなかった ${skipped.length} 件）: ${o.out}`);
  return 0;
}
