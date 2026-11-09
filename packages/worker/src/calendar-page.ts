import type { Env } from './types.js';
import { parseMonth, formatMonth, calendarSection, type EarningsEntry } from './ui/calendar.js';
import { earningsForMonth, hasEarnings, MONTH_ROW_CAP } from './db/queries.js';

/**
 * 決算カレンダーの組み立て。**D1 から材料を取って HTML にするところまで。**
 *
 * もとは `routes/lp.ts` にあったが、**カレンダーは LP のトップから外した**
 * （出し先は別サイトの「最新記事」の位置）。LP のルーティングに
 * 市場データを読む経路を残しておく理由が無いので、ここに切り出した。
 *
 * **持ち出しやすさのために 1 枚にまとめてある。** 別のリポジトリへ
 * 移すときに要るのはこのファイルと `ui/calendar.ts`、
 * それに `db/queries.ts` の `earningsForMonth` / `hasEarnings` だけ。
 */

/** カレンダー 1 枚ぶんの材料。 */
export interface CalendarData {
  readonly year: number;
  readonly month: number;
  readonly entries: EarningsEntry[];
  /**
   * その市場の予定が 1 件でもあるか。
   * **空のカレンダーを出さないための判定。**
   * 当月が空なだけなら枠は出す（翌月に送れないと困る）。
   */
  readonly any: boolean;
  /** 上限に達したか。**切り捨てた数を本当の件数として出さないため。** */
  readonly truncated: boolean;
}

/**
 * 日本株と米国株、2 枚ぶんの材料を集める。
 *
 * 月はクエリ（`?cal-jp=2026-12`）で動かす。**壊れた値は既定の月に倒す。**
 * ここで例外を投げると、カレンダーのせいでページごと落ちる。
 */
export async function earningsCalendars(
  env: Env,
  url: URL,
  now = new Date(),
): Promise<{ jp: CalendarData; us: CalendarData; today: string }> {
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const today = now.toISOString().slice(0, 10);

  const pick = async (anchor: string, market: string): Promise<CalendarData> => {
    const asked = parseMonth(url.searchParams.get(anchor) ?? '');
    const { year, month } = asked ?? current;
    const [rows, any] = await Promise.all([
      earningsForMonth(env.INVEST_DB, market, formatMonth(year, month)),
      hasEarnings(env.INVEST_DB, market),
    ]);
    return {
      year,
      month,
      any,
      truncated: rows.length >= MONTH_ROW_CAP,
      entries: rows.map((r) => ({
        symbolId: r.symbol_id,
        code: r.code,
        name: r.name,
        announceDate: r.announce_date,
        session: r.session,
      })),
    };
  };

  return { jp: await pick('cal-jp', 'JP'), us: await pick('cal-us', 'US'), today };
}

const EMPTY_NOTE =
  'この月の発表予定はまだ取り込まれていません。取り込みが済むと、ここに銘柄が並びます。';

/** 2 枚ぶんの HTML を組み立てる。 */
export function renderCalendars(
  data: { jp: CalendarData; us: CalendarData; today?: string },
  basePath: string,
): { jp: string; us: string } {
  // **1 件も無い市場は、枠ごと出さない。** 空の升目を並べても何も伝わらない。
  // 取り込みが始まれば自動的に現れる。
  const one = (d: CalendarData, title: string, anchor: string) =>
    d.any
      ? calendarSection({
          title,
          ...d,
          basePath,
          anchor,
          emptyNote: EMPTY_NOTE,
          truncated: d.truncated,
          ...(data.today === undefined ? {} : { today: data.today }),
        })
      : '';
  return {
    jp: one(data.jp, '日本株 決算発表カレンダー', 'cal-jp'),
    us: one(data.us, '米国株（Nasdaq）決算発表カレンダー', 'cal-us'),
  };
}
