#!/usr/bin/env node
/**
 * Build script for signalk-backup
 *
 * Creates public/ with a redirect page that fetches /plugins/signalk-backup/api/gui-url
 * (proxied by the plugin to the running container) and bounces the browser there.
 * The actual backup UI runs inside the signalk-backup-server container.
 *
 * Webpack adds remoteEntry.js (Module Federation) so the SignalK Admin UI can
 * mount our minimal config panel.
 */

const fs = require('fs');
const path = require('path');

const publicDest = path.join(__dirname, 'public');
const PLUGIN_PATH = '/plugins/signalk-backup';

function main() {
  console.log('=== signalk-backup plugin build ===\n');

  if (fs.existsSync(publicDest)) {
    fs.rmSync(publicDest, { recursive: true });
  }
  fs.mkdirSync(publicDest, { recursive: true });
  fs.mkdirSync(path.join(publicDest, 'assets'), { recursive: true });

  // Copy icon if present (SignalK resolves signalk.appIcon relative to public/).
  const iconSrc = path.resolve(__dirname, 'assets', 'icon.png');
  const iconDest = path.join(publicDest, 'assets', 'icon.png');
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, iconDest);
  } else {
    console.warn('Note: assets/icon.png not present; webapp will have no icon');
  }

  fs.writeFileSync(
    path.join(publicDest, 'index.html'),
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>SignalK Backup</title>
  <script>
    fetch('${PLUGIN_PATH}/api/gui-url')
      .then(r => {
        if (!r.ok) throw new Error('plugin returned ' + r.status);
        return r.json();
      })
      .then(data => {
        // The plugin returns a relative URL pointing at its own /console
        // reverse-proxy mount, so the browser stays on the SignalK origin
        // and inherits SignalK auth. No hostname rewrite needed.
        window.location.replace(data.url);
      })
      .catch((err) => {
        document.getElementById('msg').textContent =
          'signalk-backup-server not reachable: ' + err.message + '. Check the plugin configuration.';
        document.getElementById('msg').classList.add('err');
      });
  </script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #e4e4e4; }
    .box { text-align: center; max-width: 480px; padding: 24px; }
    .box img { width: 64px; margin-bottom: 16px; opacity: 0.85; }
    .err { color: #f88; }
  </style>
</head>
<body>
  <div class="box">
    <img src="assets/icon.png" alt="SignalK Backup" onerror="this.style.display='none'">
    <p id="msg">Connecting to backup engine&hellip;</p>
  </div>
</body>
</html>
`
  );

  console.log('Created public/index.html (redirect to container UI)');
  console.log('=== Build complete ===\n');
}

main();
