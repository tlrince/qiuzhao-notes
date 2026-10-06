import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

// Discover the default rustup directory without changing shell profiles or Xcode selection.
const env = { ...process.env };
const cargoBin = join(homedir(), '.cargo', 'bin');
if (existsSync(cargoBin)) env.PATH = `${cargoBin}${delimiter}${env.PATH ?? ''}`;
// A standalone CLT install can compile local apps even when full Xcode is awaiting setup.
if (process.platform === 'darwin' && !env.DEVELOPER_DIR && existsSync('/Library/Developer/CommandLineTools')) {
  env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools';
}
const args = process.argv.slice(2);
const result = args[0] === 'test'
  ? spawnSync('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml'], { env, stdio: 'inherit' })
  : spawnSync(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', ...args], { env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
