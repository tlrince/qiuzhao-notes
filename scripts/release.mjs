// Builds a signed Mac release and (with --publish) uploads it to GitHub Releases.
//
//   npm run release -- --notes "这次更新了什么"            build only, files land in release/
//   npm run release -- --notes "这次更新了什么" --publish  build and create the GitHub release
//
// Needs the updater signing key at ~/.tauri/qiuzhao-notes.key (or TAURI_SIGNING_PRIVATE_KEY).
// The app checks releases/latest/download/latest.json, so every published release must
// carry a latest.json next to the signed .app.tar.gz; this script writes both.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'tlrince/qiuzhao-notes';
const NAME = 'QiuzhaoNotes';
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const fail = message => { console.error(`\n✗ ${message}`); process.exit(1); };

const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const version = config.version;
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.version !== version) fail(`package.json 的 version (${pkg.version}) 与 tauri.conf.json (${version}) 不一致，请先改成同一个版本号`);
const notes = option('--notes') ?? '';
if (flag('--publish') && !notes.trim()) fail('发布时请用 --notes "…" 写一句更新说明');

const env = { ...process.env };
const cargoBin = join(homedir(), '.cargo', 'bin');
if (existsSync(cargoBin)) env.PATH = `${cargoBin}${delimiter}${env.PATH ?? ''}`;
if (!env.DEVELOPER_DIR && existsSync('/Library/Developer/CommandLineTools')) env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools';
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyPath = join(homedir(), '.tauri', 'qiuzhao-notes.key');
  if (!existsSync(keyPath)) fail(`找不到更新签名密钥 ${keyPath}`);
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, 'utf8');
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';

// One universal build serves both Apple-chip and Intel Macs when the Intel target is installed.
const installed = spawnSync('rustup', ['target', 'list', '--installed'], { env, encoding: 'utf8' }).stdout ?? '';
const universal = installed.includes('x86_64-apple-darwin') && installed.includes('aarch64-apple-darwin');
const arch = universal ? 'universal' : process.arch === 'arm64' ? 'aarch64' : 'x64';
const buildArgs = ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'app,dmg', ...(universal ? ['--target', 'universal-apple-darwin'] : [])];
console.log(`→ 构建 ${version}（${arch}）…`);
const build = spawnSync(process.execPath, buildArgs, { env, stdio: 'inherit' });
if (build.status !== 0) fail('构建失败');

const bundle = join('src-tauri', 'target', ...(universal ? ['universal-apple-darwin'] : []), 'release', 'bundle');
const app = join(bundle, 'macos', `${config.productName}.app.tar.gz`);
const dmgArch = universal ? 'universal' : arch;
const dmg = join(bundle, 'dmg', `${config.productName}_${version}_${dmgArch}.dmg`);
for (const file of [app, `${app}.sig`, dmg]) if (!existsSync(file)) fail(`没有找到构建产物 ${file}`);

// GitHub renames non-ASCII asset names, so publish under ASCII names.
const out = 'release';
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const assets = { dmg: `${NAME}_${version}_${arch}.dmg`, app: `${NAME}_${version}_${arch}.app.tar.gz` };
copyFileSync(dmg, join(out, assets.dmg));
copyFileSync(app, join(out, assets.app));
const url = `https://github.com/${REPO}/releases/download/v${version}/${assets.app}`;
const signature = readFileSync(`${app}.sig`, 'utf8').trim();
const platforms = universal
  ? { 'darwin-aarch64': { signature, url }, 'darwin-x86_64': { signature, url } }
  : { [arch === 'aarch64' ? 'darwin-aarch64' : 'darwin-x86_64']: { signature, url } };
writeFileSync(join(out, 'latest.json'), `${JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
console.log(`✓ 已生成 ${out}/${assets.dmg}、${out}/${assets.app}、${out}/latest.json`);

if (!flag('--publish')) {
  console.log('\n确认无误后加上 --publish 重新运行即可上传到 GitHub Releases。');
  process.exit(0);
}
const publish = spawnSync('gh', ['release', 'create', `v${version}`, '--repo', REPO, '--title', `v${version}`, '--notes', notes,
  join(out, assets.dmg), join(out, assets.app), join(out, 'latest.json')], { env, stdio: 'inherit' });
if (publish.status !== 0) fail('上传失败；可以稍后重新运行 --publish，或在 GitHub 网页上手动上传 release/ 里的三个文件');
console.log(`✓ 已发布 https://github.com/${REPO}/releases/tag/v${version}`);
