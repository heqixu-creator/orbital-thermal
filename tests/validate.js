/**
 * Physics checks for the two-node orbital thermal model.
 * Run from the repository root: node tests/validate.js
 */
"use strict";

const sim = require("../simulation.js");

const results = [];

function check(name, condition, detail) {
  results.push({ name: name, pass: Boolean(condition), detail: detail || "" });
  const mark = condition ? "PASS" : "FAIL";
  console.log(mark + "  " + name + (detail ? "  —  " + detail : ""));
}

function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

function relax(params, maxSeconds) {
  const model = new sim.Simulation(params);
  const limit = maxSeconds == null ? params.durationMin * 60 : maxSeconds;
  const originalDuration = model.params.durationMin;
  model.params.durationMin = Math.max(originalDuration, limit / 60);
  let previousChip = model.chipK;
  let previousRad = model.radiatorK;
  while (model.timeS < limit - 1e-6) {
    const chunk = Math.min(30, limit - model.timeS);
    model.advance(chunk, { record: false, maxStep: 5 });
    const slope = sim.derivatives(model.params, model.chipK, model.radiatorK, model.effectiveWorkload);
    const settled = Math.abs(slope.dTc) < 2e-5 && Math.abs(slope.dTr) < 2e-5;
    const creeping =
      Math.abs(model.chipK - previousChip) < 1e-4 && Math.abs(model.radiatorK - previousRad) < 1e-4;
    if (model.timeS > 60 && settled && creeping) break;
    previousChip = model.chipK;
    previousRad = model.radiatorK;
  }
  return model;
}

function blackbody(kelvin) {
  return sim.SIGMA * kelvin * kelvin * kelvin * kelvin;
}

// --- Algebraic anchors -------------------------------------------------------

(function lawAnchors() {
  const at300 = blackbody(300);
  check(
    "Stefan–Boltzmann at 300 K",
    near(at300, 459.300327939, 1e-6),
    at300.toFixed(6) + " W/m²"
  );

  const params = sim.defaultParams();
  const room = sim.celsiusToKelvin(25);
  const radiated = sim.radiatedPower(params, room);
  check(
    "Default radiator at 25 °C rejects about 1.6 kW",
    radiated > 1400 && radiated < 1800,
    radiated.toFixed(1) + " W"
  );

  const coldBug = sim.SIGMA * 25 * 25 * 25 * 25 * params.emissivity * params.area;
  check(
    "Fourth power is not being fed Celsius",
    radiated / coldBug > 1000,
    "ratio " + (radiated / coldBug).toExponential(2)
  );

  check("0 °C is 273.15 K", sim.celsiusToKelvin(0) === 273.15, "");
  check("Space background is 3 K", sim.T_SPACE === 3, "");
})();

(function fixedPoint() {
  const params = sim.defaultParams();
  params.powerPerChip = 0;
  params.pEnvironment = 0;
  params.workload = 0;
  const slope = sim.derivatives(params, sim.T_SPACE, sim.T_SPACE, 0);
  check(
    "Zero-power fixed point is 3 K on both nodes",
    Math.abs(slope.dTc) < 1e-12 && Math.abs(slope.dTr) < 1e-12 && Math.abs(slope.P_rad) < 1e-9,
    "dTc " + slope.dTc.toExponential(2) + ", dTr " + slope.dTr.toExponential(2)
  );

  const steady = sim.steadyTemperatures(params, 0);
  check(
    "Analytic idle equilibrium is the background temperature",
    near(steady.chipK, 3, 1e-9) && near(steady.radiatorK, 3, 1e-9),
    steady.chipK.toFixed(6) + " K"
  );
})();

// --- Test 1: approach the radiative background --------------------------------

(function testApproach() {
  const params = sim.defaultParams();
  params.powerPerChip = 0;
  params.workload = 0;
  params.pEnvironment = 0;
  params.durationMin = 60;
  const hour = new sim.Simulation(params);
  hour.advance(3600, { record: false, maxStep: 5 });
  const summary = hour.summary();
  check(
    "Test 1a: with zero load, both nodes cool during the first hour",
    summary.finalChipC < 24 && summary.finalRadiatorC < 24 && summary.minChipK > 2.5,
    "chip " + summary.finalChipC.toFixed(2) + " °C, radiator " + summary.finalRadiatorC.toFixed(2) + " °C"
  );
  check(
    "Test 1a: temperatures stay above absolute zero",
    summary.minChipK > 0 && summary.finalRadiatorK > 0 && !summary.recovered,
    "min chip " + summary.minChipK.toFixed(2) + " K"
  );

  const fast = sim.defaultParams();
  fast.powerPerChip = 0;
  fast.workload = 0;
  fast.pEnvironment = 0;
  fast.cChip = 40;
  fast.cRadiator = 80;
  fast.durationMin = 8000;
  const cold = relax(fast, 8000 * 60);
  check(
    "Test 1b: reduced thermal mass continues toward 3 K",
    cold.radiatorK < 20 && cold.chipK < 22 && cold.radiatorK > 3 && cold.chipK > 3,
    "chip " +
      cold.chipK.toFixed(2) +
      " K, radiator " +
      cold.radiatorK.toFixed(2) +
      " K after " +
      (cold.timeS / 3600).toFixed(2) +
      " h"
  );
  const slope = sim.derivatives(fast, cold.chipK, cold.radiatorK, 0);
  check(
    "Test 1b: both nodes are still cooling or have arrived",
    slope.dTc <= 1e-6 && slope.dTr <= 1e-6,
    "dTc " + slope.dTc.toExponential(2) + " K/s, dTr " + slope.dTr.toExponential(2) + " K/s"
  );
})();

