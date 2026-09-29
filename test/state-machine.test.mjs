import { test } from "node:test";
import assert from "node:assert/strict";
import { AnimationStateMachine } from "../3d/state-machine.js";

function rig(clips = { IDLE: "idle", WALK: "walk", JUMP: "jump", HAPPY: "happy" }, len = { idle: 2.4, walk: 0.9, jump: 1.1, happy: 1.6 }) {
  const log = [];
  const driver = { play: (clip, o) => { log.push([clip, o.loop]); return len[clip]; } };
  return { sm: new AnimationStateMachine({ clips, driver, fade: 0.2 }), log };
}

test("起動時は IDLE をループ再生", () => {
  const { sm, log } = rig();
  assert.deepEqual(log, [["idle", true]]);
  assert.equal(sm.current, "IDLE");
});

test("無いクリップはフォールバックする（RUN→WALK, EAT→HAPPY, SLEEP→IDLE）", () => {
  const { sm } = rig();
  assert.equal(sm.resolve("RUN").clip, "walk");
  assert.equal(sm.resolve("EAT").clip, "happy");
  assert.equal(sm.resolve("SLEEP").clip, "idle");
  assert.equal(sm.resolve("ANGRY").clip, "idle");
  assert.equal(sm.resolve("NOPE").clip, "idle");
});

test("ワンショットは終わるとベースへ戻る", () => {
  const { sm, log } = rig();
  sm.trigger("JUMP");
  assert.deepEqual(log.at(-1), ["jump", false]);
  sm.tick(0.5); assert.equal(sm.current, "JUMP");
  sm.tick(0.5); assert.equal(sm.current, "IDLE");
  assert.deepEqual(log.at(-1), ["idle", true]);
});

test("ワンショットはゲーム側の演出時間より早く終わらない", () => {
  const { sm } = rig();
  sm.trigger("HAPPY", 3);
  sm.tick(2.0); assert.equal(sm.current, "HAPPY");
  sm.tick(1.1); assert.equal(sm.current, "IDLE");
});

test("ワンショット中にベースが変わったら、終わった後は新しいベースへ", () => {
  const { sm } = rig({ IDLE: "idle", HAPPY: "happy", SLEEP: "sleep" }, { idle: 2, happy: 1, sleep: 3 });
  sm.trigger("HAPPY");
  sm.setBase("SLEEP");
  assert.equal(sm.current, "HAPPY");
  sm.tick(1);
  assert.equal(sm.current, "SLEEP");
});

test("同じループは鳴らし直さない", () => {
  const { sm, log } = rig();
  sm.setBase("IDLE"); sm.setBase("IDLE");
  assert.equal(log.length, 1);
});

test("ゲームの出来事の対応: 走る→WALK(代替)して元へ戻る / ダンス開始・終了 / 寝る姿勢", () => {
  const { sm } = rig();
  sm.onAct("run", 1500);
  assert.equal(sm.currentClip, "walk");
  sm.tick(1.6);
  assert.equal(sm.current, "IDLE");
  sm.onDance(true); assert.equal(sm.base, "DANCE"); assert.equal(sm.currentClip, "happy");
  sm.onDance(false); assert.equal(sm.base, "IDLE");
  sm.onIdlePose("sleep"); assert.equal(sm.base, "SLEEP");
  sm.onAct("eat", 1000); assert.equal(sm.current, "EAT"); assert.equal(sm.currentClip, "happy");
  sm.onAct("unknown-act", 1000); assert.equal(sm.current, "EAT");
});

test("クリップが1つも無くても落ちない", () => {
  const sm = new AnimationStateMachine({ clips: {}, driver: { play: () => 1 } });
  sm.trigger("JUMP"); sm.tick(5);
  assert.equal(sm.resolve("JUMP"), null);
});

test("ワンショット: ジャンプは1回きり、ほかはゲームの演出の長さだけ繰り返して戻る", () => {
  const { sm, log } = rig({ IDLE: "idle", HAPPY: "cheer", JUMP: "jump" }, { idle: 2, cheer: 12.1, jump: 0.9 });
  sm.trigger("JUMP", 2);
  assert.deepEqual(log.at(-1), ["jump", false]);
  sm.tick(1.9); assert.equal(sm.current, "IDLE");
  sm.trigger("HAPPY", 1.3);
  assert.deepEqual(log.at(-1), ["cheer", true]);
  sm.tick(1.0); assert.equal(sm.current, "HAPPY");
  sm.tick(0.2); assert.equal(sm.current, "IDLE");   // 演出（1.3秒）が終わるころに戻る。12秒の動きでも引っぱらない
  sm.trigger("HAPPY");
  sm.tick(4.0); assert.equal(sm.current, "IDLE");
});

test("ジャンプが無いキャラで喜ぶを代わりに使っても、繰り返さない", () => {
  const { sm, log } = rig({ IDLE: "idle", HAPPY: "happy" }, { idle: 2, happy: 1.2 });
  sm.trigger("JUMP");
  assert.deepEqual(log.at(-1), ["happy", false]);
});
