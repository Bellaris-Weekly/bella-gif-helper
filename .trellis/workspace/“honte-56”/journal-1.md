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