// --- Test 2: more chip power, higher equilibrium ------------------------------

(function testPower() {
  function settled(powerPerChip) {
    const params = sim.paramsFromPreset("baseline");
    params.powerPerChip = powerPerChip;
    params.durationMin = 6000;
    return relax(params, 8 * 3600);
  }
  const low = settled(100);
  const high = settled(400);
  check(
    "Test 2: doubling-scale chip power raises the equilibrium",
    high.chipK > low.chipK + 20 && high.radiatorK > low.radiatorK + 15,
    "100 W/chip → " +
      sim.kelvinToCelsius(low.chipK).toFixed(2) +
      " °C, 400 W/chip → " +
      sim.kelvinToCelsius(high.chipK).toFixed(2) +
      " °C"
  );
  check(
    "Test 2: neither of those loads needs the throttle on a 4 m² panel",
    low.throttleTimeS === 0 && high.throttleTimeS === 0,
    "throttle " + low.throttleTimeS.toFixed(1) + " s / " + high.throttleTimeS.toFixed(1) + " s"
  );

  const analyticLow = sim.operatingPoint(
    Object.assign(sim.paramsFromPreset("baseline"), { powerPerChip: 100 })
  );
  const analyticHigh = sim.operatingPoint(
    Object.assign(sim.paramsFromPreset("baseline"), { powerPerChip: 400 })
  );
  check(
    "Test 2: dynamic equilibrium matches the algebraic steady state",
    near(low.chipK, analyticLow.chipK, 0.15) && near(high.chipK, analyticHigh.chipK, 0.2),
    "errors " +
      (low.chipK - analyticLow.chipK).toFixed(3) +
      " K and " +
      (high.chipK - analyticHigh.chipK).toFixed(3) +
      " K"
  );
})();

// --- Test 3: area --------------------------------------------------------------

(function testArea() {
  const params = sim.defaultParams();
  const temperature = 350;
  const small = sim.radiatedPower(Object.assign({}, params, { area: 2 }), temperature);
  const large = sim.radiatedPower(Object.assign({}, params, { area: 4 }), temperature);
  check(
    "Test 3: radiated power scales with area at fixed temperature",
    near(large / small, 2, 1e-12),
    small.toFixed(2) + " W vs " + large.toFixed(2) + " W"
  );

  function eq(area) {
    const p = sim.paramsFromPreset("baseline");
    p.area = area;
    p.durationMin = 6000;
    return relax(p, 8 * 3600);
  }
  const narrow = eq(2);
  const wide = eq(8);
  check(
    "Test 3: a larger radiator equilibrates colder",
    wide.radiatorK < narrow.radiatorK - 20,
    "2 m² → " +
      sim.kelvinToCelsius(narrow.radiatorK).toFixed(2) +
      " °C, 8 m² → " +
      sim.kelvinToCelsius(wide.radiatorK).toFixed(2) +
      " °C"
  );
})();

// --- Test 4: emissivity --------------------------------------------------------

(function testEmissivity() {
  const params = sim.defaultParams();
  const temperature = 320;
  const dull = sim.radiatedPower(Object.assign({}, params, { emissivity: 0.4 }), temperature);
  const black = sim.radiatedPower(Object.assign({}, params, { emissivity: 0.8 }), temperature);
  check(
    "Test 4: radiated power scales with emissivity at fixed temperature",
    near(black / dull, 2, 1e-12),
    dull.toFixed(2) + " W vs " + black.toFixed(2) + " W"
  );

  function eq(emissivity) {
    const p = sim.paramsFromPreset("baseline");
    p.emissivity = emissivity;
    p.durationMin = 6000;
    return relax(p, 8 * 3600);
  }
  const lowE = eq(0.45);
  const highE = eq(0.9);
  check(
    "Test 4: higher emissivity equilibrates colder",
    highE.chipK < lowE.chipK - 10,
    "ε 0.45 → " +
      sim.kelvinToCelsius(lowE.chipK).toFixed(2) +
      " °C, ε 0.90 → " +
      sim.kelvinToCelsius(highE.chipK).toFixed(2) +
      " °C"
  );
})();

