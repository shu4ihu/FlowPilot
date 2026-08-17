const fs = require('node:fs');
const path = require('node:path');

const CDP_ENDPOINT = process.env.FLOWPILOT_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const SIDEPANEL_PATH = '/sidepanel/sidepanel.html';
const LOG_FILE_PATH = path.join(__dirname, 'autoRun.log');
const LOG_MODE = process.env.FLOWPILOT_LOG_MODE || 'overwrite';
const RUN_LABEL = String(process.env.FLOWPILOT_RUN_LABEL || '').trim();
const LOG_POLL_INTERVAL_MS = Number(process.env.FLOWPILOT_LOG_POLL_INTERVAL_MS) || 500;
const RESET_TIMEOUT_MS = Number(process.env.FLOWPILOT_RESET_TIMEOUT_MS) || 15_000;
const START_TIMEOUT_MS = Number(process.env.FLOWPILOT_START_TIMEOUT_MS) || 15_000;
const RUN_TIMEOUT_MS = Number(process.env.FLOWPILOT_RUN_TIMEOUT_MS) || 30 * 60_000;

if (LOG_MODE !== 'append') {
  fs.writeFileSync(LOG_FILE_PATH, '', 'utf8');
}
if (RUN_LABEL) {
  fs.appendFileSync(LOG_FILE_PATH, `\n===== ${RUN_LABEL} =====\n`, 'utf8');
}

async function findSidePanelTarget() {
  const response = await fetch(`${CDP_ENDPOINT}/json/list`);
  if (!response.ok) {
    throw new Error(`无法读取 CDP 目标列表：HTTP ${response.status}`);
  }

  const targets = await response.json();
  const target = targets.find(({ url }) => (
    typeof url === 'string'
    && url.startsWith('chrome-extension://')
    && url.endsWith(SIDEPANEL_PATH)
  ));

  if (!target?.webSocketDebuggerUrl) {
    throw new Error('未找到 FlowPilot Side Panel，请先打开扩展侧边栏。');
  }

  return target;
}

function connectToTarget(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败。')), { once: true });
  });

  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;

    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(`${request.method}：${message.error.message}`));
      return;
    }

    request.resolve(message.result);
  });

  async function call(method, params = {}) {
    await ready;
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { method, resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return { socket, call };
}

async function evaluate(call, expression) {
  const response = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || '未知脚本错误';
    throw new Error(description);
  }

  return response.result?.value;
}

const readButtonStateExpression = `(() => {
  const autoButton = document.getElementById('btn-auto-run');
  const stopButton = document.getElementById('btn-stop');
  return {
    autoText: autoButton?.textContent?.trim() || null,
    autoDisabled: autoButton?.disabled ?? null,
    stopDisabled: stopButton?.disabled ?? null,
  };
})()`;

const readRunStateExpression = `(async () => {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'autoRun' });
  return {
    autoRunning: Boolean(state?.autoRunning),
    phase: state?.autoRunPhase || 'idle',
    currentRun: state?.autoRunCurrentRun || 0,
    totalRuns: state?.autoRunTotalRuns || 0,
    attemptRun: state?.autoRunAttemptRun || 0,
  };
})()`;

