// キャラの動きを手元で作る（無料）。「どうぶつの森」のような、小さくキビキビ・ポンと弾む動き。
//
// Tripo のプリセットは人間のモーションキャプチャなので、三頭身に当てると
// 体がゆらゆら・頭がふらふら・手首が丸まる（＝フニャフニャ）。なのでプリセットは使わず、
// リグの「基本姿勢（元絵どおりの立ち姿・手は開いたまま）」を土台に、骨を少しだけ回して動かす。
//
// 決まりごと
//  ・手首（Hand）とねじれ骨（*Twist*）は触らない → 手の形がくずれない
//  ・その場で動く（前に進まない）。上下・左右の弾みは腰（Hip）の移動だけ
//  ・回転は「体の前・上・右」の軸で書く（骨ごとのローカル軸はリグ次第なので、ここで変換する）
//      right まわり ＋ … 上向きの骨（背骨・首・頭）は「のけぞる」、下向きの骨（腕・脚）は「前に振る」
//      forward まわり ＋ … 上向きの骨は「右へ傾く」、左腕は「上がる」、右腕は「下がる」
//      up まわり ＋ … 左を向く
import * as THREE from "three";

const TAU = Math.PI * 2;
const sin = (x) => Math.sin(TAU * x), cos = (x) => Math.cos(TAU * x);
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const ramp = (x, a, b) => smooth((x - a) / (b - a));
const hump = (x, a, b) => (x <= a || x >= b ? 0 : Math.sin((Math.PI * (x - a)) / (b - a))); // a〜b で 0→1→0

// 腕は基本姿勢（元絵）より少し下げて、どうぶつの森っぽく体の横に置く
export const ARMS_DOWN = 25;
// l / r: 腕を横に上げる角度（＋で上）、fl / fr: 前へ振る角度（＋で前）
const arms = (l = 0, r = 0, fl = 0, fr = 0) => ({
  L_Upperarm: [["forward", -ARMS_DOWN + l], ["right", fl]],
  R_Upperarm: [["forward", ARMS_DOWN - r], ["right", fr]],
});

