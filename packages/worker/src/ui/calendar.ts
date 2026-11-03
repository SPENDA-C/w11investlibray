import { escapeHtml } from './format.js';

/**
 * 決算発表カレンダー。LP のトップに出す。
 *
 * **JavaScript を 1 行も使わない。** LP の CSP は `script-src 'none'`
 * （CLAUDE.md）。月の移動はリンク（`?m=2026-12`）で、描画は CSS Grid。
 *
 * **外部への通信も増やさない。** 値は D1 から取って server-render する。
 */

export interface EarningsEntry {
  readonly symbolId: string;
  readonly code: string;
  readonly name: string;
  readonly announceDate: string;
  /** 'before' | 'after' | 'during' | null。分からなければ null のまま。 */
  readonly session: string | null;
}

export interface MonthCell {
  /** `YYYY-MM-DD`。前後の月の余白は null。 */
  readonly date: string | null;
  readonly entries: readonly EarningsEntry[];
}

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'] as const;

/** `YYYY-MM` を受けて妥当なら返す。おかしければ null。 */
export function parseMonth(raw: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(raw.trim());
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isInteger(year) || year < 1970 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

/** `YYYY-MM` 形式に戻す。 */
export function formatMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** 月を n だけ動かす。年をまたぐ。 */
export function shiftMonth(year: number, month: number, by: number): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + by;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

/**
 * 月曜はじまりの升目を作る。
 *
 * **先頭と末尾の余白を `null` で埋める。** 埋めないと曜日の列がずれる。
 * `Date` は UTC で組み立てる。ローカル時刻で組むと、動かす環境の
 * タイムゾーン次第で 1 日ずれる（Workers は UTC だが、テストは違いうる）。
 */
export function monthGrid(
  year: number,
  month: number,
  entries: readonly EarningsEntry[],
): MonthCell[] {
  const byDate = new Map<string, EarningsEntry[]>();
  for (const e of entries) {
    const list = byDate.get(e.announceDate);
    if (list === undefined) byDate.set(e.announceDate, [e]);
    else list.push(e);
  }

  const first = new Date(Date.UTC(year, month - 1, 1));
  // getUTCDay は日曜が 0。月曜はじまりにするため 1 ずらす。
  const lead = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells: MonthCell[] = [];
  for (let i = 0; i < lead; i += 1) cells.push({ date: null, entries: [] });
  for (let d = 1; d <= daysInMonth; d += 1) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ date, entries: byDate.get(date) ?? [] });
  }
  // 末尾を 7 の倍数まで埋める。
  while (cells.length % 7 !== 0) cells.push({ date: null, entries: [] });
  return cells;
}

const SESSION_LABEL: Readonly<Record<string, string>> = {
  before: '寄前',
  after: '引後',
  during: '場中',
};

/**
 * カレンダー 1 枚ぶんの HTML。
 *
 * `basePath` は LP のリンク接頭辞（ローカルでは `/lp`）。
 */
export function calendarSection(o: {
  readonly title: string;
  readonly year: number;
  readonly month: number;
  readonly entries: readonly EarningsEntry[];
  readonly basePath: string;
  readonly anchor: string;
  /** 取り込みが無いときに出す一言。 */
  readonly emptyNote: string;
  /** 読み込みが上限に達したか。**件数を断定しないため。** */
  readonly truncated?: boolean;
}): string {
  const cells = monthGrid(o.year, o.month, o.entries);
  const prev = shiftMonth(o.year, o.month, -1);
  const next = shiftMonth(o.year, o.month, 1);
  const link = (y: number, m: number) =>
    `${o.basePath}/?${o.anchor}=${formatMonth(y, m)}#${o.anchor}`;

  const head = WEEKDAYS.map(
    (w, i) =>
      `<div class="cal-h${i >= 5 ? ' cal-we' : ''}">${w}</div>`,
  ).join('');

  const body = cells
    .map((c) => {
      if (c.date === null) return '<div class="cal-c cal-pad"></div>';
      const day = Number(c.date.slice(8, 10));
      const items = c.entries
        .slice(0, 4)
        .map((e) => {
          const s = e.session === null ? '' : SESSION_LABEL[e.session] ?? '';
          return `<li><span class="cal-code">${escapeHtml(e.code)}</span>${
            s === '' ? '' : `<span class="cal-s">${escapeHtml(s)}</span>`
          }<span class="cal-nm">${escapeHtml(e.name)}</span></li>`;
        })
        .join('');
      const more = c.entries.length > 4 ? `<li class="cal-more">ほか ${c.entries.length - 4} 件</li>` : '';
      return `<div class="cal-c${c.entries.length > 0 ? ' cal-on' : ''}">
  <span class="cal-d">${day}</span>
  ${items === '' && more === '' ? '' : `<ul class="cal-l">${items}${more}</ul>`}
</div>`;
    })
    .join('\n');

  const total = o.entries.length;

  return `<section class="band cal-band" id="${o.anchor}">
  <div class="container">
    <div class="cal-head">
      <h2 class="section-title">${escapeHtml(o.title)}</h2>
      <nav class="cal-nav">
        <a href="${link(prev.year, prev.month)}" rel="nofollow">&larr; ${prev.year}年${prev.month}月</a>
        <strong>${o.year}年${o.month}月</strong>
        <a href="${link(next.year, next.month)}" rel="nofollow">${next.year}年${next.month}月 &rarr;</a>
      </nav>
    </div>
    ${
      total === 0
        ? `<p class="cal-empty">${escapeHtml(o.emptyNote)}</p>`
        : `<div class="cal-grid">${head}${body}</div>
    <p class="cal-note">${
      o.truncated === true
        ? `この月の発表予定 ${total} 件以上（表示できる上限に達しています）。`
        : `この月の発表予定 ${total} 件。`
    }<strong>予定は変更されることがあります。</strong>確定情報は各社の開示をご確認ください。</p>`
    }
  </div>
</section>`;
}

/** カレンダーの CSS。`ui/lp.ts` の <style> に差し込む。 */
export const CALENDAR_CSS = `
.cal-band { padding-top: 3rem; }
.cal-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .75rem; margin-bottom: 1rem; }
.cal-nav { display: flex; align-items: center; gap: .9rem; font-size: .9rem; }
.cal-nav a { color: var(--accent); text-decoration: none; }
.cal-nav a:hover { text-decoration: underline; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.cal-h { background: var(--ground); padding: .45rem 0; text-align: center; font-size: .8rem; font-weight: 700; }
.cal-we { color: var(--muted); }
.cal-c { background: var(--bg); min-height: 92px; padding: .35rem .4rem; }
.cal-pad { background: var(--ground); }
.cal-on { background: var(--bg); }
.cal-d { font-size: .78rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.cal-l { list-style: none; margin: .25rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; }
.cal-l li { font-size: .72rem; line-height: 1.3; display: flex; gap: .3rem; align-items: baseline; }
.cal-code { font-weight: 700; font-variant-numeric: tabular-nums; }
.cal-s { font-size: .64rem; padding: 0 .25rem; border-radius: 3px; background: var(--ground); color: var(--muted); }
.cal-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cal-more { color: var(--muted); }
.cal-empty, .cal-note { margin-top: .9rem; font-size: .86rem; color: var(--muted); }
@media (max-width: 720px) {
  .cal-c { min-height: 62px; }
  .cal-nm { display: none; }
}
`;
