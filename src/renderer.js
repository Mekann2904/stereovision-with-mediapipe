// Hand Distance PoC (Renderer)
// 実検出：@mediapipe/tasks-vision（未導入時はモック動作）

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const chart = document.getElementById('chart');
const ctxOverlay = overlay.getContext('2d');
const ctxChart = chart.getContext('2d');

const el = (id) => document.getElementById(id);
const valNorm1 = el('val-norm-1');
const valPx1 = el('val-px-1');
const valNorm2 = el('val-norm-2');
const valPx2 = el('val-px-2');
const valWorld = el('val-world');
const barNorm1 = el('bar-norm-1');
const barPx1 = el('bar-px-1');
const barNorm2 = el('bar-norm-2');
const barPx2 = el('bar-px-2');
const statusEl = el('status');

const field = {
  a: el('pair-a'),
  b: el('pair-b'),
  alpha: el('alpha'),
  fps: el('fps'),
  res: el('res'),
  unit: el('unit'),
  overlay: el('overlay-on'),
  confidence: el('confidence'),
  history: el('history'),
  videoVisible: el('video-visible'),
  face: el('face-on'),
  brightnessMode: el('brightness-mode'),
  brightnessLabel: el('brightness-label'),
  holistic: el('holistic-on')
};

const DEFAULTS = {
  pair: { a: 4, b: 8 },
  unit: 'normalized',
  alpha: 0.5,
  targetFps: 30,
  resolution: '480p',
  overlay: true,
  showVideo: true,
  face: false,
  holistic: false,
  brightnessMode: 'off'
};

let settings = { ...DEFAULTS };
let ema = [null, null]; // 平滑化値（手ごと）
let lastFrameTs = 0;
let series = []; // 直近の正規化距離（手1、nullは欠測）
const MAX_POINTS = 600; // 10秒@60FPS
const CONF_LOW = 0.6;

// 精度向上のための追加変数
let landmarkHistory = [[], []]; // 各手のランドマーク履歴
const HISTORY_LENGTH = 5; // 履歴の長さ
let confidenceThreshold = 0.7; // 信頼度閾値

// 明るさ制御用の状態
let brightnessEma = null;
let lastBrightnessSent = -1;
let lastBrightnessAt = 0;
let fingerDistEma0 = null; // 手1の指間距離（正規化, EMA）
const BRIGHTNESS_MIN = 0.2; // アプリ内の下限（真っ黒防止）
const BRIGHTNESS_MAX = 1.5; // アプリ内の上限（過度な白飛び防止）
const BRIGHTNESS_SEND_INTERVAL_MS = 400;
// 指間距離→明るさのマッピング範囲（正規化距離）
const BRIGHTNESS_NORM_MIN = 0.02; // これ以下はほぼ0扱い（指が接触）
const BRIGHTNESS_NORM_MAX = 0.25; // これ以上はほぼ1扱い（十分離す）

// 顔ランドマークの時間平滑化用履歴（1顔分）
let faceLandmarkHistory = [];
const FACE_HISTORY_LENGTH = 5;

// 3Dプレビュー状態
let threeMod = null;
let threeReady = false;
let threeVisible = false;
let selectedImageRel = null; // サーバから参照できる相対パス（/public/...）
let selectedImageAbs = null; // 生成用に絶対パスも保持
let selectedDepthRel = null; // 生成または選択した深度

function smoothFaceLandmarks(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) return landmarks;
  faceLandmarkHistory.push(landmarks);
  if (faceLandmarkHistory.length > FACE_HISTORY_LENGTH) faceLandmarkHistory.shift();
  if (faceLandmarkHistory.length < 3) return landmarks;
  const n = landmarks.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, c = 0;
    for (const hist of faceLandmarkHistory) {
      const p = hist[i];
      if (p && p.x != null && p.y != null) { sx += p.x; sy += p.y; c++; }
    }
    out[i] = c ? { x: sx / c, y: sy / c } : (landmarks[i] || null);
  }
  return out;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function applySettingsToUI() {
  field.a.value = settings.pair.a;
  field.b.value = settings.pair.b;
  field.alpha.value = settings.alpha;
  field.fps.value = settings.targetFps;
  field.res.value = settings.resolution;
  field.unit.value = settings.unit;
  field.overlay.value = String(settings.overlay);
  field.confidence.value = settings.confidenceThreshold || 0.7;
  field.history.value = settings.historyLength || 5;
  if (field.videoVisible) field.videoVisible.value = String(settings.showVideo ?? true);
  if (field.face) field.face.value = String(settings.face ?? false);
  if (field.holistic) field.holistic.value = String(settings.holistic ?? false);
  field.brightnessMode.value = settings.brightnessMode || 'off';
  document.getElementById('depth-source').value = settings.depthSource || 'auto';
  document.getElementById('depth-format').value = settings.depthFormat || 'grayscale';
  updateBrightnessLabel();
}

function collectSettingsFromUI() {
  return {
    pair: { a: Number(field.a.value), b: Number(field.b.value) },
    unit: field.unit.value,
    alpha: Number(field.alpha.value),
    targetFps: Number(field.fps.value),
    resolution: field.res.value,
    overlay: field.overlay.value === 'true',
    cameraId: (document.getElementById('camera')?.value) || null,
    confidenceThreshold: Number(field.confidence.value),
    historyLength: Number(field.history.value),
    showVideo: (field.videoVisible?.value ?? 'true') === 'true',
    face: (field.face?.value ?? 'false') === 'true',
    holistic: (field.holistic?.value ?? 'false') === 'true',
    brightnessMode: field.brightnessMode.value,
    depthSource: document.getElementById('depth-source')?.value || 'auto',
    depthFormat: document.getElementById('depth-format')?.value || 'grayscale'
  };
}

async function loadSettings() {
  if (window.api && window.api.loadSettings) {
    const s = await window.api.loadSettings();
    if (s) settings = { ...settings, ...s };
  } else {
    try {
      const raw = localStorage.getItem('settings');
      if (raw) settings = { ...settings, ...JSON.parse(raw) };
    } catch {}
  }
}

async function saveSettings() {
  if (window.api && window.api.saveSettings) {
    await window.api.saveSettings(settings);
  } else {
    try { localStorage.setItem('settings', JSON.stringify(settings)); } catch {}
  }
}

function setStatus(label, kind = 'ok') {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = label;
}

function applyVideoVisibility() {
  const on = !threeVisible && (settings.showVideo !== false);
  video.style.display = on ? '' : 'none';
  const st = document.querySelector('.stage');
  if (st) st.style.background = on ? '#111' : '#000';
  // 3Dモード時はオーバーレイも非表示
  overlay.style.display = threeVisible ? 'none' : '';
  const stageImg = document.getElementById('stage-img');
  if (stageImg) stageImg.style.display = threeVisible ? '' : 'none';
}