/** 各レシピ: period（秒）, pose(x) → { rot: {骨: [[軸, 度], ...]}, up, side }。x は 0〜1 の位相、up / side は背丈に対する割合 */
export const RECIPES = {
  // 待機：ほんの少し上下に息をして、体が左右にゆっくり揺れる。頭はぶれない
  idle: {
    period: 2.4,
    pose: (x) => ({
      up: 0.006 * (0.5 - 0.5 * cos(x)),
      rot: {
        ...arms(2 * sin(x), 2 * sin(x)),
        Waist: [["forward", 2 * sin(x)]],
        Head: [["forward", -1.5 * sin(x)]],
      },
    }),
  },
  // 歩く：小さい歩幅でテンポよく。一歩ごとにポンと弾み、腕は小さく前後に振る
  walk: {
    period: 0.56,
    pose: (x) => ({
      up: 0.022 * Math.abs(cos(x)),
      rot: {
        L_Thigh: [["right", 24 * sin(x)]], R_Thigh: [["right", -24 * sin(x)]],
        L_Calf: [["right", -38 * Math.max(0, cos(x))]], R_Calf: [["right", -38 * Math.max(0, -cos(x))]],
        ...arms(0, 0, -22 * sin(x), 22 * sin(x)),
        Waist: [["right", -4], ["forward", 3 * sin(x)]],
        Head: [["right", 3], ["forward", -2 * sin(x)]],
      },
    }),
  },
  // ジャンプ：しゃがむ → ピョン（腕を上げる）→ 着地でちょっと沈む → 戻る
  jump: {
    period: 0.9,
    pose: (x) => {
      const crouch = hump(x, 0, 0.2) + hump(x, 0.62, 0.8) * 0.7;
      const air = hump(x, 0.16, 0.66);
      return {
        up: -0.05 * crouch + 0.2 * air,
        rot: {
          L_Thigh: [["right", 30 * crouch + 10 * air]], R_Thigh: [["right", 30 * crouch + 10 * air]],
          L_Calf: [["right", -55 * crouch - 15 * air]], R_Calf: [["right", -55 * crouch - 15 * air]],
          ...arms(70 * air - 10 * crouch, 70 * air - 10 * crouch, -15 * crouch, -15 * crouch),
          Waist: [["right", -8 * crouch + 3 * air]],
        },
      };
    },
  },
  // 喜ぶ：両手をバンザイして、ぴょんぴょん2回
  happy: {
    period: 1.2,
    pose: (x) => {
      const hop = Math.abs(Math.sin(TAU * x));
      return {
        up: 0.07 * hop,
        rot: {
          // 頭が大きいので真上には上げない（頭にめり込む）。斜め上・少し前に出して、頭の手前で手を振る
          ...arms(68 + 8 * sin(2 * x), 68 - 8 * sin(2 * x), 25, 25),
          L_Thigh: [["right", 12 * (1 - hop)]], R_Thigh: [["right", 12 * (1 - hop)]],
          L_Calf: [["right", -24 * (1 - hop)]], R_Calf: [["right", -24 * (1 - hop)]],
          Head: [["forward", 5 * sin(x)], ["right", 4]],
        },
      };
    },
  },
  // ダンス：拍に合わせて左右にステップ。腕を交互に上げる。ひざでリズムを取る
  dance: {
    period: 1.0,
    pose: (x) => {
      const beat = Math.abs(Math.sin(TAU * x)); // 1周期に2拍
      const l = Math.max(0, sin(x)), r = Math.max(0, -sin(x));
      return {
        up: 0.02 * beat, side: 0.035 * sin(x),
        rot: {
          ...arms(15 + 50 * l, 15 + 50 * r, 20 * l, 20 * r),
          L_Thigh: [["right", 14 * (1 - beat)]], R_Thigh: [["right", 14 * (1 - beat)]],
          L_Calf: [["right", -28 * (1 - beat)]], R_Calf: [["right", -28 * (1 - beat)]],
          Waist: [["forward", -7 * sin(x)], ["up", 6 * sin(x)]],
          Head: [["forward", 9 * sin(x)]],
        },
      };
    },
  },
  // 寝る（立ったままうとうと）：頭がこくりと前に落ちて、ゆっくり息をする。腕はだらんと下げる
  sleep: {
    period: 3.2,
    pose: (x) => ({
      up: -0.008 + 0.005 * sin(x),
      rot: {
        ...arms(-22, -22),
        Waist: [["right", -5 - 1.5 * sin(x)]],
        NeckTwist01: [["right", -10], ["forward", 7]],
        Head: [["right", -16 - 3 * sin(x)], ["forward", 5]],
      },
    }),
  },
  // 食べる：右手を口元へ運んで、もぐもぐ（頭が小さくうなずく）を2回。
  // 腕は「向ける方向」で指定する（aim = [前, 上, 右] の向き。lift=0 のときは基本姿勢のまま）
  eat: {
    period: 1.6,
    pose: (x) => {
      const y = (x * 2) % 1;
      const lift = ramp(y, 0, 0.3) * (1 - ramp(y, 0.7, 1));
      const chew = Math.sin(TAU * 3 * y) * lift;
      return {
        up: 0.006 * lift,
        rot: {
          ...arms(),
          R_Upperarm: [["forward", ARMS_DOWN], ["aim", [0.75, -0.25, 0.25], lift]],
          R_Forearm: [["aim", [0.35, 0.8, -0.5], lift]],
          Head: [["right", -5 * lift + 3 * chew]],
        },
      };
    },
  },
};

export const RECIPE_NAMES = Object.keys(RECIPES);

/**
 * リグの基本姿勢を土台に、レシピの動きをアニメとして足す。
 * @param {import("@gltf-transform/core").Document} doc
 * @param {string} name RECIPES のキー
 * @param {{ forward?: number[], up?: number[], hipBone?: string, headBone?: string }} o  モデルの正面・上（Tripo 生出力は +X / +Y）
 */
