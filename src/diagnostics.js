'use strict';

// 诊断上报与用户反馈，写入 bella-live-clip 的日志服务（POST /v1/logs），
// 以 source = bella-gif-helper 区分。接收地址只在发布构建时由 CI 注入；
// 仓库里提交的产物没有地址，所有方法都是空操作，反馈按钮也不显示。
//
// 协议与 bella-live-clip src/services/diagnostics.js 保持一致：
// - 有任务编号的日志以 context.operation.id 为行 id，服务端只保留同任务最新一行；
// - 非终态更新间隔不足 5 秒会被 429，所以心跳固定 10 秒；
// - 单条请求体不超过 64 KiB。
// 上报永远不阻塞、不打断用户操作，失败最多重试一次。

const { redactText } = require('./log-redaction.js');

const SOURCE = 'bella-gif-helper';
const FEEDBACK_LIMIT = 2000;
const HEARTBEAT_MS = 10000;
const STALL_MS = 30000;
const MAX_BODY_BYTES = 65536;
const QUEUE_LIMIT = 32;
const idle = Object.freeze({ stage() {}, progress() {}, finish() {}, fail() {} });

function text(value, limit) {
  if (typeof value !== 'string') return undefined;
  // 媒体与网络库的错误里可能带签名 URL：只保留 origin + path。
  return redactText(value.slice(0, 65536))
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch (_) {
        return raw.split(/[?#]/, 1)[0];
      }
    })
    .slice(0, limit);
}

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const fact = (value) => (typeof value === 'string' ? text(value, 256) : typeof value === 'boolean' ? value : number(value));

function describe(error) {
  if (!error || typeof error !== 'object') return { message: text(String(error), 512) };
  const result = { name: text(error.name, 128), message: text(error.message, 512) };
  if (typeof error.status === 'number') result.status = error.status;
  if (error.code !== undefined) result.code = fact(error.code);
  return result;
}

function errorDetail(error) {
  if (!error || typeof error !== 'object') return undefined;
  const detail = describe(error);
  const causes = [];
  const seen = new Set([error]);
  for (let cause = error.cause; cause && causes.length < 3 && !seen.has(cause); cause = cause && cause.cause) {
    seen.add(cause);
    causes.push(describe(cause));
  }
  if (causes.length) detail.causes = causes;
  return detail;
}

const PAGE_HOSTS = ['www.bilibili.com', 'bilibili.com', 'live.bilibili.com', 'm.bilibili.com'];

// 只保留 B 站页面的 origin + path（视频页带分 P），不带任何查询参数。
function pageIdentity(value) {
  try {
    const url = new URL(value);
    if (!PAGE_HOSTS.includes(url.hostname)) return undefined;
    const part = url.searchParams.get('p');
    return `${url.origin}${url.pathname}${part && /^\d+$/.test(part) ? `?p=${part}` : ''}`.slice(0, 1024);
  } catch (_) {
    return undefined;
  }
}

function snapshot(details = {}) {
  const clip = details.clip || {};
  const selection = details.selection || {};
  const settings = details.settings || {};
  return {
    page: pageIdentity(details.pageUrl),
    mode: text(details.mode, 32),
    clip: details.clip ? {
      kind: text(clip.kind, 32),
      duration: number(clip.duration),
      width: number(clip.width),
      height: number(clip.height),
    } : undefined,
    selection: details.selection ? { start: number(selection.start), end: number(selection.end) } : undefined,
    settings: details.settings ? {
      fps: number(settings.fps),
      quality: text(settings.quality, 16),
      width: number(settings.width),
      height: number(settings.height),
      speed: number(settings.speed),
      loopMode: text(settings.loopMode, 16),
      cornerRadius: number(settings.cornerRadius),
      frames: number(settings.frames),
      textLayers: number(settings.textLayers),
    } : undefined,
    estimatedBytes: number(details.estimatedBytes),
  };
}

