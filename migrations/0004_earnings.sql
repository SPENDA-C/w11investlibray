-- 決算発表の予定日。
--
-- 適用済みの 0001〜0003 は編集しない。連番で足す（CLAUDE.md）。
--
-- **「予定」であることが要点。** 発表済みの開示を並べても
-- カレンダーにはならない（「来週どの銘柄が決算か」が出せない）。
-- 取得元には前向きのデータを返すものを選ぶこと。
--
-- **quotes_snapshot とも prices_daily とも混ぜない。**
--   - prices_daily … J-Quants の公式日足。指標とスコアが乗っている
--   - quotes_snapshot … GOOGLEFINANCE の現在値（20 分遅延）
--   - earnings_calendar … 発表予定日。値段ではない
-- 性質が違うものを同じ表に入れると、どれがどの品質か分からなくなる。

CREATE TABLE IF NOT EXISTS earnings_calendar (
  symbol_id     TEXT NOT NULL,
  -- 発表予定日（YYYY-MM-DD）。**取得元の時点で予定が変わりうる**ので、
  -- 同じ銘柄が別の日付で入り直すことがある。
  announce_date TEXT NOT NULL,
  -- 'before' | 'after' | 'during' | NULL。米国株は寄り前・引け後の別が要る。
  -- 日本株は基本的に引け後だが、取得元が返さなければ NULL のままにする。
  -- **推測で 'after' を埋めない。**
  session       TEXT,
  -- 会計期間の識別（'2027Q1' など）。取得元が返さなければ NULL。
  fiscal_period TEXT,
  -- 'jquants' | 'finnhub' など。**どこから来た値かを必ず残す。**
  source        TEXT NOT NULL,
  -- 確定か予想か。取得元が区別を返すときだけ 1 にする。
  confirmed     INTEGER NOT NULL DEFAULT 0,
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (symbol_id, announce_date, source),
  FOREIGN KEY (symbol_id) REFERENCES symbols (symbol_id)
);

-- カレンダーは「ある月の範囲」で引く。日付が先頭に来る索引を張る。
CREATE INDEX IF NOT EXISTS idx_earnings_date ON earnings_calendar (announce_date);
CREATE INDEX IF NOT EXISTS idx_earnings_symbol ON earnings_calendar (symbol_id, announce_date DESC);
