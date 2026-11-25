// Signs Koi.app after packing.
//
// With KOI_SIGN_IDENTITY set (the SHA-1 of a code-signing identity in the build keychain; CI imports it from the
// KOI_CERT_P12 secret, see tools/make-signing-cert.sh): sign with that one stable certificate. The designated
// requirement then names the certificate ("identifier com.koi.switcher and certificate root = H..."), which is the
// same for every release, so macOS keeps Koi's Accessibility permission across updates.
//
// Without it: ad-hoc sign, so Apple Silicon does not say "damaged". An ad-hoc signature has no certificate, and
// macOS ties an ad-hoc app's Accessibility grant to that exact build, even with the pinned identifier-only
// requirement below. Every update then leaves a stale grant: System Settings still shows Koi switched on, but
// macOS no longer trusts it. Koi 2.0.1 detects that and walks people through re-adding Koi.
const { execFileSync } = require('child_process');
const path = require('path');
const run = args => execFileSync('codesign', args, { stdio: 'inherit' });
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.app');
  const id = (process.env.KOI_SIGN_IDENTITY || '').trim();
  let signed = false;
  if (id) {
    try {
      const kc = process.env.KOI_KEYCHAIN ? ['--keychain', process.env.KOI_KEYCHAIN] : [];
      run(['--force', '--deep', '--sign', id, ...kc, app]);
      run(['--verify', '--deep', '--strict', app]);
      signed = true;
      console.log('signed with the stable Koi certificate');
    } catch (e) { console.log('::warning title=signing::stable certificate failed (' + e.message + '); falling back to ad-hoc, permissions will not survive this update'); }
  }
  if (!signed) {
    run(['--force', '--deep', '--sign', '-', app]);
    run(['--force', '--sign', '-', '--identifier', 'com.koi.switcher', '-r=designated => identifier "com.koi.switcher"', app]);
    run(['--verify', '--deep', '--strict', app]);
    if (process.env.CI) console.log('::warning title=signing::ad-hoc signed (no KOI_CERT_P12 secret): people must re-add Koi in Accessibility after this update');
  }
  console.log(execFileSync('codesign', ['-d', '-r-', app]).toString());
};
