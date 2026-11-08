/**
 * Dashboard for the orbital thermal model.
 * All temperatures shown to the reader are degrees Celsius.
 * The solver in simulation.js keeps kelvin.
 */
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const INTEGER_KEYS = {
    nChips: true,
    powerPerChip: true,
    workload: true,
    conductance: true,
    cChip: true,
    cRadiator: true,
    pEnvironment: true,
    tMaxC: true,
    tChip0C: true,
    tRad0C: true,
    durationMin: true,
  };

  const PRESET_NAMES = {
    baseline: "Baseline",
    undersized: "Undersized radiator",
    improved: "Improved radiator",
    current: "Current settings",
  };

  const sim = new ThermalSim.Simulation(ThermalSim.defaultParams());
  let running = false;
  let lastFrame = null;
  let writingControls = false;

  const tempChart = document.getElementById("chart-temp");
  const powerChart = document.getElementById("chart-power");

  function $(id) {
    return document.getElementById(id);
  }

  function formatTemp(celsius, digits) {
    const places = digits == null ? 2 : digits;
    const body = Math.abs(celsius).toFixed(places);
    return (celsius < 0 ? "−" : "") + body + " °C";
  }

  function formatKelvin(kelvin) {
    return kelvin.toFixed(2) + " K";
  }

  function formatPower(watts, digits) {
    const places = digits == null ? 1 : digits;
    return (watts < 0 ? "−" : "") + Math.abs(watts).toFixed(places) + " W";
  }

  function formatPercent(fraction) {
    return (fraction * 100).toFixed(1) + "%";
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(seconds + 1e-6));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = function (value) {
      return String(value).padStart(2, "0");
    };
    if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(secs);
    return pad(minutes) + ":" + pad(secs);
  }

  function formatDuration(seconds) {
    if (seconds < 0.5) return "0 s";
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds - minutes * 60);
    if (minutes <= 0) return secs + " s";
    if (secs === 0) return minutes + " min";
    return minutes + " min " + secs + " s";
  }

  function trimNumber(value) {
    const rounded = Math.round(value * 100) / 100;
    return String(rounded);
  }

  function tempRgb(celsius) {
    const stops = [
      [-80, [70, 148, 214]],
      [-20, [61, 196, 204]],
      [10, [126, 196, 122]],
      [40, [214, 196, 86]],
      [70, [240, 163, 94]],
      [85, [240, 112, 72]],
      [120, [220, 64, 78]],
    ];
    const value = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], celsius));
    let index = 0;
    while (index < stops.length - 2 && value > stops[index + 1][0]) index += 1;
    const left = stops[index];
    const right = stops[index + 1];
    const span = right[0] - left[0] || 1;
    const mix = (value - left[0]) / span;
    return left[1].map(function (channel, channelIndex) {
      return Math.round(channel + (right[1][channelIndex] - channel) * mix);
    });
  }

  function tempColor(celsius) {
    const rgb = tempRgb(celsius);
    return "rgb(" + rgb[0] + ", " + rgb[1] + ", " + rgb[2] + ")";
  }

  function readParams() {
    return ThermalSim.sanitizeParams({
      nChips: Number($("nChips").value),
      powerPerChip: Number($("powerPerChip").value),
      workload: Number($("workload").value) / 100,
      area: Number($("area").value),
      emissivity: Number($("emissivity").value),
      conductance: Number($("conductance").value),
      cChip: Number($("cChip").value),
      cRadiator: Number($("cRadiator").value),
      pEnvironment: Number($("pEnvironment").value),
      tMaxC: Number($("tMaxC").value),
      tChip0C: Number($("tChip0C").value),
      tRad0C: Number($("tRad0C").value),
      durationMin: Number($("durationMin").value),
    });
  }

  function displayValue(key, value) {
    if (key === "emissivity") return Number(value).toFixed(2);
    if (key === "area") return trimNumber(value);
    if (INTEGER_KEYS[key]) return String(Math.round(Number(value)));
    return String(value);
  }

  function writeParams(params) {
    writingControls = true;
    const view = {
      nChips: params.nChips,
      powerPerChip: params.powerPerChip,
      workload: params.workload * 100,
      area: params.area,
      emissivity: params.emissivity,
      conductance: params.conductance,
      cChip: params.cChip,
      cRadiator: params.cRadiator,
      pEnvironment: params.pEnvironment,
      tMaxC: params.tMaxC,
      tChip0C: params.tChip0C,
      tRad0C: params.tRad0C,
      durationMin: params.durationMin,
    };
    Object.keys(view).forEach(function (key) {
      const shown = displayValue(key, view[key]);
      $(key).value = shown;
      $(key + "-range").value = view[key];
    });
    writingControls = false;
  }

  function bindPairs() {
    Object.keys(INTEGER_KEYS).concat(["area", "emissivity"]).forEach(function (key) {
      const number = $(key);
      const range = $(key + "-range");
      if (!number || !range) return;

      function commit(source) {
        if (writingControls) return;
        if (source === number && String(source.value).trim() === "") return;
        const raw = Number(source.value);
        if (!Number.isFinite(raw)) return;
        const min = Number(number.min);
        const max = Number(number.max);
        const value = Math.min(max, Math.max(min, raw));
        if (source === range) number.value = displayValue(key, value);
        range.value = value;
        onParamsEdited();
      }

      range.addEventListener("input", function () { commit(range); });
      number.addEventListener("input", function () { commit(number); });
      number.addEventListener("change", function () {
        if (!Number.isFinite(Number(number.value))) return;
        const min = Number(number.min);
        const max = Number(number.max);
        const value = Math.min(max, Math.max(min, Number(number.value)));
        number.value = displayValue(key, value);
        range.value = value;
        onParamsEdited();
      });
    });
  }

  function onParamsEdited() {
    if (writingControls) return;
    clearPresetHighlight();
    sim.setParams(readParams());
    render();
    updateCompareMeta();
  }

  function clearPresetHighlight() {
    document.querySelectorAll(".preset").forEach(function (card) {
      card.classList.remove("active");
    });
  }

  function highlightPreset(id) {
    clearPresetHighlight();
    const card = document.querySelector('.preset[data-preset="' + id + '"]');
    if (card) card.classList.add("active");
  }

  function applyParams(params, presetId) {
    writeParams(params);
    sim.setParams(params);
    sim.reset();
    running = false;
    lastFrame = null;
    if (presetId) highlightPreset(presetId);
    else clearPresetHighlight();
    render();
    updateCompareMeta();
  }

  function trendWord(rate) {
    if (rate > 0.002) return "warming";
    if (rate < -0.002) return "cooling";
    return "holding";
  }

  function situationText(metrics) {
    const arriving = metrics.pHeat + metrics.pEnvironment;
    if (metrics.overLimit) {
      return "The chip node is above the limit. Workload is already cut as far as this controller can cut it, and the radiator still cannot hold the temperature.";
    }
    if (metrics.throttling || metrics.throttleFactor < 0.999) {
      return "The chip node is inside the 2 °C throttle band. Workload is reduced so the temperature can settle at or under the limit.";
    }
    if (Math.abs(metrics.dTc) < 0.002 && Math.abs(metrics.dTr) < 0.002) {
      return "Both nodes are close to steady state. Infrared rejection is matching the heat that arrives at the radiator.";
    }
    if (metrics.dTc > 0.002 && metrics.dTr < -0.002) {
      return "The chips are still warming while the radiator sheds heat it stored at the initial temperature.";
    }
    if (metrics.dTr < -0.002 && metrics.pRad > arriving + 5) {
      return "Emission exceeds the heat arriving at the radiator, so the panel is cooling toward equilibrium.";
    }
    if (metrics.dTc > 0.002 && metrics.dTr > 0.002) {
      return "Both nodes are storing heat. The radiator is not yet hot enough to reject this load.";
    }
    if (metrics.dTc < -0.002 && metrics.dTr < -0.002) {
      return "Both nodes are cooling toward the equilibrium set by the radiator.";
    }
    return "Chips are " + trendWord(metrics.dTc) + " and the radiator is " + trendWord(metrics.dTr) + ".";
  }

  function equilibriumText(params) {
    const point = ThermalSim.operatingPoint(params);
    const open = ThermalSim.steadyTemperatures(params, point.commandedW);
    if (!point.feasible) {
      const idle = ThermalSim.steadyTemperatures(params, 0);
      return "Even with the chips idle, environmental heat holds the chip node near " +
        formatTemp(idle.chipC) + ". This radiator cannot meet the " + formatTemp(params.tMaxC, 0) + " limit.";
    }
    if (!point.throttled) {
      return "Held at this command, the chips settle near " + formatTemp(point.chipC) +
        " and the radiator near " + formatTemp(point.radiatorC) +
        ". Full workload stays inside the limit. A finite run approaches that point. It does not jump there.";
    }
    return "Without throttling, the chips would settle near " + formatTemp(open.chipC) +
      ". The proportional band should hold them near " + formatTemp(point.chipC) +
      " at " + formatPercent(point.factor) + " of the commanded workload.";
  }

  function renderStatus(metrics) {
    const run = $("run-state");
    const thermal = $("thermal-state");
    let runName = "Ready";
    let runClass = "ready";
    if (running) {
      runName = "Running";
      runClass = "running";
    } else if (metrics.complete) {
      runName = "Complete";
      runClass = "complete";
    } else if (metrics.timeS > 0) {
      runName = "Paused";
      runClass = "paused";
    }
    run.className = "pill " + runClass;
    run.querySelector("span").textContent = runName;

    let thermalName = "Nominal";
    let thermalClass = "ok";
    if (metrics.overLimit) {
      thermalName = "Above limit";
      thermalClass = "bad";
    } else if (metrics.throttling || metrics.throttleFactor < 0.999) {
      thermalName = "Throttling";
      thermalClass = "warn";
    }
    thermal.className = "pill " + thermalClass;
    thermal.querySelector("span").textContent = thermalName;

    $("clock").textContent = formatClock(metrics.timeS);
    $("clock-total").textContent = formatClock(metrics.durationS);
    const fraction = metrics.durationS > 0 ? Math.min(1, metrics.timeS / metrics.durationS) : 0;
    $("progress").style.width = (100 * fraction).toFixed(2) + "%";

    $("btn-start").disabled = running || metrics.complete;
    $("btn-pause").disabled = !running;
    $("btn-step").disabled = running || metrics.complete;
  }

  function renderMetrics(metrics) {
    $("m-chip").textContent = formatTemp(metrics.chipC);
    $("m-chip-k").textContent = formatKelvin(metrics.chipK);
    $("m-rad").textContent = formatTemp(metrics.radiatorC);
    $("m-rad-k").textContent = formatKelvin(metrics.radiatorK);
    $("swatch-chip").style.background = tempColor(metrics.chipC);
    $("swatch-rad").style.background = tempColor(metrics.radiatorC);

    const commandedW = sim.params.nChips * sim.params.powerPerChip * sim.params.workload;
    $("m-power").textContent = formatPower(metrics.pHeat);
    $("m-power-sub").textContent = Math.abs(commandedW - metrics.pHeat) > 0.5
      ? "commanded " + formatPower(commandedW) + " before the throttle"
      : "converted entirely to heat";

    $("m-q").textContent = formatPower(Math.abs(metrics.transfer));
    $("m-q-sub").textContent = metrics.transfer >= 0 ? "chips to radiator" : "radiator back to chips";

    $("m-radp").textContent = formatPower(metrics.pRad);
    $("m-radp-sub").textContent = metrics.pRad >= 0
      ? "net heat leaving the spacecraft"
      : "net absorption from the 3 K background";

    const workload = $("m-workload");
    workload.textContent = formatPercent(metrics.effectiveWorkload);
    workload.className = "value" + (metrics.throttleFactor < 0.999 ? " warn" : "");
    $("m-workload-sub").textContent = metrics.throttleFactor < 0.999
      ? "commanded " + formatPercent(metrics.commandedWorkload) + " · inside the throttle band"
      : "matching the command";
    $("swatch-load").style.background = metrics.throttleFactor < 0.999 ? "#f0a35e" : "#3dd68c";

    const margin = $("m-margin");
    margin.textContent = (metrics.marginK < 0 ? "−" : "") + Math.abs(metrics.marginK).toFixed(2) + " °C";
    margin.className = "value " + (metrics.marginK < 0 ? "bad" : metrics.marginK < 5 ? "warn" : "ok");
    $("m-margin-sub").textContent = metrics.marginK >= 0 ? "spare below the limit" : "past the limit";
    $("swatch-margin").style.background = metrics.marginK < 0 ? "#ff6674" : metrics.marginK < 5 ? "#f0a35e" : "#3dd68c";
  }

  function renderDiagram(metrics) {
    const chipFill = tempColor(metrics.chipC);
    document.querySelectorAll(".die-body").forEach(function (rect) {
      rect.setAttribute("fill", chipFill);
    });
    $("radiator-panel").setAttribute("fill", tempColor(metrics.radiatorC));
    $("chip-temp-label").textContent = formatTemp(metrics.chipC);
    $("chip-kelvin-label").textContent = formatKelvin(metrics.chipK);
    $("rad-temp-label").textContent = formatTemp(metrics.radiatorC);
    $("rad-spec").textContent = trimNumber(metrics.area) + " m² · ε " + metrics.emissivity.toFixed(2);
    $("bus-power").textContent = formatPower(sim.params.nChips * sim.params.powerPerChip * sim.params.workload, 0) + " commanded";
    $("g-label").textContent = "G = " + Math.round(metrics.conductance) + " W/K";
    $("q-label").textContent = "Q = " + formatPower(metrics.transfer);

    const flow = $("q-flow");
    const towardRadiator = metrics.transfer >= 0;
    flow.setAttribute("x1", towardRadiator ? "344" : "462");
    flow.setAttribute("x2", towardRadiator ? "462" : "344");
    flow.setAttribute("stroke", towardRadiator ? "#f0a35e" : "#6fd4e8");
    flow.setAttribute("marker-end", towardRadiator ? "url(#arrow-hot)" : "url(#arrow-cold)");
    flow.classList.toggle("idle", Math.abs(metrics.transfer) < 1);

    const radiatedScale = Math.max(0.18, Math.min(1, metrics.pRad / 1800));
    $("ir-group").style.opacity = String(radiatedScale);

    const env = $("env-group");
    if (metrics.pEnvironment > 0) {
      env.setAttribute("visibility", "visible");
      $("env-label").textContent = "ENV " + formatPower(metrics.pEnvironment, 0);
    } else {
      env.setAttribute("visibility", "hidden");
    }

    $("chip-caption").textContent = metrics.nChips === 4
      ? "FOUR CHIPS, ONE NODE"
      : "LUMPED NODE OF " + metrics.nChips + " CHIPS";

    $("situation").textContent = situationText(metrics);
    $("eq-hint").textContent = equilibriumText(sim.params);
  }

  function svgEl(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (key) {
      node.setAttribute(key, attrs[key]);
    });
    return node;
  }

  function niceStep(span, count) {
    const rough = span / Math.max(1, count);
    if (!Number.isFinite(rough) || rough <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const residual = rough / magnitude;
    if (residual >= 7.5) return 10 * magnitude;
    if (residual >= 3.5) return 5 * magnitude;
    if (residual >= 1.5) return 2 * magnitude;
    return magnitude;
  }

  function ticks(min, max, count) {
    const step = niceStep(max - min, count);
    const start = Math.ceil((min - step * 1e-6) / step) * step;
    const values = [];
    for (let value = start; value <= max + step * 1e-6; value += step) {
      values.push(Number(value.toFixed(6)));
      if (values.length > 12) break;
    }
    return { step: step, values: values };
  }

  function formatTick(value, step) {
    const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    return (value < 0 ? "−" : "") + Math.abs(value).toFixed(digits);
  }

  function decimate(samples, maxPoints) {
    if (samples.length <= maxPoints) return samples;
    const stride = Math.ceil(samples.length / maxPoints);
    const kept = [];
    for (let index = 0; index < samples.length; index += stride) kept.push(samples[index]);
    const last = samples[samples.length - 1];
    if (kept[kept.length - 1] !== last) kept.push(last);
    return kept;
  }

  function drawChart(svg, config) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const width = 720;
    const height = 300;
    const plot = { left: 58, right: 16, top: 28, bottom: 36 };
    plot.w = width - plot.left - plot.right;
    plot.h = height - plot.top - plot.bottom;
    const samples = decimate(sim.samples, 700);
    const xMax = Math.max(sim.params.durationMin, 1);

    const bounds = config.bounds(samples, sim.params);
    const yTicks = ticks(bounds.min, bounds.max, 5);
    const xTicks = ticks(0, xMax, 6);

    function xOf(minute) {
      return plot.left + (minute / xMax) * plot.w;
    }
    function yOf(value) {
      return plot.top + (1 - (value - bounds.min) / (bounds.max - bounds.min || 1)) * plot.h;
    }

    svg.appendChild(svgEl("rect", {
      x: plot.left,
      y: plot.top,
      width: plot.w,
      height: plot.h,
      fill: "rgba(6, 16, 28, 0.35)",
      stroke: "rgba(180, 206, 224, 0.25)",
    }));

    yTicks.values.forEach(function (value) {
      const y = yOf(value);
      svg.appendChild(svgEl("line", {
        x1: plot.left, x2: plot.left + plot.w, y1: y, y2: y, class: "grid",
      }));
      const label = svgEl("text", {
        x: plot.left - 8, y: y + 4, "text-anchor": "end", class: "chart-label",
      });
      label.textContent = formatTick(value, yTicks.step);
      svg.appendChild(label);
    });

    xTicks.values.forEach(function (minute) {
      if (minute < 0 || minute > xMax) return;
      const x = xOf(minute);
      svg.appendChild(svgEl("line", {
        x1: x, x2: x, y1: plot.top, y2: plot.top + plot.h, class: "grid",
      }));
      const label = svgEl("text", {
        x: x, y: plot.top + plot.h + 18, "text-anchor": "middle", class: "chart-label",
      });
      label.textContent = formatTick(minute, xTicks.step);
      svg.appendChild(label);
    });

    const xTitle = svgEl("text", {
      x: plot.left + plot.w / 2,
      y: height - 4,
      "text-anchor": "middle",
      class: "chart-label",
    });
    xTitle.textContent = "Time (min)";
    svg.appendChild(xTitle);

    if (samples.length < 2) {
      const waiting = svgEl("text", {
        x: plot.left + plot.w / 2,
        y: plot.top + plot.h / 2,
        "text-anchor": "middle",
        class: "chart-label",
      });
      waiting.textContent = "Start or step to trace the history";
      svg.appendChild(waiting);
    }

    const yTitle = svgEl("text", {
      x: 8,
      y: 16,
      class: "chart-label",
    });
    yTitle.textContent = config.yTitle;
    svg.appendChild(yTitle);

    if (config.limit != null && config.limit >= bounds.min && config.limit <= bounds.max) {
      const y = yOf(config.limit);
      svg.appendChild(svgEl("line", {
        x1: plot.left,
        x2: plot.left + plot.w,
        y1: y,
        y2: y,
        stroke: "#ff6b6b",
        "stroke-width": "1.25",
        "stroke-dasharray": "5 4",
      }));
      const tag = svgEl("text", {
        x: plot.left + plot.w - 4,
        y: y - 4,
        "text-anchor": "end",
        class: "chart-label",
      });
      tag.textContent = "limit";
      svg.appendChild(tag);
    } else if (config.limit != null) {
      const note = svgEl("text", {
        x: plot.left + plot.w,
        y: plot.top - 10,
        "text-anchor": "end",
        class: "chart-label",
      });
      note.textContent = "Limit " + formatTemp(config.limit, 0) + " is off this scale";
      svg.appendChild(note);
    }

    const clipId = config.clipId;
    const clip = svgEl("clipPath", { id: clipId });
    clip.appendChild(svgEl("rect", {
      x: plot.left, y: plot.top, width: plot.w, height: plot.h,
    }));
    const defs = svgEl("defs");
    defs.appendChild(clip);
    svg.appendChild(defs);

    config.series.forEach(function (series) {
      const points = samples.map(function (sample) {
        return xOf(sample.tMin).toFixed(2) + "," + yOf(series.value(sample)).toFixed(2);
      });
      if (points.length >= 2) {
        svg.appendChild(svgEl("polyline", {
          fill: "none",
          stroke: series.color,
          "stroke-width": "2",
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
          "clip-path": "url(#" + clipId + ")",
          points: points.join(" "),
        }));
      }
      if (samples.length) {
        const last = samples[samples.length - 1];
        svg.appendChild(svgEl("circle", {
          cx: xOf(last.tMin),
          cy: yOf(series.value(last)),
          r: "3.5",
          fill: series.color,
        }));
      }
    });

    config.series.forEach(function (series, index) {
      const y = 14 + index * 0;
      const x = plot.left + index * 150;
      svg.appendChild(svgEl("line", {
        x1: x, x2: x + 16, y1: y, y2: y, stroke: series.color, "stroke-width": "2",
      }));
      const label = svgEl("text", { x: x + 22, y: y + 4, class: "chart-label" });
      label.textContent = series.name;
      svg.appendChild(label);
    });
  }

  function renderCharts() {
    const samples = sim.samples;
    let dataMin = Infinity;
    let dataMax = -Infinity;
    samples.forEach(function (sample) {
      dataMin = Math.min(dataMin, sample.chipC, sample.radC);
      dataMax = Math.max(dataMax, sample.chipC, sample.radC);
    });
    if (!Number.isFinite(dataMin)) {
      dataMin = 0;
      dataMax = 1;
    }
    const span = Math.max(dataMax - dataMin, 4);
    const limit = sim.params.tMaxC;
    let yMin = dataMin;
    let yMax = dataMax;
    if (limit > dataMin - 0.35 * span && limit < dataMax + 0.5 * span) {
      yMin = Math.min(yMin, limit);
      yMax = Math.max(yMax, limit);
    }
    const pad = Math.max(1.5, (yMax - yMin) * 0.14);
    drawChart(tempChart, {
      clipId: "clip-temp",
      yTitle: "°C",
      limit: limit,
      bounds: function () { return { min: yMin - pad, max: yMax + pad }; },
      series: [
        { name: "Chips", color: "#f0a35e", value: function (sample) { return sample.chipC; } },
        { name: "Radiator", color: "#6fd4e8", value: function (sample) { return sample.radC; } },
      ],
    });

    let powerMax = 10;
    let powerMin = 0;
    samples.forEach(function (sample) {
      powerMax = Math.max(powerMax, sample.heatW, sample.radW);
      powerMin = Math.min(powerMin, sample.heatW, sample.radW, 0);
    });
    const powerPad = Math.max(5, (powerMax - powerMin) * 0.12);
    drawChart(powerChart, {
      clipId: "clip-power",
      yTitle: "W",
      limit: null,
      bounds: function () { return { min: powerMin, max: powerMax + powerPad }; },
      series: [
        { name: "Chip heat", color: "#f0a35e", value: function (sample) { return sample.heatW; } },
        { name: "Radiated", color: "#8eb6ff", value: function (sample) { return sample.radW; } },
      ],
    });
  }

  function render() {
    const metrics = sim.metrics();
    renderStatus(metrics);
    renderMetrics(metrics);
    renderDiagram(metrics);
    renderCharts();
  }

  function loop(timestamp) {
    if (!running) return;
    if (lastFrame == null) lastFrame = timestamp;
    let elapsed = (timestamp - lastFrame) / 1000;
    lastFrame = timestamp;
    if (elapsed > 0.1) elapsed = 0.1;
    const speed = Number($("speed").value) || 1;
    sim.advance(elapsed * speed, { record: true, maxStep: 1, maxIters: 6000 });
    render();
    if (sim.complete) {
      running = false;
      render();
      return;
    }
    window.requestAnimationFrame(loop);
  }

  function start() {
    if (running || sim.complete) return;
    sim.setParams(readParams());
    running = true;
    lastFrame = null;
    render();
    window.requestAnimationFrame(loop);
  }

  function pause() {
    running = false;
    lastFrame = null;
    render();
  }

  function reset() {
    running = false;
    lastFrame = null;
    sim.setParams(readParams());
    sim.reset();
    render();
  }

  function step() {
    if (running || sim.complete) return;
    sim.setParams(readParams());
    sim.advance(30, { record: true, maxStep: 1, maxIters: 20000 });
    render();
  }

  function fillPresetEquilibria() {
    ThermalSim.PRESETS.forEach(function (preset) {
      const point = ThermalSim.operatingPoint(ThermalSim.paramsFromPreset(preset.id));
      const node = $("eq-" + preset.id);
      if (!node) return;
      const throttle = point.throttled
        ? " · throttle holds " + formatPercent(point.factor) + " workload"
        : " · no throttle";
      node.textContent = "Steady chips " + formatTemp(point.chipC) + " · radiator " + formatTemp(point.radiatorC) + throttle;
    });
  }

  function selectedParams(selectId) {
    const id = $(selectId).value;
    if (id === "current") return readParams();
    return ThermalSim.paramsFromPreset(id);
  }

  function describe(params) {
    return params.nChips + " × " + Math.round(params.powerPerChip) + " W, " +
      trimNumber(params.area) + " m², ε " + params.emissivity.toFixed(2) +
      ", " + params.durationMin + " min";
  }

  function updateCompareMeta() {
    $("cmp-a-meta").textContent = describe(selectedParams("cmp-a"));
    $("cmp-b-meta").textContent = describe(selectedParams("cmp-b"));
  }

  function cell(text, className) {
    const node = document.createElement("td");
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function headerCell(text) {
    const node = document.createElement("th");
    node.scope = "row";
    node.textContent = text;
    return node;
  }

  function signed(value, digits, suffix) {
    const magnitude = Math.abs(value).toFixed(digits);
    if (Math.abs(value) < Math.pow(10, -digits) / 2) return "0" + suffix;
    return (value > 0 ? "+" : "−") + magnitude + suffix;
  }

  function runComparison() {
    const idA = $("cmp-a").value;
    const idB = $("cmp-b").value;
    const paramsA = selectedParams("cmp-a");
    const paramsB = selectedParams("cmp-b");
    let nameA = PRESET_NAMES[idA];
    let nameB = PRESET_NAMES[idB];
    if (nameA === nameB) {
      nameA += " A";
      nameB += " B";
    }

    const runA = new ThermalSim.Simulation(paramsA);
    const runB = new ThermalSim.Simulation(paramsB);
    runA.advance(paramsA.durationMin * 60, { record: false, maxStep: 2, maxIters: 2000000 });
    runB.advance(paramsB.durationMin * 60, { record: false, maxStep: 2, maxIters: 2000000 });
    const summaryA = runA.summary();
    const summaryB = runB.summary();

    $("cmp-empty").hidden = true;
    $("cmp-table-wrap").hidden = false;
    $("cmp-head-a").textContent = nameA;
    $("cmp-head-b").textContent = nameB;
    $("cmp-caption").textContent = nameA + " is " + describe(paramsA) + ". " + nameB + " is " + describe(paramsB) + ".";

    const rows = [
      ["Maximum chip temperature", formatTemp(summaryA.maxChipC), formatTemp(summaryB.maxChipC), signed(summaryB.maxChipC - summaryA.maxChipC, 2, " °C")],
      ["Maximum radiator temperature", formatTemp(summaryA.maxRadiatorC), formatTemp(summaryB.maxRadiatorC), signed(summaryB.maxRadiatorC - summaryA.maxRadiatorC, 2, " °C")],
      ["Useful computation", summaryA.usefulComputationWh.toFixed(2) + " Wh", summaryB.usefulComputationWh.toFixed(2) + " Wh", signed(summaryB.usefulComputationWh - summaryA.usefulComputationWh, 2, " Wh")],
      ["Time spent throttling", formatDuration(summaryA.throttleSeconds), formatDuration(summaryB.throttleSeconds), signed((summaryB.throttleSeconds - summaryA.throttleSeconds) / 60, 2, " min")],
      ["Average radiative rejection", summaryA.averageRadiatedW.toFixed(1) + " W", summaryB.averageRadiatedW.toFixed(1) + " W", signed(summaryB.averageRadiatedW - summaryA.averageRadiatedW, 1, " W")],
    ];

    const body = $("cmp-body");
    body.textContent = "";
    rows.forEach(function (row) {
      const tr = document.createElement("tr");
      tr.appendChild(headerCell(row[0]));
      tr.appendChild(cell(row[1], "num"));
      tr.appendChild(cell(row[2], "num"));
      tr.appendChild(cell(row[3], "num"));
      body.appendChild(tr);
    });

    function ending(name, summary) {
      const throttle = summary.throttleSeconds >= 0.5
        ? "spends " + formatDuration(summary.throttleSeconds) + " with the workload reduced"
        : "does not throttle";
      return name + " ends at " + formatTemp(summary.finalChipC) +
        " on the chips after a peak of " + formatTemp(summary.maxChipC) +
        ", " + throttle + ", and puts " + summary.usefulComputationWh.toFixed(1) +
        " Wh through the processors.";
    }

    $("cmp-readout").textContent = ending(nameA, summaryA) + " " + ending(nameB, summaryB) +
      " The peak includes the initial condition, so a case that only cools records its warmest moment at the start. " +
      "Mean radiative rejection is " + summaryA.averageRadiatedW.toFixed(0) + " W for " + nameA +
      " and " + summaryB.averageRadiatedW.toFixed(0) + " W for " + nameB + ".";
  }

  function bindTips() {
    document.querySelectorAll(".tip").forEach(function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        const open = button.classList.contains("open");
        document.querySelectorAll(".tip.open").forEach(function (other) {
          other.classList.remove("open");
        });
        if (!open) button.classList.add("open");
      });
    });
    document.addEventListener("click", function () {
      document.querySelectorAll(".tip.open").forEach(function (button) {
        button.classList.remove("open");
      });
    });
  }

  function init() {
    bindPairs();
    bindTips();
    fillPresetEquilibria();
    updateCompareMeta();
    $("btn-start").addEventListener("click", start);
    $("btn-pause").addEventListener("click", pause);
    $("btn-reset").addEventListener("click", reset);
    $("btn-step").addEventListener("click", step);
    $("btn-defaults").addEventListener("click", function () {
      applyParams(ThermalSim.defaultParams(), "baseline");
    });
    document.querySelectorAll("[data-load]").forEach(function (button) {
      button.addEventListener("click", function () {
        const id = button.getAttribute("data-load");
        applyParams(ThermalSim.paramsFromPreset(id), id);
      });
    });
    $("cmp-a").addEventListener("change", updateCompareMeta);
    $("cmp-b").addEventListener("change", updateCompareMeta);
    $("cmp-run").addEventListener("click", runComparison);
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