const resetFlowExpression = `(async () => {
  const resetButton = document.getElementById('btn-reset');
  if (!resetButton) {
    return { ok: false, message: '未找到 FlowPilot 重置按钮' };
  }
  if (resetButton.disabled) {
    return { ok: false, message: 'FlowPilot 重置按钮当前不可用' };
  }

  resetButton.scrollIntoView({ behavior: 'instant', block: 'center' });
  resetButton.click();

  const confirmDeadline = Date.now() + 5_000;
  let confirmButton = null;
  while (Date.now() < confirmDeadline) {
    const modal = document.getElementById('auto-start-modal');
    const candidate = document.getElementById('btn-auto-start-continue');
    if (modal && !modal.hidden
      && candidate
      && !candidate.hidden
      && !candidate.disabled
      && candidate.textContent?.trim() === '确认重置') {
      confirmButton = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!confirmButton) {
    return { ok: false, message: '未找到重置确认按钮' };
  }
  confirmButton.click();

  const resetDeadline = Date.now() + ${RESET_TIMEOUT_MS};
  while (Date.now() < resetDeadline) {
    const state = await chrome.runtime.sendMessage({
      type: 'GET_STATE',
      source: 'autoRun-reset'
    });
    const autoButton = document.getElementById('btn-auto-run');
    const stopButton = document.getElementById('btn-stop');
    const modal = document.getElementById('auto-start-modal');
    if (state?.autoRunning === false
      && state?.autoRunPhase === 'idle'
      && autoButton?.disabled === false
      && autoButton.textContent?.trim() === '自动'
      && stopButton?.disabled === true
      && modal?.hidden === true) {
      return {
        ok: true,
        message: 'FlowPilot 状态已重置',
        state: {
          autoRunning: false,
          phase: state.autoRunPhase,
          currentRun: state.autoRunCurrentRun || 0,
          totalRuns: state.autoRunTotalRuns || 0,
          attemptRun: state.autoRunAttemptRun || 0,
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { ok: false, message: '等待 FlowPilot 重置完成超时' };
})()`;

const installLogCollectorExpression = `(async () => {
  window.__FLOWPILOT_CDP_LOG_LISTENER__
    && chrome.runtime.onMessage.removeListener(window.__FLOWPILOT_CDP_LOG_LISTENER__);
  window.__FLOWPILOT_CDP_LOG_OBSERVERS__?.forEach((observer) => observer.disconnect());

  const autoButton = document.getElementById('btn-auto-run');
  const stopButton = document.getElementById('btn-stop');
  const readButtonState = () => ({
    autoText: autoButton?.textContent?.trim() || null,
    autoDisabled: autoButton?.disabled ?? null,
    stopDisabled: stopButton?.disabled ?? null,
  });
  const isActive = (state) => state.autoDisabled === true || state.stopDisabled === false;
  const initialButtonState = readButtonState();
  const collector = {
    baselineCount: 0,
    nextSequence: 1,
    logs: [],
    runActiveObserved: false,
    lastRunStatus: null,
    runStatusTransitions: [],
    activeObserved: isActive(initialButtonState),
    lastActiveState: isActive(initialButtonState) ? initialButtonState : null,
    stateTransitions: [{ capturedAt: new Date().toISOString(), ...initialButtonState }],
  };

  const logListener = (message) => {
    if (message?.type === 'LOG_ENTRY' && message.payload) {
      collector.logs.push({
        sequence: collector.nextSequence++,
        capturedAt: new Date().toISOString(),
        ...message.payload,
      });
      return;
    }

    if (message?.type === 'AUTO_RUN_STATUS' && message.payload) {
      const status = {
        capturedAt: new Date().toISOString(),
        phase: message.payload.phase || 'idle',
        currentRun: message.payload.currentRun || 0,
        totalRuns: message.payload.totalRuns || 0,
        attemptRun: message.payload.attemptRun || 0,
      };
      collector.lastRunStatus = status;
      collector.runStatusTransitions.push(status);
      if (['running', 'waiting_step', 'waiting_email', 'retrying', 'waiting_interval'].includes(status.phase)) {
        collector.runActiveObserved = true;
      }
    }
  };
  chrome.runtime.onMessage.addListener(logListener);

  const buttonObserver = new MutationObserver(() => {
    const state = readButtonState();
    const previous = collector.stateTransitions.at(-1);
    if (previous?.autoText === state.autoText
      && previous?.autoDisabled === state.autoDisabled
      && previous?.stopDisabled === state.stopDisabled) {
      return;
    }
    collector.stateTransitions.push({ capturedAt: new Date().toISOString(), ...state });
    if (isActive(state)) {
      collector.activeObserved = true;
      collector.lastActiveState = state;
    }
  });
  if (autoButton) buttonObserver.observe(autoButton, { attributes: true, childList: true, subtree: true });
  if (stopButton) buttonObserver.observe(stopButton, { attributes: true, childList: true, subtree: true });

  window.__FLOWPILOT_CDP_LOG_COLLECTOR__ = collector;
  window.__FLOWPILOT_CDP_LOG_LISTENER__ = logListener;
  window.__FLOWPILOT_CDP_LOG_OBSERVERS__ = [buttonObserver];

  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'autoRun' });
  collector.baselineCount = Array.isArray(state?.logs) ? state.logs.length : 0;
  const initialRunStatus = {
    capturedAt: new Date().toISOString(),
    phase: state?.autoRunPhase || 'idle',
    currentRun: state?.autoRunCurrentRun || 0,
    totalRuns: state?.autoRunTotalRuns || 0,
    attemptRun: state?.autoRunAttemptRun || 0,
  };
  collector.lastRunStatus = initialRunStatus;
  collector.runStatusTransitions.push(initialRunStatus);
  return { ok: true, baselineCount: collector.baselineCount };
})()`;