// --- Test 5: capacitance -------------------------------------------------------

(function testCapacitance() {
  function earlyDelta(cChip, cRadiator) {
    const params = sim.paramsFromPreset("baseline");
    params.cChip = cChip;
    params.cRadiator = cRadiator;
    params.durationMin = 30;
    const model = new sim.Simulation(params);
    const startChip = model.chipK;
    const startRad = model.radiatorK;
    model.advance(120, { record: false, maxStep: 0.5 });
    return {
      chip: Math.abs(model.chipK - startChip),
      rad: Math.abs(model.radiatorK - startRad),
      finalChip: model.chipK,
    };
  }
  const light = earlyDelta(400, 2000);
  const heavy = earlyDelta(4000, 20000);
  check(
    "Test 5: larger thermal capacitance slows the first two minutes",
    heavy.chip < light.chip * 0.7 && heavy.rad < light.rad * 0.7,
    "light ΔT chip " +
      light.chip.toFixed(2) +
      " K, heavy ΔT chip " +
      heavy.chip.toFixed(2) +
      " K"
  );

  function finalAt(cChip, cRadiator) {
    const params = sim.paramsFromPreset("baseline");
    params.cChip = cChip;
    params.cRadiator = cRadiator;
    params.durationMin = 8000;
    return relax(params, 10 * 3600);
  }
  const a = finalAt(400, 2000);
  const b = finalAt(4000, 20000);
  check(
    "Test 5: capacitance does not change the equilibrium",
    near(a.chipK, b.chipK, 0.2) && near(a.radiatorK, b.radiatorK, 0.2),
    sim.kelvinToCelsius(a.chipK).toFixed(3) + " °C vs " + sim.kelvinToCelsius(b.chipK).toFixed(3) + " °C"
  );

  const analytic = sim.operatingPoint(sim.paramsFromPreset("baseline"));
  check(
    "Steady temperature formula has no capacitance in it",
    near(a.chipK, analytic.chipK, 0.2),
    "analytic chip " + analytic.chipC.toFixed(2) + " °C"
  );
})();

// --- Test 6: throttling --------------------------------------------------------

(function testThrottle() {
  const limit = sim.celsiusToKelvin(85);
  check(
    "Throttle factor is 1 below the band and 0 at the limit",
    sim.throttleFactor(limit - 2, limit) === 1 &&
      sim.throttleFactor(limit, limit) === 0 &&
      near(sim.throttleFactor(limit - 1, limit), 0.5, 1e-12),
    ""
  );

  const hot = sim.paramsFromPreset("undersized");
  hot.durationMin = 240;
  const open = sim.steadyTemperatures(hot, hot.nChips * hot.powerPerChip);
  check(
    "Undersized preset would exceed 85 °C without a throttle",
    open.chipC > 85,
    "unthrottled chip " + open.chipC.toFixed(2) + " °C, radiator " + open.radiatorC.toFixed(2) + " °C"
  );

  const run = relax(hot, 4 * 3600);
  const point = sim.operatingPoint(hot);
  check(
    "Test 6: undersized radiator engages the throttle",
    run.throttleTimeS > 60 && run.summary().finalWorkload < 0.98,
    "throttled " +
      (run.throttleTimeS / 60).toFixed(1) +
      " min, final workload " +
      (100 * run.effectiveWorkload).toFixed(1) +
      "%"
  );
  check(
    "Test 6: chip temperature is not sustained above the limit",
    run.summary().lateMaxChipC <= 85.5 && run.summary().finalChipC <= 85.5 && run.timeAboveLimitS < 30,
    "final " +
      run.summary().finalChipC.toFixed(2) +
      " °C, late max " +
      run.summary().lateMaxChipC.toFixed(2) +
      " °C, time above limit " +
      run.timeAboveLimitS.toFixed(2) +
      " s"
  );
  check(
    "Test 6: throttled equilibrium matches the proportional map",
    near(run.chipK, point.chipK, 0.3) && point.throttled && point.feasible,
    "dynamic " +
      sim.kelvinToCelsius(run.chipK).toFixed(2) +
      " °C, predicted " +
      point.chipC.toFixed(2) +
      " °C at " +
      (100 * point.factor).toFixed(1) +
      "% workload"
  );

  const safe = relax(sim.paramsFromPreset("baseline"), 3 * 3600);
  check(
    "Baseline preset does not throttle",
    safe.throttleTimeS === 0 && safe.summary().finalChipC < 85,
    "final chip " + safe.summary().finalChipC.toFixed(2) + " °C"
  );

  const choked = sim.paramsFromPreset("undersized");
  choked.pEnvironment = 4000;
  choked.durationMin = 180;
  const chokedPoint = sim.operatingPoint(choked);
  const chokedRun = relax(choked, 3 * 3600);
  check(
    "Insufficient cooling is reported instead of being hidden",
    chokedPoint.feasible === false && chokedRun.summary().finalChipC > 85,
    "zero-power chip " +
      sim.steadyTemperatures(choked, 0).chipC.toFixed(1) +
      " °C, simulated final " +
      chokedRun.summary().finalChipC.toFixed(1) +
      " °C"
  );
})();

