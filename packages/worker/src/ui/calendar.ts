import { escapeHtml } from './format.js';

/**
 * 決算発表カレンダー。LP のトップに出す。
 *
 * **JavaScript を 1 行も使わない。** LP の CSP は `script-src 'none'`
 * （CLAUDE.md）。月の移動はリンク（`?cal-us=2026-12`）で、描画は CSS Grid。
 *
 * **外部への通信も増やさない。** 値は D1 から取って server-render する。
 *
 * **色はここで書かない。** `tokens.ts` の `CALENDAR_TOKENS` が唯一の定義。
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

/**
 * **日曜はじまり。** 参照しているカレンダー（および国内の一般的な
 * 月表示）に合わせてある。`monthGrid` の先頭余白の計算と**必ず一致**させること。
 */
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

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
 * 日曜はじまりの升目を作る。
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
  // getUTCDay は日曜が 0。日曜はじまりなので、そのまま使える。
  const lead = first.getUTCDay();
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

/**
 * 発表の時間帯。**これが唯一の分類。**
 *
 * 「最低限の分類」として、いま根拠のあるものだけを出す。
 * 業種やテーマで色を分けたくなるが、そのデータを持っていない。
 */
const SESSIONS = [
  { key: 'before', label: '寄前', cls: 'before' },
  { key: 'during', label: '場中', cls: 'during' },
  { key: 'after', label: '引後', cls: 'after' },
  { key: 'none', label: '時間未定', cls: 'none' },
] as const;

/** `session` の値を凡例のキーに寄せる。知らない綴りは「時間未定」に倒す。 */
export function sessionKey(session: string | null): string {
  if (session === null) return 'none';
  return SESSIONS.some((s) => s.key === session) && session !== 'none' ? session : 'none';
}

/**
 * その月に実際に出てくる時間帯だけを凡例にする。
 *
 * **固定の 4 つを並べない。** 1 件も無い区分を凡例に出すと、
 * 「あるのに表示されていない」と読めてしまう。
 */
export function legendKeys(entries: readonly EarningsEntry[]): string[] {
  const seen = new Set(entries.map((e) => sessionKey(e.session)));
  return SESSIONS.filter((s) => seen.has(s.key)).map((s) => s.key);
}

function sessionLabel(key: string): string {
  return SESSIONS.find((s) => s.key === key)?.label ?? '時間未定';
}

/** 1 つの升目に出す最大件数。これを超えたぶんは「ほか N 件」にまとめる。 */
const PER_CELL = 4;

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
  /** 今日（`YYYY-MM-DD`）。別の月なら単に一致しないだけ。 */
  readonly today?: string;
}): string {
  const cells = monthGrid(o.year, o.month, o.entries);
  const prev = shiftMonth(o.year, o.month, -1);
  const next = shiftMonth(o.year, o.month, 1);
  const link = (y: number, m: number) =>
    `${o.basePath}/?${o.anchor}=${formatMonth(y, m)}#${o.anchor}`;

  // 曜日の色は列の位置で決まる。0 = 日曜、6 = 土曜。
  const dow = (i: number) => (i % 7 === 0 ? ' cal-sun' : i % 7 === 6 ? ' cal-sat' : '');

  const head = WEEKDAYS.map((w, i) => `<div class="cal-h${dow(i)}">${w}</div>`).join('');

  const body = cells
    .map((c, i) => {
      if (c.date === null) return `<div class="cal-c cal-pad${dow(i)}"></div>`;
      const day = Number(c.date.slice(8, 10));
      const n = c.entries.length;
      const items = c.entries
        .slice(0, PER_CELL)
        .map((e) => {
          const key = sessionKey(e.session);
          return `<li class="cal-p cal-p-${key}" title="${escapeHtml(
            `${e.name}（${sessionLabel(key)}）`,
          )}"><span class="cal-code">${escapeHtml(e.code)}</span><span class="cal-nm">${escapeHtml(
            e.name,
          )}</span></li>`;
        })
        .join('');
      const more = n > PER_CELL ? `<li class="cal-more">ほか ${n - PER_CELL} 件</li>` : '';
      const today = o.today === c.date ? ' cal-today' : '';
      return `<div class="cal-c${n > 0 ? ' cal-on' : ''}${dow(i)}${today}">
  <div class="cal-top"><span class="cal-d">${day}</span>${
    n > 0 ? `<span class="cal-n">${n}</span>` : ''
  }</div>
  ${items === '' ? '' : `<ul class="cal-l">${items}${more}</ul>`}
</div>`;
    })
    .join('\n');

  const total = o.entries.length;
  const legend = legendKeys(o.entries)
    .map(
      (k) =>
        `<li><span class="cal-key cal-p-${k}" aria-hidden="true"></span>${escapeHtml(
          sessionLabel(k),
        )}</li>`,
    )
    .join('');

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
        : `${legend === '' ? '' : `<ul class="cal-legend">${legend}</ul>`}
    <div class="cal-grid">${head}${body}</div>
    <p class="cal-note">${
      o.truncated === true
        ? `この月の発表予定 ${total} 件以上（表示できる上限に達しています）。`
        : `この月の発表予定 ${total} 件。`
    }<strong>予定は変更されることがあります。</strong>確定情報は各社の開示をご確認ください。</p>`
    }
  </div>
