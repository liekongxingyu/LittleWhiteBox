
import {
  getContext,
  saveMetadataDebounced,
} from "../../../../../extensions.js";
import {
  chat_metadata,
} from "../../../../../../script.js";
import { EXT_ID } from "../../core/constants.js";

const MODULE_ID = "storySummary";

// ═══════════════════════════════════════════════════════════════════════════
// 存储访问
// ═══════════════════════════════════════════════════════════════════════════

export function getSummaryStore() {
  const { chatId } = getContext();
  if (!chatId) return null;
  chat_metadata.extensions ||= {};
  chat_metadata.extensions[EXT_ID] ||= {};
  chat_metadata.extensions[EXT_ID].storySummary ||= {};
  return chat_metadata.extensions[EXT_ID].storySummary;
}

export function saveSummaryStore() {
  saveMetadataDebounced?.();
}

// ═══════════════════════════════════════════════════════════════════════════
// 数据计算与格式化
// ═══════════════════════════════════════════════════════════════════════════

export function getKeepVisibleCount() {
  const store = getSummaryStore();
  return store?.keepVisibleCount ?? 3;
}

export function calcHideRange(lastSummarized) {
  const keepCount = getKeepVisibleCount();
  const hideEnd = lastSummarized - keepCount;
  if (hideEnd < 0) return null;
  return { start: 0, end: hideEnd };
}

export function getNextEventId(store) {
  const events = store?.json?.events || [];
  if (events.length === 0) return 1;
  const maxId = Math.max(
    ...events.map((e) => {
      const match = e.id?.match(/evt-(\d+)/);
      return match ? parseInt(match[1]) : 0;
    }),
  );
  return maxId + 1;
}

export function formatExistingSummaryForAI(store) {
  if (!store?.json) return "（空白，这是首次总结）";
  const data = store.json;
  const parts = [];

  if (data.events?.length) {
    parts.push("【已记录事件】");
    data.events.forEach((ev, i) =>
      parts.push(`${i + 1}. [${ev.timeLabel}] ${ev.title}：${ev.summary}`),
    );
  }
  if (data.characters?.main?.length) {
    const names = data.characters.main.map((m) =>
      typeof m === "string" ? m : m.name,
    );
    parts.push(`\n【主要角色】${names.join("、")}`);
  }
  if (data.characters?.relationships?.length) {
    parts.push("【人物关系】");
    data.characters.relationships.forEach((r) =>
      parts.push(`- ${r.from} → ${r.to}：${r.label}（${r.trend}）`),
    );
  }
  if (data.arcs?.length) {
    parts.push("【角色弧光】");
    data.arcs.forEach((a) =>
      parts.push(
        `- ${a.name}：${a.trajectory}（进度${Math.round(a.progress * 100)}%）`,
      ),
    );
  }
  if (data.keywords?.length) {
    parts.push(`\n【关键词】${data.keywords.map((k) => k.text).join("、")}`);
  }

  return parts.join("\n") || "（空白，这是首次总结）";
}

// ═══════════════════════════════════════════════════════════════════════════
// 数据变更操作
// ═══════════════════════════════════════════════════════════════════════════

export function addSummarySnapshot(store, endMesId) {
  store.summaryHistory ||= [];
  store.summaryHistory.push({ endMesId });
}

export function mergeNewData(oldJson, parsed, endMesId) {
  const merged = structuredClone(oldJson || {});
  merged.keywords ||= [];
  merged.events ||= [];
  merged.characters ||= {};
  merged.characters.main ||= [];
  merged.characters.relationships ||= [];
  merged.arcs ||= [];

  // 关键词：完全替换（全局关键词）
  if (parsed.keywords?.length) {
    merged.keywords = parsed.keywords.map((k) => ({
      ...k,
      _addedAt: endMesId,
    }));
  }

  // 事件：追加
  (parsed.events || []).forEach((e) => {
    e._addedAt = endMesId;
    merged.events.push(e);
  });

  // 新角色：追加不重复
  const existingMain = new Set(
    (merged.characters.main || []).map((m) =>
      typeof m === "string" ? m : m.name,
    ),
  );
  (parsed.newCharacters || []).forEach((name) => {
    if (!existingMain.has(name)) {
      merged.characters.main.push({ name, _addedAt: endMesId });
    }
  });

  // 关系：更新或追加
  const relMap = new Map(
    (merged.characters.relationships || []).map((r) => [
      `${r.from}->${r.to}`,
      r,
    ]),
  );
  (parsed.newRelationships || []).forEach((r) => {
    const key = `${r.from}->${r.to}`;
    const existing = relMap.get(key);
    if (existing) {
      existing.label = r.label;
      existing.trend = r.trend;
    } else {
      r._addedAt = endMesId;
      relMap.set(key, r);
    }
  });
  merged.characters.relationships = Array.from(relMap.values());

  // 弧光：更新或追加
  const arcMap = new Map((merged.arcs || []).map((a) => [a.name, a]));
  (parsed.arcUpdates || []).forEach((update) => {
    const existing = arcMap.get(update.name);
    if (existing) {
      existing.trajectory = update.trajectory;
      existing.progress = update.progress;
      if (update.newMoment) {
        existing.moments = existing.moments || [];
        existing.moments.push({ text: update.newMoment, _addedAt: endMesId });
      }
    } else {
      arcMap.set(update.name, {
        name: update.name,
        trajectory: update.trajectory,
        progress: update.progress,
        moments: update.newMoment
          ? [{ text: update.newMoment, _addedAt: endMesId }]
          : [],
        _addedAt: endMesId,
      });
    }
  });
  merged.arcs = Array.from(arcMap.values());

  return merged;
}
