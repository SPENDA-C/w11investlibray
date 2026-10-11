import type { Bar, PriceRow, SymbolRow, CalendarRow } from '@invest/core';
import type { RankingRow } from '../types.js';

/**
 * D1 へのアクセスをここに閉じる。
 * SQL がルートや画面に散らばると、インデックスの効き方を追えなくなる。
 */

/** D1 の 1 文あたりのバインド変数上限に対する安全側の値。 */
const MAX_BIND_PER_STATEMENT = 80;

export async function upsertSymbols(db: D1Database, rows: readonly SymbolRow[], now: string): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO symbols (symbol_id, market, code, name, sector33, sector17, currency, delisted_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)
     ON CONFLICT (symbol_id) DO UPDATE SET
       name = excluded.name,
       sector33 = excluded.sector33,
       sector17 = excluded.sector17,
       delisted_at = NULL,
       updated_at = excluded.updated_at`,
  );
  const batch = rows.map((r) =>
    stmt.bind(r.symbolId, r.market, r.code, r.name, r.sector33, r.sector17, r.currency, now),
  );
  await runBatched(db, batch);
  return rows.length;
}

/**
 * 一覧に現れなくなった銘柄へ上場廃止日を立てる。
 * **行を削除しない。** 削除すると過去のバックテストが
 * 「生き残った銘柄だけ」を対象にしてしまう。
 */
export async function markDelisted(
  db: D1Database,
  market: string,
  liveSymbolIds: readonly string[],
  asOf: string,
): Promise<number> {
  if (liveSymbolIds.length === 0) return 0;
  const live = new Set(liveSymbolIds);
  const existing = await db
    .prepare(`SELECT symbol_id FROM symbols WHERE market = ?1 AND delisted_at IS NULL`)
    .bind(market)
    .all<{ symbol_id: string }>();

  const gone = (existing.results ?? []).map((r) => r.symbol_id).filter((id) => !live.has(id));
  if (gone.length === 0) return 0;

  const stmt = db.prepare(`UPDATE symbols SET delisted_at = ?2, updated_at = ?2 WHERE symbol_id = ?1`);
  await runBatched(db, gone.map((id) => stmt.bind(id, asOf)));
  return gone.length;
}

export async function upsertPrices(db: D1Database, rows: readonly PriceRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO prices_daily (symbol_id, date, open, high, low, close, volume, turnover, adjustment_factor)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (symbol_id, date) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume,
       turnover = excluded.turnover,
       adjustment_factor = excluded.adjustment_factor`,
  );
  await runBatched(
    db,
    rows.map((r) =>
      stmt.bind(
        r.symbolId, r.date, r.open, r.high, r.low, r.close, r.volume,
        r.turnover, r.adjustmentFactor,
      ),
    ),
  );
  return rows.length;
}

export async function upsertCalendar(db: D1Database, rows: readonly CalendarRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO market_calendar (market, date, is_open) VALUES (?1, ?2, ?3)
     ON CONFLICT (market, date) DO UPDATE SET is_open = excluded.is_open`,
  );
  await runBatched(db, rows.map((r) => stmt.bind(r.market, r.date, r.isOpen ? 1 : 0)));
  return rows.length;
}

/**
 * 対象ユニバース。売買代金の大きい順に上位を採る。
 * 売買代金が取れないソース（Phase 3 以降の市場）では終値 × 出来高で代用する。
 */
export async function selectUniverse(
  db: D1Database,
  market: string,
  asOf: string,
  limit: number,
): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT p.symbol_id AS symbol_id
       FROM prices_daily p
       JOIN symbols s ON s.symbol_id = p.symbol_id
       WHERE s.market = ?1 AND s.delisted_at IS NULL AND p.date = ?2
       ORDER BY COALESCE(p.turnover, p.close * p.volume) DESC
       LIMIT ?3`,
    )
    .bind(market, asOf, limit)
    .all<{ symbol_id: string }>();
  return (res.results ?? []).map((r) => r.symbol_id);
}

/**
 * 指標計算に必要なぶんだけ過去の足を読む。
 * SMA200 と 52 週高値のために 300 営業日ぶん取る。
 *
 * **銘柄ごとに `lookback` 本ずつ**取る（ウィンドウ関数で区切る）。
 * グループ全体に LIMIT を掛けると、履歴の長い先頭の銘柄が枠を使い切って
 * 後ろの銘柄が 0 件になり、黙って候補から消える。日足が数百本しか無いうちは
 * 表面化せず、10 年ぶんをバックフィルした瞬間に効いてくる。
 */
