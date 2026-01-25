
// ═══════════════════════════════════════════════════════════════════════════
// 导入
// ═══════════════════════════════════════════════════════════════════════════

import { extension_settings, getContext } from "../../../../../extensions.js";
import { extension_prompts, extension_prompt_types, extension_prompt_roles } from "../../../../../../script.js";
import { EXT_ID } from "../../core/constants.js";
import { createModuleEvents, event_types } from "../../core/event-manager.js";
import { xbLog, CacheRegistry } from "../../core/debug-core.js";

// 解耦服务层
import * as storeService from "./store-service.js";
import * as uiBridge from "./ui-bridge.js";
import * as genService from "./generation-service.js";
import * as mgtService from "./chat-management-service.js";

// ═══════════════════════════════════════════════════════════════════════════
// 常量与状态
// ═══════════════════════════════════════════════════════════════════════════

const MODULE_ID = "storySummary";
const SUMMARY_PROMPT_KEY = "LittleWhiteBox_StorySummary";
const VALID_SECTIONS = ["keywords", "events", "characters", "arcs"];

let summaryGenerating = false;
let currentMesId = null;
let eventsRegistered = false;
const events = createModuleEvents(MODULE_ID);

/**
 * 状态同步引用，用于传递给生成服务
 */
const stateRef = {
    get isGenerating() { return summaryGenerating; },
    setGenerating(v) { 
        summaryGenerating = v;
        uiBridge.postToFrame({ type: "GENERATION_STATE", isGenerating: v });
    },
    updatePrompt: () => updateSummaryExtensionPrompt()
};

// ═══════════════════════════════════════════════════════════════════════════
// 控制器函数
// ═══════════════════════════════════════════════════════════════════════════

function getSettings() {
  const ext = (extension_settings[EXT_ID] ||= {});
  ext.storySummary ||= { enabled: true };
  return ext;
}

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
  uiBridge.showOverlay();
  const { chat } = getContext();
  const store = storeService.getSummaryStore();
  const totalFloors = chat.length;
  sendFrameBaseData(store, totalFloors);
  sendFrameFullData(store, totalFloors);
  stateRef.setGenerating(summaryGenerating);
}

// ═══════════════════════════════════════════════════════════════════════════
// Prompt 注入
// ═══════════════════════════════════════════════════════════════════════════

