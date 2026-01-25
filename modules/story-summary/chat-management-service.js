
import { getContext } from "../../../../../extensions.js";
import { xbLog } from "../../core/debug-core.js";

const MODULE_ID = "storySummary";

/**
 * 遍历所有聊天记录，并删除匹配模糊模式的字段
 * @param {string} pattern 模糊匹配模式 (如 "TavernDB")
 * @param {number} keepRecentCount 保留最近多少条不处理 (默认 0)
 * @returns {Promise<{affectedMessages: number, deletedFields: number}>}
 */
export async function pruneFieldsFromChat(pattern, keepRecentCount = 0) {
    const context = getContext();
    const lowerPattern = pattern.toLowerCase();
    
    // 搜寻可能的完整数组源
    const sources = [
        { name: 'Global Chat', data: window.chat },
        { name: 'Context Chat', data: context?.chat },
        { name: 'Backup Chat', data: window.original_chat },
        { name: 'Raw Chat', data: window.raw_chat },
        { name: 'All Messages', data: window.all_messages },
        { name: 'Character DB', data: window.characters?.[window.this_chid]?.chat }
    ];

    // 寻找最长的那个数组，作为真实的数据源
    let bestSource = sources.reduce((prev, curr) => 
        (Array.isArray(curr.data) && curr.data.length > (Array.isArray(prev.data) ? prev.data.length : -1)) ? curr : prev, 
        { name: 'None', data: null }
    );

    const chat = bestSource.data;
    if (!Array.isArray(chat) || chat.length === 0) {
        xbLog.warn(MODULE_ID, "未能获取到有效的聊天记录数组");
        return { affectedMessages: 0, deletedFields: 0 };
    }

    const totalCount = chat.length;
    xbLog.info(MODULE_ID, `清理任务发动：使用数据源 [${bestSource.name}]，检测到数组长度为 ${totalCount}`);

    let affectedMessages = 0;
    let deletedFields = 0;
    const processUpTo = totalCount - Math.max(0, keepRecentCount);

    chat.forEach((mes, index) => {
        if (index >= processUpTo) return;
        let mesChanged = false;
        const scanAndPrune = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            const keys = Object.keys(obj);
            keys.forEach(key => {
                if (key.toLowerCase().includes(lowerPattern)) {
                    delete obj[key];
                    deletedFields++;
                    mesChanged = true;
                } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                    scanAndPrune(obj[key]);
                }
            });
        };
        scanAndPrune(mes);
        if (mesChanged) affectedMessages++;
    });

    if (affectedMessages > 0) {
        xbLog.info(MODULE_ID, `清理完成：匹配 "${pattern}"，处理了 ${affectedMessages}/${totalCount} 条消息，删除 ${deletedFields} 个字段`);
        
        // 尝试多种路径强制静默保存，不经过 UI 等待
        setTimeout(() => {
            try {
                if (typeof window.saveChat === 'function') {
                    window.saveChat(true); 
                } else {
                    context?.saveChat?.();
                }
                xbLog.info(MODULE_ID, "已触发异步静默保存。");
            } catch (e) {
                xbLog.error(MODULE_ID, "触发保存失败", e);
            }
        }, 100);
    }

    return { affectedMessages, deletedFields, totalCount };
}

/**
 * 获取聊天记录中所有字段名的统计列表 (用于模糊查询参考)
 */
export function getAllFieldNames() {
    const { chat } = getContext();
    const fieldSet = new Set();
    
    const scanKeys = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        Object.keys(obj).forEach(k => {
            fieldSet.add(k);
            if (typeof obj[k] === 'object' && obj[k] !== null) scanKeys(obj[k]);
        });
    };

    if (Array.isArray(chat)) {
        chat.forEach(m => scanKeys(m));
    }
    
    return Array.from(fieldSet).sort();
}
