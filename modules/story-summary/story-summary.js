// ═══════════════════════════════════════════════════════════════════════════
// 导入
// ═══════════════════════════════════════════════════════════════════════════

import {
  extension_settings,
  getContext,
  saveMetadataDebounced,
} from "../../../../../extensions.js";
import {
  extension_prompts,
  extension_prompt_types,
  extension_prompt_roles,
} from "../../../../../../script.js";
import { EXT_ID } from "../../core/constants.js";
import { createModuleEvents, event_types } from "../../core/event-manager.js";
import { xbLog, CacheRegistry } from "../../core/debug-core.js";
import { CommonSettingStorage } from "../../core/server-storage.js";

// 新增解耦服务
import * as storeService from "./store-service.js";
import * as uiBridge from "./ui-bridge.js";
import { generateSummary, parseSummaryJson } from "./llm-service.js";

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

const MODULE_ID = "storySummary";
const events = createModuleEvents(MODULE_ID);
const SUMMARY_SESSION_ID = "xb9";
const SUMMARY_PROMPT_KEY = "LittleWhiteBox_StorySummary";
const SUMMARY_CONFIG_KEY = "storySummaryPanelConfig";
const VALID_SECTIONS = ["keywords", "events", "characters", "arcs"];

// ═══════════════════════════════════════════════════════════════════════════
// 状态变量
// ═══════════════════════════════════════════════════════════════════════════

let summaryGenerating = false;
let currentMesId = null;
let eventsRegistered = false;

// ═══════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getSettings() {
  const ext = (extension_settings[EXT_ID] ||= {});
  ext.storySummary ||= { enabled: true };
  return ext;
}