export async function loadRecentBars(
  db: D1Database,
  symbolIds: readonly string[],
  asOf: string,
  lookback: number,
): Promise<Map<string, PriceRow[]>> {
  const out = new Map<string, PriceRow[]>();
  for (const group of chunkIds(symbolIds, MAX_BIND_PER_STATEMENT)) {
    const placeholders = group.map((_, i) => `?${i + 3}`).join(', ');
    const res = await db
      .prepare(
        `WITH ranked AS (
           SELECT symbol_id, date, open, high, low, close, volume, turnover, adjustment_factor,
                  ROW_NUMBER() OVER (PARTITION BY symbol_id ORDER BY date DESC) AS rn
           FROM prices_daily
           WHERE date <= ?1 AND symbol_id IN (${placeholders})
         )
         SELECT symbol_id, date, open, high, low, close, volume, turnover, adjustment_factor
         FROM ranked
         WHERE rn <= ?2
         ORDER BY symbol_id ASC, date ASC`,
      )
      .bind(asOf, lookback, ...group)
      .all<PriceRowDb>();

    // 昇順で読んでいる。指標は昇順を前提にしているので、ここで並べ替えない。
    for (const row of res.results ?? []) {
      const list = out.get(row.symbol_id) ?? [];
      list.push({
        symbolId: row.symbol_id,
        date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        turnover: row.turnover,
        adjustmentFactor: row.adjustment_factor,
      });
      out.set(row.symbol_id, list);
    }
  }
  return out;
}

interface PriceRowDb {
  symbol_id: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number | null;
  adjustment_factor: number;
}

export interface IndicatorInsert {
  readonly symbolId: string;
  readonly date: string;
  readonly rsi14: number | null;
  readonly macd: number | null;
  readonly macdSignal: number | null;
  readonly macdHist: number | null;
  readonly sma5: number | null;
  readonly sma25: number | null;
  readonly sma75: number | null;
  readonly sma200: number | null;
  readonly atr14: number | null;
  readonly volSma20: number | null;
  readonly volRatio: number | null;
  readonly ret20: number | null;
  readonly ret60: number | null;
  readonly hi52: number | null;
  readonly lo52: number | null;
}

export async function upsertIndicators(db: D1Database, rows: readonly IndicatorInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO indicators_daily
       (symbol_id, date, rsi14, macd, macd_signal, macd_hist, sma5, sma25, sma75, sma200,
        atr14, vol_sma20, vol_ratio, ret20, ret60, hi52, lo52)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
     ON CONFLICT (symbol_id, date) DO UPDATE SET
       rsi14=excluded.rsi14, macd=excluded.macd, macd_signal=excluded.macd_signal,
       macd_hist=excluded.macd_hist, sma5=excluded.sma5, sma25=excluded.sma25,
       sma75=excluded.sma75, sma200=excluded.sma200, atr14=excluded.atr14,
       vol_sma20=excluded.vol_sma20, vol_ratio=excluded.vol_ratio,
       ret20=excluded.ret20, ret60=excluded.ret60, hi52=excluded.hi52, lo52=excluded.lo52`,
  );
  await runBatched(
    db,
    rows.map((r) =>
      stmt.bind(
        r.symbolId, r.date, r.rsi14, r.macd, r.macdSignal, r.macdHist,
        r.sma5, r.sma25, r.sma75, r.sma200, r.atr14, r.volSma20, r.volRatio,
        r.ret20, r.ret60, r.hi52, r.lo52,
      ),
    ),
  );
  return rows.length;
}

export interface SignalInsert {
  readonly symbolId: string;
  readonly date: string;
  readonly signalCode: string;
  readonly strength: number;
  readonly detail: string;
}

export async function upsertSignals(db: D1Database, rows: readonly SignalInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO signals_daily (symbol_id, date, signal_code, strength, detail)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT (symbol_id, date, signal_code) DO UPDATE SET
       strength = excluded.strength, detail = excluded.detail`,
  );
  await runBatched(
    db,
    rows.map((r) => stmt.bind(r.symbolId, r.date, r.signalCode, r.strength, r.detail)),
  );
  return rows.length;
}

