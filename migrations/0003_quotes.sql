-- 外部ソース（GOOGLEFINANCE）のスナップショット。
--
-- 適用済みの 0001 / 0002 は編集しない。連番で足す（CLAUDE.md）。
--
-- **prices_daily に入れない。** 理由が 2 つある。
--
--   1. prices_daily は open / high / low / close / volume が全部 NOT NULL。
--      GOOGLEFINANCE が返すのは現在値ひとつで、残り 4 つを同じ値で埋めるのは
--      データの捏造になる。このプロダクトが一番やらないと決めていること
--   2. prices_daily は J-Quants の公式データを前提に指標とスコアが乗っている。
--      20 分遅延・対応範囲が公表されていないデータを混ぜると、
--      「毎日おなじ計算を回す」という土台が静かに崩れる
--
-- 銘柄そのものは既存の symbols に入る。0001_init.sql が最初から
-- 名前空間付き（JP. / US. / FX. / CRYPTO.）で設計してあるので足す必要がない。

CREATE TABLE IF NOT EXISTS quotes_snapshot (
  symbol_id   TEXT NOT NULL,
  -- シート側が計算した時刻。**取り込んだ時刻ではない。**
  -- GOOGLEFINANCE はシートが再計算されないと止まるので、
  -- 古い値を黙って入れ続けていないかはこちらで判断する。
  as_of       TEXT NOT NULL,
  price       REAL NOT NULL,
  currency    TEXT NOT NULL,
  source      TEXT NOT NULL,            -- 'googlefinance'
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (symbol_id, as_of),
  FOREIGN KEY (symbol_id) REFERENCES symbols (symbol_id)
);

CREATE INDEX IF NOT EXISTS idx_quotes_symbol_asof ON quotes_snapshot (symbol_id, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_asof ON quotes_snapshot (as_of DESC);
