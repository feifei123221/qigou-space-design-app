const STORAGE_KEY = "qigou-project-v3";
const PROJECT_ID_KEY = "qigou-project-id";
const MAX_REFERENCES = 3;
const API_ORIGIN = "https://spatial-design-studio.onrender.com";
const API_BASE = ["localhost", "127.0.0.1", new URL(API_ORIGIN).hostname].includes(window.location.hostname) ? "" : API_ORIGIN;
const apiUrl = (path) => `${API_BASE}${path}`;
const elements = Object.fromEntries([
  "sceneInput", "scenePreview", "referenceInput", "referenceGrid", "referenceCount", "openConversationButton",
  "messages", "composer", "composerContext", "quickOptions", "answerInput", "sendButton", "progressBar", "emptyStrategy", "strategyContent",
  "strategyTemplate", "apiStatus", "installButton", "newProjectButton", "exportProjectButton", "downloadImageButton", "generationState", "resultGrid"
].map((id) => [id, document.getElementById(id)]));

const defaultState = () => ({ id: localStorage.getItem(PROJECT_ID_KEY) || crypto.randomUUID(), scene: null, references: [], brief: "", conversation: [], status: "draft", phase: "discovery", progress: 0, quickOptions: [], strategy: null, confirmedStrategy: null, results: [], activeResultIndex: -1, generationError: "" });
let state = loadState();
let deferredInstallPrompt = null;
let busy = false;
let strategyLocalizationInFlight = false;
let persistTimer = null;
let localStorageWarningShown = false;