function updateBrightnessLabel(value) {
  const mode = field.brightnessMode?.value || settings.brightnessMode || 'off';
  if (!field.brightnessLabel) return;
  if (mode === 'off') {
    field.brightnessLabel.textContent = '明るさ: OFF';
    return;
  }
  if (value == null) {
    field.brightnessLabel.textContent = `明るさ: 制御待機 (${mode})`;
    return;
  }
  const pct = Math.round(value * 100);
  field.brightnessLabel.textContent = `明るさ: ${pct}% (${mode})`;
}

function emaUpdate(idx, x) {
  if (x == null) { ema[idx] = null; return null; }
  if (ema[idx] == null) { ema[idx] = x; return ema[idx]; }
  ema[idx] = settings.alpha * x + (1 - settings.alpha) * ema[idx];
  return ema[idx];
}

// 高度な平滑化：移動平均と外れ値除去
function smoothLandmarks(landmarks, handIdx) {
  if (!landmarks || landmarks.length === 0) return null;
  
  // 履歴に追加
  landmarkHistory[handIdx].push(landmarks);
  if (landmarkHistory[handIdx].length > HISTORY_LENGTH) {
    landmarkHistory[handIdx].shift();
  }
  
  // 履歴が不足している場合は元の値を返す
  if (landmarkHistory[handIdx].length < 3) return landmarks;
  
  // 各ランドマークの移動平均を計算
  const smoothed = [];
  for (let i = 0; i < 21; i++) {
    let sumX = 0, sumY = 0, count = 0;
    
    // 履歴から有効な値を収集
    for (const hist of landmarkHistory[handIdx]) {
      if (hist[i] && hist[i].x !== undefined && hist[i].y !== undefined) {
        sumX += hist[i].x;
        sumY += hist[i].y;
        count++;
      }
    }
    
    if (count > 0) {
      smoothed[i] = {
        x: sumX / count,
        y: sumY / count
      };
    } else {
      smoothed[i] = landmarks[i] || null;
    }
  }
  
  return smoothed;
}

// 信頼度フィルタリング
function filterByConfidence(landmarks, confidence) {
  if (confidence < confidenceThreshold) return null;
  return landmarks;
}

function pushSeries(x) {
  series.push(x);
  if (series.length > MAX_POINTS) series.shift();
}

function drawChart() {
  const w = chart.width, h = chart.height;
  ctxChart.clearRect(0, 0, w, h);
  ctxChart.strokeStyle = '#4caf50';
  ctxChart.lineWidth = 2;
  ctxChart.beginPath();
  let started = false;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v == null) { started = false; continue; }
    const x = (i / (MAX_POINTS - 1)) * w;
    const y = h - v * h;
    if (!started) { ctxChart.moveTo(x, y); started = true; }
    else ctxChart.lineTo(x, y);
  }
  ctxChart.stroke();
}

function resizeCanvases() {
  // ステージ領域に内部解像度を一致させて座標系を同期
  const stage = document.querySelector('.stage');
  const stageW = Math.max(1, stage.clientWidth);
  const stageH = Math.max(1, stage.clientHeight);

  overlay.width = stageW;
  overlay.height = stageH;

  // chart canvas のサイズ設定
  chart.width = el('chart').clientWidth;
  chart.height = el('chart').clientHeight;

  console.log('Canvas resize:', {
    stage: { width: stageW, height: stageH },
    video: { width: video.videoWidth, height: video.videoHeight },
    overlay: { width: overlay.width, height: overlay.height }
  });

  // Three側のリサイズ
  if (threeReady && threeMod) {
    try { 
      console.log('Three.jsリサイズ実行');
      threeMod.resize(); 
    } catch (resizeError) {
      console.error('Three.jsリサイズでエラー:', resizeError);
    }
  }
}

window.addEventListener('resize', () => {
  // リサイズ後に少し遅延してキャンバスサイズを調整
  setTimeout(resizeCanvases, 100);
});

