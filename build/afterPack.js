// Ad-hoc sign so Apple Silicon doesn't say "damaged", then pin a STABLE designated requirement
// (identifier only) so macOS permissions (Accessibility etc.) survive updates.
const { execFileSync } = require('child_process');
const path = require('path');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.koi.switcher', '-r=designated => identifier "com.koi.switcher"', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(execFileSync('codesign', ['-d', '-r-', app]).toString());
};
