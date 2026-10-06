import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'web-dist');
const nginxPath = join(root, 'deploy/nginx/autumn-notes.conf');
const nginx = readFileSync(nginxPath, 'utf8');

function blockFor(locationStart) {
  const start = nginx.indexOf(locationStart);
  assert.notEqual(start, -1, `missing Nginx location: ${locationStart}`);
  const bodyStart = nginx.indexOf('{', start) + 1;
  const end = nginx.indexOf('\n    }', bodyStart);
  assert.notEqual(end, -1, `unterminated Nginx location: ${locationStart}`);
  return nginx.slice(bodyStart, end);
}

function classify(path) {
  if (path === '/' || path === '/index.html') return 'entry';
  if (/^\/assets\/.+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/i.test(path)) return 'hashed-asset';
  if (path.startsWith('/assets/')) return 'asset';
  if (/\.[^/]+$/.test(path)) return 'static-file';
  return 'spa-route';
}

function resolveRequest(path) {
  const kind = classify(path);
  const diskPath = join(dist, path.replace(/^\/+/, ''));
  const exists = existsSync(diskPath) && statSync(diskPath).isFile();

  if (kind === 'entry') return { kind, status: existsSync(join(dist, 'index.html')) ? 200 : 404, file: 'index.html', cache: 'no-cache' };
  if (kind === 'hashed-asset' || kind === 'asset' || kind === 'static-file') {
    return { kind, status: exists ? 200 : 404, file: exists ? diskPath : null, cache: kind === 'hashed-asset' && exists ? 'immutable' : 'no-cache' };
  }
  return { kind, status: 200, file: 'index.html', cache: 'no-cache' };
}

test('Nginx config provides BrowserRouter deep-link fallback and fresh HTML', () => {
  const rootBlock = blockFor('location / {');
  assert.match(rootBlock, /try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/);
  for (const location of ['location = / {', 'location = /index.html {']) {
    assert.match(blockFor(location), /add_header\s+Cache-Control\s+"no-cache"\s+always;/);
  }

  assert.equal(classify('/analytics'), 'spa-route');
  assert.deepEqual(resolveRequest('/analytics'), {
    kind: 'spa-route', status: 200, file: 'index.html', cache: 'no-cache',
  });
});

test('hashed Vite assets are immutable while missing assets stay genuine 404s', () => {
  const hashedBlock = blockFor('location ~* ^/assets/.+-[A-Za-z0-9_-]{8}\\.[A-Za-z0-9]+$ {');
  assert.match(hashedBlock, /try_files\s+\$uri\s+=404;/);
  assert.match(hashedBlock, /public, max-age=31536000, immutable/);
  assert.doesNotMatch(hashedBlock, /add_header[^;]*\balways\b/);

  const assetBlock = blockFor('location /assets/ {');
  assert.match(assetBlock, /try_files\s+\$uri\s+=404;/);
  assert.match(assetBlock, /add_header\s+Cache-Control\s+"no-cache"\s+always;/);

  const hashedFile = readFileSync(join(dist, 'index.html'), 'utf8')
    .match(/(?:src|href)="(\/assets\/[^"?]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+)"/)?.[1];
  assert.ok(hashedFile, 'web-dist/index.html should reference a Vite hashed asset');
  assert.deepEqual(resolveRequest(hashedFile), {
    kind: 'hashed-asset', status: 200,
    file: join(dist, hashedFile.slice('/'.length)), cache: 'immutable',
  });
  assert.deepEqual(resolveRequest('/assets/not-built.js'), {
    kind: 'asset', status: 404, file: null, cache: 'no-cache',
  });
  assert.deepEqual(resolveRequest('/assets/missing-12345678.js'), {
    kind: 'hashed-asset', status: 404, file: null, cache: 'no-cache',
  });
});

test('missing file-like URLs return 404 instead of the SPA HTML', () => {
  const staticBlock = blockFor('location ~* \\.[^/]+$ {');
  assert.match(staticBlock, /try_files\s+\$uri\s+=404;/);
  assert.match(staticBlock, /add_header\s+Cache-Control\s+"no-cache"\s+always;/);

  assert.deepEqual(resolveRequest('/robots.txt'), {
    kind: 'static-file', status: 404, file: null, cache: 'no-cache',
  });
  assert.deepEqual(resolveRequest('/favicon.ico'), {
    kind: 'static-file', status: 404, file: null, cache: 'no-cache',
  });
});

test('the static deployment sample is deliberately independent of domain and TLS setup', () => {
  assert.match(nginx, /Configure listen\/server_name and HTTPS in[\s\S]*deployment environment/);
  assert.doesNotMatch(nginx, /^\s*listen\s/m);
  assert.doesNotMatch(nginx, /^\s*server_name\s/m);
  assert.ok(existsSync(join(dist, 'index.html')), 'run npm run build before testing');
});
