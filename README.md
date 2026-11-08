# Orbital AI Thermal Simulator

A browser simulation of the thermal problem faced by a computing satellite: four AI chips conduct their waste heat to a radiator, and the radiator is the only way that heat can leave.

There is no airflow in vacuum. The model asks a specific question. At a given chip power, radiator area, emissivity, and environmental load, can the chips stay under their temperature limit, or does the spacecraft have to throttle the workload?

**These are illustrative parameters, not a flight specification.** Nothing in this repository reproduces Google’s satellite hardware, or the design of any other real spacecraft. The chip power, the radiator size, and the thermal masses are round numbers chosen so the physics is easy to inspect.

The page is static. Open `index.html` in a browser, or host the folder with any file server, including GitHub Pages.

## Scientific motivation

A processor on the ground can hand heat to moving air. A satellite cannot. The gas density outside the vehicle is far too low for convection to carry heat away, so the thermal design has to do two other things:

1. Conduct heat from the electronics to an external surface.
2. Reject that heat as infrared radiation.

The Stefan–Boltzmann law makes the second step steeply dependent on absolute temperature, and directly proportional to area and emissivity. A radiator that is too small runs hot. If the chips are not allowed to follow it, the only remaining actuator in this model is to reduce the compute load.

The simulator is a two-node lumped model of that trade. It is small enough to run live in a browser and explicit enough that every term can be checked.

## Physical model

Two thermal nodes:

- **Chip node.** The four processors (or however many you set) share one temperature and one thermal capacitance. Their electrical power is assumed to become heat in full.
- **Radiator node.** A single effective surface. It receives heat from the chips through a conductance, absorbs an optional environmental load, and exchanges radiation with a 3 K background.

```
Q = G (T_chip − T_radiator)

C_chip     dT_chip/dt     = P_heat − Q
C_radiator dT_radiator/dt = Q + P_environment − P_radiated

P_heat     = N_chips · P_chip · f
P_radiated = ε σ A (T_radiator⁴ − T_space⁴)
```

| Symbol | Meaning | Unit |
| --- | --- | --- |
| `T_chip`, `T_radiator` | Node temperatures. The interface shows °C. The equations use K. | K |
| `T_space` | Background temperature, fixed at 3 K | K |
| `C_chip`, `C_radiator` | Thermal capacitances | J/K |
| `G` | Effective chip-to-radiator conductance | W/K |
| `Q` | Heat flow from the chips to the radiator | W |
| `N_chips` | Number of chips in the lumped node | — |
| `P_chip` | Electrical power of one chip at full workload | W |
| `f` | Effective workload fraction after throttling | — |
| `P_environment` | Extra heat absorbed by the radiator | W |
| `ε` | Infrared emissivity, 0 to 1 | — |
| `A` | Total effective radiating area, counted once | m² |
| `σ` | Stefan–Boltzmann constant, 5.670374419×10⁻⁸ | W·m⁻²·K⁻⁴ |

`A` is the whole radiating area. A panel that emits from both sides should be entered as the sum of those sides, not entered once and then doubled again.

### What is a law, and what is an assumption

The energy balances, `Q = G ΔT`, and the Stefan–Boltzmann law are established physics. The CODATA value of `σ` is used without rounding.

The following are choices of this model, not laws:

- Two isothermal nodes stand in for the chips and the radiator.
- Every watt drawn by the chips becomes heat in the chip node.
- The radiator is shielded from direct sunlight. Solar, albedo, and planetary infrared heating are not computed from an orbit. If you want them, put the absorbed power in `P_environment`. Near Earth the solar constant is about 1361 W/m², so an unshaded surface can dwarf the chip load.
- View factors and which faces see space are already folded into `A`.
- The sink is one temperature, 3 K.
- There is no survival heater, no minimum-temperature limit, and no eclipse timetable.

### Throttle

If the unthrottled equilibrium sits above the chip limit, temperature would otherwise climb through it. The controller multiplies the commanded workload by a factor `φ`:

- `φ = 1` at and below `T_max − 2 K`
- `φ` falls linearly to 0 at `T_max`
- `φ = 0` above the limit

The heat command is continuous. The on-screen “Throttling” flag adds 0.5 K of hysteresis so the label does not flicker on the boundary. This is a study controller, not a flight algorithm. If environmental heat alone holds the chips above the limit, workload goes to zero and the status stays “Above limit”.

## Numerical method

The two ordinary differential equations are integrated with the classical fourth-order Runge–Kutta method. The throttle factor is frozen during a step and updated between steps.

The step shrinks automatically so that one substep changes a node by about 0.3 K, and so that it stays under about one fifth of the local thermal time constant. The time constant uses the conduction `G` plus the linearized radiation conductance `4 ε σ A T³`. A trial step that would leave the physical range is rejected and retried at half size. Accepted temperatures are kept above 0 K, so the fourth power cannot see a negative absolute temperature or produce a NaN.

