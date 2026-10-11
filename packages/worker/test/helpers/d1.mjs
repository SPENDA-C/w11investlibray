import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * D1 の薄いシム（node:sqlite の上に載せる）。
 *
 * SQL を実際に走らせずにモックで済ませると、プレースホルダの取り違えや
 * インデックスの効かない JOIN が本番まで残る。ここでは本物の SQLite に
 * 本物のスキーマを流して検証する。
 */
/**
 * `?1` `?2` … を、**出現順の無印 `?`** に展開する。
 *
 * **なぜ要るのか。** `node:sqlite` に位置引数を渡したときの束縛の仕方が
 * Node の版によって違う。この環境（v22.22.2）では「`?N` の最大番号」までしか
 * 束縛できず、それを超えると `column index out of range`（SQLITE_RANGE）に
 * なる。別の版では `?` の出現数で数えるらしく、`(?1, ?2, ?2)` に 2 引数を
 * 渡しただけで同じエラーが出る（Windows で実際に踏んだ）。
 *
 * 無印 `?` だけの経路はどの版でも同じなので、**そこへ寄せて版差を消す。**
 *
 *   'VALUES (?1, ?2, ?2)' + [x, y]  →  'VALUES (?, ?, ?)' + [x, y, y]
 *   'VALUES (?2, ?1)'     + [x, y]  →  'VALUES (?, ?)'    + [y, x]
 *   'VALUES (?, ?, ?)'    + [x,y,z] →  そのまま（無印は触らない）
 *
 * **製品コードの SQL は変えていない。** `?N` は src/db/queries.ts を中心に
 * 100 箇所ほどで使っていて、本番の D1 はこの書き方を正しく扱う。
 * ここで吸収するのはテスト用のシムの都合。
 *
 * 既知の限界: 文字列リテラルの中に `?1` があると誤って書き換わる。
 * いまの SQL には無い。壊れれば既存のテストが落ちるので気づける。
 */
export function expandPlaceholders(sql, params) {
  const ordered = [];
  const text = sql.replace(/\?(\d+)/g, (_match, index) => {
    ordered.push(params[Number(index) - 1]);
    return '?';
  });
  // `?N` が 1 つも無ければ無印なので、そのまま通す
  return ordered.length === 0 ? { sql, params } : { sql: text, params: ordered };
}

class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    const next = new Stmt(this.db, this.sql);
    next.params = params.map(normalise);
    return next;
  }
  /** 展開してから prepare する。返すのは文と、それに合わせて並べ直した値。 */
  #ready() {
    const { sql, params } = expandPlaceholders(this.sql, this.params);
    return { stmt: this.db.prepare(sql), params };
  }
  async all() {
    const { stmt, params } = this.#ready();
    return { results: stmt.all(...params), success: true };
  }
  async first() {
    const { stmt, params } = this.#ready();
    const row = stmt.get(...params);
    return row === undefined ? null : row;
  }
  async run() {
    const { stmt, params } = this.#ready();
    const info = stmt.run(...params);
    return { success: true, meta: { changes: info.changes } };
  }
}

function normalise(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export class FakeD1 {
  constructor(...schemaPaths) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    for (const p of schemaPaths) this.db.exec(readFileSync(p, 'utf8'));
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  async batch(statements) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
  /** テストから直接 SQL を投げる口。 */
  exec(sql) {
    this.db.exec(sql);
  }
  query(sql, ...params) {
    const e = expandPlaceholders(sql, params.map(normalise));
    return this.db.prepare(e.sql).all(...e.params);
  }
}

/** R2 のシム。put されたものを Map に貯める。 */
export class FakeR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value) {
    this.objects.set(key, value);
    return { key };
  }
  async get(key) {
    const v = this.objects.get(key);
    return v === undefined ? null : { text: async () => v };
  }
}

export const SCHEMA_PATH = fileURLToPath(
  new URL('../../../../migrations/0001_init.sql', import.meta.url),
);
export const WAITLIST_SCHEMA_PATH = fileURLToPath(
  new URL('../../../../migrations/0002_waitlist.sql', import.meta.url),
);
export const QUOTES_SCHEMA_PATH = fileURLToPath(
  new URL('../../../../migrations/0003_quotes.sql', import.meta.url),
);

export function makeEnv(overrides = {}) {
  return {
    // **マイグレーションを足したらここにも足す。** 足し忘れると、
    // 新しいテーブルを使う画面がテストでは「無い」ことになり、
    // 本番で初めて落ちる。
    INVEST_DB: new FakeD1(SCHEMA_PATH, WAITLIST_SCHEMA_PATH, QUOTES_SCHEMA_PATH),
    INVEST_R2: new FakeR2(),
    SITE_NAME: 'ゴールデンクロスーインカムゲインを究める資産運用',
    SITE_SHORT_NAME: 'ゴールデンクロス',
    LP_HOSTNAME: '',
    APP_HOSTNAME: '',
    MARKETS: 'JP',
    UNIVERSE_LIMIT: '500',
    NEWS_MODEL: 'test-model',
    MEMBER_SIGNUP_ENABLED: 'false',
    QUOTES_PUBLIC_ENABLED: 'false',
    CF_ACCESS_TEAM_DOMAIN: '',
    CF_ACCESS_AUD: '',
    JQUANTS_BASE_URL: 'https://api.example.test/v2',
    JQUANTS_FIELD_ALIASES: '{}',
    JQUANTS_API_KEY: 'test-key',
    ...overrides,
  };
}