</section>`;
}

/**
 * カレンダーの CSS。`ui/lp.ts` の <style> に差し込む。
 *
 * **色の値をここに書かない。** すべて `CALENDAR_TOKENS` か `BRAND` の
 * `var()` 参照にしてある（`test/tokens.test.mjs` が検査している）。
 */
export const CALENDAR_CSS = `
.cal-band { padding-top: 3rem; }
.cal-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .75rem; margin-bottom: .9rem; }
.cal-nav { display: flex; align-items: center; gap: .9rem; font-size: .9rem; }
.cal-nav a { color: var(--brand-accent); text-decoration: none; }
.cal-nav a:hover { text-decoration: underline; }

.cal-legend { display: flex; flex-wrap: wrap; gap: .4rem .9rem; list-style: none; margin: 0 0 .7rem; padding: 0; font-size: .76rem; color: var(--brand-text-light); }
.cal-legend li { display: flex; align-items: center; gap: .3rem; }
/* 地の色だけだと「寄前」の水色が薄すぎて凡例で見えない。
   currentColor は cal-p-* が決める文字色を拾う（新しい色を増やさない）。 */
.cal-key { width: .72rem; height: .72rem; border-radius: 3px; display: inline-block; border: 1px solid currentColor; }

.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; }
.cal-h { padding: .3rem 0 .45rem; text-align: center; font-size: .78rem; font-weight: 700; color: var(--brand-text-light); }
.cal-h.cal-sun { color: var(--cal-sun); }
.cal-h.cal-sat { color: var(--cal-sat); }

.cal-c { background: var(--brand-surface); border: 1px solid var(--line); border-radius: 8px; min-height: 96px; padding: .3rem .35rem .4rem; }
.cal-c.cal-sun { background: var(--cal-sun-bg); }
.cal-c.cal-sat { background: var(--cal-sat-bg); }
.cal-pad { background: var(--brand-ground); border-color: transparent; }
.cal-today { border-color: var(--brand-accent); box-shadow: 0 0 0 1px var(--brand-accent); }

.cal-top { display: flex; align-items: center; justify-content: space-between; gap: .25rem; }
.cal-d { font-size: .8rem; font-weight: 700; color: var(--brand-text); font-variant-numeric: tabular-nums; }
.cal-c.cal-sun .cal-d { color: var(--cal-sun); }
.cal-c.cal-sat .cal-d { color: var(--cal-sat); }
.cal-n { font-size: .64rem; font-weight: 700; line-height: 1.5; padding: 0 .38rem; border-radius: 999px; background: var(--brand-primary); color: var(--brand-surface); font-variant-numeric: tabular-nums; }

.cal-l { list-style: none; margin: .3rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .18rem; }
.cal-p { display: flex; gap: .3rem; align-items: baseline; font-size: .7rem; line-height: 1.4; padding: .05rem .3rem; border-radius: 4px; overflow: hidden; }
.cal-p-before { background: var(--cal-before-bg); color: var(--cal-before-ink); }
.cal-p-during { background: var(--cal-during-bg); color: var(--cal-during-ink); }
.cal-p-after { background: var(--cal-after-bg); color: var(--cal-after-ink); }
.cal-p-none { background: var(--cal-none-bg); color: var(--cal-none-ink); }
.cal-code { font-weight: 700; font-variant-numeric: tabular-nums; flex: none; }
.cal-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cal-more { font-size: .66rem; color: var(--brand-text-light); padding: 0 .3rem; }
.cal-empty, .cal-note { margin-top: .9rem; font-size: .86rem; color: var(--brand-text-light); }

@media (max-width: 720px) {
  .cal-grid { gap: 3px; }
  .cal-c { min-height: 64px; padding: .2rem .22rem .3rem; border-radius: 6px; }
  .cal-nm { display: none; }
  .cal-p { padding: .05rem .2rem; font-size: .64rem; }
  .cal-more { display: none; }
}
`;