// 検出器（実/モック）
class Detector {
  constructor() { 
    this.ready = false; 
    this.mock = true; 
    this.t = 0; 
    this.hm = null; 
    this.fm = null; 
    this.hl = null; 
    this.poseAvailable = false;
    console.log('Detector初期化開始');
  }
  async init() {
    // 実装: @mediapipe/tasks-vision のバンドルを動的import
    try {
      const modUrl = new URL('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', window.location.origin).toString();
      const vision = await import(modUrl);
      const wasmRoot = new URL('/node_modules/@mediapipe/tasks-vision/wasm', window.location.origin).toString();
      const fileset = await vision.FilesetResolver.forVisionTasks(wasmRoot);
      // Holistic（包括）: あれば優先で初期化
      try {
        const holisticModelUrl = new URL('/public/assets/holistic_landmarker.task', window.location.origin).toString();
        this.hl = await vision.HolisticLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: holisticModelUrl, delegate: 'GPU' },
          runningMode: 'VIDEO'
        });
        this.poseAvailable = true; // Holisticに含まれる
        console.log('HolisticLandmarker初期化成功');
      } catch (eh) {
        console.warn('HolisticLandmarker初期化に失敗（モデル未配置/未対応）。通常検出を使用:', eh?.message || eh);
      }

      this.hm = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: new URL('/public/assets/hand_landmarker.task', window.location.origin).toString(),
          delegate: 'GPU'
        },
        numHands: 2,
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.5
      });
      // 顔トラッキング（任意）
      try {
        const faceModelUrl = new URL('/public/assets/face_landmarker.task', window.location.origin).toString();
        this.fm = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: faceModelUrl, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          minFaceDetectionConfidence: 0.7,
          minFacePresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: true
        });
        console.log('FaceLandmarker初期化成功');
      } catch (ef) {
        console.warn('FaceLandmarker初期化に失敗（モデル未配置等）。顔トラッキング無効:', ef?.message || ef);
      }
      this.mock = false;
      console.log('検出器初期化成功:', {
        hasHandModel: !!this.hm,
        hasFaceModel: !!this.fm,
        hasHolisticModel: !!this.hl,
        mock: this.mock
      });
    } catch (e) {
      console.warn('HandLandmarker初期化に失敗。モックにフォールバック:', e);
      const err = document.getElementById('cam-error');
      if (err) err.textContent = `Detector init error: ${e?.message || e}`;
      this.mock = true;
      console.log('モックモード有効:', this.mock);
    }
    this.ready = true;
    console.log('検出器準備完了:', this.ready);
  }
  detect(videoEl, ts) {
    if (this.mock || !this.hm) {
      console.log('モック検出実行:', { mock: this.mock, hasHandModel: !!this.hm, hasFaceModel: !!this.fm });
      return this.detectMock(ts);
    }
    // Holistic優先（設定ONかつ初期化済み）
    if (this.hl && settings.holistic) {
      try {
        const hr = this.hl.detectForVideo(videoEl, ts);
        const out = { hands: [], faces: [], pose: [] };
        // hands
        const left = hr?.leftHandLandmarks?.[0];
        const right = hr?.rightHandLandmarks?.[0];
        if (left?.length) {
          out.hands.push({ landmarks: left.map(p => ({ x: p.x, y: p.y })), confidence: 1, label: 'Left' });
        }
        if (right?.length) {
          out.hands.push({ landmarks: right.map(p => ({ x: p.x, y: p.y })), confidence: 1, label: 'Right' });
        }
        // face
        const face = hr?.faceLandmarks?.[0];
        if (face?.length) {
          const fsm = smoothFaceLandmarks(face.map(p => ({ x: p.x, y: p.y })));
          out.faces = [fsm];
        }
        // pose
        const pose = hr?.poseLandmarks?.[0];
        if (pose?.length) {
          out.pose = [pose.map(p => ({ x: p.x, y: p.y }))];
        }
        return out;
      } catch (ehol) {
        console.warn('Holistic detect失敗。通常検出にフォールバック:', ehol?.message || ehol);
      }
    }
    try {
      const res = this.hm.detectForVideo(videoEl, ts);
      const has = res?.landmarks && res.landmarks.length > 0;
      const out = { hands: [], faces: [], pose: [] };
      if (!has && !this.fm) return out;
      const hands = [];
      for (let i = 0; i < res.landmarks.length; i++) {
        const lm = res.landmarks[i];
        const conf = res.handedness?.[i]?.[0]?.score ?? 1;
        const simplified = lm.map(p => ({ x: p.x, y: p.y }));
        
        // 信頼度フィルタリング
        const filtered = filterByConfidence(simplified, conf);
        if (!filtered) continue;
        
        // 高度な平滑化を適用
        const smoothed = smoothLandmarks(filtered, i);
        
        hands.push({ 
          landmarks: smoothed, 
          confidence: conf, 
          label: res.handedness?.[i]?.[0]?.categoryName 
        });
      }
      out.hands = hands;
      // 顔
      if (this.fm && settings.face) {
        try {
          const fr = this.fm.detectForVideo(videoEl, ts);
          const flms = fr?.faceLandmarks || [];
          const facesRaw = flms.map(arr => arr.map(p => ({ x: p.x, y: p.y })));
          if (facesRaw[0]) facesRaw[0] = smoothFaceLandmarks(facesRaw[0]);
          out.faces = facesRaw;
          // 変換行列（高精度姿勢）
          const mats = fr?.facialTransformationMatrixes || [];
          out.faceTransforms = mats;
          console.log('FaceLandmarker出力:', {
            faces: facesRaw.length,
            hasTransforms: Array.isArray(mats) && mats.length > 0
          });
        } catch (ef2) {
          // 顔検出は任意のためログのみ
          // console.warn('face detect失敗:', ef2);
        }
      }
      return out;
    } catch (e) {
      console.warn('detectForVideo失敗:', e);
      return { hands: [], faces: [], pose: [] };
    }
  }
  detectMock(ts) {
    // 1秒に1回程度 NO_HAND に落として状態遷移を確認
    this.t += (ts - (this.prevTs || ts)) / 1000;
    this.prevTs = ts;
    const rand = Math.random();
    if (rand < 0.02) return { hands: [] };
    const phase = this.t;
    const ax = 0.4 + 0.2 * Math.sin(phase * 1.2);
    const ay = 0.5 + 0.2 * Math.cos(phase * 1.0);
    const bx = 0.6 + 0.2 * Math.cos(phase * 1.1);
    const by = 0.5 + 0.2 * Math.sin(phase * 0.9);
    const conf = 0.7 + 0.2 * Math.sin(phase * 0.5);
    const landmarks = new Array(21).fill(null);
    landmarks[settings.pair.a] = { x: ax, y: ay };
    landmarks[settings.pair.b] = { x: bx, y: by };
    // 簡易的に他点も周囲に配置
    for (let i = 0; i < 21; i++) {
      if (!landmarks[i]) {
        const rx = (Math.sin(phase + i * 0.3) * 0.05);
        const ry = (Math.cos(phase + i * 0.2) * 0.05);
        landmarks[i] = { x: clamp(0.5 + rx, 0.1, 0.9), y: clamp(0.5 + ry, 0.1, 0.9) };
      }
    }
    const hands = [{ landmarks, confidence: conf, label: 'Right' }];
    // 2手目のモック
    const landmarks2 = landmarks.map(p => ({ x: clamp(1 - p.x, 0.1, 0.9), y: p.y }));
    hands.push({ landmarks: landmarks2, confidence: conf, label: 'Left' });
    
    // 顔のモックデータも追加（顔トラッキングテスト用）
    const faceLandmarks = [];
    // MediaPipe Face Landmarkerの主要ポイントをモック
    for (let i = 0; i < 468; i++) { // Face Meshの標準ポイント数
      const angle = (i / 468) * Math.PI * 2;
      const radius = 0.1 + 0.05 * Math.sin(phase * 0.3 + i * 0.1);
      faceLandmarks[i] = {
        x: 0.5 + radius * Math.cos(angle),
        y: 0.5 + radius * Math.sin(angle)
      };
    }
    
    // 重要な顔の特徴点を上書き
    faceLandmarks[1] = { x: 0.5, y: 0.6 }; // 鼻先
    faceLandmarks[33] = { x: 0.4, y: 0.4 }; // 右目外端
    faceLandmarks[263] = { x: 0.6, y: 0.4 }; // 左目外端
    faceLandmarks[133] = { x: 0.45, y: 0.4 }; // 右目内端
    faceLandmarks[362] = { x: 0.55, y: 0.4 }; // 左目内端
    
    const faces = settings.face ? [faceLandmarks] : [];
    console.log('モック検出結果:', { handsCount: hands.length, facesCount: faces.length });
    
    return { hands, faces, pose: [] };
  }
}

const detector = new Detector();

