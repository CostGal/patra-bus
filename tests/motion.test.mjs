import { test } from 'node:test';
import assert from 'node:assert/strict';
import { springStep, rubberband, project, createSpringLoop } from '../web/js/motion.js';

function run(damping, response, steps = 400, dt = 1 / 60, target = 100) {
  let s = { value: 0, velocity: 0 };
  let max = -Infinity;
  let min = Infinity;
  for (let i = 0; i < steps; i++) {
    s = springStep(s, target, dt, { damping, response });
    max = Math.max(max, s.value);
    min = Math.min(min, s.value);
  }
  return { final: s, max, min };
}

test('springStep: damping=1 converges to target with no overshoot', () => {
  for (const response of [0.2, 0.35, 0.6]) {
    const { final, max } = run(1, response);
    assert.ok(Math.abs(final.value - 100) < 0.05, `response ${response}: value ${final.value} close to 100`);
    assert.ok(Math.abs(final.velocity) < 0.05, `response ${response}: velocity settles near 0`);
    assert.ok(max <= 100 + 1e-6, `response ${response}: no overshoot (max=${max})`);
  }
});

test('springStep: damping<1 overshoots and still converges', () => {
  for (const damping of [0.5, 0.7]) {
    const { final, max } = run(damping, 0.35);
    assert.ok(max > 100, `damping ${damping}: overshoots target (max=${max})`);
    assert.ok(Math.abs(final.value - 100) < 0.1, `damping ${damping}: converges (value=${final.value})`);
  }
});

test('springStep: damping>1 (overdamped) converges without oscillating past target twice', () => {
  const { final, max } = run(1.5, 0.35, 600);
  assert.ok(Math.abs(final.value - 100) < 0.1);
  assert.ok(max <= 100 + 1e-6, 'overdamped: no overshoot');
});

test('springStep: dt=0 is a no-op', () => {
  const s = springStep({ value: 10, velocity: 5 }, 100, 0, { damping: 1, response: 0.35 });
  assert.equal(s.value, 10);
  assert.equal(s.velocity, 5);
});

test('rubberband: zero overshoot maps to zero', () => {
  assert.equal(rubberband(0, 120), 0);
});

test('rubberband: monotonic increasing for positive overshoot', () => {
  const xs = [1, 10, 50, 200, 1000, 10000];
  let prev = -Infinity;
  for (const x of xs) {
    const f = rubberband(x, 120);
    assert.ok(f > prev, `rubberband(${x}) = ${f} should exceed previous ${prev}`);
    prev = f;
  }
});

test('rubberband: bounded by the dimension as overshoot grows', () => {
  const dimension = 120;
  const f = rubberband(1e9, dimension);
  assert.ok(f < dimension, `f=${f} should stay below dimension ${dimension}`);
  assert.ok(f > dimension * 0.99, `f=${f} should approach dimension ${dimension} for huge overshoot`);
});

test('rubberband: odd function (symmetric for negative overshoot)', () => {
  assert.ok(Math.abs(rubberband(-40, 120) + rubberband(40, 120)) < 1e-9);
});

test('project: matches the deceleration-decay formula (v=50 -> fixed endpoint)', () => {
  const d = 0.998;
  const expected = (50 / 1000) * (d / (1 - d)); // 0.05 * 499 = 24.95
  assert.ok(Math.abs(project(50, d) - expected) < 1e-9);
  assert.ok(Math.abs(project(50) - 24.95) < 1e-9);
});

test('project: zero velocity projects to zero displacement', () => {
  assert.equal(project(0), 0);
});

test('project: negative velocity projects backwards', () => {
  assert.ok(project(-50) < 0);
});

// --- createSpringLoop: fake rAF/clock so we can drive frames deterministically ---
function fakeDriver(frameMs = 16) {
  let scheduled = null;
  let t = 0;
  const raf = (cb) => { scheduled = cb; return 1; };
  const caf = () => { scheduled = null; };
  const now = () => t;
  const tick = () => {
    if (!scheduled) return false;
    t += frameMs;
    const cb = scheduled;
    scheduled = null;
    cb();
    return true;
  };
  const ticks = (n) => { for (let i = 0; i < n && tick(); i++); };
  return { raf, caf, now, tick, ticks, hasScheduled: () => !!scheduled };
}

test('createSpringLoop: animates from current value to target and settles', () => {
  const driver = fakeDriver();
  let value = 0;
  const loop = createSpringLoop({
    get: () => value,
    set: (v) => { value = v; },
    raf: driver.raf,
    caf: driver.caf,
    now: driver.now,
  });
  loop.to(100, { damping: 1, response: 0.35 });
  assert.ok(loop.isAnimating());
  driver.ticks(200);
  assert.ok(!loop.isAnimating(), 'settled');
  assert.equal(value, 100, 'snaps exactly to target on settle');
});

test('createSpringLoop: onSettle fires exactly once', () => {
  const driver = fakeDriver();
  let value = 0;
  let settles = 0;
  const loop = createSpringLoop({
    get: () => value,
    set: (v) => { value = v; },
    onSettle: () => { settles++; },
    raf: driver.raf,
    caf: driver.caf,
    now: driver.now,
  });
  loop.to(50, { damping: 1, response: 0.3 });
  driver.ticks(200);
  assert.equal(settles, 1);
});

test('createSpringLoop: retargeting mid-flight continues from the live value (no jump)', () => {
  const driver = fakeDriver();
  let value = 0;
  const loop = createSpringLoop({
    get: () => value,
    set: (v) => { value = v; },
    raf: driver.raf,
    caf: driver.caf,
    now: driver.now,
  });
  loop.to(100, { damping: 0.8, response: 0.3, velocity: 400 });
  driver.ticks(10); // partway through the flight, well short of settling
  const valueBeforeRetarget = value;
  loop.to(0, { damping: 1, response: 0.35 }); // redirect, e.g. user grabs it again
  // the retarget call itself must not move the value synchronously
  assert.equal(value, valueBeforeRetarget);
  driver.tick(); // first frame after retarget
  const jump = Math.abs(value - valueBeforeRetarget);
  // one 16ms frame at this speed should move it a small amount, not snap toward the new target
  assert.ok(jump < 20, `expected a small continuous step, got a jump of ${jump}`);
});

test('createSpringLoop: stop() halts the loop and isAnimating() becomes false', () => {
  const driver = fakeDriver();
  let value = 0;
  const loop = createSpringLoop({
    get: () => value,
    set: (v) => { value = v; },
    raf: driver.raf,
    caf: driver.caf,
    now: driver.now,
  });
  loop.to(100);
  driver.ticks(2);
  loop.stop();
  assert.ok(!loop.isAnimating());
  assert.ok(!driver.hasScheduled());
});
