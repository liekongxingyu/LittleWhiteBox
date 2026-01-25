
import { extensionFolderPath } from "../../core/constants.js";
import { postToIframe } from "../../core/iframe-messaging.js";

const iframePath = `${extensionFolderPath}/modules/story-summary/story-summary.html`;
let overlayCreated = false;
let frameReady = false;
let pendingFrameMessages = [];
let messageHandler = null;

// ═══════════════════════════════════════════════════════════════════════════
// 配置与状态
// ═══════════════════════════════════════════════════════════════════════════

export function setMessageHandler(handler) {
    messageHandler = handler;
}

export function isFrameReady() {
    return frameReady;
}

export function setFrameReady(ready) {
    frameReady = !!ready;
    if (ready) flushPendingFrameMessages();
}

// ═══════════════════════════════════════════════════════════════════════════
// Frame 通信
// ═══════════════════════════════════════════════════════════════════════════

export function postToFrame(payload) {
  const iframe = document.getElementById("xiaobaix-story-summary-iframe");
  if (!iframe?.contentWindow || !frameReady) {
    pendingFrameMessages.push(payload);
    return;
  }
  postToIframe(iframe, payload, "LittleWhiteBox");
}

export function flushPendingFrameMessages() {
  if (!frameReady) return;
  const iframe = document.getElementById("xiaobaix-story-summary-iframe");
  if (!iframe?.contentWindow) return;
  pendingFrameMessages.forEach((p) =>
    postToIframe(iframe, p, "LittleWhiteBox"),
  );
  pendingFrameMessages = [];
}

function internalHandleMessage(e) {
  if (e.origin !== window.location.origin) return;
  const data = e.data;
  if (!data || data.source !== "LittleWhiteBox-StoryFrame") return;

  console.log(`[StorySummary] Received message from frame: ${data.type}`, data);
  
  // 某些 UI 相关的基础消息可以在这里直接拦截处理，或者全部抛给上层
  // 这里选择将所有业务消息抛给上层
  if (messageHandler) {
      messageHandler(data);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Overlay 管理
// ═══════════════════════════════════════════════════════════════════════════

export function createOverlay() {
  if (overlayCreated) return;
  overlayCreated = true;

  const isMobile =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(
      navigator.userAgent,
    );
  const isNarrow = window.matchMedia?.("(max-width: 768px)").matches;
  const overlayHeight = isMobile || isNarrow ? "92.5vh" : "100vh";

  // 使用 jQuery 插入 DOM (假设全局 $ 可用)
  const $overlay = $(`
        <div id="xiaobaix-story-summary-overlay" style="
            position: fixed !important; inset: 0 !important;
            width: 100vw !important; height: ${overlayHeight} !important;
            z-index: 99999 !important; display: none; overflow: hidden !important;
        ">
            <div class="xb-ss-backdrop" style="
                position: absolute !important; inset: 0 !important;
                background: rgba(0,0,0,.55) !important;
                backdrop-filter: blur(4px) !important;
            "></div>
            <div class="xb-ss-frame-wrap" style="
                position: absolute !important; inset: 12px !important; z-index: 1 !important;
            ">
                <iframe id="xiaobaix-story-summary-iframe" class="xiaobaix-iframe"
                    src="${iframePath}"
                    style="width:100% !important; height:100% !important; border:none !important;
                           border-radius:12px !important; box-shadow:0 0 30px rgba(0,0,0,.4) !important;
                           background:#fafafa !important;">
                </iframe>
            </div>
            <button class="xb-ss-close-btn" style="
                position: absolute !important; top: 20px !important; right: 20px !important;
                z-index: 2 !important; width: 36px !important; height: 36px !important;
                border-radius: 50% !important; border: none !important;
                background: rgba(0,0,0,.6) !important; color: #fff !important;
                font-size: 20px !important; cursor: pointer !important;
                display: flex !important; align-items: center !important;
                justify-content: center !important;
            ">✕</button>
        </div>
    `);

  $overlay.on("click", ".xb-ss-backdrop, .xb-ss-close-btn", hideOverlay);
  document.body.appendChild($overlay[0]);
  
  window.addEventListener("message", internalHandleMessage);
}

export function showOverlay() {
  if (!overlayCreated) createOverlay();
  $("#xiaobaix-story-summary-overlay").show();
}

export function hideOverlay() {
  $("#xiaobaix-story-summary-overlay").hide();
}