// Side Effect: 执行斜杠命令
async function executeSlashCommand(command) {
  try {
    const executeCmd =
      window.executeSlashCommands ||
      window.executeSlashCommandsOnChatInput ||
      (typeof SillyTavern !== "undefined" &&
        SillyTavern.getContext()?.executeSlashCommands);
    if (executeCmd) {
      await executeCmd(command);
    } else if (typeof window.STscript === "function") {
      await window.STscript(command);
    }
  } catch (e) {
    xbLog.error(MODULE_ID, `执行命令失败: ${command}`, e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 控制器辅助函数
// ═══════════════════════════════════════════════════════════════════════════

function setSummaryGenerating(flag) {
  summaryGenerating = !!flag;
  uiBridge.postToFrame({ type: "GENERATION_STATE", isGenerating: summaryGenerating });
}

function isSummaryGenerating() {
  return summaryGenerating;
}

function sendFrameBaseData(store, totalFloors) {
  const lastSummarized = store?.lastSummarizedMesId ?? -1;
  const range = storeService.calcHideRange(lastSummarized);
  const hiddenCount = range ? range.end + 1 : 0;

  uiBridge.postToFrame({
    type: "SUMMARY_BASE_DATA",
    stats: {
      totalFloors,
      summarizedUpTo: lastSummarized + 1,
      archiveStartFloor: (store?.archiveStartMesId ?? -1) + 1,
      eventsCount: store?.json?.events?.length || 0,
      pendingFloors: totalFloors - lastSummarized - 1,
      hiddenCount,
    },
    hideSummarized: store?.hideSummarizedHistory || false,
    keepVisibleCount: store?.keepVisibleCount ?? 3,
  });
}

function sendFrameFullData(store, totalFloors) {
  const lastSummarized = store?.lastSummarizedMesId ?? -1;
  if (store?.json) {
    uiBridge.postToFrame({
      type: "SUMMARY_FULL_DATA",
      payload: {
        keywords: store.json.keywords || [],
        events: store.json.events || [],
        characters: store.json.characters || { main: [], relationships: [] },
        arcs: store.json.arcs || [],
        lastSummarizedMesId: lastSummarized,
      },
    });
  } else {
    uiBridge.postToFrame({ type: "SUMMARY_CLEARED", payload: { totalFloors } });
  }
}

function openPanelForMessage(mesId) {
  uiBridge.createOverlay();
  uiBridge.showOverlay();
  const { chat } = getContext();
  const store = storeService.getSummaryStore();
  const totalFloors = chat.length;
  sendFrameBaseData(store, totalFloors);
  sendFrameFullData(store, totalFloors);
  setSummaryGenerating(summaryGenerating);
}

// ═══════════════════════════════════════════════════════════════════════════
// 业务逻辑：增量切片构建
// ═══════════════════════════════════════════════════════════════════════════

function buildIncrementalSlice(
  targetMesId,
  lastSummarizedMesId,
  maxPerRun = 100,
) {
  const { chat, name1, name2 } = getContext();
  const start = Math.max(0, (lastSummarizedMesId ?? -1) + 1);
  const rawEnd = Math.min(targetMesId, chat.length - 1);
  const end = Math.min(rawEnd, start + maxPerRun - 1);
  if (start > end) return { text: "", count: 0, range: "", endMesId: -1 };

  const userLabel = name1 || "用户";
  const charLabel = name2 || "角色";
  const slice = chat.slice(start, end + 1);

  const text = slice
    .map((m, i) => {
      const speaker = m.name || (m.is_user ? userLabel : charLabel);
      return `#${start + i + 1} 【${speaker}】\n${m.mes}`;
    })
    .join("\n\n");

  return {
    text,
    count: slice.length,
    range: `${start + 1}-${end + 1}楼`,
    endMesId: end,
  };
}

function getSummaryPanelConfig() {
  const defaults = {
    api: { provider: "st", url: "", key: "", model: "", modelCache: [] },
    gen: {
      temperature: null,
      top_p: null,
      top_k: null,
      presence_penalty: null,
      frequency_penalty: null,
    },
    trigger: {
      enabled: false,
      interval: 20,
      timing: "after_ai",
      useStream: true,
      maxPerRun: 100,
    },
  };
  try {
    const raw = localStorage.getItem("summary_panel_config");
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);

    const result = {
      api: { ...defaults.api, ...(parsed.api || {}) },
      gen: { ...defaults.gen, ...(parsed.gen || {}) },
      trigger: { ...defaults.trigger, ...(parsed.trigger || {}) },
    };

    if (result.trigger.timing === "manual") result.trigger.enabled = false;
    if (result.trigger.useStream === undefined) result.trigger.useStream = true;

    return result;
  } catch {
    return defaults;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 业务逻辑：执行生成
// ═══════════════════════════════════════════════════════════════════════════

async function runSummaryGeneration(mesId, configFromFrame) {
  if (isSummaryGenerating()) {
    uiBridge.postToFrame({
      type: "SUMMARY_STATUS",
      statusText: "上一轮总结仍在进行中...",
    });
    return false;
  }

  setSummaryGenerating(true);
  xbLog.info(MODULE_ID, `开始总结 mesId=${mesId}`);

  const cfg = configFromFrame || {};
  const store = storeService.getSummaryStore();
  const lastSummarized = store?.lastSummarizedMesId ?? -1;
  const maxPerRun = cfg.trigger?.maxPerRun || 100;
  const slice = buildIncrementalSlice(mesId, lastSummarized, maxPerRun);

  if (slice.count === 0) {
    uiBridge.postToFrame({ type: "SUMMARY_STATUS", statusText: "没有新的对话需要总结" });
    setSummaryGenerating(false);
    return true;
  }

  uiBridge.postToFrame({
    type: "SUMMARY_STATUS",
    statusText: `正在总结 ${slice.range}（${slice.count}楼新内容）...`,
  });

  const existingSummary = storeService.formatExistingSummaryForAI(store);
  const nextEventId = storeService.getNextEventId(store);
  const existingEventCount = store?.json?.events?.length || 0;
  const useStream = cfg.trigger?.useStream !== false;
  const apiCfg = cfg.api || {};
  const genCfg = cfg.gen || {};

  let raw;
  try {
    raw = await generateSummary({
      existingSummary,
      newHistoryText: slice.text,
      historyRange: slice.range,
      nextEventId,
      existingEventCount,
      llmApi: {
        provider: apiCfg.provider,
        url: apiCfg.url,
        key: apiCfg.key,
        model: apiCfg.model,
      },
      genParams: genCfg,
      useStream,
      timeout: 120000,
      sessionId: SUMMARY_SESSION_ID,
    });
  } catch (err) {
    xbLog.error(MODULE_ID, "生成失败", err);
    uiBridge.postToFrame({ type: "SUMMARY_ERROR", message: err?.message || "生成失败" });
    setSummaryGenerating(false);
    return false;
  }

  if (!raw?.trim()) {
    xbLog.error(MODULE_ID, "AI返回为空");
    uiBridge.postToFrame({ type: "SUMMARY_ERROR", message: "AI返回为空" });
    setSummaryGenerating(false);
    return false;
  }

  const parsed = parseSummaryJson(raw);
  if (!parsed) {
    xbLog.error(MODULE_ID, "JSON解析失败");
    uiBridge.postToFrame({ type: "SUMMARY_ERROR", message: "AI未返回有效JSON" });
    setSummaryGenerating(false);
    return false;
  }

  const oldJson = store?.json || {};
  const merged = storeService.mergeNewData(oldJson, parsed, slice.endMesId);

  store.lastSummarizedMesId = slice.endMesId;
  store.json = merged;
  store.updatedAt = Date.now();
  storeService.addSummarySnapshot(store, slice.endMesId);
  storeService.saveSummaryStore();

  uiBridge.postToFrame({
    type: "SUMMARY_FULL_DATA",
    payload: {
      keywords: merged.keywords || [],
      events: merged.events || [],
      characters: merged.characters || { main: [], relationships: [] },
      arcs: merged.arcs || [],
      lastSummarizedMesId: slice.endMesId,
    },
  });

  uiBridge.postToFrame({
    type: "SUMMARY_STATUS",
    statusText: `已更新至 ${slice.endMesId + 1} 楼 · ${merged.events?.length || 0} 个事件`,
  });

  const { chat } = getContext();
  const totalFloors = Array.isArray(chat) ? chat.length : 0;
  const newHideRange = storeService.calcHideRange(slice.endMesId);
  let actualHiddenCount = 0;

  if (store.hideSummarizedHistory && newHideRange) {
    const oldHideRange = storeService.calcHideRange(lastSummarized);
    const newHideStart = oldHideRange ? oldHideRange.end + 1 : 0;
    if (newHideStart <= newHideRange.end) {
      executeSlashCommand(`/hide ${newHideStart}-${newHideRange.end}`);
    }
    actualHiddenCount = newHideRange.end + 1;
  }

  uiBridge.postToFrame({
    type: "SUMMARY_BASE_DATA",
    stats: {
      totalFloors,
      summarizedUpTo: slice.endMesId + 1,
      eventsCount: merged.events?.length || 0,
      pendingFloors: totalFloors - slice.endMesId - 1,
      hiddenCount: actualHiddenCount,
    },
  });

  updateSummaryExtensionPrompt();
  setSummaryGenerating(false);

  xbLog.info(
    MODULE_ID,
    `总结完成，已更新至 ${slice.endMesId + 1} 楼，共 ${merged.events?.length || 0} 个事件`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 业务逻辑：自动运行
// ═══════════════════════════════════════════════════════════════════════════

async function maybeAutoRunSummary(reason) {
  const { chatId, chat } = getContext();
  if (!chatId || !Array.isArray(chat)) return;
  if (!getSettings().storySummary?.enabled) return;

  const cfgAll = getSummaryPanelConfig();
  const trig = cfgAll.trigger || {};

  if (trig.timing === "manual") return;
  if (!trig.enabled) return;
  if (trig.timing === "after_ai" && reason !== "after_ai") return;
  if (trig.timing === "before_user" && reason !== "before_user") return;

  if (isSummaryGenerating()) return;

  const store = storeService.getSummaryStore();
  const lastSummarized = store?.lastSummarizedMesId ?? -1;
  const pending = chat.length - lastSummarized - 1;
  if (pending < (trig.interval || 1)) return;

  xbLog.info(
    MODULE_ID,
    `自动触发剧情总结: reason=${reason}, pending=${pending}`,
  );
  await autoRunSummaryWithRetry(chat.length - 1, {
    api: cfgAll.api,
    gen: cfgAll.gen,
    trigger: trig,
  });
}

async function autoRunSummaryWithRetry(targetMesId, configForRun) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await runSummaryGeneration(targetMesId, configForRun)) return;
    if (attempt < 3) await sleep(1000);
  }
  xbLog.error(MODULE_ID, "自动总结失败（已重试3次）");
  await executeSlashCommand(
    "/echo severity=error 剧情总结失败（已自动重试 3 次）。请稍后再试。",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 业务逻辑：回滚与Prompt更新
// ═══════════════════════════════════════════════════════════════════════════

function formatSummaryForPrompt(store) {
  const data = store.json || {};
  const parts = [];
  parts.push(
    "【此处是对以上可见历史，及因上下文限制被省略历史的所有总结。请严格依据此总结理解剧情背景。】",
  );

  if (data.keywords?.length) {
    parts.push(`关键词：${data.keywords.map((k) => k.text).join(" / ")}`);
  }
  if (data.events?.length) {
    const lines = data.events
      .map((ev) => `- [${ev.timeLabel}] ${ev.title}：${ev.summary}`)
      .join("\n");
    parts.push(`事件：\n${lines}`);
  }
  if (data.arcs?.length) {
    const lines = data.arcs
      .map((a) => {
        const moments = (a.moments || []).map((m) =>
          typeof m === "string" ? m : m.text,
        );
        if (!moments.length) return `- ${a.name}：${a.trajectory}`;
        return `- ${a.name}：${moments.join(" → ")}（当前：${a.trajectory}）`;
      })
      .join("\n");
    parts.push(`角色弧光：\n${lines}`);
  }

  return `<剧情总结>\n${parts.join("\n\n")}\n</剧情总结>\n以下是总结后新发生的情节:`;
}

function updateSummaryExtensionPrompt() {
  if (!getSettings().storySummary?.enabled) {
    delete extension_prompts[SUMMARY_PROMPT_KEY];
    return;
  }

  const { chat } = getContext();
  const store = storeService.getSummaryStore();

  if (!store?.json) {
    delete extension_prompts[SUMMARY_PROMPT_KEY];
    return;
  }

  const cfg = getSummaryPanelConfig();
  let text = formatSummaryForPrompt(store);

  if (cfg.trigger?.wrapperHead) {
    text = cfg.trigger.wrapperHead + "\n" + text;
  }
  if (cfg.trigger?.wrapperTail) {
    text = text + "\n" + cfg.trigger.wrapperTail;
  }
  if (!text.trim()) {
    delete extension_prompts[SUMMARY_PROMPT_KEY];
    return;
  }

  const lastIdx = store.lastSummarizedMesId ?? 0;
  const length = Array.isArray(chat) ? chat.length : 0;
  if (lastIdx >= length) {
    delete extension_prompts[SUMMARY_PROMPT_KEY];
    return;
  }

  let depth = length - lastIdx - 1;
  if (depth < 0) depth = 0;

  if (cfg.trigger?.forceInsertAtEnd) {
    depth = 10000;
  }
  extension_prompts[SUMMARY_PROMPT_KEY] = {
    value: text,
    position: extension_prompt_types.IN_CHAT,
    depth,
    role: extension_prompt_roles.ASSISTANT,
  };
}

function clearSummaryExtensionPrompt() {
  delete extension_prompts[SUMMARY_PROMPT_KEY];
}

function rollbackSummaryIfNeeded() {
  const { chat } = getContext();
  const currentLength = Array.isArray(chat) ? chat.length : 0;
  const store = storeService.getSummaryStore();

  if (
    !store ||
    store.lastSummarizedMesId == null ||
    store.lastSummarizedMesId < 0
  ) {
    return false;
  }

  const lastSummarized = store.lastSummarizedMesId;

  if (currentLength <= lastSummarized) {
    const deletedCount = lastSummarized + 1 - currentLength;

    if (deletedCount < 2) {
      return false;
    }

    xbLog.warn(
      MODULE_ID,
      `删除已总结楼层 ${deletedCount} 条，当前${currentLength}，原总结到${lastSummarized + 1}，触发回滚`,
    );

    const history = store.summaryHistory || [];
    let targetEndMesId = -1;

    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].endMesId < currentLength) {
        targetEndMesId = history[i].endMesId;
        break;
      }
    }

    executeFilterRollback(store, targetEndMesId, currentLength);
    return true;
  }

  return false;
}

function executeFilterRollback(store, targetEndMesId, currentLength) {
  const oldLastSummarized = store.lastSummarizedMesId ?? -1;
  const wasHidden = store.hideSummarizedHistory;
  const oldHideRange = wasHidden ? storeService.calcHideRange(oldLastSummarized) : null;

  if (targetEndMesId < 0) {
    store.lastSummarizedMesId = -1;
    store.json = null;
    store.summaryHistory = [];
    store.hideSummarizedHistory = false;
  } else {
    const json = store.json || {};

    // 过滤逻辑
    json.events = (json.events || []).filter(
      (e) => (e._addedAt ?? 0) <= targetEndMesId,
    );
    json.keywords = (json.keywords || []).filter(
      (k) => (k._addedAt ?? 0) <= targetEndMesId,
    );
    json.arcs = (json.arcs || []).filter(
      (a) => (a._addedAt ?? 0) <= targetEndMesId,
    );
    json.arcs.forEach((a) => {
      a.moments = (a.moments || []).filter(
        (m) => typeof m === "string" || (m._addedAt ?? 0) <= targetEndMesId,
      );
    });

    if (json.characters) {
      json.characters.main = (json.characters.main || []).filter(
        (m) => typeof m === "string" || (m._addedAt ?? 0) <= targetEndMesId,
      );
      json.characters.relationships = (
        json.characters.relationships || []
      ).filter((r) => (r._addedAt ?? 0) <= targetEndMesId);
    }

    store.json = json;
    store.lastSummarizedMesId = targetEndMesId;
    store.summaryHistory = (store.summaryHistory || []).filter(
      (h) => h.endMesId <= targetEndMesId,
    );
  }

  // 恢复隐藏/取消隐藏副作用
  if (oldHideRange && oldHideRange.end >= 0) {
    const newHideRange =
      targetEndMesId >= 0 && store.hideSummarizedHistory
        ? storeService.calcHideRange(targetEndMesId)
        : null;

    const unhideStart = newHideRange
      ? Math.min(newHideRange.end + 1, currentLength)
      : 0;
    const unhideEnd = Math.min(oldHideRange.end, currentLength - 1);

    if (unhideStart <= unhideEnd) {
      executeSlashCommand(`/unhide ${unhideStart}-${unhideEnd}`);
    }
  }

  store.updatedAt = Date.now();
  storeService.saveSummaryStore();
  updateSummaryExtensionPrompt();
  
  // Notify Frame
  const { chat } = getContext();
  const totalFloors = Array.isArray(chat) ? chat.length : 0;
  if (store.json) {
    sendFrameFullData(store, totalFloors);
  } else {
    uiBridge.postToFrame({ type: "SUMMARY_CLEARED", payload: { totalFloors } });
  }
  sendFrameBaseData(store, totalFloors);
}

// ═══════════════════════════════════════════════════════════════════════════
// UI 事件处理
// ═══════════════════════════════════════════════════════════════════════════

async function sendSavedConfigToFrame() {
  try {
    const savedConfig = await CommonSettingStorage.get(
      SUMMARY_CONFIG_KEY,
      null,
    );
    if (savedConfig) {
      uiBridge.postToFrame({ type: "LOAD_PANEL_CONFIG", config: savedConfig });
      xbLog.info(MODULE_ID, "已从服务器加载面板配置");
    }
  } catch (e) {
    xbLog.warn(MODULE_ID, "加载面板配置失败", e);
  }
}

function handleFrameControllerMessage(data) {
  // 注意：origin 检查已在 uiBridge 中完成

  switch (data.type) {
    case "FRAME_READY":
      uiBridge.setFrameReady(true);
      setSummaryGenerating(summaryGenerating);
      sendSavedConfigToFrame();
      break;

    case "SETTINGS_OPENED":
    case "FULLSCREEN_OPENED":
    case "EDITOR_OPENED":
      $(".xb-ss-close-btn").hide();
      break;

    case "SETTINGS_CLOSED":
    case "FULLSCREEN_CLOSED":
    case "EDITOR_CLOSED":
      $(".xb-ss-close-btn").show();
      break;

    case "REQUEST_GENERATE": {
      const ctx = getContext();
      currentMesId = (ctx.chat?.length ?? 1) - 1;
      runSummaryGeneration(currentMesId, data.config || {});
      break;
    }

    case "REQUEST_CANCEL":
      window.xiaobaixStreamingGeneration?.cancel?.(SUMMARY_SESSION_ID);
      setSummaryGenerating(false);
      uiBridge.postToFrame({ type: "SUMMARY_STATUS", statusText: "已停止" });
      break;

    case "REQUEST_CLEAR": {
      const { chat } = getContext();
      const store = storeService.getSummaryStore();
      if (store) {
        delete store.json;
        store.lastSummarizedMesId = -1;
        store.updatedAt = Date.now();
        storeService.saveSummaryStore();
      }
      clearSummaryExtensionPrompt();
      uiBridge.postToFrame({
        type: "SUMMARY_CLEARED",
        payload: { totalFloors: Array.isArray(chat) ? chat.length : 0 },
      });
      xbLog.info(MODULE_ID, "总结数据已清空");
      break;
    }

    case "CLOSE_PANEL":
      uiBridge.hideOverlay();
      break;

    case "UPDATE_SECTION": {
      const store = storeService.getSummaryStore();
      if (!store) break;
      store.json ||= {};
      if (VALID_SECTIONS.includes(data.section)) {
        store.json[data.section] = data.data;
      }
      store.updatedAt = Date.now();
      storeService.saveSummaryStore();
      updateSummaryExtensionPrompt();
      break;
    }

    case "TOGGLE_HIDE_SUMMARIZED": {
      const store = storeService.getSummaryStore();
      if (!store) break;
      const lastSummarized = store.lastSummarizedMesId ?? -1;
      if (lastSummarized < 0) break;
      store.hideSummarizedHistory = !!data.enabled;
      storeService.saveSummaryStore();
      if (data.enabled) {
        const range = storeService.calcHideRange(lastSummarized);
        if (range) executeSlashCommand(`/hide ${range.start}-${range.end}`);
      } else {
        executeSlashCommand(`/unhide 0-${lastSummarized}`);
      }
      break;
    }

    case "UPDATE_KEEP_VISIBLE": {
      const store = storeService.getSummaryStore();
      if (!store) break;

      const oldCount = store.keepVisibleCount ?? 3;
      const newCount = Math.max(0, Math.min(50, parseInt(data.count) || 3));

      if (newCount === oldCount) break;

      store.keepVisibleCount = newCount;
      storeService.saveSummaryStore();

      const lastSummarized = store.lastSummarizedMesId ?? -1;

      if (store.hideSummarizedHistory && lastSummarized >= 0) {
        (async () => {
          await executeSlashCommand(`/unhide 0-${lastSummarized}`);
          const range = storeService.calcHideRange(lastSummarized);
          if (range) {
            await executeSlashCommand(`/hide ${range.start}-${range.end}`);
          }
          const { chat } = getContext();
          sendFrameBaseData(store, Array.isArray(chat) ? chat.length : 0);
        })();
      } else {
        const { chat } = getContext();
        sendFrameBaseData(store, Array.isArray(chat) ? chat.length : 0);
      }
      break;
    }

    case "SAVE_PANEL_CONFIG":
      if (data.config) {
        CommonSettingStorage.set(SUMMARY_CONFIG_KEY, data.config);
        xbLog.info(MODULE_ID, "面板配置已保存到服务器");
      }
      break;

    case "UPDATE_START_FLOOR": {
      const store = storeService.getSummaryStore();
      if (!store) break;
      const { chat } = getContext();
      const totalLen = Array.isArray(chat) ? chat.length : 0;
      const targetFloor = Math.max(1, Math.min(totalLen, parseInt(data.floor) || 1));
      
      const oldLastSum = store.lastSummarizedMesId ?? -1;
      
      store.lastSummarizedMesId = targetFloor - 2;
      store.archiveStartMesId = targetFloor - 2; 
      store.updatedAt = Date.now();
      storeService.saveSummaryStore();

      if (store.hideSummarizedHistory) {
          if (oldLastSum >= 0) executeSlashCommand(`/unhide 0-${oldLastSum}`);
          const range = storeService.calcHideRange(store.lastSummarizedMesId);
          if (range) executeSlashCommand(`/hide ${range.start}-${range.end}`);
      }
      
      sendFrameBaseData(store, totalLen);
      updateSummaryExtensionPrompt();
      xbLog.info(MODULE_ID, `通过面板手动设置总结起点为：第 ${targetFloor} 楼`);
      break;
    }

    case "MG_DELETE_EVENTS": {
      const store = storeService.getSummaryStore();
      if (!store?.json?.events) break;
      const { start, end } = data.range || {};
      if (start === undefined || end === undefined) break;
      
      const removed = store.json.events.splice(start, end - start + 1);
      store.updatedAt = Date.now();
      storeService.saveSummaryStore();
      
      const { chat } = getContext();
      sendFrameFullData(store, Array.isArray(chat) ? chat.length : 0);
      xbLog.info(MODULE_ID, `已批量删除 ${removed.length} 个事件`);
      break;
    }

    case "MG_MERGE_EVENTS": {
      const store = storeService.getSummaryStore();
      if (!store?.json?.events) break;
      const { start, end } = data.range || {};
      if (start === undefined || end === undefined) break;

      const eventsToMerge = store.json.events.slice(start, end + 1);
      const eventsText = eventsToMerge.map((e, idx) => `[${idx + 1}] 时刻:${e.timeLabel} 标题:${e.title} 内容:${e.summary}`).join("\n");
      
      const mergeSystemPrompt = `你也一个资深作家，现在需要你将一段剧情时间线（多个零碎的事件）进行“史诗级”的合并。
你的目标是：将这些零碎的、日常的事件，精炼成1个具有概括性的、能体现这段剧情“大势”的总结性事件。

### 注意：
1. 保持时间顺序，概括这段时间的整体变化。
2. 继承最后一个事件的时间标号（timeLabel）。
3. 必须输出 JSON (格式如下)：
{
  "timeLabel": "原最后一个事件的时间",
  "title": "概括性的史诗标题",
  "summary": "精炼后的合并剧情描述"
}
4. 严禁复读原文，要进行深度的意会和概括。
5. 字数限制：总结内容（summary）应保持在 100 字以内，字数规模应与单条普通事件记录保持一致。`;

      setSummaryGenerating(true);
      uiBridge.postToFrame({ type: "SUMMARY_STATUS", statusText: "正在调用 AI 进行史诗级合并..." });

      (async () => {
        try {
          const cfg = data.config || {};
          console.log("[Merge DEBUG] 正在启动 runIncremental...", { api: cfg.api, sessionId: SUMMARY_SESSION_ID });

          if (!window.xiaobaixStreamingGeneration) {
            throw new Error("找不到生成引擎 xiaobaixStreamingGeneration，请确保主插件已加载。");
          }

          const resultText = await window.xiaobaixStreamingGeneration.runIncremental(
            mergeSystemPrompt,
            `请合并以下事件：\n${eventsText}`,
            SUMMARY_SESSION_ID,
            cfg.api,
            cfg.gen,
            null
          );

          console.log("[Merge DEBUG] AI 返回原始文本:", resultText);

          if (!resultText) {
            throw new Error("AI 返回内容为空，请检查模型配置或 API 余额。");
          }

          const match = resultText.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              const mergedEvent = JSON.parse(match[0]);
              mergedEvent.id = `evt-merged-${Date.now()}`;
              mergedEvent._addedAt = eventsToMerge[eventsToMerge.length - 1]._addedAt;
              
              store.json.events.splice(start, end - start + 1, mergedEvent);
              store.updatedAt = Date.now();
              storeService.saveSummaryStore();
              
              const { chat } = getContext();
              sendFrameFullData(store, Array.isArray(chat) ? chat.length : 0);
              xbLog.info(MODULE_ID, "批量合并事件成功");
            } catch (jsonErr) {
              console.error("[Merge DEBUG] JSON 解析失败", jsonErr);
              throw new Error(`JSON 解析失败：${jsonErr.message}`);
            }
          } else {
            console.error("[Merge DEBUG] 未匹配到 JSON 结构");
            throw new Error("AI 返回的内容中没有找到有效的 JSON 结构。");
          }
        } catch (e) {
          console.error("[Merge DEBUG] 异步流程崩溃", e);
          xbLog.error(MODULE_ID, "合并事件过程崩溃", e);
          uiBridge.postToFrame({ type: "SUMMARY_ERROR", message: `合并失败：${e.message}` });
        } finally {
          setSummaryGenerating(false);
          uiBridge.postToFrame({ type: "SUMMARY_STATUS", statusText: null });
        }
      })();
      break;
    }

    case "REQUEST_PANEL_CONFIG":
      sendSavedConfigToFrame();
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 楼层按钮
// ═══════════════════════════════════════════════════════════════════════════

function createSummaryBtn(mesId) {
  const btn = document.createElement("div");
  btn.className = "mes_btn xiaobaix-story-summary-btn";
  btn.title = "剧情总结";
  btn.dataset.mesid = mesId;
  btn.innerHTML = '<i class="fa-solid fa-chart-line"></i>';
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!getSettings().storySummary?.enabled) return;
    currentMesId = Number(mesId);
    openPanelForMessage(currentMesId);
  });
  return btn;
}