// 返回 HTTP 状态码；网络失败为 0；请求根本没发出去为 null。
function post(request, endpoint, body) {
  return new Promise((resolve) => {
    try {
      request({
        method: 'POST',
        url: endpoint,
        anonymous: true,
        timeout: 8000,
        headers: { 'Content-Type': 'application/json' },
        data: body,
        onload: (result) => resolve(result.status),
        onerror: () => resolve(0),
        ontimeout: () => resolve(0),
        onabort: () => resolve(null),
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function transferNeedsRetry(request, endpoint, body) {
  const status = await post(request, endpoint, body);
  return status === 0 || status === 429 || status >= 500;
}

function createDiagnosticReporter({
  endpoint = '',
  request,
  version = '0.0.0',
  userAgent = '',
  online = () => globalThis.navigator?.onLine !== false,
  id = () => crypto.randomUUID(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => performance.now(),
  clock = () => new Date().toISOString(),
  every = (fn, ms) => setInterval(fn, ms),
  cancelTimer = (timer) => clearInterval(timer),
  visibility = () => globalThis.document?.visibilityState ?? 'unknown',
} = {}) {
  const enabled = Boolean(endpoint) && typeof request === 'function';
  let pending = 0;
  let dropped = 0;
  const queue = [];

  async function send(item) {
    try {
      if (await transferNeedsRetry(request, endpoint, item.body)) {
        await wait(1000);
        if (online()) await transferNeedsRetry(request, endpoint, item.body);
      }
    } catch (_) {
      /* 日志永远不影响用户操作。 */
    } finally {
      pending -= 1;
      pump();
    }
  }

  function pump() {
    while (pending < 2 && queue.length) {
      pending += 1;
      void send(queue.shift());
    }
  }

  function enqueue(item) {
    if (!online()) {
      dropped += 1;
      return;
    }
    // 积压的心跳会被同任务更新的快照或终态取代。
    const obsolete = queue.findIndex((old) => old.operation === item.operation && old.periodic);
    if (obsolete >= 0) queue.splice(obsolete, 1);
    if (queue.length >= QUEUE_LIMIT) {
      const expendable = queue.findIndex((old) => old.periodic);
      if (item.periodic && expendable < 0) {
        dropped += 1;
        return;
      }
      queue.splice(Math.max(0, expendable), 1);
      dropped += 1;
    }
    queue.push(item);
    pump();
  }

  function begin(action, details = {}) {
    if (!enabled) return idle;
    const context = { ...snapshot(details), stage: 'starting', timeline: [] };
    const operation = id();
    const started = now();
    const startedAt = clock();
    const stageTimes = {};
    // 导出保留完整生命周期；其余操作（回溯、录制、载入）只在真正失败时上报。
    const lifecycle = action === 'export';
    let finished = false;
    let sequence = 0;
    let timer;
    let stageStarted = started;
    let lastAdvance = started;
    let signature;
    let nextHeartbeat = started + HEARTBEAT_MS;

    function point() {
      context.timeline.push({
        elapsedMs: Math.max(0, now() - started),
        stage: context.stage,
        fraction: number(context.progress?.fraction),
        frames: number(context.progress?.frames),
      });
      // 保留第一个点和近期细节；满 60 点时把较早的一半减半。
      if (context.timeline.length > 60) context.timeline = context.timeline.filter((_, i) => i >= 30 || i % 2 === 0);
    }

    function stage(value) {
      const next = text(value, 64);
      if (finished || !next || next === context.stage) return;
      const time = now();
      stageTimes[context.stage] = (stageTimes[context.stage] ?? 0) + Math.max(0, time - stageStarted);
      context.stage = next;
      stageStarted = time;
      lastAdvance = time;
      point();
    }

    function publish(outcome, message, error, periodic = false) {
      if (!lifecycle && outcome !== 'failed') return;
      try {
        const time = now();
        const elapsedMs = Math.max(0, time - started);
        point();
        const runtime = {
          visibility: visibility(),
          noAdvanceMs: Math.max(0, time - lastAdvance),
          timerDelayMs: periodic ? Math.max(0, time - nextHeartbeat) : 0,
          droppedLogs: dropped,
          hardwareConcurrency: number(globalThis.navigator?.hardwareConcurrency),
          deviceMemoryGiB: number(globalThis.navigator?.deviceMemory),
        };
        const heap = globalThis.performance?.memory;
        if (heap) runtime.jsHeapBytes = number(heap.usedJSHeapSize);
        const payload = {
          id: `${operation}:${sequence}`,
          source: SOURCE,
          event: `${action}_${outcome}`,
          level: outcome === 'failed' ? 'error' : outcome === 'stalled' ? 'warn' : 'info',
          version,
          message: text(message, 4096) || '运行记录',
          context: {
            ...context,
            browser: text(userAgent, 512),
            operation: {
              id: operation,
              action,
              outcome,
              sequence,
              startedAt,
              clientAt: clock(),
              elapsedMs,
            },
            stageTimes: {
              ...stageTimes,
              [context.stage]: (stageTimes[context.stage] ?? 0) + Math.max(0, time - stageStarted),
            },
            runtime,
            ...(error
              ? { errorName: text(error.name, 128), error: errorDetail(error), stack: text(error.stack, 8192) }
              : {}),
          },
        };
        sequence += 1;
        let body = JSON.stringify(payload);
        if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
          payload.context.stack = undefined;
          payload.context.truncated = true;
          payload.message = payload.message.slice(0, 1024);
          body = JSON.stringify(payload);
        }
        if (new TextEncoder().encode(body).byteLength <= MAX_BODY_BYTES) enqueue({ body, operation, periodic });
      } catch (_) {
        /* 不递归上报，也不打扰用户。 */
      }
    }

    function complete(outcome, message, error) {
      if (finished) return;
      finished = true;
      if (timer !== undefined) cancelTimer(timer);
      publish(outcome, message, error);
    }

    if (lifecycle) {
      publish('started', '导出开始');
      timer = every(() => {
        if (finished) return;
        const stalled = now() - lastAdvance >= STALL_MS;
        publish(stalled ? 'stalled' : 'progress', stalled ? '导出进度暂未推进' : '导出运行中', undefined, true);
        nextHeartbeat = now() + HEARTBEAT_MS;
      }, HEARTBEAT_MS);
      timer?.unref?.();
    }

    return {
      stage,
      progress(value = {}) {
        if (finished) return;
        const next = [value.fraction, value.frames].join(':');
        if (next !== signature) {
          signature = next;
          lastAdvance = now();
        }
        context.progress = { fraction: number(value.fraction), frames: number(value.frames) };
        stage(value.phase);
      },
      finish(result = {}) {
        if (finished) return;
        context.result = { bytes: number(result.bytes), frames: number(result.frames) };
        complete('completed', '导出完成');
      },
      fail(error, { canceled = false } = {}) {
        if (canceled || error?.name === 'AbortError') complete('canceled', '导出已取消');
        else complete('failed', error?.message || String(error), error);
      },
    };
  }

  // 用户填写的反馈立即发送（不排队），这样表单能告诉用户是否送达。
  async function feedback(kind, message, details = {}) {
    if (!enabled || !['issue', 'suggestion'].includes(kind)) return 'failed';
    const body = String(message || '').trim();
    if (!body) return 'failed';
    const payload = JSON.stringify({
      id: id(),
      source: SOURCE,
      event: `feedback_${kind}`,
      level: 'info',
      version,
      message: text(body.slice(0, FEEDBACK_LIMIT), 4096),
      context: {
        ...snapshot(details),
        browser: text(userAgent, 512),
        clientAt: clock(),
      },
    });
    const status = await post(request, endpoint, payload);
    if (status >= 200 && status < 300) return 'sent';
    return status === 429 ? 'rate_limited' : 'failed';
  }

  return { enabled, canFeedback: enabled, begin, feedback };
}

module.exports = { createDiagnosticReporter, pageIdentity, FEEDBACK_LIMIT };
