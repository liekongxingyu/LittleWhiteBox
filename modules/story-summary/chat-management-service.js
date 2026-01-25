
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
    
    // --- 雷达模式：在内存中肉眼搜寻那个巨大的数组 ---
    let chat = null;
    let sourceName = "None";

    const scanForChatArray = () => {
        // 优先检查已知的可能路径
        const knownPaths = [
            { n: 'window.chat', d: window.chat },
            { n: 'context.chat', d: context?.chat },
            { n: 'window.original_chat', d: window.original_chat },
            { n: 'window.raw_chat', d: window.raw_chat },
            { n: 'window.all_messages', d: window.all_messages },
            { n: 'CharacterDB', d: window.characters?.[window.this_chid ?? context?.characterId]?.chat }
        ];

        for (const path of knownPaths) {
            if (Array.isArray(path.d) && path.d.length > 100) return { d: path.d, n: path.n };
        }

        // 如果已知路径都失败了，启动全域扫描 (寻找长度>100且看起来像聊天的数组)
        try {
            for (const key in window) {
                const val = window[key];
                if (Array.isArray(val) && val.length > 100) {
                    // 检查特征：元素是否包含 mes 或 name 属性
                    if (val[0] && (typeof val[0].mes !== 'undefined' || typeof val[0].name !== 'undefined')) {
                        return { d: val, n: `Explored_Global_${key}` };
                    }
                }
            }
        } catch (e) {}
        
        return { d: window.chat || context?.chat, n: "Fallback" };
    };

    const result = scanForChatArray();
    chat = result.d;
    sourceName = result.n;

    if (!Array.isArray(chat) || chat.length === 0) {
        xbLog.warn(MODULE_ID, "雷达扫描未能在内存中找到有效的长聊天记录。");
        return { affectedMessages: 0, deletedFields: 0 };
    }

    const totalCount = chat.length;
    xbLog.info(MODULE_ID, `清理任务发动 [源:${sourceName}]：雷达在内存中锁定了 ${totalCount} 条原始对话记录`);

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
        xbLog.info(MODULE_ID, `清理完成：匹配 "${pattern}"，修改了 ${affectedMessages}/${totalCount} 条，清除了 ${deletedFields} 个字段`);
        
        // 尝试唤起原本休眠的保存进程
        setTimeout(() => {
            try {
                // 1. 手动标记 dirty
                if (typeof window.setDirty === 'function') window.setDirty();
                
                // 2. 模拟消息列表末尾变动
                if (window.eventSource) {
                    window.eventSource.emit('chat_edited', { messageId: chat.length - 1 });
                    window.eventSource.emit('messages_rendered');
                }

                // 3. 执行物理保存
                if (typeof window.saveChat === 'function') {
                    window.saveChat(); 
                } else {
                    context?.saveChat?.();
                }
                
                xbLog.info(MODULE_ID, "全量同步信号已发出，请观察 2 秒后文件大小。");
            } catch (e) {
                xbLog.error(MODULE_ID, "同步失败", e);
            }
        }, 300);
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