export interface ScoreInsert {
  readonly symbolId: string;
  readonly date: string;
  readonly scoreVersion: string;
  readonly total: number | null;
  readonly cTrend: number | null;
  readonly cRsi: number | null;
  readonly cMacd: number | null;
  readonly cMa: number | null;
  readonly cVolume: number | null;
  readonly cMomentum: number | null;
  readonly cFundamental: number | null;
  readonly cNews: number | null;
  readonly verdict: string;
  readonly entryPx: number | null;
  readonly stopPx: number | null;
  readonly targetPx: number | null;
  readonly rr: number | null;
}

export async function upsertScores(db: D1Database, rows: readonly ScoreInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO scores_daily
       (symbol_id, date, score_version, total, c_trend, c_rsi, c_macd, c_ma, c_volume,
        c_momentum, c_fundamental, c_news, verdict, entry_px, stop_px, target_px, rr)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
     ON CONFLICT (symbol_id, date, score_version) DO UPDATE SET
       total=excluded.total, c_trend=excluded.c_trend, c_rsi=excluded.c_rsi,
       c_macd=excluded.c_macd, c_ma=excluded.c_ma, c_volume=excluded.c_volume,
       c_momentum=excluded.c_momentum, c_fundamental=excluded.c_fundamental,
       c_news=excluded.c_news, verdict=excluded.verdict, entry_px=excluded.entry_px,
       stop_px=excluded.stop_px, target_px=excluded.target_px, rr=excluded.rr`,
  );
  await runBatched(
    db,
    rows.map((r) =>
      stmt.bind(
        r.symbolId, r.date, r.scoreVersion, r.total, r.cTrend, r.cRsi, r.cMacd, r.cMa,
        r.cVolume, r.cMomentum, r.cFundamental, r.cNews, r.verdict,
        r.entryPx, r.stopPx, r.targetPx, r.rr,
      ),
    ),
  );
  return rows.length;
}

/**
 * ランキング。画面と API が同じクエリを通る。
 *
 * **`score_version` で必ず 1 つに絞る。** `scores_daily` の主キーは
 * (symbol_id, date, score_version) なので、Phase 1b で v2-full が入ると
 * 絞らないかぎり同じ銘柄が 2 行返る。既定はその日にある最新版
 * （`docs/SCORING.md` の版番号は辞書順で並ぶ約束）。
 */
export async function selectRanking(
  db: D1Database,
  date: string,
  options: {
    limit: number;
    verdict?: string | undefined;
    sector?: string | undefined;
    minTotal?: number | undefined;
    scoreVersion?: string | undefined;
  },
): Promise<RankingRow[]> {
  const conditions = ['sc.date = ?1'];
  const binds: unknown[] = [date];
  if (options.scoreVersion === undefined) {
    conditions.push(
      `sc.score_version = (SELECT MAX(score_version) FROM scores_daily WHERE date = ?1)`,
    );
  } else {
    binds.push(options.scoreVersion);
    conditions.push(`sc.score_version = ?${binds.length}`);
  }
  if (options.verdict !== undefined) {
    binds.push(options.verdict);
    conditions.push(`sc.verdict = ?${binds.length}`);
  }
  if (options.sector !== undefined) {
    binds.push(options.sector);
    conditions.push(`s.sector33 = ?${binds.length}`);
  }
  if (options.minTotal !== undefined) {
    binds.push(options.minTotal);
    conditions.push(`sc.total >= ?${binds.length}`);
  }
  binds.push(options.limit);
  const limitParam = `?${binds.length}`;

  const res = await db
    .prepare(
      `SELECT s.symbol_id, s.code, s.name, s.sector33, sc.date, sc.total, sc.verdict,
              sc.entry_px, sc.stop_px, sc.target_px, sc.rr,
              i.rsi14, i.macd_hist, i.vol_ratio, p.close,
              g.strength AS gc_strength
       FROM scores_daily sc
       JOIN symbols s ON s.symbol_id = sc.symbol_id
       LEFT JOIN indicators_daily i ON i.symbol_id = sc.symbol_id AND i.date = sc.date
       LEFT JOIN prices_daily p ON p.symbol_id = sc.symbol_id AND p.date = sc.date
       LEFT JOIN signals_daily g ON g.symbol_id = sc.symbol_id AND g.date = sc.date
            AND g.signal_code = 'golden_cross'
       WHERE ${conditions.join(' AND ')}
       ORDER BY sc.total DESC, s.symbol_id ASC
       LIMIT ${limitParam}`,
    )
    .bind(...binds)
    .all<RankingRowDb>();

  return (res.results ?? []).map(toRankingRow);
}

interface RankingRowDb {
  symbol_id: string;
  code: string;
  name: string;
  sector33: string | null;
  date: string;
  total: number | null;
  verdict: string;
  entry_px: number | null;
  stop_px: number | null;
  target_px: number | null;
  rr: number | null;
  rsi14: number | null;
  macd_hist: number | null;
  vol_ratio: number | null;
  close: number | null;
  gc_strength: number | null;
}

function toRankingRow(r: RankingRowDb): RankingRow {
  return {
    symbolId: r.symbol_id,
    code: r.code,
    name: r.name,
    sector33: r.sector33,
    date: r.date,
    total: r.total,
    verdict: r.verdict,
    rsi14: r.rsi14,
    macdHist: r.macd_hist,
    volRatio: r.vol_ratio,
    close: r.close,
    entryPx: r.entry_px,
    stopPx: r.stop_px,
    targetPx: r.target_px,
    rr: r.rr,
    goldenCrossStrength: r.gc_strength,
  };
}

export async function selectSymbolDetail(
  db: D1Database,
  symbolId: string,
  date: string,
): Promise<{ ranking: RankingRow | null; history: Bar[] }> {
  const rows = await selectRankingForSymbol(db, symbolId, date);
  const hist = await db
    .prepare(
      `SELECT date, open, high, low, close, volume FROM prices_daily
       WHERE symbol_id = ?1 AND date <= ?2 ORDER BY date DESC LIMIT 120`,
    )
    .bind(symbolId, date)
    .all<Bar>();
  return { ranking: rows, history: (hist.results ?? []).slice().reverse() };
}

async function selectRankingForSymbol(
  db: D1Database,
  symbolId: string,
  date: string,
): Promise<RankingRow | null> {
  const res = await db
    .prepare(
      `SELECT s.symbol_id, s.code, s.name, s.sector33, sc.date, sc.total, sc.verdict,
              sc.entry_px, sc.stop_px, sc.target_px, sc.rr,
              i.rsi14, i.macd_hist, i.vol_ratio, p.close,
              g.strength AS gc_strength
       FROM scores_daily sc
       JOIN symbols s ON s.symbol_id = sc.symbol_id
       LEFT JOIN indicators_daily i ON i.symbol_id = sc.symbol_id AND i.date = sc.date
       LEFT JOIN prices_daily p ON p.symbol_id = sc.symbol_id AND p.date = sc.date
       LEFT JOIN signals_daily g ON g.symbol_id = sc.symbol_id AND g.date = sc.date
            AND g.signal_code = 'golden_cross'
       WHERE sc.symbol_id = ?1 AND sc.date <= ?2
       ORDER BY sc.date DESC, sc.score_version DESC LIMIT 1`,
    )
    .bind(symbolId, date)
    .first<RankingRowDb>();
  return res === null ? null : toRankingRow(res);
}

/** スコアが入っている最新の日付。画面はここを起点にする。 */
export async function latestScoredDate(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT MAX(date) AS d FROM scores_daily`)
    .first<{ d: string | null }>();
  return row?.d ?? null;
}