async function ensureCamera() {
  setStatus('カメラ初期化中...', 'warn');
  console.log('カメラ初期化開始');
  
  // 既存ストリームを停止
  try {
    const s = video.srcObject; if (s) s.getTracks().forEach(t => t.stop());
  } catch {}
  
  const want720 = settings.resolution === '720p';
  const base = { width: want720 ? { ideal: 1280 } : { ideal: 640 }, height: want720 ? { ideal: 720 } : { ideal: 480 }, frameRate: { ideal: settings.targetFps } };
  const withDevice = settings.cameraId ? { ...base, deviceId: { exact: settings.cameraId } } : base;
  const tries = [ 
    withDevice, 
    base, 
    { width: { ideal: 640 }, height: { ideal: 480 } }, 
    { width: { min: 320, ideal: 640, max: 1280 }, height: { min: 240, ideal: 480, max: 720 } },
    { width: { min: 160, max: 1920 }, height: { min: 120, max: 1080 } },
    {} 
  ];
  
  console.log('カメラ設定:', { settings, tries });
  
  let lastErr = null;
  for (let i = 0; i < tries.length; i++) {
    const v = tries[i];
    console.log(`試行 ${i + 1}/${tries.length}:`, v);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: v });
      console.log('getUserMedia成功:', s.getVideoTracks()[0]?.getSettings());
      video.srcObject = s;
      
      await new Promise((resolve) => {
        const onMeta = () => { 
          video.removeEventListener('loadedmetadata', onMeta); 
          console.log('video loadedmetadata:', { width: video.videoWidth, height: video.videoHeight });
          resolve(); 
        };
        const to = setTimeout(() => { 
          video.removeEventListener('loadedmetadata', onMeta); 
          console.log('video metadata timeout');
          resolve(); 
        }, 2000);
        if (video.readyState >= 1) { 
          clearTimeout(to); 
          console.log('video already ready:', video.readyState);
          resolve(); 
        }
        else video.addEventListener('loadedmetadata', () => { clearTimeout(to); onMeta(); });
      });
      
      await video.play();
      console.log('video play成功');
      setStatus('DETECTING', 'ok');
      return;
    } catch (e) {
      console.warn(`試行 ${i + 1} 失敗:`, e);
      lastErr = e;
      continue;
    }
  }
  console.warn('getUserMedia失敗:', lastErr);
  let errorMessage = 'カメラ取得失敗。';
  
  if (lastErr?.name === 'NotAllowedError') {
    errorMessage += 'カメラ権限が拒否されました。ブラウザの設定でカメラ権限を許可してください。';
  } else if (lastErr?.name === 'NotFoundError') {
    errorMessage += 'カメラデバイスが見つかりません。';
  } else if (lastErr?.name === 'NotReadableError') {
    errorMessage += 'カメラが他のアプリケーションで使用中です。';
  } else {
    errorMessage += `エラー: ${lastErr?.name || lastErr?.message || 'Unknown error'}`;
  }
  
  setStatus(errorMessage, 'err');
  const errEl = document.getElementById('cam-error');
  if (errEl) errEl.textContent = errorMessage;
}

function dist(a, b) {
  const dx = (a?.x ?? 0) - (b?.x ?? 0);
  const dy = (a?.y ?? 0) - (b?.y ?? 0);
  return Math.sqrt(dx*dx + dy*dy);
}

// より高精度な距離計算（3D座標がある場合）
function dist3D(a, b) {
  if (a?.z !== undefined && b?.z !== undefined) {
    const dx = (a.x ?? 0) - (b.x ?? 0);
    const dy = (a.y ?? 0) - (b.y ?? 0);
    const dz = (a.z ?? 0) - (b.z ?? 0);
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }
  return dist(a, b);
}

// ランドマークの品質チェック
function validateLandmarks(landmarks, pair) {
  const la = landmarks[pair.a];
  const lb = landmarks[pair.b];
  
  if (!la || !lb) return false;
  
  // 座標が有効な範囲内かチェック
  if (la.x < 0 || la.x > 1 || la.y < 0 || la.y > 1) return false;
  if (lb.x < 0 || lb.x > 1 || lb.y < 0 || lb.y > 1) return false;
  
  // 距離が極端に大きすぎないか（外れ値除外）。近すぎる（0付近）は許容。
  const distance = dist(la, lb);
  if (distance > 0.8) return false;
  
  return true;
}

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4], // thumb
  [0,5],[5,6],[6,7],[7,8], // index
  [0,9],[9,10],[10,11],[11,12], // middle
  [0,13],[13,14],[14,15],[15,16], // ring
  [0,17],[17,18],[18,19],[19,20], // pinky
  [5,9],[9,13],[13,17] // palm
];

function drawOverlay(hands) {
  const stageW = overlay.width;
  const stageH = overlay.height;
  ctxOverlay.clearRect(0, 0, stageW, stageH);
  if (!settings.overlay || !hands || hands.length === 0) return;

  // object-fit: contain の幾何
  const vidW = Math.max(1, video.videoWidth);
  const vidH = Math.max(1, video.videoHeight);
  const scale = Math.min(stageW / vidW, stageH / vidH);
  const dispW = vidW * scale;
  const dispH = vidH * scale;
  const offX = (stageW - dispW) / 2;
  const offY = (stageH - dispH) / 2;

  const toStageX = (nx) => offX + nx * dispW;
  const toStageY = (ny) => offY + ny * dispH;

  const colors = ['#4caf50','#03a9f4'];
  for (let i = 0; i < hands.length; i++) {
    const lms = hands[i].landmarks;
    if (!lms) continue;

    // connections
    ctxOverlay.strokeStyle = colors[i % colors.length] + 'cc';
    ctxOverlay.lineWidth = 2;
    ctxOverlay.beginPath();
    for (const [a,b] of HAND_CONNECTIONS) {
      const pa = lms[a], pb = lms[b];
      if (!pa || !pb) continue;
      ctxOverlay.moveTo(toStageX(pa.x), toStageY(pa.y));
      ctxOverlay.lineTo(toStageX(pb.x), toStageY(pb.y));
    }
    ctxOverlay.stroke();

    // points
    ctxOverlay.fillStyle = colors[i % colors.length];
    for (let k = 0; k < lms.length; k++) {
      const p = lms[k];
      if (!p) continue;
      ctxOverlay.beginPath();
      ctxOverlay.arc(toStageX(p.x), toStageY(p.y), 3, 0, Math.PI*2);
      ctxOverlay.fill();
    }

    // selected pair line
    const la = lms[settings.pair.a];
    const lb = lms[settings.pair.b];
    if (la && lb) {
      ctxOverlay.strokeStyle = '#ffffffaa';
      ctxOverlay.lineWidth = 2.5;
      ctxOverlay.beginPath();
      ctxOverlay.moveTo(toStageX(la.x), toStageY(la.y));
      ctxOverlay.lineTo(toStageX(lb.x), toStageY(lb.y));
      ctxOverlay.stroke();
    }
  }
}