Capacitance changes the speed of the transient and not the steady state. The steady radiator temperature at a frozen heat load `P` solves

```
P + P_environment = ε σ A (T_radiator⁴ − T_space⁴)
T_chip = T_radiator + P / G
```

The dashboard prints that prediction, including the throttle, next to the drawing. A finite run approaches it. The run does not jump to it.

## Parameters and the initial setup

| Parameter | Initial value |
| --- | ---: |
| Chips | 4 |
| Power per chip | 200 W |
| Workload | 100% |
| Chip capacitance | 2,000 J/K |
| Radiator capacitance | 10,000 J/K |
| Radiator area | 4 m² |
| Emissivity | 0.90 |
| Conductance | 100 W/K |
| Environmental heat | 0 W |
| Initial chip temperature | 25 °C |
| Initial radiator temperature | 25 °C |
| Chip limit | 85 °C |
| Duration | 60 min |

With those defaults the algebraic steady state is about **−14.9 °C on the chips** and **−22.9 °C on the radiator**. The 8 K gap is `800 W / 100 W/K`. The chips have almost 100 K of margin, so the throttle never moves. At the initial 25 °C the 4 m² panel already emits about 1.6 kW, more than the chips produce, so the radiator cools. The chips rise a few degrees first, peaking near 30 °C, because the conductance needs a temperature difference before it can carry 800 W.

## How to run it locally

No build step and no dependencies.

Open `index.html` in a browser.

Or serve the folder, which is what GitHub Pages will do:

```bash
python3 -m http.server 4173
```

Then open `http://127.0.0.1:4173`.

The speed menu maps wall-clock time onto spacecraft time. `60×` plays one simulated minute each real second. `3600×` plays the whole hour in about one second. Pause, reset, and Step 30 s are independent of that speed. Sliders take effect on the next solver step. Initial temperatures are applied when you reset or load a preset.

### Check the physics from the command line

```bash
node tests/validate.js
```

The script does not start a browser. It exercises the solver directly.

## GitHub Pages

The site is the repository root: `index.html`, `styles.css`, `simulation.js`, and `ui.js`. There is no compile step. `.nojekyll` is included so Pages serves the files as they are.

1. Push this repository to GitHub.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Choose branch **main** and folder **/ (root)**.
5. Save.

The published address has the form `https://<user>.github.io/<repository>/`. This project does not deploy itself. Publishing happens only after those settings are saved on GitHub.

## Example experiments

Equilibrium values below are the infinite-time steady state of this model. A 60 minute run from 25 °C finishes close to them.

### Baseline — 4 m²

800 W, emissivity 0.90. Steady state about −14.9 °C on the chips and −22.9 °C on the radiator. Full workload. Over a 60 minute run the chip peaks near 29.5 °C at the start of the transient, then falls. Average radiation is higher than 800 W because the panel is also dumping heat it held at room temperature.

### Undersized radiator — 1 m²

Same chips, same emissivity. Without a throttle the chips would settle near 88.7 °C and the radiator near 80.7 °C. The band holds the chips near **83.1 °C** at about **94%** of the commanded workload, with the radiator near 75.6 °C. The cut is small because 1 m² at this emissivity can reject almost 800 W a few degrees under the limit. Raising chip power, or lowering the area further, makes the throttle give up much more of the workload. Over 60 minutes the useful energy is about 798 Wh against 800 Wh unthrottled, and the controller is actively reducing load for a few minutes at the end of the warm-up.

### Improved radiator — 8 m²

Same chips. Steady state about −54.8 °C on the chips and −62.8 °C on the radiator. No throttle. The model does not charge this area for mass or for the volume it takes up when folded.

### Environmental load

Set the environmental heat to a few hundred watts on the baseline panel. The equilibrium rises by the amount the radiator must warm in order to emit the extra power. A very large load on a small panel stays above the chip limit even at zero workload. The status reports that instead of hiding it.

### Capacitance

Double both capacitances and run again. The early slope is shallower. The steady temperatures printed beside the drawing do not move.

### Comparison

The comparison panel integrates two configurations to their own durations without touching the live run. It reports peak chip temperature, peak radiator temperature, useful computation (integrated chip electrical energy, in Wh), time spent with the workload reduced, and average radiative rejection. The written summary also gives the temperature at the end of the run. That matters: a case that only cools records its maximum at the initial transient, not at equilibrium.

## Validation

`node tests/validate.js` checks the following. On the reference run, all of them passed.

