/**
 * `diagnose` の入口。**リポジトリの一番上から `npm run diagnose` で走る。**
 *
 * これを足した理由は 1 つ。**`cd` と `$env:` で繰り返し失敗したから。**
 *
 *   cd : パス '…\packages\worker\packages\worker' が存在しない
 *   .\scripts\diagnose.ps1 : 用語 … は認識されません   ← worker の中から呼んだ
 *   LP_URL=… ./scripts/diagnose.sh                      ← bash の書き方を PowerShell へ
 *
 * どれも設定の問題ではなく、**打つ場所と書き方**の問題だった。
 * 手順書に注意書きを足すのではなく、要らなくする。
 *
 * やることは 3 つだけ:
 *   1. URL を wrangler.toml から読む（手で写させない）
 *   2. OS で .ps1 / .sh を選ぶ
 *   3. 終了コードをそのまま返す（NG があれば 1。CI から使える）
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = fileURLToPath(new URL('../packages/worker/wrangler.toml', import.meta.url));

/**
 * `[env.production.vars]` から 1 つ読む。
 *
 * **TOML を丸ごと解釈しない。** 依存を増やしたくないのと、
 * ここで欲しいのはホスト名 2 つだけだから。セクションを切り出してから
 * 探すので、既定側の同名キーを拾うことはない。
 */
export function readProdVar(config, key) {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '[env.production.vars]');
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trimStart().startsWith('[')) { end = i; break; }
  }
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`);
  for (const line of lines.slice(start + 1, end)) {
    const m = pattern.exec(line);
    if (m !== null) return m[1];
  }
  return '';
}

/**
 * 診断先の URL を決める。
 *
 * 環境変数が渡されていればそちらが勝つ（ローカルや検証環境を見るため)。
 * 無ければ wrangler.toml のホスト名。それも空ならローカルの既定。
 */
export function buildUrls(config, env = {}) {
  const lp = readProdVar(config, 'LP_HOSTNAME');
  const app = readProdVar(config, 'APP_HOSTNAME');
  return {
    LP_URL: env['LP_URL'] || (lp === '' ? 'http://localhost:8787/lp' : `https://${lp}`),
    APP_URL: env['APP_URL'] || (app === '' ? 'http://localhost:8787' : `https://${app}`),
  };
}

/**
 * 手元が origin より古くないかを見る。
 *
 * **これを足した理由も「打つ場所」と同じ種類。** pull を忘れたまま
 * コマンドを打ち、`Missing script` や「フラグが効かない」で何度も
 * 止まった。古いことに気付ける場所が無かったのが原因。
 *
 * `diagnose` は本番を見るときに必ず叩くので、ここに出す。
 * **ネットワークを使わない**（`git fetch` しない）。手元にある
 * 情報だけで判断するので、オフラインでも遅くならない。
 */
export function behindCount(run = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })) {
  const head = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.status !== 0) return null;
  const branch = (head.stdout ?? '').trim();
  if (branch === '' || branch === 'HEAD') return null;

  const counts = run(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
  if (counts.status !== 0) return null;
  const m = /^(\d+)\s+(\d+)/.exec((counts.stdout ?? '').trim());
  if (m === null) return null;
  return { ahead: Number(m[1]), behind: Number(m[2]), branch };
}

function reportFreshness() {
  const s = behindCount();
  if (s === null) return;
  if (s.behind > 0) {
    console.log(`⚠ 手元が origin より ${s.behind} コミット古い（${s.branch}）`);
    console.log(`    git pull --rebase origin ${s.branch}`);
    console.log('    古いままだと Missing script やフラグ無視として現れる');
    console.log('');
  }
}

function main() {
  reportFreshness();
  const urls = buildUrls(readFileSync(CONFIG, 'utf8'), process.env);

  // **PowerShell 5.1 でも通るように呼ぶ。** -NoProfile は利用者のプロファイルに
  // 影響されないため、-ExecutionPolicy Bypass は既定の Restricted でも動かすため。
  const [cmd, args] =
    process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/diagnose.ps1']]
      : ['bash', ['scripts/diagnose.sh']];

  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...urls },
  });

  if (res.error) {
    console.error(`✗ ${cmd} を起動できなかった: ${res.error.message}`);
    console.error(`    直接実行するなら: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
  // NG があれば diagnose 自身が 1 で終わる。握り潰さない。
  process.exit(res.status ?? 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
