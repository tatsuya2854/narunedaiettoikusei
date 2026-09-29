// 3Dキャラのアニメーション状態機械（three.js には依存しない。再生は driver に任せる）
//
// 状態は2種類:
//   ・ベース状態（ループ）: IDLE / WALK / RUN / SLEEP / SAD / DANCE
//     「今ずっとしていること」。setBase で切り替える
//   ・ワンショット: JUMP / HAPPY / EAT / LEVEL_UP / WAVE / PET / ANGRY
//     trigger で割り込み、終わったらベース状態へクロスフェードで戻る
//
// キャラによっては全部のクリップを持っていない（最初は idle/walk/jump/happy の4つだけ）。
// 無いクリップは FALLBACK をたどって近いものに置き換える。最後は IDLE。

export const BASE_STATES = ["IDLE", "WALK", "RUN", "SLEEP", "SAD", "DANCE"];
export const ONESHOT_STATES = ["JUMP", "HAPPY", "EAT", "LEVEL_UP", "WAVE", "PET", "ANGRY"];

export const FALLBACK = {
  RUN: "WALK", DANCE: "HAPPY", EAT: "HAPPY", LEVEL_UP: "HAPPY", WAVE: "HAPPY", PET: "HAPPY",
  SAD: "IDLE", SLEEP: "IDLE", ANGRY: "SAD", WALK: "IDLE", JUMP: "HAPPY", HAPPY: "IDLE",
};

// ゲームの出来事 → 状態。ゲーム本体（index.html）は名前を渡すだけで、ここが唯一の対応表
export const GAME_ACT = {
  dance: "DANCE", cheer: "HAPPY", clap: "HAPPY", win: "HAPPY", yay: "HAPPY", kiss: "PET",
  jump: "JUMP", run: "RUN", tilt: "IDLE", shy: "SAD", nap: "SLEEP",
  eat: "EAT", levelup: "LEVEL_UP", pet: "PET", wave: "WAVE",
};
// idlePose() の結果（待機中の姿勢）→ ベース状態
export const GAME_POSE = { sleep: "SLEEP", sorry: "SAD" };

export class AnimationStateMachine {
  /**
   * @param {object} o
   * @param {Record<string,string>} o.clips   状態名 → クリップ名（character.json の animations）
   * @param {{play:(clip:string,opt:{loop:boolean,fade:number})=>number}} o.driver
   *        play は再生を始め、クリップの長さ（秒）を返す
   * @param {number} [o.fade] クロスフェード秒
   */
  constructor({ clips, driver, fade = 0.25 }) {
    this.clips = clips || {};
    this.driver = driver;
    this.fade = fade;
    this.base = "IDLE";
    this.current = null;       // 今鳴っている状態
    this.currentClip = null;
    this.oneShotLeft = 0;      // ワンショットの残り秒（0 ならベース状態を再生中）
    this.setBase("IDLE");
  }

  /** 状態 → 実在するクリップ名（フォールバック込み）。何も無ければ null */
  resolve(state) {
    const seen = new Set();
    let s = state;
    while (s && !seen.has(s)) {
      seen.add(s);
      if (this.clips[s]) return { state: s, clip: this.clips[s] };
      s = FALLBACK[s];
    }
    return this.clips.IDLE ? { state: "IDLE", clip: this.clips.IDLE } : null;
  }

  _play(state, loop) {
    const r = this.resolve(state);
    if (!r) return 0;
    // 同じクリップをループ中なら頭から鳴らし直さない（ガクッとしないように）
    if (loop && this.oneShotLeft <= 0 && this.currentClip === r.clip) { this.current = state; return 0; }
    this.current = state;
    this.currentClip = r.clip;
    return this.driver.play(r.clip, { loop, fade: this.fade }) || 0;
  }

  setBase(state) {
    if (!BASE_STATES.includes(state)) state = "IDLE";
    this.base = state;
    if (this.oneShotLeft <= 0) this._play(state, true);
  }

  /** ワンショットを割り込ませる。minSec があればそれより短くは終わらせない（ゲーム側の演出の長さに合わせる） */
  trigger(state, minSec = 0) {
    if (BASE_STATES.includes(state)) { this.setBase(state); return; }
    const dur = this._play(state, false);
    // Tripo のプリセットには長いもの（cheer は12秒）があるので、ゲームの演出に合わせて切り上げる。
    // ゲームが長さを渡したらそれ以上・最長3秒、渡さなければ最長4秒
    const len = Math.min(dur, minSec > 0 ? Math.max(minSec, 3) : 4);
    this.oneShotLeft = Math.max(len - this.fade, minSec, 0.01);
  }

  /** 毎フレーム呼ぶ。ワンショットが終わったらベースへ戻す */
  update(dt) {
    if (this.oneShotLeft > 0) {
      this.oneShotLeft -= dt;
      if (this.oneShotLeft <= 0) { this.oneShotLeft = 0; this.currentClip = null; this._play(this.base, true); }
    }
  }

  // --- ゲームからの入口（index.html はこれだけ呼ぶ） ---
  onAct(name, ms) {
    const s = GAME_ACT[name];
    if (!s) return;
    if (s === "DANCE" && ms == null) { this.setBase("DANCE"); return; }  // ダンスモード（終わりが決まっていない）
    if (BASE_STATES.includes(s)) {
      // 走る・寝るなどのループ系の演出は、演出の長さだけベースを差し替えて戻す
      const prev = this.base;
      this.setBase(s);
      if (ms) this._restore = { at: ms / 1000, to: prev === s ? "IDLE" : prev };
      return;
    }
    this.trigger(s, (ms || 0) / 1000);
  }
  onIdlePose(pose) { this._restore = null; this.setBase(GAME_POSE[pose] || "IDLE"); }
  onDance(on) { this._restore = null; this.setBase(on ? "DANCE" : "IDLE"); }

  tick(dt) {
    if (this._restore) {
      this._restore.at -= dt;
      if (this._restore.at <= 0) { const to = this._restore.to; this._restore = null; this.setBase(to); }
    }
    this.update(dt);
  }
}
