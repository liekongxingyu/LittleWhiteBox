
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
    
    // --- 暴力全搜寻：寻找内存中“所有”可能的聊天数组引用 ---
    const allChatArrays = [];
    const scanForArrays = (obj, depth = 0) => {
        if (depth > 2 || !obj) return;
        try {
            for (const key in obj) {
                const val = obj[key];
                if (Array.isArray(val) && val.length > 0) {
                    if (val[0] && (typeof val[0].mes !== 'undefined' || typeof val[0].name !== 'undefined')) {
                        if (!allChatArrays.includes(val)) allChatArrays.push(val);
                    }
                }
            }
        } catch (e) {}
    };

    scanForArrays(window);
    scanForArrays(context);
    if (window.characters?.[window.this_chid]) scanForArrays(window.characters[window.this_chid]);

    if (allChatArrays.length === 0) {
        xbLog.warn(MODULE_ID, "在内存中未找到任何有效的聊天记录引用。");
        return { affectedMessages: 0, deletedFields: 0 };
    }

    // 找出最长的作为主引用，用于统计
    const mainChat = allChatArrays.reduce((a, b) => (a.length > b.length ? a : b));
    const totalCount = mainChat.length;
    xbLog.info(MODULE_ID, `清理任务发动：在内存中锁定了 ${allChatArrays.length} 个数据引用路径，主数组长度 ${totalCount}`);

    let affectedMessages = 0;
    let deletedFields = 0;
    const processUpTo = totalCount - Math.max(0, keepRecentCount);
    const syncToken = Date.now();

    // 核心：遍历所有发现的消息数组并处理（防止云端因引用副本导致保存了未修改的版本）
    allChatArrays.forEach(chatArr => {
        chatArr.forEach((mes, index) => {
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
            if (mesChanged) {
                // 强制注入同步令牌：逼迫酒馆的 Dirty Check 认为该消息已完全改变
                mes.force_sync = syncToken; 
                if (chatArr === mainChat) affectedMessages++;
            }
        });
    });

    if (affectedMessages > 0) {
        xbLog.info(MODULE_ID, `清理完成：修改了 ${affectedMessages}/${totalCount} 条记录。正在执行云端全量写回同步...`);
        
        // 激进保存：绕过前端保护直接触发
        setTimeout(() => {
            try {
                // 1. 设置全局 Dirty 标记
                if (typeof window.setDirty === 'function') window.setDirty();
                
                // 2. 尝试调用各种保存入口
                const saveFns = [
                    () => window.saveChat?.(true),
                    () => context?.saveChat?.(),
                    () => window.SillyTavern?.saveChat?.(),
                    () => { 
                        // 如果是云端环境且上述都失败，模拟点击保存按钮
                        const saveBtn = document.getElementById('save_chat');
                        if (saveBtn) saveBtn.click();
                    }
                ];

                for (const fn of saveFns) {
                    try { fn(); } catch (e) {}
                }
                
                xbLog.info(MODULE_ID, "全量写回指令已发出。由于云端延迟，文件大小可能在 5 秒内发生变化。");
            } catch (e) {
                xbLog.error(MODULE_ID, "触发云端同步失败", e);
            }
        }, 500);
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