/**
 * サンプルデータが入っているか。
 * 合成データを本物と見間違えたまま判断材料にされるのが一番まずいので、
 * 画面上部に警告を出すために見る。
 */
export async function hasSampleData(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM job_runs WHERE job = 'sample_seed' LIMIT 1`)
    .first<{ x: number }>();
  return row !== null;
}

export async function countVerdicts(db: D1Database, date: string): Promise<Record<string, number>> {
  const res = await db
    .prepare(`SELECT verdict, COUNT(*) AS n FROM scores_daily WHERE date = ?1 GROUP BY verdict`)
    .bind(date)
    .all<{ verdict: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of res.results ?? []) out[r.verdict] = r.n;
  return out;
}

export async function countQualifiedGoldenCross(db: D1Database, date: string, minStrength: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM signals_daily
       WHERE date = ?1 AND signal_code = 'golden_cross' AND strength >= ?2`,
    )
    .bind(date, minStrength)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---- ジョブ記録 -------------------------------------------------------------

export async function startJob(db: D1Database, job: string, targetDate: string, now: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO job_runs (job, target_date, status, started_at)
       VALUES (?1, ?2, 'running', ?3)
       ON CONFLICT (job, target_date) DO UPDATE SET
         status = 'running', started_at = excluded.started_at, finished_at = NULL, error = NULL`,
    )
    .bind(job, targetDate, now)
    .run();
}

export async function finishJob(
  db: D1Database,
  job: string,
  targetDate: string,
  now: string,
  rowsWritten: number,
  error: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE job_runs SET status = ?4, finished_at = ?3, rows_written = ?5, error = ?6
       WHERE job = ?1 AND target_date = ?2`,
    )
    .bind(job, targetDate, now, error === null ? 'ok' : 'error', rowsWritten, error)
    .run();
}

