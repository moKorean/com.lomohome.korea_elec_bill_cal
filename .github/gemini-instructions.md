# Gemini Instructions: Homey App Development (SDK v3)

## Project Context
- **App:** Korea Electricity Bill Calculator — estimates KEPCO bills from an existing energy meter.
- **Platform:** Homey Pro (SDK v3). **Node:** `>=22` (see `package.json` engines).
- **Tooling:** Homey CLI (`homey app build|validate|run`), ESLint (`eslint-config-athom`), Node's built-in test runner.

## Layout
| Path | Role |
|------|------|
| `app.js` | App entry; connects HomeyAPI |
| `drivers/korea_elec/device.js` | Meter tracking, billing periods, capability updates, TOU bucketing |
| `drivers/korea_elec/driver.js` | Pairing, flow card registration |
| `lib/KoreaElecBillCalculator.js` | Pure bill calculation (no Homey dependency) |
| `lib/kr_holidays.js` | Korean public holidays for the TOU Saturday/holiday metering rule |
| `lib/rates_korea.json` | All KEPCO rates |
| `.homeycompose/` | Source of truth for the manifest |
| `test/` | Tests (excluded from the app bundle via `.homeyignore`) |
| `docs/2026_kr_bills.pdf` | Official KEPCO rate table the data is derived from |

## Architectural Rules
1. **Never edit `app.json` directly.** It is generated from `.homeycompose/` + `drivers/*/driver.compose.json`. Edit those, then run `homey app build`. Commit the regenerated `app.json`.
2. **Rates come from the PDF.** Any change to `lib/rates_korea.json` must be traceable to `docs/2026_kr_bills.pdf` (or a newer official table). State the source and effective date in the commit message.
3. **Keep the calculator Homey-free.** `lib/KoreaElecBillCalculator.js` must stay runnable in plain Node so it can be tested directly.
4. **Class-based, async/await.** Extend `Homey.Device` / `Homey.Driver` / `Homey.App`. No legacy callbacks.
5. **Permissions:** mirror any new web-API usage in the `permissions` array of `.homeycompose/app.json`.
6. **Capabilities:** add a definition under `.homeycompose/capabilities/` and put the id in the driver's `capabilities` array at the position it should appear. `device.js#ensureCapabilities()` syncs already-paired devices to that order on app update.

## Before Proposing a Change
```bash
npm test            # 46 tests, ~1.3s
npm run lint        # must stay at 0 errors, 0 warnings
npx homey app validate --level publish
```

Changing rate data or calculation logic will fail `test/bill-golden.test.js`. That is intended: confirm the diff is what you meant, then run `npm run test:golden:update` and explain the change in the commit message. Never update the golden fixture to silence an unexplained failure.

## Response Guidelines
- **Factual & concise.** Propose one logical change at a time.
- **Error handling:** use `this.error()` / `this.log()` in `onInit()` and capability listeners.
- **No new dependencies** unless essential and compatible with Homey's restricted runtime. The test suite deliberately uses `node:test` to avoid a framework dependency.
- **User-facing strings** must be provided in both `en` and `ko`.
- **When debugging:** ask for `homey app run` output or logs from the Homey Developer Portal.