// 凸包（単調連鎖法）で顔の外形を近似し塗りつぶす
function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length <= 1) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function drawFaces(faces) {
  if (!settings.overlay || !faces || faces.length === 0) return;
  const stageW = overlay.width;
  const stageH = overlay.height;

  // object-fit: contain 同等の変換
  const vidW = Math.max(1, video.videoWidth);
  const vidH = Math.max(1, video.videoHeight);
  const scale = Math.min(stageW / vidW, stageH / vidH);
  const dispW = vidW * scale;
  const dispH = vidH * scale;
  const offX = (stageW - dispW) / 2;
  const offY = (stageH - dispH) / 2;
  const toStageX = (nx) => offX + nx * dispW;
  const toStageY = (ny) => offY + ny * dispH;

  for (const lm of faces) {
    if (!lm) continue;
    // ステージ座標へ変換
    const pts = lm.map(p => ({ x: toStageX(p.x), y: toStageY(p.y) }));

    // 外形を薄く塗りつぶし
    try {
      const hull = convexHull(pts);
      if (hull.length >= 3) {
        ctxOverlay.fillStyle = 'rgba(255,255,255,0.06)';
        ctxOverlay.beginPath();
        ctxOverlay.moveTo(hull[0].x, hull[0].y);
        for (let i = 1; i < hull.length; i++) ctxOverlay.lineTo(hull[i].x, hull[i].y);
        ctxOverlay.closePath();
        ctxOverlay.fill();
      }
    } catch {}

    // 近傍接続で擬似メッシュ
    const K = 4; // 近傍数
    const faceSize = Math.max(
      Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)),
      Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y))
    );
    const maxDist = Math.max(8, faceSize * 0.08); // px閾値
    const maxDist2 = maxDist * maxDist;
    const edges = new Set();

    for (let i = 0; i < pts.length; i++) {
      // K近傍を探索
      const di = [];
      const pi = pts[i];
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const pj = pts[j];
        const dx = pi.x - pj.x, dy = pi.y - pj.y;
        const d2 = dx*dx + dy*dy;
        if (d2 <= maxDist2) di.push({ j, d2 });
      }
      di.sort((a, b) => a.d2 - b.d2);
      for (let m = 0; m < Math.min(K, di.length); m++) {
        const j = di[m].j;
        const a = Math.min(i, j), b = Math.max(i, j);
        edges.add(a + '-' + b);
      }
    }

    ctxOverlay.strokeStyle = 'rgba(255,255,255,0.6)';
    ctxOverlay.lineWidth = 1;
    ctxOverlay.beginPath();
    edges.forEach(key => {
      const [a, b] = key.split('-').map(Number);
      ctxOverlay.moveTo(pts[a].x, pts[a].y);
      ctxOverlay.lineTo(pts[b].x, pts[b].y);
    });
    ctxOverlay.stroke();

    // ランドマーク点（小さめ、白）
    ctxOverlay.fillStyle = '#ffffff';
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      ctxOverlay.beginPath();
      ctxOverlay.arc(p.x, p.y, 0.8, 0, Math.PI * 2);
      ctxOverlay.fill();
    }
  }
}

// 指の距離（正規化）→明るさ(0..1)へマップ
function drawPoses(poses) {
  if (!settings.overlay || !poses || poses.length === 0) return;
  const stageW = overlay.width;
  const stageH = overlay.height;
  const vidW = Math.max(1, video.videoWidth);
  const vidH = Math.max(1, video.videoHeight);
  const scale = Math.min(stageW / vidW, stageH / vidH);
  const dispW = vidW * scale;
  const dispH = vidH * scale;
  const offX = (stageW - dispW) / 2;
  const offY = (stageH - dispH) / 2;
  const toStageX = (nx) => offX + nx * dispW;
  const toStageY = (ny) => offY + ny * dispH;

  // 代表的な骨格接続（MediaPipe Pose 33点準拠の一部）
  const C = [
    [11,12],[11,13],[13,15],[12,14],[14,16], // 肩-肘-手首
    [23,24],[11,23],[12,24],                 // 胴体
    [23,25],[25,27],[24,26],[26,28],         // 腰-膝-足首
  ];

  ctxOverlay.strokeStyle = '#ffcc00cc';
  ctxOverlay.lineWidth = 2;
  ctxOverlay.beginPath();
  for (const lm of poses) {
    for (const [a,b] of C) {
      const pa = lm[a], pb = lm[b];
      if (!pa || !pb) continue;
      ctxOverlay.moveTo(toStageX(pa.x), toStageY(pa.y));
      ctxOverlay.lineTo(toStageX(pb.x), toStageY(pb.y));
    }
  }
  ctxOverlay.stroke();

  ctxOverlay.fillStyle = '#ffcc00';
  for (const lm of poses) {
    for (let i = 0; i < lm.length; i++) {
      const p = lm[i]; if (!p) continue;
      ctxOverlay.beginPath();
      ctxOverlay.arc(toStageX(p.x), toStageY(p.y), 2, 0, Math.PI*2);
      ctxOverlay.fill();
    }
  }
}

// 指の距離（正規化）→明るさ(0..1)へマップ
function distanceToBrightnessNorm(d) {
  if (d == null || Number.isNaN(d)) return null;
  const n = (d - BRIGHTNESS_NORM_MIN) / (BRIGHTNESS_NORM_MAX - BRIGHTNESS_NORM_MIN);
  return Math.max(0, Math.min(1, n));
}

function updateValues(handIdx, norm, px) {
  const normStr = norm == null ? 'N/A' : norm.toFixed(3);
  const pxStr = px == null ? 'N/A' : px.toFixed(1);
  // バーの正規化は表示中の対角長で行う
  const diag = Math.hypot(overlay.width, overlay.height) || 1;
  if (handIdx === 0) {
    valNorm1.textContent = normStr;
    valPx1.textContent = pxStr;
    barNorm1.style.width = `${clamp((norm ?? 0) * 100, 0, 100)}%`;
    barPx1.style.width = `${clamp(((px ?? 0) / diag) * 100, 0, 100)}%`;
  } else if (handIdx === 1) {
    valNorm2.textContent = normStr;
    valPx2.textContent = pxStr;
    barNorm2.style.width = `${clamp((norm ?? 0) * 100, 0, 100)}%`;
    barPx2.style.width = `${clamp(((px ?? 0) / diag) * 100, 0, 100)}%`;
  }
}