| Test | What was checked | Result |
| --- | --- | --- |
| 1. Energy balance, zero load | With chip power and environmental load at zero, both derivatives are exactly zero at 3 K. Over the first hour from 25 °C both nodes cool and stay far above absolute zero. With the thermal mass reduced, a long integration continues down toward 3 K (about 7.5 K after many hours, still cooling). Reaching 3 K from room temperature at the default mass is not a 60 minute event: radiated power collapses as `T⁴`. | Passed |
| 2. Chip power | 100 W/chip equilibrates colder than 400 W/chip by tens of degrees on the 4 m² panel, and the dynamic result matches the algebraic steady state within 0.2 K. Neither case throttles. | Passed |
| 3. Area | At fixed temperature, radiated power scales exactly with area. A larger area equilibrates colder. | Passed |
| 4. Emissivity | At fixed temperature, radiated power scales exactly with emissivity. Higher emissivity equilibrates colder. | Passed |
| 5. Capacitance | A 10× larger thermal mass moves much less in the first two minutes and reaches the same equilibrium, within 0.2 K. | Passed |
| 6. Throttling | The 1 m² case would exceed 85 °C without control. With control, the chip is not held above the limit (the late-window maximum stays under 85 °C, and time above the limit is zero when cooling is sufficient). The baseline case does not throttle. A 4 kW environmental load on 1 m² stays hot at zero chip power, and the model says the limit is infeasible. | Passed |

Two further checks sit in the same script. A one-hour baseline closes the energy balance to a residual of a fraction of a joule on a stored-energy change of about 5.5×10⁵ J. The same closure holds while the throttle is moving. Corner combinations of the allowed ranges stay finite and above 0 K. A direct evaluation also confirms that 25 °C is not being inserted into the fourth power: the default panel at 25 °C emits about 1.6 kW, not a fraction of a watt.

## Known limitations

- Two nodes cannot show gradients across a chip, a heat pipe, or a radiator fin.
- The environmental term is a number, not a solar-aspect, albedo, or planetary-infrared calculation. Eclipses are not on a clock.
- `A` and `ε` are constants. Degradation, specular reflection, and temperature-dependent properties are absent.
- There is no minimum operating temperature and no heater. The baseline equilibrium is well below a typical electronics cold limit. That is a real gap if you are reading the cold cases as a survival analysis.
- The throttle is a proportional band with a status hysteresis. It is not a PID, and it is not the control law of any spacecraft.
- Useful computation is integrated electrical energy. The model has no notion of work that leaves as radio-frequency or optical power rather than heat.
- Fixed-step RK4 with an adaptive substep is accurate for these time constants. It is not a variable-order differential-equation library.

## Possible next steps

- Drive `P_environment` from beta angle, eclipse fraction, solar constant, albedo, and Earth infrared.
- Split the chip node into one temperature per processor, and give the heat pipe its own limit.
- Trade radiator area against mass.
- Compare this proportional band with a PID or a scheduler that drops whole chips.
- Let emissivity age, or let absorbed solar power use a separate absorptance.

Not planned for this version: machine learning, trajectory propagation, computational fluid dynamics, or phase-change storage. Those answer different questions.

## Files

| File | Role |
| --- | --- |
| `index.html` | Dashboard structure |
| `styles.css` | Layout and instrument styling |
| `simulation.js` | Parameters, Stefan–Boltzmann evaluation, RK4, throttle, steady state. No DOM. |
| `ui.js` | Controls, diagram, metrics, charts, presets, comparison |
| `tests/validate.js` | The checks in the validation section |
| `.nojekyll` | Tells GitHub Pages not to run Jekyll |
| `.gitignore` | Local editor and OS files |

## References

- Stefan–Boltzmann constant, CODATA 2018/2022 exact value `5.670374419×10⁻⁸ W·m⁻²·K⁻⁴`. NIST, [Frequently used constants](https://physics.nist.gov/cuu/Constants/index.html). The constant is exact in the SI because it is defined from `h`, `c`, and `k`.
- Stefan, J. (1879) and Boltzmann, L. (1884), the `T⁴` radiation law.
- Gilmore, D. G., ed. *Spacecraft Thermal Control Handbook, Volume I: Fundamental Technologies*. The Aerospace Press / AIAA, 2nd ed., 2002. The radiator chapter is the standard engineering statement that spacecraft reject internal heat as `ε σ A T⁴`, and that a surface in low Earth orbit often rejects on the order of 100–350 W/m² once environmental backload is included.
- NASA Small Spacecraft Systems Virtual Institute. [State of the Art of Small Spacecraft Technology: Thermal Control](https://www.nasa.gov/smallsat-institute/sst-soa/thermal-control/).
- Incropera, F. P. and DeWitt, D. P. *Fundamentals of Heat and Mass Transfer*. The lumped-capacitance energy balance used for each node.

The 100–350 W/m² range quoted from Gilmore is why an 800 W load on 4 m² (200 W/m² before the temperature is even solved) looks comfortable, and why the same load on 1 m² sits near the top of what a warm, lightly loaded radiator can do. That comparison is an orientation. It is not a sizing certification.
