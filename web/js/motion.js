// Shared spring-physics engine. Pure, no DOM. See docs/DESIGN.md §2.
// Parameterised by damping ratio + response time (s), like SwiftUI's
// `.spring(response:dampingFraction:)`, not by mass/stiffness/damping.

const VALUE_EPS = 0.01; // px: settle threshold
const VELOCITY_EPS = 0.01; // px/s: settle threshold

// One analytic step of a damped harmonic oscillator (exact solution, stable for any dt).
// omega = natural angular frequency derived from `response`; `damping` is the damping ratio
// (1 = critically damped, no overshoot; <1 = underdamped, oscillates; >1 = overdamped).
export function springStep(state, target, dt, { damping = 1, response = 0.35 } = {}) {
  const { value, velocity } = state;
  if (!(dt > 0)) return { value, velocity };
  const omega = (2 * Math.PI) / Math.max(response, 1e-6);
  const x0 = value - target; // position relative to target
  const v0 = velocity;
  let x, v;
  if (Math.abs(damping - 1) < 1e-3) {
    // critically damped: x(t) = (x0 + b*t) * e^(-omega*t), b = v0 + omega*x0
    const b = v0 + omega * x0;
    const e = Math.exp(-omega * dt);
    x = (x0 + b * dt) * e;
    v = (v0 - omega * b * dt) * e;
  } else if (damping < 1) {
    // underdamped: decaying oscillation around the target
    const omegaD = omega * Math.sqrt(1 - damping * damping);
    const e = Math.exp(-damping * omega * dt);
    const a = x0;
    const b = (v0 + damping * omega * x0) / omegaD;
    const cos = Math.cos(omegaD * dt);
    const sin = Math.sin(omegaD * dt);
    x = e * (a * cos + b * sin);
    v = e * (-damping * omega * (a * cos + b * sin) + omegaD * (-a * sin + b * cos));
  } else {
    // overdamped: two real exponential decays, no oscillation
    const s = omega * Math.sqrt(damping * damping - 1);
    const r1 = -damping * omega + s;
    const r2 = -damping * omega - s;
    const a = (v0 - r2 * x0) / (r1 - r2);
    const b = x0 - a;
    const e1 = Math.exp(r1 * dt);
    const e2 = Math.exp(r2 * dt);
    x = a * e1 + b * e2;
    v = a * r1 * e1 + b * r2 * e2;
  }
  return { value: target + x, velocity: v };
}

// iOS-style rubber-band resistance for dragging past a limit. docs/DESIGN.md §2:
// f(x) = x*D*c / (D + c*|x|). Monotonic, bounded (|f(x)| -> D as |x| -> Infinity).
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

// Projects where a flick comes to rest (iOS deceleration-style). docs/DESIGN.md §2:
// end = pos + (v/1000) * d / (1 - d). Returns the DISPLACEMENT from the current position;
// the caller adds its own `pos`. `velocity` is in px/s.
export function project(velocity, decelerationRate = 0.998) {
  return (velocity / 1000) * (decelerationRate / (1 - decelerationRate));
}

// Drives a value toward a target via rAF, reading/writing through get/set so a retarget
// mid-flight never jumps: the next step always continues from get()'s live value and the
// loop's own tracked velocity (docs/DESIGN.md §2: "keep the current velocity when re-targeted").
export function createSpringLoop({ get, set, onSettle, raf, caf, now }) {
  const reqFrame = raf || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
  const cancelFrame = caf || (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);
  const clock = now || (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());

  let target = get();
  let vel = 0;
  let damping = 1;
  let response = 0.35;
  let frameId = 0;
  let running = false;
  let lastT = 0;

  function tick() {
    const t = clock();
    let dt = (t - lastT) / 1000;
    lastT = t;
    if (!(dt > 0)) { frameId = reqFrame(tick); return; }
    dt = Math.min(dt, 1 / 30); // clamp large gaps (tab switch, slow test clock)
    const current = get();
    const result = springStep({ value: current, velocity: vel }, target, dt, { damping, response });
    vel = result.velocity;
    if (Math.abs(result.value - target) < VALUE_EPS && Math.abs(vel) < VELOCITY_EPS) {
      set(target);
      vel = 0;
      running = false;
      onSettle?.();
      return;
    }
    set(result.value);
    frameId = reqFrame(tick);
  }

  return {
    // Retargets from the current get() value and the loop's current velocity. `velocity` here
    // is an explicit override (e.g. a release velocity from a drag); omit it to keep coasting.
    to(newTarget, { velocity = 0, damping: d = 1, response: r = 0.35 } = {}) {
      target = newTarget;
      vel = velocity;
      damping = d;
      response = r;
      if (!running) {
        running = true;
        lastT = clock();
        frameId = reqFrame(tick);
      }
    },
    stop() {
      if (running && cancelFrame) cancelFrame(frameId);
      running = false;
    },
    isAnimating() { return running; },
  };
}
