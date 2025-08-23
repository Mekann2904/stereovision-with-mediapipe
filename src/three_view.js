// Three.js based 3D displacement preview
// 画像テクスチャ + 深度（グレースケールPNG想定）をdisplacementMapとして適用

let THREE = null;
let renderer, scene, camera, mesh;
let containerEl;
let width = 0, height = 0;
let imageTex = null;
let depthTex = null;

export async function initThree(container) {
  if (!THREE) {
    try {
      // CDNからThree.jsを読み込み（バックアップとして）
      const cdnUrl = 'https://unpkg.com/three@0.158.0/build/three.module.js';
      console.log('Three.js初期化開始');
      
      // まずローカルのnode_modulesを試す
      try {
        const modUrl = new URL('/node_modules/three/build/three.module.js', window.location.origin).toString();
        console.log('ローカルThree.jsを試行:', modUrl);
        THREE = await import(modUrl);
        console.log('ローカルThree.js読み込み成功');
      } catch (localError) {
        console.log('ローカルThree.js読み込み失敗、CDNにフォールバック:', localError.message);
        THREE = await import(cdnUrl);
        console.log('CDN Three.js読み込み成功');
      }
    } catch (error) {
      console.error('Three.js読み込みに完全に失敗:', error);
      throw new Error(`Three.js読み込み失敗: ${error.message}`);
    }
  }
  try {
    console.log('Three.jsシーン初期化開始');
    containerEl = container;
    if (!containerEl) {
      throw new Error('コンテナ要素が指定されていません');
    }
    
    scene = new THREE.Scene();
    console.log('シーン作成完了');
    
    // 2Dプレビュー安定のため直交投影を使用（画面内収納重視）
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 2.0);
    scene.add(camera);
    console.log('カメラ設定完了（画面内収納重視）');

    renderer = new THREE.WebGLRenderer({ 
      antialias: true, 
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true
    });
    console.log('WebGLレンダラー作成完了');
    
    // 色管理と背景
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 1);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    
    // 色の正確性を向上させる設定
    renderer.physicallyCorrectLights = false; // 古いバージョン互換性
    
    console.log('レンダラー設定:', {
      outputColorSpace: renderer.outputColorSpace,
      premultipliedAlpha: renderer.getContextAttributes().premultipliedAlpha
    });
    
    containerEl.innerHTML = '';
    containerEl.appendChild(renderer.domElement);
    // ステージ内に厳密固定（CSS依存を避け、JSでも明示）
    const cvs = renderer.domElement;
    cvs.style.position = 'absolute';
    cvs.style.top = '0';
    cvs.style.left = '0';
    cvs.style.width = '100%';
    cvs.style.height = '100%';
    cvs.style.display = 'block';
    console.log('レンダラーDOM要素追加完了');
    
    resize();
    console.log('初期リサイズ完了');

    // より高解像度のジオメトリで3D効果を向上
    const geom = new THREE.PlaneGeometry(1, 1, 512, 512);
    // 既定は画像のみを想定し、ライト不要のBasicMaterialを使用
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    mesh = new THREE.Mesh(geom, mat);
    scene.add(mesh);
    console.log('高解像度メッシュ作成・追加完了（512x512セグメント）');

    // ライトは必要時に追加（標準マテリアルへ切替時）

    animate();
    console.log('Three.js初期化完全に成功');
  } catch (error) {
    console.error('Three.js初期化中にエラー:', error);
    throw error;
  }
}