function loadState() {
  try { return { ...defaultState(), ...JSON.parse(localStorage.getItem(STORAGE_KEY)) }; } catch { return defaultState(); }
}
function persist() {
  try {
    localStorage.setItem(PROJECT_ID_KEY, state.id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("本机存储空间不足，项目将继续保存到服务端", error);
    if (!localStorageWarningShown) {
      localStorageWarningShown = true;
      showNotice("本机存储空间不足，项目将继续尝试保存到云端。建议及时下载效果图。", "error");
    }
  }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const response = await fetch(apiUrl(`/api/projects/${encodeURIComponent(state.id)}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) { console.warn("项目云端保存暂时失败", error.message); }
  }, 700);
}
async function restoreServerProject() {
  try {
    const response = await fetch(apiUrl(`/api/projects/${encodeURIComponent(state.id)}`));
    if (!response.ok) return;
    const result = await response.json();
    if (result.project?.savedAt && (!state.savedAt || result.project.savedAt > state.savedAt)) { state = { ...defaultState(), ...result.project }; renderAll(); }
  } catch (error) { console.warn("项目云端恢复暂时不可用", error.message); }
}
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function emit(name, detail = {}) { const payload = { type: `qigou:${name}`, detail, timestamp: new Date().toISOString() }; if (window.parent !== window) window.parent.postMessage(payload, "*"); window.dispatchEvent(new CustomEvent(payload.type, { detail })); }

function strategyNeedsLocalization(strategy) {
  if (!strategy) return false;
  const displayText = [strategy.positioning, ...(strategy.goals || []), strategy.style, strategy.lighting, strategy.materials, strategy.layout, strategy.constraints, strategy.known, strategy.inferred, strategy.unknown].join(" ");
  const chineseCount = (displayText.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (displayText.match(/[A-Za-z]/g) || []).length;
  return latinCount > 40 && latinCount > chineseCount * 1.5;
}

async function localizeStoredStrategy() {
  if (strategyLocalizationInFlight || !strategyNeedsLocalization(state.strategy)) return;
  strategyLocalizationInFlight = true;
  try {
    const response = await fetch(apiUrl("/api/chat"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ localizeOnly: true, phase: state.phase, strategy: state.strategy }) });
    const result = await response.json();
    if (!response.ok || !result.strategy) throw new Error(result.error || "设计决策中文化失败");
    state.strategy = result.strategy;
    persist();
    renderStrategy();
  } catch (error) { showNotice(error.message, "error"); }
  finally { strategyLocalizationInFlight = false; }
}

async function imageFromFile(file) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  const source = await createImageBitmap(file);
  const ratio = Math.min(1, 1800 / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * ratio); canvas.height = Math.round(source.height * ratio);
  canvas.getContext("2d", { alpha: false }).drawImage(source, 0, 0, canvas.width, canvas.height); source.close();
  return { name: file.name, type: "image/jpeg", dataUrl: canvas.toDataURL("image/jpeg", 0.86) };
}

function renderMedia() {
  elements.scenePreview.innerHTML = state.scene ? `<figure class="image-card scene-card"><img src="${state.scene.dataUrl}" alt="空间现场图"><figcaption><span>现场基准图</span><button data-remove-scene aria-label="删除现场图">×</button></figcaption></figure>` : "";
  elements.referenceGrid.innerHTML = state.references.map((image, index) => `<figure class="image-card reference-card"><img src="${image.dataUrl}" alt="参考图 ${index + 1}"><button data-remove-reference="${index}" aria-label="删除参考图">×</button><figcaption>参考 ${String(index + 1).padStart(2, "0")}</figcaption></figure>`).join("");
  elements.referenceCount.textContent = `${state.references.length} / ${MAX_REFERENCES}`;
}

function addMessage(role, text, label) {
  const article = document.createElement("article"); article.className = `message ${role}`;
  article.innerHTML = role === "designer" ? `<div class="avatar">栖</div><div><strong>${escapeHtml(label || "设计总监")}</strong><p>${escapeHtml(text)}</p></div>` : `<div><strong>你</strong><p>${escapeHtml(text)}</p></div>`;
  elements.messages.append(article);
}
function rebuildConversation() {
  elements.messages.innerHTML = '<article class="message designer"><div class="avatar">栖</div><div><strong>设计总监</strong><p>上传现场图和参考素材，再用自己的话描述期待。模糊没关系，我会观察图片并逐步把它变成明确方案。</p></div></article>';
  state.conversation.forEach((message) => addMessage(message.role === "assistant" ? "designer" : "user", message.content));
  if (busy) elements.messages.insertAdjacentHTML("beforeend", '<article class="message designer thinking-message" role="status" aria-live="polite"><div class="avatar">栖</div><div><strong>设计总监正在分析</strong><p>正在理解你的需求和空间信息，请稍候 <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span></p></div></article>');
  elements.messages.scrollTop = elements.messages.scrollHeight;
}
function renderComposer() {
  elements.composer.hidden = false;
  elements.progressBar.style.width = `${state.progress || 0}%`;
  elements.quickOptions.innerHTML = (state.quickOptions || []).map((option) => `<button type="button">${escapeHtml(option)}</button>`).join("");
  const latestAssistant = [...state.conversation].reverse().find((message) => message.role === "assistant");
  const resultConversation = state.results.length > 0 && ["revision", "complete", "review", "generating", "error"].includes(state.status);
  elements.composerContext.classList.toggle("visible", resultConversation);
  elements.composerContext.innerHTML = resultConversation ? `<strong>正在讨论版本 ${Math.max(1, state.activeResultIndex + 1)}</strong> · ${escapeHtml(latestAssistant?.content || "直接告诉我哪些地方保留、哪些地方修改，我会基于当前效果图继续优化。")}` : "";
  elements.answerInput.placeholder = state.phase === "revision" ? "说出要修改的地方，例如：保留沙发，只把灯光调暖……" : state.status === "draft" ? "描述你的空间需求……" : "继续回答设计总监……";
  elements.sendButton.disabled = busy;
}

function resultImage(result) { return result?.dataUrl || result?.url || ""; }
function renderStrategy() {
  if (strategyNeedsLocalization(state.strategy)) {
    elements.emptyStrategy.hidden = false; elements.strategyContent.hidden = true; elements.strategyContent.innerHTML = "";
    void localizeStoredStrategy();
    return;
  }
  if (!state.strategy) { elements.emptyStrategy.hidden = false; elements.strategyContent.hidden = true; elements.strategyContent.innerHTML = ""; return; }
  elements.emptyStrategy.hidden = true; elements.strategyContent.hidden = false;
  const fragment = elements.strategyTemplate.content.cloneNode(true); const root = fragment.querySelector(".strategy-content");
  const set = (field, value) => { root.querySelector(`[data-field="${field}"]`).textContent = value || "待确认"; };
  ["positioning", "style", "lighting", "materials", "layout", "constraints", "known", "inferred", "unknown"].forEach((field) => set(field, state.strategy[field]));
  root.querySelector('[data-field="goals"]').innerHTML = (state.strategy.goals || []).map((goal) => `<li>${escapeHtml(goal)}</li>`).join("");
  root.querySelector(".strategy-status b").textContent = state.status === "complete" ? "可继续优化" : state.phase === "revision" ? "修改方案" : "待确认";
  root.querySelector("#reviseButton").addEventListener("click", () => beginRevision(state.activeResultIndex));
  root.querySelector("#confirmButton").addEventListener("click", confirmAndGenerate);
  elements.strategyContent.replaceChildren(fragment);
}

function renderResults() {
  elements.generationState.textContent = state.status === "generating" ? "生成中，请耐心等待" : state.status === "error" ? state.generationError : state.results.length ? `版本 ${state.activeResultIndex + 1} / ${state.results.length}` : "等待生成";
  elements.downloadImageButton.hidden = !state.results.length;
  if (state.status === "generating" && !state.results.length) {
    elements.resultGrid.innerHTML = '<div class="generating-card"><i></i><p>正在生成设计效果图</p></div>';
    return;
  }
  if (state.status === "error" && !state.results.length) {
    elements.resultGrid.innerHTML = `<div class="error-card"><p>${escapeHtml(state.generationError)}</p></div>`;
    return;
  }
  if (!state.results.length) {
    elements.resultGrid.innerHTML = '<div class="visual-empty"><div class="line-art">⌂</div><h3>效果图将在这里呈现</h3><p>完成需求讨论并确认方案后，无需离开对话区即可查看结果。</p></div>';
    return;
  }
  elements.resultGrid.innerHTML = state.results.map((result, index) => `<figure class="result-card ${index === state.activeResultIndex ? "active" : ""}"><img src="${resultImage(result)}" alt="设计效果图版本 ${index + 1}"><figcaption><span>版本 ${index + 1}</span><span><button class="secondary" data-version="${index}">查看</button> <button class="secondary" data-optimize="${index}">基于此图优化</button></span></figcaption></figure>`).join("");
}
async function askDirector(phase) {
  busy = true; rebuildConversation(); renderComposer();
  try {
    const active = state.results[state.activeResultIndex];
    const response = await fetch(apiUrl("/api/chat"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phase, brief: state.brief, conversation: state.conversation, scene: state.scene, references: state.references, strategy: state.strategy, activeResultIndex: state.activeResultIndex, activeImage: active ? { name: `version-${state.activeResultIndex + 1}.png`, type: active.type || "image/png", dataUrl: resultImage(active) } : null }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "设计大脑暂时不可用");
    state.conversation.push({ role: "assistant", content: result.reply });
    state.phase = result.phase; state.progress = result.progress; state.quickOptions = result.quickOptions || [];
    if (result.readyForProposal && result.strategy) { state.strategy = result.strategy; state.status = "review"; state.phase = phase === "revision" ? "revision" : result.phase; state.progress = 100; state.quickOptions = phase === "revision" ? ["继续调整灯光", "继续修改布局", "继续优化材质", "确认并生成新版"] : []; switchMobilePanel("visual"); } else state.status = phase === "revision" ? "revision" : "interview";
    persist(); rebuildConversation(); renderComposer(); renderStrategy(); renderResults();
  } catch (error) { showNotice(error.message, "error"); state.status = phase === "revision" ? "revision" : "interview"; }
  finally { busy = false; renderComposer(); }
}

async function submitAnswer() {
  const answer = elements.answerInput.value.trim(); if (!answer || busy) return;
  if (!state.scene) return showNotice("请先在“素材”页上传一张空间现场图。", "error");
  elements.answerInput.value = ""; state.quickOptions = [];
  if (state.status === "draft") {
    state.brief = answer; state.conversation = [{ role: "user", content: answer }]; state.strategy = null; state.results = []; state.activeResultIndex = -1; state.status = "interview"; state.phase = "discovery"; state.progress = 5;
  } else {
    if (state.strategy && ["review", "complete"].includes(state.status)) { state.status = "revision"; state.phase = "revision"; state.progress = Math.max(70, state.progress || 0); }
    state.conversation.push({ role: "user", content: answer });
  }
  const isResultRevision = state.phase === "revision" && state.results.length > 0;
  persist(); rebuildConversation(); switchMobilePanel(isResultRevision ? "visual" : "conversation"); await askDirector(isResultRevision ? "revision" : "discovery");
}
function beginRevision(index) {
  if (!state.results.length) { state.status = "interview"; state.phase = "discovery"; } else { state.activeResultIndex = index >= 0 ? index : state.results.length - 1; state.status = "revision"; state.phase = "revision"; state.progress = 70; state.quickOptions = ["灯光与氛围", "布局与家具", "材质与颜色", "摆件与细节"]; state.conversation.push({ role: "assistant", content: `现在基于版本 ${state.activeResultIndex + 1} 继续优化。请告诉我哪里需要改变、哪些必须保持不动。我会先理解改动边界，再生成新版本。` }); }
  persist(); rebuildConversation(); renderComposer(); renderStrategy(); renderResults(); switchMobilePanel(state.results.length ? "visual" : "conversation"); elements.answerInput.focus();
}

function buildPrompt() { return state.strategy?.imagePrompt || "Preserve the original room geometry, camera, perspective, windows and doors. Create a realistic, buildable interior design visualization with natural lighting, accurate materials, no people, no text and no watermark."; }
async function confirmAndGenerate() {
  if (busy || !state.strategy?.imagePrompt) return;
  busy = true; state.confirmedStrategy = state.strategy; state.status = "generating"; state.generationError = ""; persist(); renderStrategy();
  try {
    const active = state.results[state.activeResultIndex]; const inputs = [state.scene];
    if (state.phase === "revision" && resultImage(active)) inputs.push({ name: `generated-version-${state.activeResultIndex + 1}.png`, type: active.type || "image/png", dataUrl: resultImage(active) });
    inputs.push(...state.references);
    const response = await fetch(apiUrl("/api/generate"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: buildPrompt(), images: inputs.filter(Boolean).slice(0, 4), size: "1536x1024" }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "生图服务返回错误"); if (!result.images?.length) throw new Error("服务没有返回图片");
    state.results.push(...result.images); state.activeResultIndex = state.results.length - 1; state.status = "complete"; state.phase = "revision"; state.progress = 100; state.quickOptions = ["灯光再暖一点", "调整布局与家具", "优化材质和颜色", "修改摆件与细节"]; state.conversation.push({ role: "assistant", content: `版本 ${state.results.length} 已完成。请直接在下方告诉我哪些地方保留、哪些地方修改，我会把这张效果图作为主要视觉基准继续讨论并生成下一版。` }); switchMobilePanel("visual"); emit("generation-complete", { images: result.images, strategy: state.strategy });
  } catch (error) { state.status = "error"; state.generationError = error.message; emit("generation-error", { message: error.message }); }
  finally { busy = false; persist(); rebuildConversation(); renderComposer(); renderStrategy(); renderResults(); }
}

function showNotice(text, type = "info") { const notice = document.createElement("div"); notice.className = `notice ${type}`; notice.textContent = text; document.body.append(notice); requestAnimationFrame(() => notice.classList.add("visible")); setTimeout(() => notice.remove(), 3500); }
function switchMobilePanel(panel) { document.body.dataset.mobilePanel = panel; document.querySelectorAll("[data-mobile-tab]").forEach((button) => button.classList.toggle("active", button.dataset.mobileTab === panel)); }
async function checkHealth() { elements.apiStatus.textContent = "AI 服务正在连接"; try { const response = await fetch(apiUrl("/api/health")); const health = await response.json(); const ready = health.imageApiConfigured && health.llmApiConfigured; elements.apiStatus.textContent = ready ? `智能设计与 ${health.model} 已连接` : "模型服务待配置"; elements.apiStatus.classList.toggle("ready", ready); } catch { elements.apiStatus.textContent = "AI 服务暂时未连接"; } }
async function handleScene(event) { const [file] = event.target.files; if (!file) return; try { state.scene = await imageFromFile(file); persist(); renderMedia(); } catch (error) { showNotice(error.message, "error"); } event.target.value = ""; }
async function handleReferences(event) { const files = [...event.target.files].slice(0, MAX_REFERENCES - state.references.length); if (!files.length) return showNotice(`最多添加 ${MAX_REFERENCES} 张参考图。`, "error"); try { state.references.push(...await Promise.all(files.map(imageFromFile))); persist(); renderMedia(); } catch (error) { showNotice(error.message, "error"); } event.target.value = ""; }
function resetProject() { if (!confirm("新建设计会清空当前访谈和图片，确定继续吗？")) return; elements.answerInput.value = ""; localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(PROJECT_ID_KEY); state = defaultState(); persist(); renderAll(); }
function renderAll() { renderMedia(); rebuildConversation(); renderComposer(); renderStrategy(); renderResults(); }

elements.sceneInput.addEventListener("change", handleScene); elements.referenceInput.addEventListener("change", handleReferences); elements.openConversationButton.addEventListener("click", () => { switchMobilePanel("conversation"); elements.answerInput.focus(); }); elements.sendButton.addEventListener("click", submitAnswer);
elements.answerInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitAnswer(); } });
elements.quickOptions.addEventListener("click", (event) => { if (event.target.tagName !== "BUTTON") return; elements.answerInput.value = elements.answerInput.value.trim() ? `${elements.answerInput.value.trim()}，${event.target.textContent}` : event.target.textContent; elements.answerInput.focus(); });
elements.scenePreview.addEventListener("click", (event) => { if (event.target.matches("[data-remove-scene]")) { state.scene = null; persist(); renderMedia(); } });
elements.referenceGrid.addEventListener("click", (event) => { if (event.target.dataset.removeReference !== undefined) { state.references.splice(Number(event.target.dataset.removeReference), 1); persist(); renderMedia(); } });
elements.newProjectButton.addEventListener("click", resetProject);
elements.exportProjectButton.addEventListener("click", () => window.print());
elements.downloadImageButton.addEventListener("click", () => { const active = state.results[state.activeResultIndex]; if (!active) return; const link = document.createElement("a"); link.href = resultImage(active); link.download = `栖构空间设计-版本${state.activeResultIndex + 1}.png`; link.click(); });
elements.resultGrid.addEventListener("click", (event) => { const version = event.target.dataset.version; const optimize = event.target.dataset.optimize; if (version !== undefined) { state.activeResultIndex = Number(version); persist(); renderResults(); } if (optimize !== undefined) beginRevision(Number(optimize)); });
document.querySelectorAll("[data-mobile-tab]").forEach((button) => button.addEventListener("click", () => switchMobilePanel(button.dataset.mobileTab)));
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstallPrompt = event; elements.installButton.hidden = false; }); elements.installButton.addEventListener("click", async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; elements.installButton.hidden = true; });
window.addEventListener("message", (event) => { const message = event.data; if (!message || typeof message !== "object") return; if (message.type === "qigou:set-context") { state.context = { ...(state.context || {}), ...(message.detail || {}) }; persist(); emit("context-updated", state.context); } if (message.type === "qigou:get-state") emit("state", { state }); if (message.type === "qigou:reset") resetProject(); });
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.warn));
renderAll(); void restoreServerProject(); checkHealth(); emit("ready", { version: "2.2.0", capabilities: ["vision-interview", "llm-reasoning", "design-strategy", "image-generation", "image-revision", "version-history", "pwa", "embed"] });