async function loop(ts) {
  requestAnimationFrame(loop);
  const minDelta = 1000 / settings.targetFps - 1;
  if (ts - lastFrameTs < minDelta) return;
  lastFrameTs = ts;
  if (!detector.ready) return;

  // 3Dモード中でも顔トラッキングのみ実行
  if (threeVisible) {
    console.log('3Dモード - 顔トラッキング処理開始');
    
    // カメラが停止していないかチェック
    if (!video.srcObject) {
      console.warn('3Dモード中にカメラストリームが停止している');
      // カメラを再開（3Dモード時はカメラを停止すべきではない）
      await ensureCamera();
    }
    
    if (video.readyState >= 2 && detector.ready) {
      console.log('3Dモード検出処理:', { 
        faceEnabled: settings.face, 
        videoReady: video.readyState >= 2,
        detectorReady: detector.ready,
        threeReady 
      });
      
      const res = detector.detect(video, ts);
      const faces = res.faces || [];
      const faceMats = res.faceTransforms || [];
      console.log('3Dモード検出結果:', { facesCount: faces.length });
      
      // 3Dカメラ連動（顔）
      if (threeReady && settings.face && (faces.length > 0 || (Array.isArray(faceMats) && faceMats.length > 0))) {
        let pose;
        if (Array.isArray(faceMats) && faceMats.length > 0) {
          const m = faceMats[0];
          // MediaPipeは列優先Float32Arrayまたは配列16要素を返す想定
          const arr = m?.data ? Array.from(m.data) : (Array.isArray(m) ? m : null);
          if (arr && arr.length === 16) {
            pose = { matrix: arr };
          }
        }
        if (!pose && faces[0]?.length) {
          pose = estimateFacePose(faces[0]);
        }
        try { 
          threeMod.updateCameraFromFacePose(pose); 
          console.log('顔トラッキング更新成功:', pose);
        } catch (e) {
          console.warn('顔トラッキング更新失敗:', e);
        }
      } else if (settings.face) {
        console.log('顔トラッキング条件不満足:', {
          threeReady,
          faceEnabled: settings.face,
          facesDetected: faces.length > 0
        });
      }
    } else {
      console.log('3Dモード検出スキップ:', {
        videoReady: video.readyState >= 2,
        detectorReady: detector.ready
      });
    }
    drawChart();
    return;
  }
  
  // video要素の状態をログ出力（初回のみ）
  if (ts - lastFrameTs < 1000) {
    console.log('video状態:', {
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      srcObject: !!video.srcObject,
      paused: video.paused,
      ended: video.ended
    });
  }
  
  if (video.readyState < 2) return;

  const res = detector.detect(video, ts);
  // 表示幾何を計算（object-fit: contain 基準）
  const stageW = overlay.width;
  const stageH = overlay.height;
  const vidW = Math.max(1, video.videoWidth);
  const vidH = Math.max(1, video.videoHeight);
  const scale = Math.min(stageW / vidW, stageH / vidH);
  const dispW = vidW * scale;
  const dispH = vidH * scale;

  resizeCanvases();

  const hands = res.hands || [];
  const faces = res.faces || [];
  const poses = res.pose || [];
  const n = Math.min(2, hands.length);
  const statusKind = n === 0 && faces.length === 0
    ? 'warn'
    : (hands.some(h => (h.confidence ?? 1) < 0.6) ? 'warn' : 'ok');
  setStatus(n === 0 && faces.length === 0 ? 'NO HAND/FACE' : 'DETECTING', statusKind);
  // 手の描画（クリア込み）
  drawOverlay(hands);
  // 顔の描画（重畳）
  if (settings.face && faces.length > 0) {
    drawFaces(faces);
  }
  // ポーズの描画（Holistic使用時）
  if (settings.holistic && poses.length > 0) {
    drawPoses(poses);
  }

  // 3Dカメラ連動は3Dモード時のループで処理済み

  for (let i = 0; i < 2; i++) {
    if (i < n) {
      const lms = hands[i].landmarks;
      const conf = hands[i].confidence;
      
      // 品質チェック
      if (!validateLandmarks(lms, settings.pair)) {
        console.log(`手${i+1}: ランドマーク品質チェック失敗`);
        emaUpdate(i, null);
        if (i === 0) pushSeries(null);
        updateValues(i, null, null);
        continue;
      }
      
      const la = lms[settings.pair.a];
      const lb = lms[settings.pair.b];
      const dNorm = dist(la, lb);
      const dEma = emaUpdate(i, dNorm);

      if (i === 0) pushSeries(dEma);
      if (i === 0) fingerDistEma0 = dEma;
      // ピクセル距離は表示中サイズで換算
      let outPx = null;
      if (dEma != null) {
        const dxPx = (la.x - lb.x) * dispW;
        const dyPx = (la.y - lb.y) * dispH;
        outPx = Math.hypot(dxPx, dyPx);
      }
      updateValues(i, dEma, outPx);
    } else {
      emaUpdate(i, null);
      if (i === 0) pushSeries(null);
      updateValues(i, null, null);
    }
  }
  // 明るさ制御（手1の指間距離ベース）
  const mode = settings.brightnessMode || 'off';
  if (mode !== 'off' && n > 0) {
    const norm = distanceToBrightnessNorm(fingerDistEma0);
    if (norm != null) {
      if (brightnessEma == null) brightnessEma = norm;
      brightnessEma = lerp(brightnessEma, norm, 0.25);
      updateBrightnessLabel(brightnessEma);

      if (mode === 'app') {
        const b = BRIGHTNESS_MIN + (BRIGHTNESS_MAX - BRIGHTNESS_MIN) * brightnessEma;
        document.querySelector('.stage').style.filter = `brightness(${b.toFixed(3)})`;
      } else if (mode === 'system') {
        const now = performance.now();
        if (now - lastBrightnessAt > BRIGHTNESS_SEND_INTERVAL_MS && Math.abs(brightnessEma - lastBrightnessSent) > 0.05) {
          lastBrightnessAt = now;
          lastBrightnessSent = brightnessEma;
          window.api?.setSystemBrightness?.(Math.max(0, Math.min(1, brightnessEma))).then((ok) => {
            if (!ok) {
              const b = BRIGHTNESS_MIN + (BRIGHTNESS_MAX - BRIGHTNESS_MIN) * brightnessEma;
              document.querySelector('.stage').style.filter = `brightness(${b.toFixed(3)})`;
            }
          });
        }
      }
    } else {
      updateBrightnessLabel(null);
    }
  } else {
    updateBrightnessLabel();
  }

  drawChart();
}

