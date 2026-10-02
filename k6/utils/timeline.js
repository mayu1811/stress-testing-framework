// Builds the k6 `ramping-vus` stages AND a matching list of measurement
// windows, so every request can be tagged with the stage it belongs to and
// whether it happened during ramp or steady-state ("hold").
//
// Only steady-state samples are used for the per-stage numbers: ramp-up
// samples mix several concurrency levels and would blur the results.

import exec from 'k6/execution';
import { seconds } from '../config.js';

const label = (i, vus) => `s${String(i + 1).padStart(2, '0')}_${vus}vus`;

// Load test: 0 -> N -> hold -> 0 -> cool down, for each stage.
export function buildLoadTimeline({ stages, rampUp, rampDown, cooldown }) {
  const k6Stages = [];
  const windows = [];
  let t = 0;
  stages.forEach((s, i) => {
    const up = seconds(rampUp);
    const hold = seconds(s.hold);
    const down = seconds(rampDown);
    const cool = seconds(cooldown);
    k6Stages.push({ duration: `${up}s`, target: s.vus });
    k6Stages.push({ duration: `${hold}s`, target: s.vus });
    k6Stages.push({ duration: `${down}s`, target: 0 });
    if (cool > 0) k6Stages.push({ duration: `${cool}s`, target: 0 });
    windows.push({ name: label(i, s.vus), vus: s.vus, start: t, holdStart: t + up, holdEnd: t + up + hold, holdSec: hold });
    t += up + hold + down + cool;
  });
  return { k6Stages, windows, totalSec: t };
}

// Stress test: stair-step upwards without returning to zero, then (optionally)
// a RECOVERY window: drop back to a baseline level and hold, to measure
// whether the system returns to its pre-stress behaviour.
export function buildStressTimeline({ levels, stepRamp, stepHold, rampDown, recovery }) {
  const k6Stages = [];
  const windows = [];
  let t = 0;
  levels.forEach((vus, i) => {
    const up = seconds(stepRamp);
    const hold = seconds(stepHold);
    k6Stages.push({ duration: `${up}s`, target: vus });
    k6Stages.push({ duration: `${hold}s`, target: vus });
    windows.push({ name: label(i, vus), vus, start: t, holdStart: t + up, holdEnd: t + up + hold, holdSec: hold });
    t += up + hold;
  });
  if (recovery && recovery.enabled) {
    const down = seconds(recovery.ramp);
    const hold = seconds(recovery.hold);
    k6Stages.push({ duration: `${down}s`, target: recovery.vus });
    k6Stages.push({ duration: `${hold}s`, target: recovery.vus });
    windows.push({
      name: `s${String(levels.length + 1).padStart(2, '0')}_recovery_${recovery.vus}vus`,
      vus: recovery.vus, recovery: true, start: t, holdStart: t + down, holdEnd: t + down + hold, holdSec: hold,
    });
    t += down + hold;
  }
  k6Stages.push({ duration: rampDown, target: 0 });
  return { k6Stages, windows, totalSec: t + seconds(rampDown) };
}

// Smoke test: one window covering the whole run.
export function buildSmokeTimeline({ vus, duration }) {
  const d = seconds(duration);
  return { windows: [{ name: 'smoke', vus, start: 0, holdStart: 0, holdEnd: d, holdSec: d }], totalSec: d };
}

let activeWindows = [];
export function useTimeline(windows) {
  activeWindows = windows;
}

// Tags for "right now", based on time elapsed since the scenario started.
export function currentStageTags() {
  if (activeWindows.length === 1 && activeWindows[0].name === 'smoke') return { stage: 'smoke', phase: 'steady' };
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  for (let i = activeWindows.length - 1; i >= 0; i--) {
    const w = activeWindows[i];
    if (elapsed >= w.start) {
      return { stage: w.name, phase: elapsed >= w.holdStart && elapsed < w.holdEnd ? 'steady' : 'ramp' };
    }
  }
  return { stage: 'none', phase: 'ramp' };
}