const readCollectorExpression = `(() => {
  const collector = window.__FLOWPILOT_CDP_LOG_COLLECTOR__;
  if (!collector) return null;
  return {
    runActiveObserved: collector.runActiveObserved,
    lastRunStatus: collector.lastRunStatus,
    runStatusTransitions: collector.runStatusTransitions,
    activeObserved: collector.activeObserved,
    lastActiveState: collector.lastActiveState,
    stateTransitions: collector.stateTransitions,
  };
})()`;

const drainLogsExpression = `(() => {
  const collector = window.__FLOWPILOT_CDP_LOG_COLLECTOR__;
  if (!collector) return [];
  return collector.logs.splice(0, collector.logs.length);
})()`;

const stopLogCollectorExpression = `(() => {
  window.__FLOWPILOT_CDP_LOG_LISTENER__
    && chrome.runtime.onMessage.removeListener(window.__FLOWPILOT_CDP_LOG_LISTENER__);
  window.__FLOWPILOT_CDP_LOG_OBSERVERS__?.forEach((observer) => observer.disconnect());
  delete window.__FLOWPILOT_CDP_LOG_LISTENER__;
  delete window.__FLOWPILOT_CDP_LOG_OBSERVERS__;
  delete window.__FLOWPILOT_CDP_LOG_COLLECTOR__;
  return true;
})()`;

const clickAutoButtonExpression = `(async () => {
  const button = document.getElementById('btn-auto-run');

  if (!button) {
    return { ok: false, message: '未找到 FlowPilot 自动按钮' };
  }

  if (button.disabled) {
    return { ok: false, message: 'FlowPilot 自动按钮当前不可用' };
  }

  button.scrollIntoView({ behavior: 'instant', block: 'center' });
  button.click();

  const restartDeadline = Date.now() + 5_000;
  while (Date.now() < restartDeadline) {
    const modal = document.getElementById('auto-start-modal');
    if (modal && !modal.hidden) {
      const restartButton = document.getElementById('btn-auto-start-restart');
      if (!restartButton || restartButton.disabled) {
        return { ok: false, message: '检测到自动运行选择框，但重新开始按钮不可用' };
      }
      restartButton.click();
      return { ok: true, message: '已触发 FlowPilot 自动按钮并选择重新开始' };
    }

    if (button.disabled || button.textContent?.trim() !== '自动') {
      return { ok: true, message: '已触发 FlowPilot 自动按钮' };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { ok: true, message: '已触发 FlowPilot 自动按钮' };
})()`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const ACTIVE_RUN_PHASES = new Set([
  'running',
  'waiting_step',
  'waiting_email',
  'retrying',
  'waiting_interval',
]);

function isRunPhaseActive(runState) {
  return runState?.autoRunning === true || ACTIVE_RUN_PHASES.has(runState?.phase);
}