function addSummaryBtnToMessage(mesId) {
  if (!getSettings().storySummary?.enabled) return;
  const msg = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
  if (!msg || msg.querySelector(".xiaobaix-story-summary-btn")) return;

  const sumBtn = createSummaryBtn(mesId);

  if (window.registerButtonToSubContainer?.(mesId, sumBtn)) return;

  const container = msg.querySelector(".flex-container.flex1.alignitemscenter");
  if (container) {
    container.appendChild(sumBtn);
  }
}

function initButtonsForAll() {
  if (!getSettings().storySummary?.enabled) return;
  $("#chat .mes").each((_, el) => {
    const mesId = el.getAttribute("mesid");
    if (mesId != null) addSummaryBtnToMessage(mesId);
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// 事件注册
// ═══════════════════════════════════════════════════════════════════════════

function handleChatChanged() {
  const { chat } = getContext();
  const newLength = Array.isArray(chat) ? chat.length : 0;

  rollbackSummaryIfNeeded();
  initButtonsForAll();
  updateSummaryExtensionPrompt();

  const store = storeService.getSummaryStore();
  const lastSummarized = store?.lastSummarizedMesId ?? -1;

  if (lastSummarized >= 0 && store?.hideSummarizedHistory === true) {
    const range = storeService.calcHideRange(lastSummarized);
    if (range) executeSlashCommand(`/hide ${range.start}-${range.end}`);
  }

  if (uiBridge.isFrameReady()) {
    sendFrameBaseData(store, newLength);
    sendFrameFullData(store, newLength);
  }
}

function handleMessageDeleted() {
  rollbackSummaryIfNeeded();
  updateSummaryExtensionPrompt();
}

function handleMessageReceived() {
  updateSummaryExtensionPrompt();
  initButtonsForAll();
  setTimeout(() => maybeAutoRunSummary("after_ai"), 1000);
}

function handleMessageSent() {
  updateSummaryExtensionPrompt();
  initButtonsForAll();
  setTimeout(() => maybeAutoRunSummary("before_user"), 1000);
}

function handleMessageUpdated() {
  rollbackSummaryIfNeeded();
  updateSummaryExtensionPrompt();
  initButtonsForAll();
}

function handleMessageRendered(data) {
  const mesId = data?.element ? $(data.element).attr("mesid") : data?.messageId;
  if (mesId != null) {
    addSummaryBtnToMessage(mesId);
  } else {
    initButtonsForAll();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════════════════

function registerEvents() {
  if (eventsRegistered) return;
  eventsRegistered = true;

  xbLog.info(MODULE_ID, "模块初始化");

  // 将处理器注册给 UI 桥接
  uiBridge.setMessageHandler(handleFrameControllerMessage);

  initButtonsForAll();

  events.on(event_types.CHAT_CHANGED, () => setTimeout(handleChatChanged, 80));
  events.on(event_types.MESSAGE_DELETED, () =>
    setTimeout(handleMessageDeleted, 50),
  );
  events.on(event_types.MESSAGE_RECEIVED, () =>
    setTimeout(handleMessageReceived, 150),
  );
  events.on(event_types.MESSAGE_SENT, () => setTimeout(handleMessageSent, 150));
  events.on(event_types.MESSAGE_SWIPED, () =>
    setTimeout(handleMessageUpdated, 100),
  );
  events.on(event_types.MESSAGE_UPDATED, () =>
    setTimeout(handleMessageUpdated, 100),
  );
  events.on(event_types.MESSAGE_EDITED, () =>
    setTimeout(handleMessageUpdated, 100),
  );
  events.on(event_types.USER_MESSAGE_RENDERED, (data) =>
    setTimeout(() => handleMessageRendered(data), 50),
  );
  events.on(event_types.CHARACTER_MESSAGE_RENDERED, (data) =>
    setTimeout(() => handleMessageRendered(data), 50),
  );
}

function unregisterEvents() {
  xbLog.info(MODULE_ID, "模块清理");
  events.cleanup();
  CacheRegistry.unregister(MODULE_ID);
  eventsRegistered = false;
  $(".xiaobaix-story-summary-btn").remove();
  uiBridge.hideOverlay();
  clearSummaryExtensionPrompt();
}

$(document).on("xiaobaix:storySummary:toggle", (_e, enabled) => {
  if (enabled) {
    registerEvents();
    initButtonsForAll();
    updateSummaryExtensionPrompt();
  } else {
    unregisterEvents();
  }
});

jQuery(() => {
  if (!getSettings().storySummary?.enabled) {
    clearSummaryExtensionPrompt();
    return;
  }
  registerEvents();
  updateSummaryExtensionPrompt();
});
