'use strict';
// Compiles src/helper/WinNotchHelper.cs into winnotch-helper.exe with the C#
// compiler that ships with Windows (.NET Framework 4.x) — no SDK or extra
// dependency. Runs before `npm start` and `npm run build`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') {
  console.log('[build-helper] not on Windows; skipping native helper');
  process.exit(0);
}

const root   = path.join(__dirname, '..');
const source = path.join(root, 'src', 'helper', 'WinNotchHelper.cs');
const output = path.join(root, 'src', 'helper', 'winnotch-helper.exe');
const winDir = process.env.WINDIR || 'C:\\Windows';
const fw     = path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const winmd  = path.join(winDir, 'System32', 'WinMetadata');
const csc    = path.join(fw, 'csc.exe');

if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) {
  console.log('[build-helper] up to date');
  process.exit(0);
}

const refs = [
  path.join(fw, 'System.Runtime.dll'),
  path.join(fw, 'System.Drawing.dll'),
  path.join(winmd, 'Windows.Foundation.winmd'),
  path.join(winmd, 'Windows.Media.winmd'),
  path.join(winmd, 'Windows.Storage.winmd'),
];
for (const f of [csc, ...refs]) {
  if (!fs.existsSync(f)) {
    console.error(`[build-helper] missing ${f} — needs Windows 10/11 with .NET Framework 4.x`);
    process.exit(1);
  }
}

try {
  execFileSync(csc, [
    '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/warnaserror-',
    `/out:${output}`,
    ...refs.map(r => `/reference:${r}`),
    source,
  ], { stdio: 'inherit' });
} catch (_) {
  console.error('[build-helper] compile failed');
  process.exit(1);
}
console.log('[build-helper] built', path.relative(root, output));
