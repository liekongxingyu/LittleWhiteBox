
import { getContext, saveChatDebounced } from "../../../../../extensions.js";
import { xbLog } from "../../core/debug-core.js";

const MODULE_ID = "storySummary";

/**
 * 遍历所有聊天记录，并删除匹配模糊模式的字段
 * @param {string} pattern 模糊匹配模式 (如 "TavernDB")
 * @returns {Promise<{affectedMessages: number, deletedFields: number}>}
 */
export async function pruneFieldsFromChat(pattern) {
    const { chat } = getContext();
    if (!Array.isArray(chat)) return { affectedMessages: 0, deletedFields: 0 };

    let affectedMessages = 0;
    let deletedFields = 0;

    const lowerPattern = pattern.toLowerCase();

    chat.forEach((mes) => {
        let mesChanged = false;
        
        // 1. 递归扫描对象字段
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
        
        if (mesChanged) {
            affectedMessages++;
        }
    });

    if (affectedMessages > 0) {
        xbLog.info(MODULE_ID, `清理元数据：匹配周期 "${pattern}"，影响 ${affectedMessages} 条消息，删除 ${deletedFields} 个字段`);
        saveChatDebounced?.();
    }

    return { affectedMessages, deletedFields };
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