export function addProceduralClip(doc, name, { forward = [1, 0, 0], up = [0, 1, 0], hipBone = "Hip", headBone = "Head" } = {}) {
  const recipe = RECIPES[name];
  if (!recipe) throw new Error(`レシピがありません: ${name}`);
  const root = doc.getRoot();
  const F = new THREE.Vector3(...forward).normalize(), U = new THREE.Vector3(...up).normalize();
  const R = new THREE.Vector3().crossVectors(F, U).normalize();
  const AX = { right: R, up: U, forward: F };

  const joints = new Set(root.listSkins().flatMap((s) => s.listJoints()));
  const byName = new Map([...joints].map((j) => [j.getName(), j]));
  const hip = byName.get(hipBone);
  if (!hip) throw new Error(`腰の骨 ${hipBone} がありません`);
  // どのフレームでも触る骨の一覧（途中で出てくる骨も拾うため、何点か見ておく）
  const touched = new Set([0, 0.25, 0.5, 0.75].flatMap((x) => Object.keys(recipe.pose(x).rot || {})));
  for (const b of touched) if (!byName.has(b)) throw new Error(`骨 ${b} がありません（別のリグ？）`);

  // 背丈（足元〜頭）。上下の弾みはこれに対する割合で書く
  const wpos = (n) => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(n.getWorldMatrix()));
  const feet = Math.min(...[...joints].map((j) => wpos(j).dot(U)));
  const height = Math.max(1e-3, wpos(byName.get(headBone) || hip).dot(U) - feet);
  const hipParent = hip.getParentNode();
  const hipParentInv = hipParent
    ? new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().fromArray(hipParent.getWorldMatrix())).invert()
    : new THREE.Matrix3();
  const hipRest = new THREE.Vector3(...hip.getTranslation());

  // 骨の向き（基本姿勢で、いちばん遠い子の関節へ向かう方向）。aim で使う
  const restDir = new Map();
  for (const j of joints) {
    const kids = j.listChildren().filter((c) => joints.has(c));
    const far = kids.map((c) => wpos(c).sub(wpos(j))).sort((a, b) => b.length() - a.length())[0];
    if (far && far.length() > 1e-5) restDir.set(j, far.normalize());
  }
  // aim を使う骨には向き（子の関節）が必要。無ければ作り始める前に止める
  for (const x of [0, 0.25, 0.5, 0.75]) for (const [b, spec] of Object.entries(recipe.pose(x).rot || {})) {
    if (spec.some(([axis]) => axis === "aim") && !restDir.has(byName.get(b))) throw new Error(`骨 ${b} に向き（子の関節）が無いので aim できません`);
  }
  const roots = [...joints].filter((j) => !joints.has(j.getParentNode()));
  const fps = 30, frames = Math.max(2, Math.round(recipe.period * fps));
  const times = new Float32Array(frames + 1);
  const outRot = new Map();
  const hipPos = new Float32Array((frames + 1) * 3);

  for (let f = 0; f <= frames; f++) {
    times[f] = (f / frames) * recipe.period;
    const pose = recipe.pose(f / frames);
    const visit = (node, pRest, pNew) => {
      const local = new THREE.Quaternion(...node.getRotation());
      const worldRest = pRest.clone().multiply(local);
      let worldNew = pNew.clone().multiply(local), newLocal = local;
      const spec = pose.rot?.[node.getName()];
      if (spec) {
        // 目標 = （体の軸で回す量）×（基本姿勢での向き）。親が動いた分を打ち消してローカルに戻す
        let target = worldRest.clone();
        for (const [axis, v, w = 1] of spec) {
          if (axis === "aim") {
            // 骨の向き（基本姿勢で子の関節へ向かう方向）を、指定の方向へ向ける。w で基本姿勢との間をなめらかに
            const cur = restDir.get(node).clone().applyQuaternion(new THREE.Quaternion().multiplyQuaternions(target, worldRest.clone().invert()));
            const want = F.clone().multiplyScalar(v[0]).add(U.clone().multiplyScalar(v[1])).add(R.clone().multiplyScalar(v[2])).normalize();
            const full = new THREE.Quaternion().setFromUnitVectors(cur.normalize(), want);
            target = new THREE.Quaternion().slerp(full, w).multiply(target);
          } else target = new THREE.Quaternion().setFromAxisAngle(AX[axis], (v * Math.PI) / 180).multiply(target);
        }
        newLocal = pNew.clone().invert().multiply(target);
        worldNew = target;
      }
      if (touched.has(node.getName())) {
        if (!outRot.has(node)) outRot.set(node, new Float32Array((frames + 1) * 4));
        newLocal.normalize().toArray(outRot.get(node), f * 4);
      }
      for (const c of node.listChildren()) if (joints.has(c)) visit(c, worldRest, worldNew);
    };
    for (const r of roots) {
      const p = r.getParentNode();
      // 親に拡大縮小が入っていても回転だけを取り出す（setFromRotationMatrix は純粋な回転行列が前提）
      const pw = new THREE.Quaternion();
      if (p) new THREE.Matrix4().fromArray(p.getWorldMatrix()).decompose(new THREE.Vector3(), pw, new THREE.Vector3());
      visit(r, pw, pw);
    }
    const d = U.clone().multiplyScalar((pose.up || 0) * height).add(R.clone().multiplyScalar((pose.side || 0) * height));
    hipRest.clone().add(d.applyMatrix3(hipParentInv)).toArray(hipPos, f * 3);
  }

  const buffer = root.listBuffers()[0] || doc.createBuffer();
  const anim = doc.createAnimation(name);
  const input = doc.createAccessor().setType("SCALAR").setArray(times).setBuffer(buffer);
  const add = (node, path, arr, type) => {
    const s = doc.createAnimationSampler().setInput(input).setOutput(doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer)).setInterpolation("LINEAR");
    anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(s));
  };
  for (const [n, arr] of outRot) add(n, "rotation", arr, "VEC4");
  add(hip, "translation", hipPos, "VEC3");
  return anim;
}

/** 手元で作った動きだけのGLBにする（Tripo のプリセットのアニメは外す） */
export function replaceWithProceduralClips(doc, names = RECIPE_NAMES, opts = {}) {
  for (const a of doc.getRoot().listAnimations()) a.dispose();
  return names.map((n) => addProceduralClip(doc, n, opts).getName());
}