function formatLog(entry) {
  const time = Number.isFinite(Number(entry.timestamp))
    ? new Date(Number(entry.timestamp)).toLocaleTimeString('zh-CN', { hour12: false })
    : entry.capturedAt;
  return [
    time,
    entry.level,
    Number(entry.step) > 0 ? `步${entry.step}` : null,
    entry.message,
  ].filter(Boolean).join(' ');
}

function writeLogLine(line) {
  fs.appendFileSync(LOG_FILE_PATH, `${line}\n`, 'utf8');
}

function printLog(entry) {
  const line = formatLog(entry);
  console.error(line);
  writeLogLine(line);
}

async function collectLogs(call, collectedLogs) {
  const logs = await evaluate(call, drainLogsExpression);
  if (!Array.isArray(logs) || logs.length === 0) return;

  for (const log of logs) {
    collectedLogs.push(log);
    printLog(log);
  }
}

async function waitForRunToStart(call, collectedLogs) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await collectLogs(call, collectedLogs);
    const runState = await evaluate(call, readRunStateExpression);
    if (isRunPhaseActive(runState)) return runState;

    const collector = await evaluate(call, readCollectorExpression);
    if (collector?.runActiveObserved) return collector.lastRunStatus || runState;
    await sleep(LOG_POLL_INTERVAL_MS);
  }
  throw new Error(`等待自动流程启动超时（${START_TIMEOUT_MS}ms）。`);
}

async function waitForRunToFinish(call, collectedLogs) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await collectLogs(call, collectedLogs);
    const runState = await evaluate(call, readRunStateExpression);
    if (!isRunPhaseActive(runState)) {
      await sleep(LOG_POLL_INTERVAL_MS * 2);
      const confirmedState = await evaluate(call, readRunStateExpression);
      if (!isRunPhaseActive(confirmedState)) {
        await collectLogs(call, collectedLogs);
        return confirmedState;
      }
    }
    await sleep(LOG_POLL_INTERVAL_MS);
  }
  throw new Error(`等待自动流程结束超时（${RUN_TIMEOUT_MS}ms）。`);
}

async function main() {
  const target = await findSidePanelTarget();
  const { socket, call } = connectToTarget(target.webSocketDebuggerUrl);
  const logs = [];

  try {
    const reset = await evaluate(call, resetFlowExpression);
    if (!reset?.ok) {
      throw new Error(reset?.message || 'FlowPilot 重置失败。');
    }

    const before = await evaluate(call, readButtonStateExpression);
    const collector = await evaluate(call, installLogCollectorExpression);
    if (!collector?.ok) {
      throw new Error(collector?.message || '日志采集器初始化失败。');
    }

    const execution = await evaluate(call, clickAutoButtonExpression);
    if (!execution?.ok) {
      throw new Error(execution?.message || '自动按钮触发失败。');
    }

    const started = await waitForRunToStart(call, logs);
    const after = await waitForRunToFinish(call, logs);
    const collectorState = await evaluate(call, readCollectorExpression);

    console.log(JSON.stringify({
      target: target.url,
      reset,
      before,
      execution,
      started,
      after,
      logBaselineCount: collector.baselineCount,
      logCount: logs.length,
      logs,
      runStatusTransitions: collectorState?.runStatusTransitions || [],
      stateTransitions: collectorState?.stateTransitions || [],
    }, null, 2));
  } catch (error) {
    await collectLogs(call, logs).catch(() => {});
    error.flowPilotLogs = logs;
    throw error;
  } finally {
    await evaluate(call, stopLogCollectorExpression).catch(() => {});
    socket.close();
  }
}

main().catch((error) => {
  const failure = {
    ok: false,
    error: error.message,
    logCount: error.flowPilotLogs?.length || 0,
    logs: error.flowPilotLogs || [],
  };
  writeLogLine(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} error ${error.message}`);
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
