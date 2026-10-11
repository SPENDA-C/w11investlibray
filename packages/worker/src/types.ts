export interface Env {
  INVEST_DB: D1Database;
  INVEST_R2: R2Bucket;

  // vars
  /** 正式名。LP の <title> と og:title に使う。 */
  SITE_NAME: string;
  /** 短縮名。ヘッダーとダッシュボードの <title> に使う。 */
  SITE_SHORT_NAME: string;
  /** LP を出すホスト名。空ならローカル扱いで `/lp` 配下に出る。 */
  LP_HOSTNAME: string;
  /** ダッシュボードを出すホスト名。Cloudflare Access はこちらに掛ける。 */
  APP_HOSTNAME: string;
  MARKETS: string;
  UNIVERSE_LIMIT: string;
  NEWS_MODEL: string;
  MEMBER_SIGNUP_ENABLED: string;
  /** GOOGLEFINANCE の現在値を認証なしで見せるか。既定 "false"。 */
  QUOTES_PUBLIC_ENABLED: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  JQUANTS_BASE_URL: string;
  JQUANTS_FIELD_ALIASES: string;

  // secrets
  JQUANTS_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

/** ランキング 1 行。API と画面が同じ形を見る。 */
export interface RankingRow {
  readonly symbolId: string;
  readonly code: string;
  readonly name: string;
  readonly sector33: string | null;
  readonly date: string;
  readonly total: number | null;
  readonly verdict: string;
  readonly rsi14: number | null;
  readonly macdHist: number | null;
  readonly volRatio: number | null;
  readonly close: number | null;
  readonly entryPx: number | null;
  readonly stopPx: number | null;
  readonly targetPx: number | null;
  readonly rr: number | null;
  readonly goldenCrossStrength: number | null;
}