export function resize() {
  try {
    if (!containerEl || !renderer || !camera) {
      console.warn('resize: 必要な要素が初期化されていません', {
        containerEl: !!containerEl,
        renderer: !!renderer,
        camera: !!camera
      });
      return;
    }
    
    const w = Math.max(1, containerEl.clientWidth);
    const h = Math.max(1, containerEl.clientHeight);
    console.log('Three.js resize:', { width: w, height: h });
    
    width = w; height = h;
    renderer.setSize(w, h, false);
    
    // Orthoカメラは左右上下を比率に応じて調整
    const aspect = w / h;
    const view = 1;
    if (aspect >= 1) {
      camera.left = -view * aspect;
      camera.right = view * aspect;
      camera.top = view;
      camera.bottom = -view;
    } else {
      camera.left = -view;
      camera.right = view;
      camera.top = view / aspect;
      camera.bottom = -view / aspect;
    }
    camera.updateProjectionMatrix();
    console.log('カメラ投影行列更新完了');
    
    // メッシュのスケールも再計算（画面サイズに合わせる）
    if (mesh && imageTex) {
      const iw = imageTex.image?.naturalWidth || imageTex.image?.width || 1;
      const ih = imageTex.image?.naturalHeight || imageTex.image?.height || 1;
      const imageAspect = iw / ih;
      const containerAspect = w / h;
      
      let scaleX, scaleY;
      
      // 適応的スケーリング（setTexturesと同じロジック）
      if (imageAspect > 2.0) {
        // 極端に横長の画像
        scaleY = 1;
        scaleX = Math.min(imageAspect / containerAspect, 2.0);
      } else if (imageAspect < 0.5) {
        // 極端に縦長の画像
        scaleX = 1;
        scaleY = Math.min(1 / imageAspect * containerAspect, 2.0);
      } else if (imageAspect > containerAspect) {
        scaleX = 1;
        scaleY = 1 / imageAspect * containerAspect;
      } else {
        scaleX = imageAspect / containerAspect;
        scaleY = 1;
      }
      
      // 適応的スケールファクター
      let scaleFactor;
      if (imageAspect > 1.5 || imageAspect < 0.7) {
        scaleFactor = 0.8;
      } else {
        scaleFactor = 0.9;
      }
      
      mesh.scale.set(scaleX * scaleFactor, scaleY * scaleFactor, 1);
      console.log('リサイズ時適応的メッシュスケール更新:', { 
        imageAspect, 
        containerAspect, 
        scaleX: scaleX * scaleFactor, 
        scaleY: scaleY * scaleFactor,
        scaleFactor
      });
    }
  } catch (error) {
    console.error('リサイズ中にエラー:', error);
  }
}

