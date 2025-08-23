const { app, BrowserWindow, ipcMain, session, systemPreferences, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

function createStaticServer(rootDir) {
  const mimes = new Map(Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.cjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.task': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.map': 'application/json'
  }));

  function send(res, code, body, headers = {}) {
    res.writeHead(code, {
      'Cache-Control': 'no-cache',
      // crossOriginIsolated 化（MediaPipe Tasks のスレッド最適化に有効）
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...headers
    });
    if (body) res.end(body); else res.end();
  }

  const server = http.createServer((req, res) => {
    if (!req.url) return send(res, 400, 'Bad Request');
    let reqPath = decodeURIComponent(req.url.split('?')[0]);
    if (reqPath === '/') reqPath = '/index.html';
    // 防御: ルート外参照禁止（絶対パスを排除し、正規化）
    const relPath = reqPath.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(rootDir, relPath));
    if (!filePath.startsWith(rootDir)) return send(res, 403, 'Forbidden');
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        return send(res, 404, 'Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = mimes.get(ext) || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin'
      });
      fs.createReadStream(filePath).pipe(res);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  pair: { a: 4, b: 8 },
  unit: 'normalized', // 'normalized' | 'px' | 'world'
  alpha: 0.5,
  targetFps: 30, // 30 | 60
  resolution: '480p', // '480p' | '720p'
  overlay: true,
  cameraId: null,
  face: false,
  holistic: false,
  brightnessMode: 'off'
};

function readSettings() {
  try {
    const f = SETTINGS_FILE();
    if (!fs.existsSync(f)) return { ...DEFAULT_SETTINGS };
    const raw = fs.readFileSync(f, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(next) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

async function createWindow() {
  const { server, port } = await createStaticServer(path.resolve(__dirname));
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      webSecurity: true
    }
  });

  // カメラ権限の設定
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const cameraPermission = 'media';
    if (permission === cameraPermission) {
      callback(true); // カメラ権限を許可
    } else {
      callback(false);
    }
  });

  win.on('closed', () => server.close());
  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
}