function formatSummaryForPrompt(store) {
  const data = store.json || {};
  const parts = [];
  parts.push("【此处是对以往历史及省略内容的剧情背景总结】");

  if (data.keywords?.length) {
    parts.push(`关键词：${data.keywords.map((k) => k.text).join(" / ")}`);
  }
  if (data.events?.length) {
    const lines = data.events.map((ev) => `- [${ev.timeLabel}] ${ev.title}：${ev.summary}`).join("\n");
    parts.push(`重要事件记录：\n${lines}`);
  }
  if (data.arcs?.length) {
    const lines = data.arcs.map((a) => {
        const moments = (a.moments || []).map((m) => typeof m === "string" ? m : m.text);
        if (!moments.length) return `- ${a.name}：${a.trajectory}`;
        return `- ${a.name}：${moments.join(" → ")}（当前：${a.trajectory}）`;
      }).join("\n");
    parts.push(`人物弧光：\n${lines}`);
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

  const cfg = genService.getSummaryPanelConfig();
  let text = formatSummaryForPrompt(store);

  if (cfg.trigger?.wrapperHead) text = cfg.trigger.wrapperHead + "\n" + text;
  if (cfg.trigger?.wrapperTail) text = text + "\n" + cfg.trigger.wrapperTail;
  
  const lastIdx = store.lastSummarizedMesId ?? 0;
  const length = Array.isArray(chat) ? chat.length : 0;
  if (lastIdx >= length) {
    delete extension_prompts[SUMMARY_PROMPT_KEY];
    return;
  }

  let depth = Math.max(0, length - lastIdx - 1);
  if (cfg.trigger?.forceInsertAtEnd) depth = 10000;

  extension_prompts[SUMMARY_PROMPT_KEY] = {
    value: text,
    position: extension_prompt_types.IN_CHAT,
    depth,
    role: extension_prompt_roles.ASSISTANT,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 面板指令分发
// ═══════════════════════════════════════════════════════════════════════════

async function handleUICommand(data) {
  const store = storeService.getSummaryStore();
  const { chat } = getContext();
  const totalFloors = Array.isArray(chat) ? chat.length : 0;

  switch (data.type) {
    case "FRAME_READY":
      uiBridge.setFrameReady(true);
      stateRef.setGenerating(summaryGenerating);
      sendFrameBaseData(store, totalFloors);
      sendFrameFullData(store, totalFloors);
      break;

    case "REQUEST_GENERATE":
      currentMesId = totalFloors - 1;
      genService.runSummaryGeneration(currentMesId, data.config, stateRef);
      break;

    case "REQUEST_CANCEL":
      window.xiaobaixStreamingGeneration?.cancel?.("xb9");
      stateRef.setGenerating(false);
      break;

    case "REQUEST_PRUNE_FIELDS":
      const res = await mgtService.pruneFieldsFromChat(data.pattern, data.keepRecentCount);
      uiBridge.postToFrame({ type: "PRUNE_RESULT", ...res });
      break;

    case "REQUEST_CLEAR":
      if (store) {
          delete store.json;
          store.lastSummarizedMesId = -1;
          store.updatedAt = Date.now();
          storeService.saveSummaryStore();
      }
      delete extension_prompts[SUMMARY_PROMPT_KEY];
      uiBridge.postToFrame({ type: "SUMMARY_CLEARED", payload: { totalFloors } });
      break;

    case "UPDATE_SECTION":
      if (!store) break;
      store.json ||= {};
      if (VALID_SECTIONS.includes(data.section)) store.json[data.section] = data.data;
      store.updatedAt = Date.now();
      storeService.saveSummaryStore();
      updateSummaryExtensionPrompt();
      break;

    case "TOGGLE_HIDE_SUMMARIZED":
      if (!store) break;
      store.hideSummarizedHistory = !!data.enabled;
      storeService.saveSummaryStore();
      const lastSum = store.lastSummarizedMesId ?? -1;
      if (data.enabled && lastSum >= 0) {
          const range = storeService.calcHideRange(lastSum);
          if (range) executeSlashCommand(`/hide ${range.start}-${range.end}`);
      } else if (lastSum >= 0) {
          executeSlashCommand(`/unhide 0-${lastSum}`);
      }
      break;
    
    case "CLOSE_PANEL":
        uiBridge.hideOverlay();
        break;
        
    case "UPDATE_START_FLOOR":
        const target = Math.max(1, Math.min(totalFloors, parseInt(data.floor) || 1));
        store.lastSummarizedMesId = target - 2;
        store.updatedAt = Date.now();
        storeService.saveSummaryStore();
        sendFrameBaseData(store, totalFloors);
        updateSummaryExtensionPrompt();
        break;

    case "MG_DELETE_EVENTS":
        genService.runEventsDelete(data.range, stateRef);
        break;

    case "MG_MERGE_EVENTS":
        genService.runEventsMerge(data.range, data.config, stateRef);
        break;

    case "UPDATE_KEEP_VISIBLE":
        storeService.setKeepVisibleCount(data.count);
        break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 楼层按钮逻辑
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
    openPanelForMessage(Number(mesId));
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
  if (container) container.appendChild(sumBtn);
}

function initButtonsForAll() {
  if (!getSettings().storySummary?.enabled) return;
  $("#chat .mes").each((_, el) => {
    const mesId = el.getAttribute("mesid");
    if (mesId != null) addSummaryBtnToMessage(mesId);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 回滚逻辑
// ═══════════════════════════════════════════════════════════════════════════

function rollbackSummaryIfNeeded() {
  const { chat } = getContext();
  const currentLength = Array.isArray(chat) ? chat.length : 0;
  const store = storeService.getSummaryStore();
  if (!store || store.lastSummarizedMesId == null || store.lastSummarizedMesId < 0) return;
  
  if (currentLength <= store.lastSummarizedMesId) {
    const history = store.summaryHistory || [];
    let targetId = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].endMesId < currentLength) { targetId = history[i].endMesId; break; }
    }
    executeFilterRollback(store, targetId, currentLength);
  }
}

function executeFilterRollback(store, targetId, currentLength) {
  const oldLastSum = store.lastSummarizedMesId;
  store.lastSummarizedMesId = targetId;
  if (targetId < 0) {
    store.json = null;
    store.summaryHistory = [];
  } else {
    const filter = (arr) => (arr || []).filter(item => (item._addedAt ?? 0) <= targetId);
    store.json.events = filter(store.json.events);
    store.json.keywords = filter(store.json.keywords);
    store.json.arcs = filter(store.json.arcs);
    store.summaryHistory = (store.summaryHistory || []).filter(h => h.endMesId <= targetId);
  }
  storeService.saveSummaryStore();
  updateSummaryExtensionPrompt();
  if (uiBridge.isFrameReady()) {
      sendFrameFullData(store, currentLength);
      sendFrameBaseData(store, currentLength);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 事件监听注册
// ═══════════════════════════════════════════════════════════════════════════

function handleChatChanged() {
  const { chat } = getContext();
  const len = chat?.length || 0;
  rollbackSummaryIfNeeded();
  initButtonsForAll();
  updateSummaryExtensionPrompt();
  if (uiBridge.isFrameReady()) sendFrameBaseData(storeService.getSummaryStore(), len);
}

function registerEvents() {
  if (eventsRegistered) return;
  eventsRegistered = true;
  uiBridge.setMessageHandler(handleUICommand);

  events.on(event_types.CHAT_CHANGED, () => setTimeout(handleChatChanged, 80));
  events.on(event_types.MESSAGE_RECEIVED, () => {
      initButtonsForAll();
      setTimeout(() => genService.maybeAutoRunSummary("after_ai", getSettings().storySummary?.enabled, stateRef), 1000);
  });
  events.on(event_types.MESSAGE_SENT, () => {
      initButtonsForAll();
      setTimeout(() => genService.maybeAutoRunSummary("before_user", getSettings().storySummary?.enabled, stateRef), 1000);
  });
  events.on(event_types.USER_MESSAGE_RENDERED, (data) => {
      const mesId = data?.element ? $(data.element).attr("mesid") : data?.messageId;
      if (mesId != null) addSummaryBtnToMessage(mesId);
  });
  events.on(event_types.CHARACTER_MESSAGE_RENDERED, (data) => {
      const mesId = data?.element ? $(data.element).attr("mesid") : data?.messageId;
      if (mesId != null) addSummaryBtnToMessage(mesId);
  });
}

// 初始化
jQuery(() => {
  if (getSettings().storySummary?.enabled) registerEvents();
});