export async function setTextures(imagePath, depthPath) {
  try {
    if (!THREE || !mesh) {
      console.warn('setTextures: Three.jsまたはメッシュが初期化されていません', {
        THREE: !!THREE,
        mesh: !!mesh
      });
      return;
    }
    
    console.log('テクスチャ設定開始:', { imagePath, depthPath });
    const loader = new THREE.TextureLoader();
    const baseUrl = window.location.origin;
    const toURL = (p) => new URL(p, baseUrl).toString();

    // 画像
    console.log('画像テクスチャ読み込み開始:', toURL(imagePath));
    try {
      imageTex = await new Promise((res, rej) => {
        loader.load(
          toURL(imagePath),
          (texture) => {
            console.log('画像テクスチャ読み込み成功:', {
              width: texture.image?.width,
              height: texture.image?.height
            });
            res(texture);
          },
          undefined,
          (error) => {
            console.error('画像テクスチャ読み込み失敗:', error);
            rej(error);
          }
        );
      });
      
      // テクスチャ設定を慎重に行う
      imageTex.colorSpace = THREE.SRGBColorSpace;
      imageTex.generateMipmaps = false;
      imageTex.minFilter = THREE.LinearFilter;
      imageTex.magFilter = THREE.LinearFilter;
      imageTex.wrapS = imageTex.wrapT = THREE.ClampToEdgeWrapping;
      // HTML画像の通常座標系に合わせ上下反転を有効化（デプスマップと整合）
      imageTex.flipY = true;
      
      // テクスチャの詳細情報をログ出力
      console.log('画像テクスチャ設定完了:', {
        colorSpace: imageTex.colorSpace,
        format: imageTex.format,
        type: imageTex.type,
        flipY: imageTex.flipY,
        imageData: !!imageTex.image
      });
    } catch (imageError) {
      console.error('画像テクスチャでエラー:', imageError);
      throw imageError;
    }
    
    // 深度（任意）。未指定なら画像のみ表示。
    if (depthPath) {
      console.log('深度テクスチャ読み込み開始:', toURL(depthPath));
      try {
        depthTex = await new Promise((res, rej) => {
          loader.load(
            toURL(depthPath),
            (texture) => {
              console.log('深度テクスチャ読み込み成功');
              res(texture);
            },
            undefined,
            (error) => {
              console.error('深度テクスチャ読み込み失敗:', error);
              rej(error);
            }
          );
        });
        
        // 深度マップ形式に応じた設定
        depthTex.wrapS = depthTex.wrapT = THREE.ClampToEdgeWrapping;
        depthTex.minFilter = THREE.LinearFilter;
        depthTex.magFilter = THREE.LinearFilter;
        // 画像テクスチャと上下方向を一致させる
        depthTex.flipY = true;
        
        // 16-bit画像の場合の特別な設定
        const filename = depthPath.toLowerCase();
        if (filename.includes('16bit') || filename.includes('raw') || filename.endsWith('.tiff') || filename.endsWith('.tif')) {
          console.log('16-bit深度マップを検出、特別な設定を適用');
          depthTex.type = THREE.UnsignedShortType;
          depthTex.format = THREE.RedFormat;
        }
        
        // カラー深度マップの場合
        if (filename.includes('color') || filename.includes('vis')) {
          console.log('カラー深度マップを検出、輝度変換を適用');
          // Three.jsは自動的にRGB->グレースケール変換を行う
        }
        
        console.log('深度テクスチャ設定完了');
      } catch (depthError) {
        console.warn('深度テクスチャでエラー、画像のみで続行:', depthError);
        depthTex = null;
      }
    } else {
      depthTex = null;
      console.log('深度テクスチャなし、画像のみで設定');
    }

    // 画像・コンテナのアスペクト比を先に算出（以降で参照）
    const iw = imageTex.image?.naturalWidth || imageTex.image?.width || 1;
    const ih = imageTex.image?.naturalHeight || imageTex.image?.height || 1;
    const imageAspect = iw / ih;
    const containerAspect = (width || 1) / (height || 1);
    console.log('画像/コンテナアスペクト準備:', { iw, ih, imageAspect, containerAspect });

    // マテリアルを状況に応じて切替
    if (depthTex) {
      console.log('StandardMaterial（深度あり）で設定');
      const mat = new THREE.MeshStandardMaterial({ 
        map: imageTex,
        displacementMap: depthTex,
        color: 0xffffff, 
        roughness: 0.9, 
        metalness: 0.0, 
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1.0
      });
      
      // テクスチャが正しく設定されているかチェック
      console.log('StandardMaterial設定:', {
        hasMainTexture: !!mat.map,
        hasDepthTexture: !!mat.displacementMap,
        imageSize: imageTex ? { 
          width: imageTex.image?.width, 
          height: imageTex.image?.height 
        } : null,
        depthSize: depthTex ? {
          width: depthTex.image?.width,
          height: depthTex.image?.height
        } : null
      });
      
      // 画像のアスペクト比に応じてディスプレースメントを調整
      let displacementScale, displacementBias;
      if (imageAspect > 1.5) {
        // 横長画像：控えめなディスプレースメント
        displacementScale = 0.15;
        displacementBias = -0.075;
      } else if (imageAspect < 0.7) {
        // 縦長画像：少し強めのディスプレースメント
        displacementScale = 0.25;
        displacementBias = -0.125;
      } else {
        // 通常の画像：標準設定
        displacementScale = 0.2;
        displacementBias = -0.1;
      }
      
      mat.displacementScale = displacementScale;
      mat.displacementBias = displacementBias;
      mesh.material = mat;
      
      // マテリアルの更新を強制
      mat.needsUpdate = true;
      if (mat.map) mat.map.needsUpdate = true;
      if (mat.displacementMap) mat.displacementMap.needsUpdate = true;
      
      console.log('ディスプレースメント設定:', { displacementScale, displacementBias, imageAspect });
      // ライト追加（なければ）
      if (!scene.getObjectByName('ambient')) {
        const amb = new THREE.AmbientLight(0xffffff, 0.6); amb.name = 'ambient'; scene.add(amb);
        console.log('アンビエントライト追加');
      }
      if (!scene.getObjectByName('dir')) {
        const dir = new THREE.DirectionalLight(0xffffff, 0.6); dir.name = 'dir'; dir.position.set(0.4, 0.7, 1.0); scene.add(dir);
        console.log('ディレクショナルライト追加');
      }
    } else {
      console.log('BasicMaterial（画像のみ）で設定');
      // 画像のみの場合はBasicMaterialを使用してテクスチャ表示を確実にする
      const mat = new THREE.MeshBasicMaterial({ 
        map: imageTex,
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1.0
      });
      
      // テクスチャが正しく設定されているかチェック
      console.log('BasicMaterial設定:', {
        hasTexture: !!mat.map,
        textureLoaded: !!imageTex,
        imageSize: imageTex ? { 
          width: imageTex.image?.width, 
          height: imageTex.image?.height 
        } : null
      });
      
      mesh.material = mat;
      
      // マテリアルとテクスチャの更新を強制
      mat.needsUpdate = true;
      if (mat.map) mat.map.needsUpdate = true;
      
      console.log('BasicMaterial適用完了 - 画像テクスチャのみ');
    }

    // 画像アスペクトに合わせてメッシュのスケール調整（画面幅に合わせる）
    console.log('画像アスペクト比:', { width: iw, height: ih, aspect: imageAspect });
    // コンテナのアスペクト比を取得
    console.log('コンテナアスペクト比:', { width, height, aspect: containerAspect });
    
    // あらゆる画像に対応する適応的スケーリング
    let scaleX, scaleY;
    
    // 画像が極端に横長（パノラマ風）の場合の特別処理
    if (imageAspect > 2.0) {
      // 極端に横長の画像：高さを基準にして幅を制限
      scaleY = 1;
      scaleX = Math.min(imageAspect / containerAspect, 2.0); // 最大2倍まで
      console.log('極端に横長の画像を検出');
    }
    // 画像が極端に縦長の場合の特別処理  
    else if (imageAspect < 0.5) {
      // 極端に縦長の画像：幅を基準にして高さを制限
      scaleX = 1;
      scaleY = Math.min(1 / imageAspect * containerAspect, 2.0); // 最大2倍まで
      console.log('極端に縦長の画像を検出');
    }
    // 通常のアスペクト比の場合
    else if (imageAspect > containerAspect) {
      // 画像が横長：幅を基準にスケール（画面幅に合わせる）
      scaleX = 1;
      scaleY = 1 / imageAspect * containerAspect;
    } else {
      // 画像が縦長：高さを基準にスケール（画面高さに合わせる）
      scaleX = imageAspect / containerAspect;
      scaleY = 1;
    }
    
    // 適応的スケールファクター（画像の種類に応じて調整）
    let scaleFactor;
    if (imageAspect > 1.5 || imageAspect < 0.7) {
      // 極端なアスペクト比の画像：少し小さめ
      scaleFactor = 0.8;
    } else {
      // 通常の画像：標準サイズ
      scaleFactor = 0.9;
    }
    
    mesh.scale.set(scaleX * scaleFactor, scaleY * scaleFactor, 1);
    console.log('適応的メッシュスケール設定:', { 
      imageAspect, 
      containerAspect, 
      scaleX: scaleX * scaleFactor, 
      scaleY: scaleY * scaleFactor,
      scaleFactor
    });
    
    console.log('テクスチャ設定完全に成功');
  } catch (error) {
    console.error('setTextures中にエラー:', error);
    throw error;
  }
}

