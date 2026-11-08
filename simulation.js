/**
 * Orbital AI thermal simulator — two-node lumped model.
 *
 * This file is the physics and numerical core. It does not touch the DOM.
 * Temperatures inside the solver are always kelvin. Callers that talk to
 * people convert to degrees Celsius at the boundary.
 *
 * The parameters are illustrative. They are not a specification of any
 * real satellite.
 *
 * Governing equations
 * -------------------
 *   Q = G (T_chip - T_radiator)
 *   C_chip     dT_chip/dt     = P_heat - Q
 *   C_radiator dT_radiator/dt = Q + P_environment - P_radiated
 *   P_heat     = N_chips * P_chip * f_effective
 *   P_radiated = epsilon * sigma * A * (T_radiator^4 - T_space^4)
 *
 * sigma is the CODATA Stefan–Boltzmann constant. T_space is 3 K.
 * A is the total effective radiating area, counted once.
 *
 * The radiator is assumed to be shielded from direct solar illumination.
 * Any extra absorbed load (sun, albedo, planetary infrared, nearby
 * surfaces) is an input, P_environment, not a second radiation term.
 *
 * Throttle
 * --------
 * A proportional law unloads the chips across a 2 K band ending at the
 * configured limit, so a steady state cannot sit above that limit when
 * the radiator is physically able to reject the heat. The status flag
 * uses an extra 0.5 K of hysteresis so the "throttling" indication does
 * not flicker on the boundary. The heat load itself has no jump.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ThermalSim = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** CODATA Stefan–Boltzmann constant, W m^-2 K^-4. */
  const SIGMA = 5.670374419e-8;

  /** Simplified deep-space background temperature, kelvin. */
  const T_SPACE = 3;

  /**
   * Width of the proportional unload band, kelvin.
   * Factor is 1 at (T_max - band) and 0 at T_max.
   */
  const THROTTLE_BAND_K = 2;

  /** Extra kelvin below the band before the status flag clears. */
  const STATUS_HYSTERESIS_K = 0.5;

  const DEFAULT_PARAMS = Object.freeze({
    nChips: 4,
    powerPerChip: 200,
    workload: 1,
    cChip: 2000,
    cRadiator: 10000,
    area: 4,
    emissivity: 0.9,
    conductance: 100,
    pEnvironment: 0,
    tChip0C: 25,
    tRad0C: 25,
    tMaxC: 85,
    durationMin: 60,
  });

  const PRESETS = Object.freeze([
    Object.freeze({
      id: "baseline",
      name: "Baseline",
      demonstrates:
        "800 W of chip heat on a 4 m² radiator. The equilibrium sits well below the chip limit, so the array can hold full workload.",
      overrides: Object.freeze({
        nChips: 4,
        powerPerChip: 200,
        workload: 1,
        area: 4,
        emissivity: 0.9,
      }),
    }),
    Object.freeze({
      id: "undersized",
      name: "Undersized radiator",
      demonstrates:
        "The same 800 W into 1 m². The unthrottled chip temperature would pass the limit, so the controller has to give up workload.",
      overrides: Object.freeze({
        nChips: 4,
        powerPerChip: 200,
        workload: 1,
        area: 1,
        emissivity: 0.9,
      }),
    }),
    Object.freeze({
      id: "improved",
      name: "Improved radiator",
      demonstrates:
        "The same chips on 8 m². More area lowers the equilibrium temperature and widens the margin. Mass and stowed volume are not in this model.",
      overrides: Object.freeze({
        nChips: 4,
        powerPerChip: 200,
        workload: 1,
        area: 8,
        emissivity: 0.9,
      }),
    }),
  ]);

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function finiteOr(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function celsiusToKelvin(celsius) {
    return celsius + 273.15;
  }

  function kelvinToCelsius(kelvin) {
    return kelvin - 273.15;
  }

  function defaultParams() {
    return Object.assign({}, DEFAULT_PARAMS);
  }

  function sanitizeParams(input) {
    const source = input || {};
    return {
      nChips: Math.round(clamp(finiteOr(source.nChips, DEFAULT_PARAMS.nChips), 1, 64)),
      powerPerChip: clamp(finiteOr(source.powerPerChip, DEFAULT_PARAMS.powerPerChip), 0, 5000),
      workload: clamp(finiteOr(source.workload, DEFAULT_PARAMS.workload), 0, 1),
      cChip: clamp(finiteOr(source.cChip, DEFAULT_PARAMS.cChip), 20, 100000),
      cRadiator: clamp(finiteOr(source.cRadiator, DEFAULT_PARAMS.cRadiator), 50, 500000),
      area: clamp(finiteOr(source.area, DEFAULT_PARAMS.area), 0.05, 100),
      emissivity: clamp(finiteOr(source.emissivity, DEFAULT_PARAMS.emissivity), 0.02, 1),
      conductance: clamp(finiteOr(source.conductance, DEFAULT_PARAMS.conductance), 0.2, 5000),
      pEnvironment: clamp(finiteOr(source.pEnvironment, DEFAULT_PARAMS.pEnvironment), 0, 50000),
      tChip0C: clamp(finiteOr(source.tChip0C, DEFAULT_PARAMS.tChip0C), -200, 400),
      tRad0C: clamp(finiteOr(source.tRad0C, DEFAULT_PARAMS.tRad0C), -200, 400),
      tMaxC: clamp(finiteOr(source.tMaxC, DEFAULT_PARAMS.tMaxC), -50, 400),
      durationMin: clamp(finiteOr(source.durationMin, DEFAULT_PARAMS.durationMin), 1, 30000),
    };
  }

  function paramsFromPreset(id) {
    const preset = PRESETS.find(function (item) {
      return item.id === id;
    });
    if (!preset) return defaultParams();
    return sanitizeParams(Object.assign({}, DEFAULT_PARAMS, preset.overrides));
  }

  /**
   * Fraction of the commanded workload the throttle still allows.
   * 1 below the band, 0 at and above the limit, linear between.
   */
  function throttleFactor(tempK, limitK) {
    const start = limitK - THROTTLE_BAND_K;
    if (!(tempK > start)) return 1;
    if (tempK >= limitK) return 0;
    return (limitK - tempK) / THROTTLE_BAND_K;
  }

  function heatGeneration(params, workloadFraction) {
    return params.nChips * params.powerPerChip * workloadFraction;
  }

  /** Net heat leaving the radiator toward the 3 K background, watts. */
  function radiatedPower(params, radiatorK) {
    const temperature = Number.isFinite(radiatorK) ? Math.max(radiatorK, 0) : 0;
    const fourth = temperature * temperature * temperature * temperature;
    const spaceFourth = T_SPACE * T_SPACE * T_SPACE * T_SPACE;
    return params.emissivity * SIGMA * params.area * (fourth - spaceFourth);
  }

  function conductionPower(params, chipK, radiatorK) {
    return params.conductance * (chipK - radiatorK);
  }

  function derivatives(params, chipK, radiatorK, workloadFraction) {
    const pHeat = heatGeneration(params, workloadFraction);
    const transfer = conductionPower(params, chipK, radiatorK);
    const radiated = radiatedPower(params, radiatorK);
    return {
      dTc: (pHeat - transfer) / params.cChip,
      dTr: (transfer + params.pEnvironment - radiated) / params.cRadiator,
      P_heat: pHeat,
      Q: transfer,
      P_rad: radiated,
    };
  }

  /**
   * Algebraic steady state at a frozen chip heat load.
   * Radiator: P + P_environment = epsilon sigma A (T_r^4 - T_space^4)
   * Chip:     T_c = T_r + P / G
   */
  function steadyTemperatures(paramsInput, powerW) {
    const params = sanitizeParams(paramsInput);
    const power = Math.max(0, finiteOr(powerW, 0));
    const coefficient = params.emissivity * SIGMA * params.area;
    const spaceFourth = T_SPACE * T_SPACE * T_SPACE * T_SPACE;
    const radiatorFourth = (power + params.pEnvironment) / coefficient + spaceFourth;
    const radiatorK = Math.pow(Math.max(radiatorFourth, 0), 0.25);
    const chipK = radiatorK + power / params.conductance;
    return {
      chipK: chipK,
      radiatorK: radiatorK,
      chipC: kelvinToCelsius(chipK),
      radiatorC: kelvinToCelsius(radiatorK),
      transferW: power,
      radiatedW: radiatedPower(params, radiatorK),
    };
  }

  /**
   * Steady operating point including the proportional throttle.
   * Solves for the heat load that is consistent with the throttle map.
   */
  function operatingPoint(paramsInput) {
    const params = sanitizeParams(paramsInput);
    const commanded = heatGeneration(params, params.workload);
    const limitK = celsiusToKelvin(params.tMaxC);
    const idle = steadyTemperatures(params, 0);
    const feasible = idle.chipK <= limitK + 1e-6;

    if (commanded <= 0) {
      return {
        chipK: idle.chipK,
        radiatorK: idle.radiatorK,
        chipC: idle.chipC,
        radiatorC: idle.radiatorC,
        powerW: 0,
        factor: 1,
        throttled: false,
        feasible: feasible,
        commandedW: 0,
      };
    }

    const open = steadyTemperatures(params, commanded);
    if (open.chipK <= limitK) {
      return {
        chipK: open.chipK,
        radiatorK: open.radiatorK,
        chipC: open.chipC,
        radiatorC: open.radiatorC,
        powerW: commanded,
        factor: 1,
        throttled: false,
        feasible: true,
        commandedW: commanded,
      };
    }

    let low = 0;
    let high = commanded;
    for (let i = 0; i < 60; i += 1) {
      const mid = 0.5 * (low + high);
      const temps = steadyTemperatures(params, mid);
      const allowed = commanded * throttleFactor(temps.chipK, limitK);
      if (mid > allowed) high = mid;
      else low = mid;
    }
    const powerW = 0.5 * (low + high);
    const temps = steadyTemperatures(params, powerW);
    return {
      chipK: temps.chipK,
      radiatorK: temps.radiatorK,
      chipC: temps.chipC,
      radiatorC: temps.radiatorC,
      powerW: powerW,
      factor: powerW / commanded,
      throttled: true,
      feasible: feasible,
      commandedW: commanded,
    };
  }

  function stageIsPhysical(chipK, radiatorK) {
    return (
      Number.isFinite(chipK) &&
      Number.isFinite(radiatorK) &&
      chipK > 0 &&
      radiatorK > 0 &&
      chipK < 8000 &&
      radiatorK < 8000
    );
  }

  function rk4Step(params, chipK, radiatorK, workloadFraction, h) {
    function rates(tc, tr) {
      const slope = derivatives(params, tc, tr, workloadFraction);
      return [slope.dTc, slope.dTr];
    }

    const k1 = rates(chipK, radiatorK);
    const c2 = chipK + 0.5 * h * k1[0];
    const r2 = radiatorK + 0.5 * h * k1[1];
    if (!stageIsPhysical(c2, r2)) return null;
    const k2 = rates(c2, r2);

    const c3 = chipK + 0.5 * h * k2[0];
    const r3 = radiatorK + 0.5 * h * k2[1];
    if (!stageIsPhysical(c3, r3)) return null;
    const k3 = rates(c3, r3);

    const c4 = chipK + h * k3[0];
    const r4 = radiatorK + h * k3[1];
    if (!stageIsPhysical(c4, r4)) return null;
    const k4 = rates(c4, r4);

    const nextChip = chipK + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    const nextRad = radiatorK + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    if (!stageIsPhysical(nextChip, nextRad)) return null;
    return { chipK: nextChip, radiatorK: nextRad };
  }

  function safeStep(params, chipK, radiatorK, workloadFraction, stepCap) {
    const slope = derivatives(params, chipK, radiatorK, workloadFraction);
    const rate = Math.max(Math.abs(slope.dTc), Math.abs(slope.dTr), 1e-8);
    const byTemperature = 0.3 / rate;
    const radiationConductance =
      4 * params.emissivity * SIGMA * params.area * Math.pow(Math.max(radiatorK, 1), 3);
    const chipTau = params.cChip / Math.max(params.conductance, 1e-9);
    const radiatorTau = params.cRadiator / Math.max(params.conductance + radiationConductance, 1e-9);
    const byTimeConstant = 0.2 * Math.min(chipTau, radiatorTau);
    const uncapped = Math.min(byTemperature, byTimeConstant, stepCap);
    return clamp(uncapped, 0.01, stepCap);
  }

  function Simulation(params) {
    this.params = sanitizeParams(params || defaultParams());
    this.reset();
  }

  Simulation.prototype.reset = function reset() {
    const params = this.params;
    this.timeS = 0;
    this.chipK = celsiusToKelvin(params.tChip0C);
    this.radiatorK = celsiusToKelvin(params.tRad0C);
    this.throttling = false;
    this.effectiveWorkload = params.workload;
    this.complete = false;
    this.recovered = false;
    this.maxChipK = this.chipK;
    this.maxRadiatorK = this.radiatorK;
    this.minChipK = this.chipK;
    this.lateMaxChipK = null;
    this.throttleTimeS = 0;
    this.timeAboveLimitS = 0;
    this.computeEnergyJ = 0;
    this.idealEnergyJ = 0;
    this.radiatedEnergyJ = 0;
    this.auditTrapezoidJ = 0;
    this.auditStoredJ = 0;
    this.samples = [];
    this._nextSampleS = 0;
    this._applyThrottleMap();
    this._refreshDiagnostics();
    this._pushSample();
    this._nextSampleS = 1;
  };

  Simulation.prototype.setParams = function setParams(params) {
    this.params = sanitizeParams(params);
    const duration = this.params.durationMin * 60;
    this.complete = this.timeS >= duration - 1e-6;
    this._applyThrottleMap();
    this._refreshDiagnostics();
  };

  Simulation.prototype._applyThrottleMap = function applyThrottleMap() {
    const limitK = celsiusToKelvin(this.params.tMaxC);
    const start = limitK - THROTTLE_BAND_K;
    const factor = throttleFactor(this.chipK, limitK);
    if (factor < 1 - 1e-9) this.throttling = true;
    else if (this.chipK < start - STATUS_HYSTERESIS_K) this.throttling = false;
    const commanded = clamp(this.params.workload, 0, 1);
    this.effectiveWorkload = clamp(commanded * factor, 0, 1);
    this.throttleFactor = factor;
  };

  Simulation.prototype._refreshDiagnostics = function refreshDiagnostics() {
    const slope = derivatives(this.params, this.chipK, this.radiatorK, this.effectiveWorkload);
    this.P_heat = slope.P_heat;
    this.Q = slope.Q;
    this.P_rad = slope.P_rad;
    this.dTc = slope.dTc;
    this.dTr = slope.dTr;
  };

  Simulation.prototype._pushSample = function pushSample() {
    this.samples.push({
      tMin: this.timeS / 60,
      chipC: kelvinToCelsius(this.chipK),
      radC: kelvinToCelsius(this.radiatorK),
      heatW: this.P_heat,
      radW: this.P_rad,
      workload: this.effectiveWorkload,
    });
  };

  /**
   * Accept an RK4 step that was integrated at a frozen heat load.
   * The trapezoidal audit uses that same frozen load, so a throttle
   * update at the new temperature does not rewrite the step's energy.
   */
  Simulation.prototype._commit = function commit(next, h, record, step) {
    const params = this.params;
    const chip0 = this.chipK;
    const rad0 = this.radiatorK;
    const radBefore = radiatedPower(params, rad0);
    const radAfter = radiatedPower(params, next.radiatorK);
    const netBefore = step.heatW + params.pEnvironment - radBefore;
    const netAfter = step.heatW + params.pEnvironment - radAfter;

    this.auditTrapezoidJ += 0.5 * (netBefore + netAfter) * h;
    this.auditStoredJ += params.cChip * (next.chipK - chip0) + params.cRadiator * (next.radiatorK - rad0);

    this.chipK = next.chipK;
    this.radiatorK = next.radiatorK;
    this.timeS += h;
    this.computeEnergyJ += step.heatW * h;
    this.idealEnergyJ += heatGeneration(params, params.workload) * h;
    this.radiatedEnergyJ += 0.5 * (radBefore + radAfter) * h;
    if (step.reduced) this.throttleTimeS += h;

    this._applyThrottleMap();
    this._refreshDiagnostics();

    if (this.chipK > celsiusToKelvin(params.tMaxC) + 1e-3) this.timeAboveLimitS += h;
    if (this.chipK > this.maxChipK) this.maxChipK = this.chipK;
    if (this.radiatorK > this.maxRadiatorK) this.maxRadiatorK = this.radiatorK;
    if (this.chipK < this.minChipK) this.minChipK = this.chipK;

    const duration = params.durationMin * 60;
    if (this.timeS >= 0.8 * duration) {
      if (this.lateMaxChipK == null || this.chipK > this.lateMaxChipK) {
        this.lateMaxChipK = this.chipK;
      }
    }

    if (record) {
      let guard = 0;
      while (this.timeS + 1e-6 >= this._nextSampleS && guard < 20) {
        this._pushSample();
        this._nextSampleS += 1;
        guard += 1;
      }
    }
  };

  /**
   * Advance spacecraft time by up to `seconds`.
   * options.record stores chart samples.
   * options.maxStep caps the integrator step in seconds.
   * options.maxIters stops a single call from running away on a stiff case.
   */
  Simulation.prototype.advance = function advance(seconds, options) {
    const opts = options === true ? { record: true } : options || {};
    const record = Boolean(opts.record);
    const stepCap = finiteOr(opts.maxStep, record ? 1 : 5);
    const maxIters = opts.maxIters || 2000000;
    const duration = this.params.durationMin * 60;
    let left = Math.min(Math.max(finiteOr(seconds, 0), 0), Math.max(0, duration - this.timeS));

    if (left <= 1e-9) {
      this.complete = this.timeS >= duration - 1e-6;
      return 0;
    }

    const started = this.timeS;
    let iters = 0;
    while (left > 1e-8 && iters < maxIters) {
      this._applyThrottleMap();
      let h = Math.min(left, safeStep(this.params, this.chipK, this.radiatorK, this.effectiveWorkload, stepCap));
      const frozenWorkload = this.effectiveWorkload;
      const step = {
        heatW: heatGeneration(this.params, frozenWorkload),
        reduced: this.throttleFactor < 1 - 1e-9,
      };
      let accepted = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        accepted = rk4Step(this.params, this.chipK, this.radiatorK, frozenWorkload, h);
        if (accepted) break;
        h *= 0.5;
        if (h < 1e-4) break;
      }
      if (!accepted) {
        this.recovered = true;
        this.chipK = clamp(finiteOr(this.chipK, T_SPACE), 0.01, 8000);
        this.radiatorK = clamp(finiteOr(this.radiatorK, T_SPACE), 0.01, 8000);
        this.timeS += Math.max(h, 1e-4);
        left -= Math.max(h, 1e-4);
        this._applyThrottleMap();
        this._refreshDiagnostics();
        iters += 1;
        continue;
      }

      this._commit(accepted, h, record, step);
      left -= h;
      iters += 1;
    }

    this.complete = this.timeS >= duration - 1e-4;
    if (this.complete && record) {
      const last = this.samples[this.samples.length - 1];
      if (!last || Math.abs(last.tMin * 60 - this.timeS) > 0.05) this._pushSample();
    }
    return this.timeS - started;
  };

  Simulation.prototype.summary = function summary() {
    const duration = this.timeS;
    return {
      maxChipC: kelvinToCelsius(this.maxChipK),
      maxRadiatorC: kelvinToCelsius(this.maxRadiatorK),
      finalChipC: kelvinToCelsius(this.chipK),
      finalRadiatorC: kelvinToCelsius(this.radiatorK),
      finalChipK: this.chipK,
      finalRadiatorK: this.radiatorK,
      lateMaxChipC:
        this.lateMaxChipK == null ? kelvinToCelsius(this.maxChipK) : kelvinToCelsius(this.lateMaxChipK),
      usefulComputationJ: this.computeEnergyJ,
      usefulComputationWh: this.computeEnergyJ / 3600,
      idealComputationJ: this.idealEnergyJ,
      throttleSeconds: this.throttleTimeS,
      timeAboveLimitS: this.timeAboveLimitS,
      averageRadiatedW: duration > 0 ? this.radiatedEnergyJ / duration : this.P_rad,
      durationS: duration,
      finalWorkload: this.effectiveWorkload,
      throttling: this.throttling,
      minChipK: this.minChipK,
      energyResidualJ: this.auditStoredJ - this.auditTrapezoidJ,
      recovered: this.recovered,
      complete: this.complete,
    };
  };

  Simulation.prototype.metrics = function metrics() {
    const params = this.params;
    const limitK = celsiusToKelvin(params.tMaxC);
    return {
      timeS: this.timeS,
      durationS: params.durationMin * 60,
      chipC: kelvinToCelsius(this.chipK),
      radiatorC: kelvinToCelsius(this.radiatorK),
      chipK: this.chipK,
      radiatorK: this.radiatorK,
      pHeat: this.P_heat,
      transfer: this.Q,
      pRad: this.P_rad,
      pEnvironment: params.pEnvironment,
      commandedWorkload: params.workload,
      effectiveWorkload: this.effectiveWorkload,
      throttleFactor: this.throttleFactor,
      throttling: this.throttling,
      overLimit: this.chipK > limitK + 1e-3,
      marginK: limitK - this.chipK,
      dTc: this.dTc,
      dTr: this.dTr,
      complete: this.complete,
      nChips: params.nChips,
      area: params.area,
      emissivity: params.emissivity,
      conductance: params.conductance,
      limitC: params.tMaxC,
      recovered: this.recovered,
    };
  };

  return {
    SIGMA: SIGMA,
    T_SPACE: T_SPACE,
    THROTTLE_BAND_K: THROTTLE_BAND_K,
    STATUS_HYSTERESIS_K: STATUS_HYSTERESIS_K,
    DEFAULT_PARAMS: DEFAULT_PARAMS,
    PRESETS: PRESETS,
    celsiusToKelvin: celsiusToKelvin,
    kelvinToCelsius: kelvinToCelsius,
    defaultParams: defaultParams,
    sanitizeParams: sanitizeParams,
    paramsFromPreset: paramsFromPreset,
    throttleFactor: throttleFactor,
    heatGeneration: heatGeneration,
    radiatedPower: radiatedPower,
    conductionPower: conductionPower,
    derivatives: derivatives,
    steadyTemperatures: steadyTemperatures,
    operatingPoint: operatingPoint,
    Simulation: Simulation,
  };
});