function bindUI() {
  for (const k of ['pair-a','pair-b','alpha','fps','res','unit','overlay-on','confidence','history','brightness-mode','video-visible','face-on','holistic-on','depth-source','depth-format']) {
    el(k).addEventListener('change', async () => {
      settings = collectSettingsFromUI();
      // 設定変更時に履歴をリセット
      landmarkHistory = [[], []];
      confidenceThreshold = settings.confidenceThreshold;
      await saveSettings();
      if (k === 'brightness-mode') {
        // OFF時にフィルタを解除
        if (settings.brightnessMode === 'off') {
          document.querySelector('.stage').style.filter = '';
        }
        updateBrightnessLabel();
      }
      if (k === 'video-visible') {
        applyVideoVisibility();
        resizeCanvases();
      }
      if (k === 'face-on') {
        // 顔検出ONの場合、初期化済みならそのまま、未初期化なら次回起動時に有効
        // ここでは表示のみ即時反映（検出はdetector.fmの有無に依存）
      }
      if (k === 'holistic-on') {
        // Holisticは初期化済みなら即反映。未配置の場合はフォールバック。
      }
    });
  }
  const retryBtn = document.getElementById('retry');
  retryBtn?.addEventListener('click', async () => {
    settings = collectSettingsFromUI();
    await saveSettings();
    await ensureCamera();
  });
  const startBtn = document.getElementById('start');
  startBtn?.addEventListener('click', async () => {
    settings = collectSettingsFromUI();
    await saveSettings();
    await ensureCamera();
  });

  // メイン表示切替
  const mainSel = document.getElementById('main-display');
  mainSel?.addEventListener('change', async () => {
    const mode = mainSel.value;
    await setMainDisplay(mode);
  });

  // 3D: 画像選択
  const pickBtn = document.getElementById('pick-image');
  pickBtn?.addEventListener('click', async () => {
    const picked = await window.api?.pickImage?.();
    if (picked && picked.rel && picked.abs) {
      selectedImageRel = picked.rel;
      selectedImageAbs = picked.abs;
      selectedDepthRel = null;
      document.getElementById('three-hint').textContent = `選択: ${picked.name}`;
      const prev = document.getElementById('img-preview');
      if (prev) prev.src = selectedImageRel;
      // ステージ画像は最初は非表示のまま（3Dモードや画像表示モードの時のみ表示）
      const stageImg = document.getElementById('stage-img');
      if (stageImg) { 
        stageImg.src = selectedImageRel; 
        stageImg.style.display = 'none'; // 画像選択時は非表示のまま
      }

      // 画像選択時は3D準備のみ行い、自動表示はしない
      console.log('画像選択完了、プレビュー表示と3D準備');
      
      // 深度マップの自動検索
      let depthRel = null;
      if ((document.getElementById('depth-source')?.value || 'auto') === 'auto') {
        depthRel = await resolveDepthPath(selectedImageRel);
        if (depthRel) {
          selectedDepthRel = depthRel;
          const dp = document.getElementById('depth-preview');
          if (dp) dp.src = selectedDepthRel;
          document.getElementById('three-hint').textContent = '画像選択完了。深度マップも発見しました。「3D表示切替」ボタンで3D表示可能。';
        } else {
          document.getElementById('three-hint').textContent = '画像選択完了。「深度生成」または「3D表示切替」ボタンをお使いください。';
        }
      } else {
        document.getElementById('three-hint').textContent = '画像選択完了。「深度生成」または「3D表示切替」ボタンをお使いください。';
      }
      
      // 画像プレビューのみ表示（3Dモードは手動切替に変更）
      console.log('画像プレビュー表示、3Dは手動切替待ち');
    } else {
      document.getElementById('three-hint').textContent = '画像選択をキャンセル';
    }
  });

  // 3D: 深度生成
  const genBtn = document.getElementById('gen-depth');
  genBtn?.addEventListener('click', async () => {
    if (!selectedImageAbs) {
      document.getElementById('three-hint').textContent = '先に画像を選択';
      return;
    }
    document.getElementById('three-hint').textContent = '深度生成中...';
    const out = await window.api?.generateDepth?.(selectedImageAbs);
    if (out && out.rel) {
      selectedDepthRel = out.rel;
      document.getElementById('three-hint').textContent = `深度生成: ${out.name}`;
      const dp = document.getElementById('depth-preview');
      if (dp) dp.src = selectedDepthRel;
      // 表示モードが深度ならメインも更新
      const mainSel = document.getElementById('main-display');
      if (mainSel?.value === 'depth') {
        const stageImg = document.getElementById('stage-img');
        if (stageImg) stageImg.src = selectedDepthRel;
      }

      // 3Dモード中なら即反映
      if (threeReady && threeVisible && selectedImageRel) {
        try {
          await threeMod.setTextures(selectedImageRel, selectedDepthRel);
          document.getElementById('three-hint').textContent = '3D: 画像+深度を表示（更新）';
        } catch (e) {
          try {
            await threeMod.setImageOnly(selectedImageRel);
            document.getElementById('three-hint').textContent = '3D: 深度反映失敗のため画像のみ';
          } catch {}
        }
      }
    } else {
      document.getElementById('three-hint').textContent = '深度生成に失敗。Python環境/モデルを確認。';
    }
  });

  // 3D: 深度マップ選択
  const pickDepthBtn = document.getElementById('pick-depth');
  pickDepthBtn?.addEventListener('click', async () => {
    const picked = await window.api?.pickDepth?.();
    if (picked && picked.rel && picked.abs) {
      selectedDepthRel = picked.rel;
      document.getElementById('three-hint').textContent = `深度マップ選択: ${picked.name}`;
      const dp = document.getElementById('depth-preview');
      if (dp) dp.src = selectedDepthRel;
      
      // 深度マップ形式に応じた処理
      const format = document.getElementById('depth-format')?.value || 'grayscale';
      await processDepthFormat(selectedDepthRel, format);
      
      // 3Dモード中なら即反映
      if (threeReady && threeVisible && selectedImageRel) {
        try {
          await threeMod.setTextures(selectedImageRel, selectedDepthRel);
          document.getElementById('three-hint').textContent = '深度マップ適用完了。3D表示を更新しました。';
        } catch (e) {
          console.error('深度マップ適用失敗:', e);
          document.getElementById('three-hint').textContent = `深度マップ適用失敗: ${e.message}`;
        }
      }
    } else {
      document.getElementById('three-hint').textContent = '深度マップ選択をキャンセル';
    }
  });

  // 3D: 表示切替
  const tglBtn = document.getElementById('toggle-3d');
  tglBtn?.addEventListener('click', async () => {
    await setThreeMode(!threeVisible);
  });
}

async function main() {
  await loadSettings();
  applySettingsToUI();
  applyVideoVisibility();
  bindUI();
  await populateCameras();
  await detector.init();
  
  // video要素のイベントリスナーを追加
  video.addEventListener('loadedmetadata', () => {
    console.log('video loadedmetadata event:', { width: video.videoWidth, height: video.videoHeight });
  });
  
  video.addEventListener('canplay', () => {
    console.log('video canplay event');
  });
  
  video.addEventListener('playing', () => {
    console.log('video playing event');
  });
  
  video.addEventListener('error', (e) => {
    console.error('video error event:', e);
  });
  
  // 自動でカメラを開始
  setStatus('カメラ自動開始中...', 'warn');
  await ensureCamera();
  requestAnimationFrame(loop);
}

main();

async function populateCameras() {
  try {
    console.log('カメラデバイス列挙開始');
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log('全デバイス:', devices);
    
    const cams = devices.filter(d => d.kind === 'videoinput');
    console.log('カメラデバイス:', cams);
    
    const sel = document.getElementById('camera');
    if (!sel) return;
    sel.innerHTML = '';
    
    for (const d of cams) {
      const opt = document.createElement('option');
      opt.value = d.deviceId; 
      opt.textContent = d.label || `Camera ${sel.length+1}`;
      sel.appendChild(opt);
      console.log('カメラオプション追加:', { deviceId: d.deviceId, label: d.label });
    }
    
    if (settings.cameraId) sel.value = settings.cameraId;
    sel.addEventListener('change', async () => {
      settings.cameraId = sel.value || null;
      console.log('カメラ選択変更:', settings.cameraId);
      await saveSettings();
      await ensureCamera();
    });
  } catch (e) {
    console.warn('enumerateDevices失敗:', e);
  }
}