export async function setImageOnly(imagePath) {
  return setTextures(imagePath, null);
}

// 姿勢平滑化用（EMA）
const poseSmoothing = { inited: false, x: 0, y: 0, z: 2.0 };
const rotSmoothing = { inited: false, rx: 0, rz: 0 };
const ENABLE_TILT = false; // 安定性優先のため既定は無効
const POSE_ALPHA = 0.25; // 平行移動のEMA係数
const ROT_ALPHA = 0.3;   // 回転のEMA係数

export function updateCameraFromFacePose(pose) {
  // pose: { yaw,pitch,roll,tx,ty, tz?, matrix?: number[16] }
  if (!camera || !mesh) return;

  // 現在の画像のアスペクト比を取得
  let imageAspect = 1;
  if (imageTex && imageTex.image) {
    const iw = imageTex.image.naturalWidth || imageTex.image.width || 1;
    const ih = imageTex.image.naturalHeight || imageTex.image.height || 1;
    imageAspect = iw / ih;
  }

  // 感度調整
  let sensitivity;
  if (imageAspect > 1.5) sensitivity = { x: 0.45, y: 0.25, z: 0.10 };
  else if (imageAspect < 0.7) sensitivity = { x: 0.25, y: 0.45, z: 0.10 };
  else sensitivity = { x: 0.35, y: 0.35, z: 0.12 };

  let tx = 0, ty = 0, tz = 0, yaw = 0, pitch = 0, roll = 0;

  // 高精度: 顔の変換行列がある場合はそれを優先
  if (pose && Array.isArray(pose.matrix) && pose.matrix.length === 16 && THREE) {
    try {
      const m = new THREE.Matrix4();
      m.fromArray(pose.matrix);
      const pos = new THREE.Vector3();
      const rot = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      m.decompose(pos, rot, scl);
      // 座標系はモデル依存のため軽いスケーリングで視差調整
      tx = pos.x;
      ty = pos.y;
      tz = pos.z;
      // 参考用のyaw（回転は適用しないがZ距離に反映）
      const eul = new THREE.Euler().setFromQuaternion(rot, 'YXZ');
      yaw = eul.y || 0;
      pitch = eul.x || 0;
      roll = eul.z || 0;
    } catch (e) {
      console.warn('顔姿勢行列の分解に失敗。フォールバックへ:', e?.message || e);
    }
  }

  // フォールバック: 既存の近似（tx,ty: 画面中心からの偏位 / yaw: 鼻先x偏差）
  if (!pose || (!Array.isArray(pose.matrix) && !('matrix' in pose))) {
    tx = pose?.tx || 0;
    ty = pose?.ty || 0;
    yaw = pose?.yaw || 0;
    pitch = pose?.pitch || 0;
    roll = pose?.roll || 0;
    tz = 0;
  }

  // 位置変換を感度で調整（tyは画面座標系と逆）
  const targetX = tx * sensitivity.x;
  const targetY = -ty * sensitivity.y;
  const baseZ = 2.0;
  const targetZ = baseZ + (tz * sensitivity.z) + (yaw * (sensitivity.z * 0.6));

  // EMA平滑化（位置）
  if (!poseSmoothing.inited) {
    poseSmoothing.inited = true;
    poseSmoothing.x = targetX;
    poseSmoothing.y = targetY;
    poseSmoothing.z = targetZ;
  } else {
    poseSmoothing.x = POSE_ALPHA * targetX + (1 - POSE_ALPHA) * poseSmoothing.x;
    poseSmoothing.y = POSE_ALPHA * targetY + (1 - POSE_ALPHA) * poseSmoothing.y;
    poseSmoothing.z = POSE_ALPHA * targetZ + (1 - POSE_ALPHA) * poseSmoothing.z;
  }

  // カメラ位置更新
  camera.position.set(poseSmoothing.x, poseSmoothing.y, poseSmoothing.z);
  camera.lookAt(0, 0, 0);
  if (ENABLE_TILT) {
    // 目標回転（上下＝pitch、傾き＝roll）。過度な回転は抑制。
    const rotLimit = { rx: 0.14, rz: 0.10 }; // 約8度/6度
    const targetRx = Math.max(-rotLimit.rx, Math.min(rotLimit.rx, pitch * 0.6));
    const targetRz = Math.max(-rotLimit.rz, Math.min(rotLimit.rz, roll * 0.6));
    // EMA平滑化（回転）
    if (!rotSmoothing.inited) {
      rotSmoothing.inited = true;
      rotSmoothing.rx = targetRx;
      rotSmoothing.rz = targetRz;
    } else {
      rotSmoothing.rx = ROT_ALPHA * targetRx + (1 - ROT_ALPHA) * rotSmoothing.rx;
      rotSmoothing.rz = ROT_ALPHA * targetRz + (1 - ROT_ALPHA) * rotSmoothing.rz;
    }
    const baseX = camera.rotation.x;
    const baseZ = camera.rotation.z;
    camera.rotation.x = baseX + rotSmoothing.rx;
    camera.rotation.z = baseZ + rotSmoothing.rz;
  } else {
    // 傾きは適用しない（以前の安定挙動）
    camera.rotation.z = 0;
  }

  // デバッグ
  // console.log('カメラ更新(high-precision):', { tx,ty,tz,yaw, imageAspect, sensitivity, pos: {...poseSmoothing} });
}

let frameCount = 0;
function animate() {
  try {
    if (!renderer || !scene || !camera) {
      console.warn('animate: レンダリングに必要な要素が不足しています');
      return;
    }
    
    // 定期的にレンダリング状況をログ出力（デバッグ用）
    frameCount++;
    if (frameCount % 60 === 0) { // 60フレームごと
      console.log('レンダリング状況:', {
        frame: frameCount,
        meshVisible: mesh?.visible,
        meshMaterial: mesh?.material?.type,
        meshTexture: !!mesh?.material?.map,
        cameraPosition: camera ? {
          x: camera.position.x.toFixed(3),
          y: camera.position.y.toFixed(3),
          z: camera.position.z.toFixed(3)
        } : null
      });
    }
    
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  } catch (error) {
    console.error('アニメーション中にエラー:', error);
    // エラーが発生してもアニメーションループを続行
    requestAnimationFrame(animate);
  }
}
