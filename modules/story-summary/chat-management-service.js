
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
    
    // 方案 1: 从当前上下文中找
    let chat = context?.chat;
    let sourceName = "Context";

    // 方案 2: 穿透模式 - 如果 Context 里的太少，去酒馆最底层的 character 存储里挖
    const currentChid = window.this_chid ?? context?.characterId;
    if (currentChid != null && window.characters?.[currentChid]?.chat) {
        const rawChat = window.characters[currentChid].chat;
        if (Array.isArray(rawChat) && rawChat.length > (Array.isArray(chat) ? chat.length : 0)) {
            chat = rawChat;
            sourceName = "CharacterRawDB";
        }
    }

    // 方案 3: 备份路径检测
    if (!Array.isArray(chat) || chat.length < 50) {
        const backups = [window.original_chat, window.raw_chat, window.all_messages];
        for (const b of backups) {
            if (Array.isArray(b) && b.length > (Array.isArray(chat) ? chat.length : 0)) {
                chat = b;
                sourceName = "LegacyBackup";
            }
        }
    }

    if (!Array.isArray(chat) || chat.length === 0) {
        xbLog.warn(MODULE_ID, "未能获取到有效的聊天记录数组");
        return { affectedMessages: 0, deletedFields: 0 };
    }

    const totalCount = chat.length;
    xbLog.info(MODULE_ID, `清理任务发动 [源:${sourceName}]：检测到全量楼层数为 ${totalCount}`);

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
        
        // 关键：强制让酒馆认为数据已变动，且绕过 UI 锁
        setTimeout(() => {
            try {
                // 如果在某些脚本下 saveChat 会超时，我们尝试通过修改 dirty 状态强制让酒馆在下一个心跳保存
                if (typeof window.eventSource !== 'undefined') {
                    // 模拟一个消息被编辑的事件，这通常会强制触发全量保存
                    window.eventSource.emit('chat_edited', { messageId: 0 });
                }

                // 尝试各种级别的保存函数
                if (typeof window.saveChat === 'function') {
                    window.saveChat(); 
                } else {
                    context?.saveChat?.();
                }
                
                xbLog.info(MODULE_ID, "全量保存指令已发送，请观察 .jsonl 文件大小变化。");
            } catch (e) {
                xbLog.error(MODULE_ID, "自动同步失败", e);
            }
        }, 200);
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
