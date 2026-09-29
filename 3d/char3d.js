// 3Dキャラの描画（three.js）。index.html の2Dリグの「代わりに」同じ場所へ描く。
// ・ゲームのロジック（いつ何をするか）は index.html のまま。ここは出来事を受けてアニメを切り替えるだけ
// ・読み込みや描画に失敗したら onFail を呼ぶ → index.html が2Dに戻す
// ・重すぎる端末（平均 22fps 未満が続く）でも2Dに戻す（iPhone の発熱・電池を優先）
import * as T from "./vendor/three-char.js";
import { AnimationStateMachine } from "./state-machine.js";

const FIT_H = 0.74;          // キャラの背丈が描画枠の高さに占める割合（2D の FIT に見た目を合わせた値）
const SLOW_MS = 45;          // これより遅いフレームが続いたら2Dへ

export async function mount({ host, base = "./", characterId, reduced = false, onFail = () => {} }) {
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
  scene.add(new T.HemisphereLight(0xffffff, 0xcdbfb3, 2.4));
  const key = new T.DirectionalLight(0xffffff, 1.3); key.position.set(0.6, 2, 2.4); scene.add(key);
  const cam = new T.PerspectiveCamera(20, 1, 0.01, 100);

  const loader = new T.GLTFLoader().setMeshoptDecoder(T.MeshoptDecoder);
  const t0 = performance.now();
  const gltf = await loader.loadAsync(base + cfg.model);
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

  // アクセの取り付け点（今は「付けられる口」だけ用意。見た目は今後 character.json の sockets で調整）
  const sockets = {};
  for (const [name, s] of Object.entries(cfg.sockets || {})) {
    const bone = model.getObjectByName(s.bone);
    if (bone) sockets[name] = bone;
  }

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
  const sm = new AnimationStateMachine({ clips: cfg.animations || {}, driver, fade: 0.25 });

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
  const clock = new T.Clock();
  let api = null;
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
  function loop() {
    raf = requestAnimationFrame(loop);
    if (document.hidden) { clock.getDelta(); return; }
    const dtRaw = clock.getDelta();
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
    active = false; api.active = false;
    cancelAnimationFrame(raf); ro?.disconnect();
    mixer.stopAllAction();
    renderer.dispose();
    canvas.remove();
  }

  api = {
    active: true, loadMs, fps: null,
    info: { id: cfg.characterId, version: cfg.version, provider: cfg.provenance?.provider, clips: Object.keys(clips) },
    onAct: (name, ms) => { sm.onAct(name, ms); if (reduced) draw(0); },
    onIdlePose: (p) => { sm.onIdlePose(p); if (reduced) draw(0); },
    onDance: (on) => sm.onDance(on),
    state: () => ({ base: sm.base, current: sm.current, clip: sm.currentClip }),
    socket: (name) => sockets[name] || null,       // 今後: アクセ（サングラス等）を骨に付ける
    dispose,
  };
  host.appendChild(canvas);
  ro?.observe(canvas);
  fit();
  if (reduced) draw(0); else loop();
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
