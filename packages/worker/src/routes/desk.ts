import type { Env } from '../types.js';
import { isAccessConfigured } from '../auth.js';
import { layout } from '../ui/layout.js';
import { deskPage, type QuoteView } from '../ui/desk.js';
import { latestQuotes } from '../db/queries.js';

/**
 * デスク画面。GOOGLEFINANCE から取り込んだ現在値を出す。
 *
 * **J-Quants のデータを 1 行も使わない。** スコアも指標も出さない。
 * 混ぜると、20 分遅延で対応範囲も公表されていないデータが
 * 「毎日おなじ計算を回す」土台に紛れ込む（migrations/0003_quotes.sql）。
 */

/** 取り込みが止まっているとみなす時間。 */
const STALE_HOURS = 36;

export async function handleDesk(env: Env, now = new Date()): Promise<Response> {
  const rows = await latestQuotes(env.INVEST_DB);
  const quotes: QuoteView[] = rows.map((r) => ({
    symbolId: r.symbol_id,
    market: r.market,
    code: r.code,
    name: r.name,
    price: r.price,
    currency: r.currency,
    asOf: r.as_of,
  }));

  const asOf = quotes.reduce<string | null>(
    (max, q) => (max === null || q.asOf > max ? q.asOf : max),
    null,
  );
  const stale =
    asOf !== null && now.getTime() - Date.parse(asOf) > STALE_HOURS * 3600 * 1000;

  return new Response(
    layout({
      title: 'デスク',
      siteName: env.SITE_SHORT_NAME,
      body: deskPage({ quotes, asOf, stale }),
      accessWarning: !isAccessConfigured(env),
      activeNav: 'desk',
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}
