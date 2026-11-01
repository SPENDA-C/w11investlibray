/**
 * Cloudflare Access の 2 つの値を wrangler.toml に書き込む。
 *
 *   npm run set:access -- weathered-frost-70c2.cloudflareaccess.com a1b2…（64桁）
 *   npm run set:access -- a1b2…（64桁）                 ← AUD だけ足す
 *
 * 順番は問わない。**値の形で見分ける**ので、どちらを先に書いてもよい。
 *
 * **なぜスクリプトにしたか。** `database_id` のときと同じ理由。
 * `[env.production.vars]` がファイルのどこにあるか分からない、という
 * ところで止まった。貼り先を探す作業そのものを無くす。
 *
 * **既定側には書かない。** 既定（ローカルの `wrangler dev`）に値が入ると
 * Access の JWT 検証が始まり、手元で何も開けなくなる。本番側だけを変える。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** AUD は 64 桁の 16 進数。Team domain は `.cloudflareaccess.com` で終わる。 */
const AUD = /\b[0-9a-f]{64}\b/i;
const TEAM = /\b[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com\b/i;

/**
 * 入力から 2 つの値を拾う。
 *
 * 画面からまるごと貼っても拾えるようにしてある（それが自然な操作）。
 * **見つからないものは `null`。** 片方だけ渡すこともできる。
 */
export function extractAccess(input) {
  const aud = AUD.exec(input);
  const team = TEAM.exec(input);
  return {
    aud: aud === null ? null : aud[0].toLowerCase(),
    teamDomain: team === null ? null : team[0].toLowerCase(),
  };
}

/**
 * `[env.production.vars]` の中の 1 つのキーを書き換える。
 *
 * **本番のセクションだけを対象にする。** 既定側にも同名のキーがあるので、
 * 全体を置換すると手元の `wrangler dev` が開かなくなる。
 */
export function applyToProdVars(config, key, value) {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '[env.production.vars]');
  if (start === -1) return { ok: false, reason: '[env.production.vars] が見つからない' };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trimStart().startsWith('[')) {
      end = i;
      break;
    }
  }

  const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)"[^"]*"(.*)$`);
  for (let i = start + 1; i < end; i += 1) {
    const m = pattern.exec(lines[i]);
    if (m !== null) {
      lines[i] = `${m[1]}"${value}"${m[2]}`;
      return { ok: true, config: lines.join('\n') };
    }
  }
  return { ok: false, reason: `[env.production.vars] に ${key} の行が無い` };
}

const CONFIG_PATH = fileURLToPath(new URL('../packages/worker/wrangler.toml', import.meta.url));

function main(argv) {
  const input = argv.join(' ');
  if (input.trim() === '') {
    console.error(`使い方:
  npm run set:access -- <Team domain> <AUD>

  Team domain : Zero Trust → Settings → General の Team domain
                （.cloudflareaccess.com で終わる）
  AUD         : Access → Applications → 対象のアプリを開く
                → Overview の Application Audience (AUD) Tag
                （64 桁の 16 進数）

順番は問わない。片方だけでもよい。画面からまるごと貼っても拾う。`);
    return 1;
  }

  const { aud, teamDomain } = extractAccess(input);
  if (aud === null && teamDomain === null) {
    console.error(`渡された文字列から値を見つけられなかった。
  AUD は 64 桁の 16 進数、Team domain は .cloudflareaccess.com で終わる。
  AUD が 32 桁なら、それは別の値（Application ID など）。Overview の
  **Application Audience (AUD) Tag** を探すこと。`);
    return 1;
  }

  let config = readFileSync(CONFIG_PATH, 'utf8');
  const done = [];
  for (const [key, value] of [
    ['CF_ACCESS_TEAM_DOMAIN', teamDomain],
    ['CF_ACCESS_AUD', aud],
  ]) {
    if (value === null) continue;
    const res = applyToProdVars(config, key, value);
    if (!res.ok) {
      console.error(`✗ ${res.reason}`);
      return 1;
    }
    config = res.config;
    done.push(key);
  }

  writeFileSync(CONFIG_PATH, config);
  for (const key of done) console.log(`✓ ${key} を [env.production.vars] に書いた`);

  const missing = [
    teamDomain === null ? 'CF_ACCESS_TEAM_DOMAIN' : null,
    aud === null ? 'CF_ACCESS_AUD' : null,
  ].filter((x) => x !== null);
  if (missing.length > 0) {
    console.log(`\nまだ空: ${missing.join(', ')}`);
    console.log('**両方そろって初めて Access の検証が有効になる。**');
    return 0;
  }

  console.log(`
両方そろった。コミットして push すれば Actions がデプロイする:

  git add packages/worker/wrangler.toml
  git commit -m "Access の team domain と AUD を設定"
  git push origin claude/stock-screening-ai-library-35qwmk

そのあと npm run diagnose の [3] が 302 に変わる。`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
