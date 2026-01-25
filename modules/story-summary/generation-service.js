
import { getContext } from "../../../../../extensions.js";
import { extension_prompts, extension_prompt_types, extension_prompt_roles } from "../../../../../../script.js";
import { xbLog } from "../../core/debug-core.js";
import { generateSummary, parseSummaryJson, generateEventMerge } from "./llm-service.js";
import * as storeService from "./store-service.js";
import * as uiBridge from "./ui-bridge.js";
const MODULE_ID = "storySummary";

export async function runEventsMerge(range, configFromFrame, stateRef) {
  const store = storeService.getSummaryStore();
  if (!store?.json?.events) return;

  const { start, end } = range;
  const eventsToMerge = store.json.events.slice(start, end + 1);
  if (eventsToMerge.length === 0) return;

  uiBridge.postToFrame({ type: "SUMMARY_STATUS", statusText: `正在合并第 ${start + 1} 到 ${end + 1} 个事件...` });

  try {
    const apiCfg = configFromFrame?.api || {};
    const mergedEvent = await generateEventMerge(eventsToMerge, {
      provider: apiCfg.provider,
      url: apiCfg.url,
      key: apiCfg.key,
      model: apiCfg.model,
    });

    if (mergedEvent) {
      storeService.replaceEventsRange(store, start, end, mergedEvent);
      uiBridge.postToFrame({
        type: "SUMMARY_FULL_DATA",
        payload: {
          events: store.json.events,
          lastSummarizedMesId: store.lastSummarizedMesId,
        },
      });
      uiBridge.postToFrame({ type: "SUMMARY_STATUS", statusText: "事件合并成功" });
      stateRef.updatePrompt();
    } else {
      throw new Error("AI 合并返回无效结果");
    }
  } catch (err) {
    xbLog.error(MODULE_ID, "合并失败", err);
    uiBridge.postToFrame({ type: "SUMMARY_ERROR", message: "合并失败: " + err.message });
  }
}

export function runEventsDelete(range, stateRef) {
  const store = storeService.getSummaryStore();
  if (!store?.json?.events) return;

  const { start, end } = range;
  if (storeService.deleteEvents(store, start, end)) {
    uiBridge.postToFrame({
      type: "SUMMARY_FULL_DATA",
      payload: {
        events: store.json.events,
        lastSummarizedMesId: store.lastSummarizedMesId,
      },
    });
    uiBridge.postToFrame({ type: "SUMMARY_STATUS", statusText: "事件已删除" });
    stateRef.updatePrompt();
  }
}
const SUMMARY_SESSION_ID = "xb9";
const SUMMARY_PROMPT_KEY = "LittleWhiteBox_StorySummary";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// 配置获取
// ═══════════════════════════════════════════════════════════════════════════

export function getSummaryPanelConfig() {
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
      wrapperHead: '',
      wrapperTail: '',
      forceInsertAtEnd: false
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
// 切片构建
// ═══════════════════════════════════════════════════════════════════════════

export function buildIncrementalSlice(targetMesId, lastSummarizedMesId, maxPerRun = 100) {
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

// ═══════════════════════════════════════════════════════════════════════════
// 核心生成逻辑
// ═══════════════════════════════════════════════════════════════════════════

export async function runSummaryGeneration(mesId, configFromFrame, stateRef) {
  if (stateRef.isGenerating) {
    uiBridge.postToFrame({
      type: "SUMMARY_STATUS",
      statusText: "上一轮总结仍在进行中...",
    });
    return false;
  }

  stateRef.setGenerating(true);
  xbLog.info(MODULE_ID, `开始总结 mesId=${mesId}`);

  const cfg = configFromFrame || {};
  const store = storeService.getSummaryStore();
  const lastSummarized = store?.lastSummarizedMesId ?? -1;
  const maxPerRun = cfg.trigger?.maxPerRun || 100;
  const slice = buildIncrementalSlice(mesId, lastSummarized, maxPerRun);

  if (slice.count === 0) {
    uiBridge.postToFrame({ type: "SUMMARY_STATUS", statusText: "没有新的对话需要总结" });
    stateRef.setGenerating(false);
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
    stateRef.setGenerating(false);
    return false;
  }

  if (!raw?.trim()) {
    xbLog.error(MODULE_ID, "AI返回为空");
    uiBridge.postToFrame({ type: "SUMMARY_ERROR", message: "AI返回为空" });
    stateRef.setGenerating(false);
    return false;
  }

  const parsed = parseSummaryJson(raw);
  if (!parsed) {
    xbLog.error(MODULE_ID, "JSON解析失败");
    uiBridge.postToFrame({ type: "SUMMARY_ERROR", message: "AI未返回有效JSON" });
    stateRef.setGenerating(false);
    return false;
  }

  const oldJson = store?.json || {};
  const merged = storeService.mergeNewData(oldJson, parsed, slice.endMesId);

  store.lastSummarizedMesId = slice.endMesId;
  store.json = merged;
  store.updatedAt = Date.now();
  storeService.addSummarySnapshot(store, slice.endMesId);
  storeService.saveSummaryStore();

  // 更新 UI
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

  // 更新延迟显示的数据
  const { chat } = getContext();
  const totalFloors = Array.isArray(chat) ? chat.length : 0;
  
  uiBridge.postToFrame({
    type: "SUMMARY_BASE_DATA",
    stats: {
      totalFloors,
      summarizedUpTo: slice.endMesId + 1,
      eventsCount: merged.events?.length || 0,
      pendingFloors: totalFloors - slice.endMesId - 1,
    },
  });

  stateRef.updatePrompt();
  stateRef.setGenerating(false);

  xbLog.info(MODULE_ID, `总结完成，已更新至 ${slice.endMesId + 1} 楼`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 自动触发逻辑
// ═══════════════════════════════════════════════════════════════════════════

export async function maybeAutoRunSummary(reason, isEnabled, stateRef) {
  const { chatId, chat } = getContext();
  if (!chatId || !Array.isArray(chat) || !isEnabled) return;

  const cfgAll = getSummaryPanelConfig();
  const trig = cfgAll.trigger || {};

  if (trig.timing === "manual") return;
  if (!trig.enabled) return;
  if (trig.timing === "after_ai" && reason !== "after_ai") return;
  if (trig.timing === "before_user" && reason !== "before_user") return;

  if (stateRef.isGenerating) return;

  const store = storeService.getSummaryStore();
  const lastSummarized = store?.lastSummarizedMesId ?? -1;
  const pending = chat.length - lastSummarized - 1;
  if (pending < (trig.interval || 1)) return;

  xbLog.info(MODULE_ID, `自动触发剧情总结: reason=${reason}, pending=${pending}`);
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await runSummaryGeneration(chat.length - 1, { api: cfgAll.api, gen: cfgAll.gen, trigger: trig }, stateRef)) return;
    if (attempt < 3) await sleep(1000);
  }
}
