# Journal - “honte-56” (Part 1)

> AI development session journal
> Started: 2026-08-23

---



## Session 1: Refine timeline range dragging

**Date**: 2026-08-27
**Task**: Refine timeline range dragging
**Branch**: `main`

### Summary

时间轴聚焦后保留两侧上下文，端点按固定时间尺度线性向外扩选，并补充几何回归测试。

### Main Changes

- Replaced fragmented timestamp lookups with one presentation-ordered `VideoSampleSink.samples()` scan.
- Added exact target-frame matching, incomplete-tail errors, cancellation cleanup, and structured decode timing.
- Added a synthetic eight-fragment AVC long-GOP fixture and regression coverage for sequential decoding.
- Updated the userscript and README to version 1.4.12 and documented the frame-source contract.

### Git Commits

| Hash | Message |
|------|---------|
| `e210a0c` | (see git log) |

### Testing

- [OK] `node --check bella-gif-helper.user.js`
- [OK] `node --test tests/*.test.js` (47/47)
- [OK] Chrome 151 decoded all five browser fixtures.
- [OK] Real Mac Chrome live rewind export: 4.00 seconds, 49 frames, 428 ms frame extraction, 4.384 seconds total.

### Status

[OK] **Completed**

### Next Steps

- Validate the original scenario on Win11 Edge.


## Session 2: 修复直播回溯顺序解码

**Date**: 2026-08-28
**Task**: 修复直播回溯顺序解码
**Branch**: `main`

### Summary

将直播 fMP4 与录制 WebM 的导出帧源改为单路顺序解码，补齐跨短分片长 GOP 回归样本，并通过 Chrome 真实直播导出验证。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d709d42` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Preserve Full GIF Palette

**Date**: 2026-08-28
**Task**: Preserve Full GIF Palette
**Branch**: `main`

### Summary

将“然 · 体积优先”的可见颜色上限从 192 提升至 255，使三档均使用包含透明索引的 256 项 GIF 调色板；增加全档位回归测试、同步 README，并将 userscript 版本升级至 1.4.14。

### Main Changes

- Unified all quality presets at 255 visible colors plus the reserved transparent index.
- Kept dithering and lossy compression as the only quality-level differences.
- Added a regression test for the shared palette-capacity rule and updated the README.
- Bumped the userscript version from 1.4.13 to 1.4.14.

### Git Commits

| Hash | Message |
|------|---------|
| `469ba2e` | (see git log) |

### Testing

- [OK] `node --check bella-gif-helper.user.js`
- [OK] `node --test tests/*.test.js` (47/47 passed)
- [OK] `git diff --check`

### Status

[OK] **Completed**

### Next Steps

- None - task complete

---

## Session 4: Optimization pass T0-T9 and 1.5.8 release

**Date**: 2026-09-04
**Task**: OPTIMIZATION_PLAN.md T0-T9
**Branch**: `main`

### Summary

Completed the planned optimization pass (T0-T7 plus a T9 review round), closed it out,
and promoted the script from `1.5.x-beta` to the stable `1.5.8`.

### Main Changes

- T0 CI gate: `sync-r2.yml` now runs `npm run verify` and a built-artifact drift check
  before the R2 upload job.
- T1 1:1 crop lock persistence + README corrections.
- T2 Unified six preference keys into a single `GM_setValue` store with one-way
  migration from the legacy `localStorage` / `GM` keys; preferences now shared across
  `www` / `live` / `m` subdomains.
- T3 Opt-in debug logging replacing 58 silent `catch (_) { }` blocks.
  The one inside `makeEncodingWorkerSource()` is intentionally left as-is (Worker context).
- T4 All eight pointer-move handlers coalesced into `requestAnimationFrame`;
  `flush()` applies the final frame before pointer release.
- T5 Unified recording session bootstrap (`beginRecordingSession` / `abortRecordingSession`).
- T6 esbuild bundling; sources moved to `src/`, built artifact still committed.
- T7 Panel stylesheet and markup extracted to `src/ui/panel.css` / `panel.html`
  (verified as a pure move, line-for-line).
- T9 Review fixes: aspect-button metric cache no longer locks in the hidden-panel
  fallback; `migrateLegacyPrefs()` early-returns in sub-frames; added
  `scripts/check-version.mjs` to pin README / header / artifact versions together.
- CI no longer runs the same commit twice for same-repo pull requests.
- Release channel decision recorded: single channel, main is production.
- T8 (splitting `startApp`) downgraded from a project to on-demand work.

### Git Commits

| Hash | Message |
|------|---------|
| `8065b22` | test: gate R2 sync behind syntax and test checks |
| `2518a08` | refactor: unify preferences into a single cross-origin store |
| `766b622` | feat: add opt-in debug logging for silenced failures |
| `c40ef7d` | refactor: coalesce pointer-driven layout writes into animation frames |
| `cfd42f4` | refactor: unify recording session bootstrap |
| `3df7913` | refactor: introduce esbuild bundling with single-file output |
| `76408c1` | refactor: extract panel stylesheet and markup into modules |
| `c50e78b` | fix: harden pref migration and aspect-button metric cache |
| `8073a08` | docs: record decision to keep a single release channel |

### Testing

- [OK] `npm run verify` (build + `node --check` + version consistency + 47/47 tests)
- [OK] Manual smoke checklist, all 9 items, run in a real browser by the maintainer
- [OK] Extra item: upgraded from a browser profile carrying 1.4.x settings and
      confirmed shortcut, launcher position, export presets and the 1:1 toggle
      all migrated intact

### Status

[OK] **Completed**

### Next Steps

- Add unit tests for `parseLegacyPref()` / `migrateLegacyPrefs()` — the only
  remaining gap. Preference-migration failures are silent, so until these exist,
  any change to preference code needs a manual 1.4.x-upgrade check.
- T8.1 only (move the already-tested pure layer out, drop the `vm` hack) if and
  when test-writing cost becomes a bottleneck.
