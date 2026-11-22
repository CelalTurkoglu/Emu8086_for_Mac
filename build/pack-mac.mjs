import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const archFlag = process.argv.includes('--arm64') ? '--arm64' : '--universal';
const tmpOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emu8086-mac-build-'));
const finalReleaseDir = path.join(projectRoot, 'release');

console.log(`[pack-mac] Staging macOS package (${archFlag}) in local APFS dir: ${tmpOutDir}`);

try {
  // 1. Run electron-builder outputting to local APFS temp dir (avoids iCloud Desktop xattr detritus during codesign & DMG creation)
  execFileSync(
    'npx',
    [
      'electron-builder',
      '--mac',
      archFlag,
      `--config.directories.output=${tmpOutDir}`,
    ],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      },
    }
  );

  // 2. Copy verified artifacts (.dmg, .zip, and mac-universal/ or mac-arm64/ .app) into ./release/
  // Avoid removing release/ itself (Finder / iCloud Desktop can hold .DS_Store inside it).
  fs.mkdirSync(finalReleaseDir, { recursive: true });

  const entries = fs.readdirSync(tmpOutDir);
  for (const name of entries) {
    if (
      name.endsWith('-temp') ||
      name.endsWith('.yml') ||
      name.endsWith('.yaml') ||
      name.endsWith('.blockmap')
    ) {
      continue;
    }
    const src = path.join(tmpOutDir, name);
    const dst = path.join(finalReleaseDir, name);
    if (fs.existsSync(dst)) {
      fs.rmSync(dst, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    console.log(`[pack-mac] Copying ${name} -> release/${name}`);
    execFileSync('ditto', [src, dst], { stdio: 'inherit' });
  }

  console.log('[pack-mac] Done! Clean artifacts are in ./release/');
} finally {
  fs.rmSync(tmpOutDir, { recursive: true, force: true });
}