app.whenReady().then(() => {
  // macOSでのカメラ権限確認
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('camera').then((hasAccess) => {
      console.log('カメラ権限:', hasAccess ? '許可' : '拒否');
    });
  }
  
  ipcMain.handle('settings:load', () => readSettings());
  ipcMain.handle('settings:save', (_evt, s) => writeSettings(s));
  ipcMain.handle('pick:image', async () => {
    const res = await dialog.showOpenDialog({
      title: '画像を選択',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png','jpg','jpeg','webp'] }
      ]
    });
    if (res.canceled || !res.filePaths?.[0]) return null;
    const abs = res.filePaths[0];
    try {
      const genDir = path.join(__dirname, 'public', 'generated', 'input');
      fs.mkdirSync(genDir, { recursive: true });
      const base = path.basename(abs);
      const dst = path.join(genDir, base);
      fs.copyFileSync(abs, dst);
      return { rel: `/public/generated/input/${base}`, abs: dst, name: base };
    } catch (e) {
      console.warn('画像コピー失敗:', e?.message || e);
      return null;
    }
  });
  
  ipcMain.handle('pick:depth', async () => {
    const res = await dialog.showOpenDialog({
      title: '深度マップを選択',
      properties: ['openFile'],
      filters: [
        { name: 'Depth Maps', extensions: ['png','tiff','tif','exr','hdr'] },
        { name: 'All Images', extensions: ['png','jpg','jpeg','tiff','tif','exr','hdr','webp'] }
      ]
    });
    if (res.canceled || !res.filePaths?.[0]) return null;
    const abs = res.filePaths[0];
    try {
      const genDir = path.join(__dirname, 'public', 'generated', 'depth');
      fs.mkdirSync(genDir, { recursive: true });
      const base = path.basename(abs);
      const dst = path.join(genDir, base);
      fs.copyFileSync(abs, dst);
      return { rel: `/public/generated/depth/${base}`, abs: dst, name: base };
    } catch (e) {
      console.warn('深度マップコピー失敗:', e?.message || e);
      return null;
    }
  });
  ipcMain.handle('depth:generate', async (_evt, inputAbs) => {
    try {
      const base = path.basename(inputAbs).replace(/\.[^.]+$/, '') + '_depth.png';
      const outDir = path.join(__dirname, 'public', 'generated', 'depth');
      fs.mkdirSync(outDir, { recursive: true });
      const outAbs = path.join(outDir, base);
      // venv優先: PYTHON 環境変数 > VIRTUAL_ENV/bin/python > python3
      let py = process.env.PYTHON || null;
      if (!py && process.env.VIRTUAL_ENV) {
        const cand = path.join(process.env.VIRTUAL_ENV, 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
        try { fs.accessSync(cand, fs.constants.X_OK); py = cand; } catch {}
      }
      if (!py) py = 'python3';
      const args = [
        path.join(__dirname, 'scripts', 'depth', 'generate_depth.py'),
        '--input', inputAbs,
        '--output', outAbs,
        '--backend', process.env.DAV2_BACKEND || 'auto',
        '--device', process.env.DAV2_DEVICE || 'auto',
      ];
      if (process.env.DAV2_WEIGHTS) { args.push('--weights', process.env.DAV2_WEIGHTS); }
      if (process.env.DAV2_MAX_SIZE) { args.push('--max-size', process.env.DAV2_MAX_SIZE); }
      if (process.env.DAV2_NORM) { args.push('--normalize', process.env.DAV2_NORM); }
      const ok = await new Promise((resolve) => {
        const p = execFile(py, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
          if (stdout) console.log('[depth] stdout:', stdout.trim());
          if (stderr) console.log('[depth] stderr:', stderr.trim());
          resolve(!err);
        });
        p.on('error', () => resolve(false));
      });
      if (!ok) return null;
      return { rel: `/public/generated/depth/${base}`, abs: outAbs, name: base };
    } catch (e) {
      console.warn('深度生成失敗:', e?.message || e);
      return null;
    }
  });
  ipcMain.handle('brightness:set', async (_evt, level) => {
    // システム輝度を設定（0..1）。Homebrewの`brightness`コマンドがある場合のみ対応。
    // メイン/内蔵ディスプレイを優先して対象を選択する。
    const candidates = [
      '/opt/homebrew/bin/brightness',
      '/usr/local/bin/brightness'
    ];
    const findBin = () => {
      for (const p of candidates) {
        try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
      }
      return null;
    };
    const execFileP = (cmd, args) => new Promise((resolve, reject) => {
      execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      });
    });
    try {
      const bin = findBin();
      if (!bin) {
        console.warn('brightnessコマンド未検出。システム輝度制御不可。');
        return false;
      }
      const lv = Math.max(0, Math.min(1, Number(level) || 0));

      // ディスプレイ一覧を取得し、候補を決める
      let targetIndex = null;
      try {
        const { stdout } = await execFileP(bin, ['-l']);
        const lines = stdout.split(/\r?\n/);
        const displays = [];
        let current = null;
        for (const line of lines) {
          const m = line.match(/^\s*display\s+(\d+):\s*(.*)$/i);
          if (m) {
            if (current) displays.push(current);
            current = { index: Number(m[1]), text: m[2] || '' };
          } else if (current) {
            current.text += `\n${line}`;
          }
        }
        if (current) displays.push(current);

        // フラグ抽出
        for (const d of displays) {
          const t = d.text.toLowerCase();
          d.isMain = /\bmain\b/.test(t);
          d.isBuiltIn = /built-?in/.test(t) || /internal/.test(t);
        }
        // 優先順位: main && built-in -> built-in -> main -> 先頭
        const pref = displays.find(d => d.isMain && d.isBuiltIn) ||
                     displays.find(d => d.isBuiltIn) ||
                     displays.find(d => d.isMain) ||
                     displays[0];
        if (pref) targetIndex = pref.index;
      } catch (eList) {
        console.warn('brightness -l 取得失敗。全ディスプレイ対象で設定を試行:', eList?.message || eList);
      }

      if (targetIndex != null) {
        await execFileP(bin, ['-d', String(targetIndex), String(lv)]);
      } else {
        // 対象不明の場合は全ディスプレイへ（内蔵が存在すれば反映される）
        await execFileP(bin, [String(lv)]);
      }
      return true;
    } catch (e) {
      console.warn('輝度設定失敗:', e?.message || e);
      return false;
    }
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
// 余計なフラグは無効化し、標準挙動に委譲