// --- Energy balance and solver hygiene ----------------------------------------

(function testEnergy() {
  const params = sim.paramsFromPreset("baseline");
  params.durationMin = 60;
  const model = new sim.Simulation(params);
  model.advance(3600, { record: false, maxStep: 0.5 });
  const residual = Math.abs(model.auditStoredJ - model.auditTrapezoidJ);
  const scale = Math.max(1, Math.abs(model.auditStoredJ), Math.abs(model.auditTrapezoidJ));
  check(
    "Energy balance on a one-hour baseline run",
    residual / scale < 0.005 && Number.isFinite(residual),
    "residual " + residual.toFixed(2) + " J (" + ((100 * residual) / scale).toFixed(4) + "% of " + scale.toFixed(0) + " J)"
  );

  const hot = sim.paramsFromPreset("undersized");
  hot.durationMin = 90;
  const throttled = new sim.Simulation(hot);
  throttled.advance(5400, { record: false, maxStep: 0.5 });
  const hotResidual = Math.abs(throttled.auditStoredJ - throttled.auditTrapezoidJ);
  const hotScale = Math.max(1, Math.abs(throttled.auditStoredJ), Math.abs(throttled.auditTrapezoidJ));
  check(
    "Energy balance while the throttle is moving",
    hotResidual / hotScale < 0.01 && Number.isFinite(throttled.chipK),
    "residual " + hotResidual.toFixed(2) + " J (" + ((100 * hotResidual) / hotScale).toFixed(4) + "%)"
  );
})();

(function testExtremes() {
  const corners = [
    { powerPerChip: 1000, nChips: 8, area: 0.2, emissivity: 0.05, conductance: 1, cChip: 200, cRadiator: 500 },
    { powerPerChip: 0, pEnvironment: 1500, area: 0.5, emissivity: 0.2, conductance: 5 },
    { powerPerChip: 50, area: 20, emissivity: 1, conductance: 400, cChip: 20000, cRadiator: 80000 },
    { tChip0C: -40, tRad0C: 80, powerPerChip: 300, area: 1.5, workload: 0.4 },
  ];
  let worst = 0;
  let finite = true;
  corners.forEach(function (overrides) {
    const params = Object.assign(sim.defaultParams(), overrides, { durationMin: 30 });
    const model = new sim.Simulation(params);
    model.advance(1800, { record: false, maxStep: 1 });
    const summary = model.summary();
    if (!Number.isFinite(summary.finalChipK) || !Number.isFinite(summary.finalRadiatorK)) finite = false;
    if (summary.finalChipK < 0.01 || summary.finalRadiatorK < 0.01) finite = false;
    worst = Math.max(worst, summary.finalChipC, summary.maxChipC);
  });
  check(
    "Extreme corners stay finite and above 0 K",
    finite,
    "hottest chip seen " + worst.toFixed(1) + " °C"
  );
})();

(function reportPresets() {
  sim.PRESETS.forEach(function (preset) {
    const params = sim.paramsFromPreset(preset.id);
    const point = sim.operatingPoint(params);
    console.log(
      "PRESET " +
        preset.name +
        ": unthrottled " +
        sim.steadyTemperatures(params, point.commandedW).chipC.toFixed(2) +
        " °C chip / " +
        sim.steadyTemperatures(params, point.commandedW).radiatorC.toFixed(2) +
        " °C radiator; operating " +
        point.chipC.toFixed(2) +
        " °C chip / " +
        point.radiatorC.toFixed(2) +
        " °C radiator; workload " +
        (100 * point.factor).toFixed(1) +
        "%; throttled " +
        point.throttled
    );
  });
})();

const failed = results.filter(function (item) {
  return !item.pass;
});
console.log("");
console.log(results.length - failed.length + " passed, " + failed.length + " failed");
if (failed.length) {
  failed.forEach(function (item) {
    console.log("  FAIL " + item.name);
  });
  process.exit(1);
}