function stopCamera() {
  try {
    const s = video.srcObject; if (s) { s.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  } catch {}
}

async function setThreeMode(on) {
  threeVisible = on;
  const container = document.getElementById('three-container');
  container.style.display = threeVisible ? '' : 'none';
  if (threeVisible) {
    // 3Dモード時はカメラを停止せず、顔トラッキングのために継続
    console.log('3Dモード開始 - カメラ継続');
    setStatus('3D PREVIEW', 'ok');
    // 明るさフィルタ等を解除
    const stage = document.querySelector('.stage');
    if (stage) stage.style.filter = '';
    applyVideoVisibility();
    // 初期化
    if (!threeReady) {
      try {
        console.log('setThreeMode: Three.js初期化開始');
        threeMod = await import('./three_view.js');
        await threeMod.initThree(container);
        threeReady = true;
        console.log('setThreeMode: Three.js初期化成功');
      } catch (threeError) {
        console.error('setThreeMode: Three.js初期化失敗:', threeError);
        document.getElementById('three-hint').textContent = `3D初期化失敗: ${threeError.message}`;
        return;
      }
    }
    // テクスチャ適用
    if (selectedImageRel) {
      let depthRel = selectedDepthRel;
      if (!depthRel && (document.getElementById('depth-source')?.value || 'auto') === 'auto') {
        depthRel = await resolveDepthPath(selectedImageRel);
      }
      try {
        console.log('テクスチャ適用開始:', { selectedImageRel, depthRel });
        if (depthRel) {
          selectedDepthRel = depthRel;
          await threeMod.setTextures(selectedImageRel, depthRel);
          document.getElementById('three-hint').textContent = '3D: 画像+深度を表示';
          console.log('3D表示成功: 画像+深度');
        } else {
          await threeMod.setImageOnly(selectedImageRel);
          document.getElementById('three-hint').textContent = '3D: 画像のみを表示';
          console.log('3D表示成功: 画像のみ');
        }
        const stageImg2 = document.getElementById('stage-img');
        if (stageImg2) stageImg2.style.display = 'none';
      } catch (e) {
        // Three失敗: HTML画像を表示し続ける
        console.error('3Dテクスチャ適用失敗:', e);
        const stageImg2 = document.getElementById('stage-img');
        if (stageImg2) { stageImg2.src = selectedImageRel; stageImg2.style.display = ''; }
        document.getElementById('three-hint').textContent = `3D描画失敗: ${e.message}。HTML画像で表示`;
      }
    } else {
      document.getElementById('three-hint').textContent = '先に画像を選択';
    }
    resizeCanvases();
  } else {
    // 3Dモードを終了してカメラビューに戻る
    console.log('3Dモード終了、カメラビューに戻る');
    setStatus('DETECTING', 'ok');
    // ステージ画像を非表示にしてカメラビューを復活
    const stageImg = document.getElementById('stage-img');
    if (stageImg) stageImg.style.display = 'none';
    applyVideoVisibility();
    // カメラ再開
    await ensureCamera();
  }
}

async function setMainDisplay(mode) {
  const stageImg = document.getElementById('stage-img');
  const container = document.getElementById('three-container');
  if (mode === 'camera') {
    // カメラモードに戻る
    await setThreeMode(false);
  } else if (mode === '3d') {
    // 3DモードON
    if (stageImg) stageImg.style.display = 'none';
    await setThreeMode(true);
  } else if (mode === 'image') {
    // カメラ停止＋HTML画像表示
    stopCamera();
    threeVisible = false; // 3Dモードは無効
    if (container) container.style.display = 'none';
    if (selectedImageRel && stageImg) { 
      stageImg.src = selectedImageRel;
      stageImg.style.display = '';
    }
    applyVideoVisibility();
    setStatus('IMAGE PREVIEW', 'ok');
  } else if (mode === 'depth') {
    // カメラ停止＋深度画像表示
    stopCamera();
    threeVisible = false; // 3Dモードは無効
    if (container) container.style.display = 'none';
    if (selectedDepthRel && stageImg) { 
      stageImg.src = selectedDepthRel;
      stageImg.style.display = '';
    }
    applyVideoVisibility();
    setStatus('DEPTH PREVIEW', 'ok');
  }
}

// 顔姿勢の簡易推定（2Dランドマークのみの近似）
function estimateFacePose(landmarks) {
  // 目の外端/内端、鼻先、目の中心などの代表点ID（FaceMesh準拠近似）
  // 右目外端: 33, 左目外端: 263, 右目内端: 133, 左目内端: 362, 鼻先: 1
  const p = (i) => landmarks[i] || null;
  const rOuter = p(33), lOuter = p(263), rInner = p(133), lInner = p(362), nose = p(1);
  if (!rOuter || !lOuter || !rInner || !lInner || !nose) return { yaw:0, pitch:0, roll:0, tx:0, ty:0 };

  // 顔の中心（両目外端の中点）
  const cx = (rOuter.x + lOuter.x) / 2;
  const cy = (rOuter.y + lOuter.y) / 2;

  // yaw: 鼻先のx偏差
  const yaw = (nose.x - cx) * 3.0;
  // pitch: 鼻先のy偏差（上向き負）
  const pitch = (cy - nose.y) * 3.0;
  // roll: 両目外端の傾き
  const dx = lOuter.x - rOuter.x; const dy = lOuter.y - rOuter.y;
  const roll = Math.atan2(dy, dx);

  // 平行移動（視差的カメラパン）
  const tx = (cx - 0.5) * 2.0;
  const ty = (cy - 0.5) * 2.0;
  return { yaw, pitch, roll, tx, ty };
}

async function processDepthFormat(depthPath, format) {
  // 深度マップ形式に応じた処理
  try {
    console.log('深度マップ形式処理:', { depthPath, format });
    
    switch (format) {
      case 'grayscale':
        // グレースケール深度マップ（標準）
        document.getElementById('three-hint').textContent += ' - グレースケール形式で処理中。';
        break;
        
      case 'raw16bit':
        // 16-bit Raw出力の処理
        document.getElementById('three-hint').textContent += ' - 16-bit Raw形式で処理中。特別な正規化を適用。';
        // 16-bit画像の正規化は Three.js 側で自動的に処理される
        break;
        
      case 'colorized':
        // カラー可視化深度マップの処理
        document.getElementById('three-hint').textContent += ' - カラー可視化形式で処理中。グレースケール変換を適用。';
        // カラー深度マップは Three.js で自動的にグレースケールに変換される
        break;
        
      default:
        console.warn('未知の深度マップ形式:', format);
    }
  } catch (error) {
    console.error('深度マップ形式処理でエラー:', error);
  }
}

async function resolveDepthPath(imageRel) {
  // 自動: 同名ファイルを /public/generated/depth に探索
  try {
    const name = imageRel.split('/').pop().replace(/\.[^.]+$/, '') + '_depth.png';
    const cand = '/public/generated/depth/' + name;
    // 実際の存在確認は省略（静的サーバで404ならTextureLoader失敗）
    return cand;
  } catch { return null; }
}
