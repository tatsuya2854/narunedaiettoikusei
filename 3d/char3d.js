// 3Dキャラの描画（three.js）。index.html の2Dリグの「代わりに」同じ場所へ描く。
// ・ゲームのロジック（いつ何をするか）は index.html のまま。ここは出来事を受けてアニメを切り替えるだけ
// ・読み込みや描画に失敗したら onFail を呼ぶ → index.html が2Dに戻す
// ・重すぎる端末（平均 22fps 未満が続く）でも2Dに戻す（iPhone の発熱・電池を優先）
import * as T from "./vendor/three-char.js";
import { AnimationStateMachine } from "./state-machine.js";
import { createFace, measureHead, createOutfitter } from "./look.js";
import { attachAccessory, disposeObject, hasAccessory } from "./accessories.js";

const FIT_H = 0.82;          // キャラの背丈が描画枠の高さに占める割合（2D の FIT に見た目を合わせた値）
const SLOW_MS = 45;          // これより遅いフレームが続いたら2Dへ

export async function mount({ host, base = "./", characterId, reduced = false, onFail = () => {}, face: faceInfo = null }) {
  const idx = await getJson(`${base}assets/characters/index.json`);
  const entry = idx.characters.find((c) => c.id === (characterId || idx.default));
  if (!entry) throw new Error("3Dキャラが登録されていません");
  const cfg = await getJson(base + entry.config);
  if (!cfg.model) throw new Error(`${cfg.characterId}: model がありません`);

  const canvas = document.createElement("canvas");
  canvas.className = "rig rig3d";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", cfg.name || "キャラクター");
  const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: (window.devicePixelRatio || 1) < 2, powerPreference: "low-power" });
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const scene = new T.Scene();
  // 元絵はフラットな塗りなので、影は弱め・全体を明るく（肌の色が元絵から離れないように）
  scene.add(new T.HemisphereLight(0xffffff, 0xd8cabd, 3.0));
  const key = new T.DirectionalLight(0xffffff, 0.8); key.position.set(0.5, 2, 3); scene.add(key);
  const cam = new T.PerspectiveCamera(20, 1, 0.01, 100);

  const loader = new T.GLTFLoader().setMeshoptDecoder(T.MeshoptDecoder);
  const t0 = performance.now();
  let gltf;
  try { gltf = await loader.loadAsync(base + cfg.model); }
  catch (e) { renderer.dispose(); renderer.forceContextLoss(); throw e; }   // 2Dに戻る前に GPU を返す
  const loadMs = Math.round(performance.now() - t0);
  const model = gltf.scene;
  model.scale.setScalar(cfg.scale || 1);
  if (cfg.rotation) model.rotation.set(...cfg.rotation.map((d) => (d * Math.PI) / 180));
  if (cfg.position) model.position.set(...cfg.position);
  model.traverse((o) => { if (o.isMesh) o.frustumCulled = false; }); // スキンで動くと境界箱からはみ出すため
  scene.add(model);

  // 足元を原点・背丈を1に揃えてから、カメラの位置を決める（どのモデルでも同じ枠に収まる）
  const box = new T.Box3().setFromObject(model);
  const size = box.getSize(new T.Vector3()), center = box.getCenter(new T.Vector3());
  model.position.x -= center.x; model.position.z -= center.z; model.position.y -= box.min.y;
  const H = size.y;

  // 接地影（2D と同じ考え方：キャラ幅の7割・薄く・ぼかし）
  const shadow = makeShadow(Math.max(size.x, size.z) * 0.7);
  scene.add(shadow);

  // アクセの取り付け点
  const sockets = {};
  for (const [name, s] of Object.entries(cfg.sockets || {})) {
    const bone = model.getObjectByName(s.bone);
    if (bone) sockets[name] = bone;
  }
  // 表情（顔シートに2Dの顔パーツを描く）・頭の大きさ・着せ替え。アニメを始める前（基本姿勢）に測る
  const face = await createFace(model, faceInfo).catch((e) => { console.warn("表情の準備に失敗:", e); return null; });
  const head = sockets.head ? { ...measureHead(model, sockets.head), eyes: face?.eyes, boneRest: sockets.head.matrixWorld.clone() } : null;
  const outfitter = createOutfitter(model);
  let acc = null, accId = null;

  const mixer = new T.AnimationMixer(model);
  const clips = Object.fromEntries(gltf.animations.map((c) => [c.name, c]));
  let cur = null;
  const driver = {
    play(name, { loop, fade }) {
      const clip = clips[name]; if (!clip) return 0;
      const next = mixer.clipAction(clip);
      next.reset(); next.enabled = true;
      next.setLoop(loop ? T.LoopRepeat : T.LoopOnce, loop ? Infinity : 1);
      next.clampWhenFinished = !loop;
      if (cur && cur !== next) next.crossFadeFrom(cur, fade, false);
      next.play();
      cur = next;
      return clip.duration;
    },
  };
  // character.json の animations は「状態 → クリップ名」
  // 動きを減らす設定ではフェードせず、各クリップの最初の姿勢で止めて見せる
  const sm = new AnimationStateMachine({ clips: cfg.animations || {}, driver, fade: reduced ? 0 : 0.25 });

  // --- 大きさ ---
  let W = 0, Hh = 0;
  function fit() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === W && h === Hh && renderer.getPixelRatio() === dpr) return;
    W = w; Hh = h;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    // 背丈 H が枠の高さの FIT_H になる距離。足元が枠の下端に来るように注視点をずらす
    const visH = H / FIT_H;
    const dist = visH / 2 / Math.tan((cam.fov * Math.PI) / 360);
    cam.position.set(0, visH / 2, dist);
    cam.lookAt(0, visH / 2, 0);
    cam.updateProjectionMatrix();
    if (reduced) draw(0);
  }
  const ro = window.ResizeObserver ? new ResizeObserver(fit) : null;

  // --- 描画ループ ---
  const timer = new T.Timer();
  let api = null;
  let still = 0;
  let raf = 0, active = true, slow = 0, frames = 0, sum = 0;
  const hips = model.getObjectByName("Hips") || model.getObjectByName(Object.values(cfg.sockets || {})[0]?.bone || "") || null;
  const hipsY0 = hips ? hips.getWorldPosition(new T.Vector3()).y : 0;
  function draw(dt) {
    sm.tick(dt);
    mixer.update(dt);
    if (hips) {  // 跳ぶと影が小さく薄くなる
      const up = Math.max(0, hips.getWorldPosition(tmp).y - hipsY0) / H;
      const s = 1 - Math.min(0.5, up * 2.2);
      shadow.scale.set(s, s, s); shadow.material.opacity = 0.22 * s;
    }
    renderer.render(scene, cam);
  }
  const tmp = new T.Vector3();
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    timer.update(ts);
    if (document.hidden) return;
    const dtRaw = timer.getDelta();
    const dt = Math.min(0.05, dtRaw);
    draw(dt);
    // 読み込み直後の数秒は除いて、遅いフレームが続くか見る
    frames++;
    if (frames > 90) {
      sum += dtRaw * 1000;
      if (frames % 60 === 0) {
        const avg = sum / 60; sum = 0;
        slow = avg > SLOW_MS ? slow + 1 : 0;
        api.fps = Math.round(1000 / avg);
        if (slow >= 5) fail(new Error(`描画が重い（平均 ${api.fps}fps）`));
      }
    }
  }
  function fail(e) { if (!active) return; dispose(); onFail(e); }
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); fail(new Error("WebGL context lost")); });

  function dispose() {
    active = false; if (api) api.active = false;
    cancelAnimationFrame(raf); clearInterval(still); ro?.disconnect();
    mixer.stopAllAction(); mixer.uncacheRoot(model);
    disposeObject(acc); face?.dispose(); outfitter?.dispose();
    scene.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
        m.dispose();
      }
    });
    renderer.dispose(); renderer.forceContextLoss();
    canvas.remove();
  }

  api = {
    active: true, loadMs, fps: null,
    info: { id: cfg.characterId, version: cfg.version, provider: cfg.provenance?.provider, clips: Object.keys(clips), face: !!face, head: !!head },
    onAct: (name, ms) => { sm.onAct(name, ms); if (reduced) draw(0); },
    onIdlePose: (p) => { sm.onIdlePose(p); if (reduced) draw(0); },
    onDance: (on) => sm.onDance(on),
    // 表情：2Dの EOUT をそのまま受け取る（目は開かない）
    setFace: (E) => { if (face?.draw(E) && reduced) draw(0); },
    // 着せ替え：2Dの OUTFITS の1つ（shirt / shorts の HSL）
    setOutfit: (o) => { outfitter?.apply(o); if (reduced) draw(0); },
    // アクセ：2Dの ACCS の id。3Dの形が無いものは付けない
    setAcc: (id) => {
      if (id === accId) return;
      disposeObject(acc); acc = null; accId = id;
      if (head && hasAccessory(id)) acc = attachAccessory(id, head, sockets.head);
      if (reduced) draw(0);
    },
    state: () => ({ base: sm.base, current: sm.current, clip: sm.currentClip }),
    socket: (name) => sockets[name] || null,
    // 確認用：キャラを y 軸まわりに回して見る（度）
    turn: (deg) => { model.rotation.y = (deg * Math.PI) / 180 + ((cfg.rotation?.[1] || 0) * Math.PI) / 180; if (reduced) draw(0); },       // 今後: アクセ（サングラス等）を骨に付ける
    dispose,
  };
  host.appendChild(canvas);
  ro?.observe(canvas);
  fit();
  if (reduced) {
    // 時間は進める（ワンショットの終わりで待機に戻るため）が、アニメは動かさない
    draw(0);
    still = setInterval(() => { const before = sm.currentClip; sm.tick(0.25); if (sm.currentClip !== before) draw(0); }, 250);
  } else loop();
  return api;
}

async function getJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

function makeShadow(w) {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(0,0,0,1)"); gr.addColorStop(0.55, "rgba(0,0,0,.55)"); gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const m = new T.Mesh(new T.CircleGeometry(w / 2, 32), new T.MeshBasicMaterial({ map: new T.CanvasTexture(c), transparent: true, opacity: 0.22, depthWrite: false }));
  // カメラはほぼ水平に見ているので、床に寝かせず「足元の後ろに立てた横長の楕円」にする（2D の影と同じ見え方）
  m.geometry.scale(1, 0.22, 1);
  m.position.set(0, 0, -w * 0.25);
  m.renderOrder = -1;
  return m;
}
