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
