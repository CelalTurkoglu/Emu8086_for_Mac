const { execFileSync } = require('child_process');
const path = require('path');

/**
 * electron-builder afterPack hook:
 * Strips macOS extended attributes (xattr detritus) and applies a valid
 * ad-hoc signature so Apple Silicon (M1-M4) and Intel Macs execute the
 * Universal .app cleanly without SIGKILL (Code Signature Invalid).
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  // Only sign the final app bundle (skip intermediate universal temp slices)
  const outBase = path.basename(context.appOutDir);
  if (outBase.endsWith('-temp')) {
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`  • stripping xattr detritus  path=${appPath}`);
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });

  console.log(`  • ad-hoc signing macOS app  path=${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });

  console.log(`  • verifying code signature  path=${appPath}`);
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
};