export async function lastSuccessfulJob(
  db: D1Database,
  job: string,
): Promise<{ target_date: string; finished_at: string | null } | null> {
  return db
    .prepare(
      `SELECT target_date, finished_at FROM job_runs
       WHERE job = ?1 AND status = 'ok' ORDER BY target_date DESC LIMIT 1`,
    )
    .bind(job)
    .first<{ target_date: string; finished_at: string | null }>();
}

export async function jobStatus(db: D1Database, job: string, targetDate: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT status FROM job_runs WHERE job = ?1 AND target_date = ?2`)
    .bind(job, targetDate)
    .first<{ status: string }>();
  return row?.status ?? null;
}

// ---- 内部 ------------------------------------------------------------------

/**
 * D1 の batch は 1 回に送れる文の数に上限があるので、分割して流す。
 * まとめて送るほうが往復が減るが、上限を超えると丸ごと失敗する。
 */
async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const SIZE = 100;
  for (let i = 0; i < statements.length; i += SIZE) {
    await db.batch(statements.slice(i, i + SIZE));
  }
}

function chunkIds(ids: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export interface WaitlistRow {
  readonly email: string;
  readonly createdAt: string;
  readonly consentedAt: string;
  readonly source: string | null;
  readonly status: string;
}

/**
 * 先行登録の一覧。新しい順。
 *
 * **個人情報を返す。** 呼び出せるのはアプリ側（Cloudflare Access の後ろ）だけ。
 * LP 側から到達する経路を作らないこと（`test/waitlist-admin.test.mjs` が検査）。
 */
export async function selectWaitlist(db: D1Database, limit: number): Promise<WaitlistRow[]> {
  const res = await db
    .prepare(
      `SELECT email, created_at, consented_at, source, status
       FROM waitlist ORDER BY created_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<{
      email: string;
      created_at: string;
      consented_at: string;
      source: string | null;
      status: string;
    }>();
  return (res.results ?? []).map((r) => ({
    email: r.email,
    createdAt: r.created_at,
    consentedAt: r.consented_at,
    source: r.source,
    status: r.status,
  }));
}

export interface QuoteRow {
  readonly symbol_id: string;
  readonly market: string;
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly currency: string;
  readonly as_of: string;
}

/**
 * 銘柄ごとの最新のスナップショット。
 *
 * **1 銘柄 1 行に畳む。** `quotes_snapshot` は取り込むたびに行が増えるので、
 * 畳まないと同じ銘柄が何度も並ぶ。`MAX(as_of)` で選んだ行だけを返す。
 *
 * `prices_daily` には触れない。あちらは J-Quants の公式データで、
 * 混ぜない方針（migrations/0003_quotes.sql）。
 */
export async function latestQuotes(db: D1Database): Promise<QuoteRow[]> {
  const res = await db
    .prepare(
      `SELECT q.symbol_id, s.market, s.code, s.name, q.price, q.currency, q.as_of
         FROM quotes_snapshot q
         JOIN symbols s ON s.symbol_id = q.symbol_id
         JOIN (SELECT symbol_id, MAX(as_of) AS as_of
                 FROM quotes_snapshot GROUP BY symbol_id) m
           ON m.symbol_id = q.symbol_id AND m.as_of = q.as_of
        ORDER BY s.market, s.code`,
    )
    .all<QuoteRow>();
  return res.results ?? [];
}

/** 状態ごとの件数。画面の見出しに出す。 */
export async function countWaitlist(db: D1Database): Promise<Record<string, number>> {
  const res = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM waitlist GROUP BY status`)
    .all<{ status: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of res.results ?? []) out[r.status] = r.n;
  return out;
}
