const API_BASE = window.__API_BASE__ ?? "";
const HISTORY_KEY = "sentinela.history.v1";
const THEME_KEY = "sentinela.theme";
const MAX_HISTORY = 12;
// Limite de caracteres do thumb salvo em localStorage (~80 KB por imagem)
const MAX_THUMB_CHARS = 80_000;

const EPI_LABELS = {
    capacete:           "Capacete",
    oculos:             "Óculos de proteção",
    luvas:              "Luvas",
    mascara:            "Máscara",
    bota:               "Botas de segurança",
    colete:             "Colete refletivo",
    protetor_auricular: "Protetor auricular",
};

const COMPLIANCE_COPY = {
    conforme:    "Todos os EPIs essenciais foram identificados na imagem.",
    parcial:     "Alguns EPIs essenciais estão ausentes — revise o checklist.",
    nao_conforme:"Nenhum dos EPIs obrigatórios foi detectado.",
    nenhum_epi:  "A imagem não apresentou EPIs reconhecíveis.",
};

const COMPLIANCE_STATUS_LABEL = {
    conforme:    "Conforme",
    parcial:     "Parcial",
    nao_conforme:"Não conforme",
    nenhum_epi:  "Sem EPI",
};

// ── Referências do DOM ──────────────────────────────────────────────────────
const els = {
    dropzone:            document.getElementById("dropzone"),
    fileInput:           document.getElementById("fileInput"),
    previewImg:          document.getElementById("previewImg"),
    dropzoneContent:     document.getElementById("dropzoneContent"),
    analyzeBtn:          document.getElementById("analyzeBtn"),
    clearBtn:            document.getElementById("clearBtn"),
    statusPill:          document.getElementById("statusPill"),
    confRange:           document.getElementById("confRange"),
    confValue:           document.getElementById("confValue"),
    resultEmpty:         document.getElementById("resultEmpty"),
    resultSummary:       document.getElementById("resultSummary"),
    summaryMeta:         document.getElementById("summaryMeta"),
    annotatedImg:        document.getElementById("annotatedImg"),
    resultFrame:         document.getElementById("resultFrame"),
    scoreValue:          document.getElementById("scoreValue"),
    complianceStatus:    document.getElementById("complianceStatus"),
    checklist:           document.getElementById("checklist"),
    detectionList:       document.getElementById("detectionList"),
    downloadBtn:         document.getElementById("downloadBtn"),
    themeToggle:         document.getElementById("themeToggle"),
    statCount:           document.getElementById("statCount"),
    statTime:            document.getElementById("statTime"),
    statClasses:         document.getElementById("statClasses"),
    historyGrid:         document.getElementById("historyGrid"),
    clearHistoryBtn:     document.getElementById("clearHistoryBtn"),
    apiStatus:           document.getElementById("apiStatus"),
};

// ── Estado ──────────────────────────────────────────────────────────────────
const state = {
    currentFile:    null,
    currentResult:  null,
    currentObjURL:  null,   // para revogar ObjectURL após uso
    history:        loadHistory(),
    sessionCount:   0,
    analyzing:      false,  // previne duplo-submit
};

init();

// ── Inicialização ────────────────────────────────────────────────────────────
function init() {
    applyStoredTheme();
    bindEvents();
    checkApi();
    renderHistory();
}

function applyStoredTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark")  document.documentElement.setAttribute("data-theme", "dark");
    if (stored === "light") document.documentElement.setAttribute("data-theme", "light");
}

// ── Eventos ──────────────────────────────────────────────────────────────────
function bindEvents() {
    els.themeToggle.addEventListener("click", toggleTheme);

    // Dropzone: click / keyboard
    els.dropzone.addEventListener("click", () => els.fileInput.click());
    els.dropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
    });

    // File input
    els.fileInput.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (file) loadFile(file);
    });

    // Drag & drop
    ["dragenter", "dragover"].forEach((type) =>
        els.dropzone.addEventListener(type, (e) => { e.preventDefault(); els.dropzone.classList.add("is-dragging"); })
    );
    ["dragleave", "drop"].forEach((type) =>
        els.dropzone.addEventListener(type, (e) => { e.preventDefault(); els.dropzone.classList.remove("is-dragging"); })
    );
    els.dropzone.addEventListener("drop", (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) loadFile(file);
    });

    // Paste global
    document.addEventListener("paste", (e) => {
        const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
        if (item) { const f = item.getAsFile(); if (f) loadFile(f); }
    });

    // Ações
    els.analyzeBtn.addEventListener("click", analyze);
    els.clearBtn.addEventListener("click", reset);

    // Confidence range (com debounce)
    els.confRange.addEventListener("input", debounce(() => {
        els.confValue.textContent = `${els.confRange.value}%`;
    }, 50));

    els.downloadBtn.addEventListener("click", downloadAnnotated);
    els.clearHistoryBtn.addEventListener("click", () => {
        state.history = [];
        saveHistory();
        renderHistory();
    });

    // Atalhos de teclado globais
    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !els.analyzeBtn.disabled) analyze();
        if (e.key === "Escape" && state.currentFile) reset();
    });
}

// ── Tema ─────────────────────────────────────────────────────────────────────
function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    // Ciclo: system → dark → light → system
    if (!current || current === "light") {
        document.documentElement.setAttribute("data-theme", "dark");
        localStorage.setItem(THEME_KEY, "dark");
    } else {
        document.documentElement.setAttribute("data-theme", "light");
        localStorage.setItem(THEME_KEY, "light");
    }
}

// ── API health check (com retry 1×) ─────────────────────────────────────────
async function checkApi(retry = true) {
    try {
        const res = await fetch(`${API_BASE}/api/health`);
        if (!res.ok) throw new Error("not ok");
        const data = await res.json();
        els.apiStatus.textContent = `backend online · ${data.classes.length} classes carregadas`;
        els.apiStatus.setAttribute("data-state", "online");
        els.statClasses.textContent = data.classes.length;
    } catch {
        if (retry) {
            setTimeout(() => checkApi(false), 5000);
        } else {
            els.apiStatus.textContent = "backend offline — inicie o servidor Python";
            els.apiStatus.setAttribute("data-state", "offline");
        }
    }
}

// ── Carregamento de arquivo ───────────────────────────────────────────────────
function loadFile(file) {
    if (!file.type.startsWith("image/")) {
        setStatus("Arquivo não é uma imagem", "error");
        return;
    }
    if (file.size > 10 * 1024 * 1024) {
        setStatus("Imagem acima de 10MB", "error");
        return;
    }

    // Revoga URL anterior para evitar memory leak
    if (state.currentObjURL) {
        URL.revokeObjectURL(state.currentObjURL);
        state.currentObjURL = null;
    }

    state.currentFile = file;
    const url = URL.createObjectURL(file);
    state.currentObjURL = url;
    els.previewImg.src = url;
    els.dropzone.classList.add("has-image");
    els.analyzeBtn.disabled = false;
    els.clearBtn.disabled = false;
    setStatus(`${file.name} · ${formatSize(file.size)}`, "idle");
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function reset() {
    if (state.currentObjURL) {
        URL.revokeObjectURL(state.currentObjURL);
        state.currentObjURL = null;
    }
    state.currentFile   = null;
    state.currentResult = null;
    els.previewImg.src  = "";
    els.dropzone.classList.remove("has-image");
    els.analyzeBtn.disabled = true;
    els.clearBtn.disabled   = true;
    els.fileInput.value     = "";
    els.resultEmpty.hidden  = false;
    els.annotatedImg.hidden = true;
    els.annotatedImg.removeAttribute("src");
    els.resultSummary.hidden = true;
    els.downloadBtn.hidden  = true;
    setStatus("", "idle", true);
}

// ── Análise ───────────────────────────────────────────────────────────────────
async function analyze() {
    if (!state.currentFile || state.analyzing) return;
    state.analyzing = true;
    els.analyzeBtn.classList.add("is-loading");
    els.analyzeBtn.disabled = true;
    setStatus("Analisando…", "idle");

    const form = new FormData();
    form.append("file", state.currentFile);
    const conf = Number(els.confRange.value) / 100;

    try {
        const res = await fetch(`${API_BASE}/api/analyze?confidence=${conf}`, {
            method: "POST",
            body: form,
        });
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(txt || `HTTP ${res.status}`);
        }
        const data = await res.json();
        state.currentResult  = data;
        state.sessionCount  += 1;
        els.statCount.textContent = state.sessionCount;
        els.statTime.textContent  = `${data.processing_time_ms.toFixed(0)} ms`;
        renderResult(data);
        pushHistory(data);
        setStatus(`Análise concluída · ${data.detections.length} detecções`, "success");
        // Atualiza status do backend após análise bem-sucedida
        checkApi(false);
    } catch (err) {
        setStatus(`Erro: ${err.message}`, "error");
    } finally {
        els.analyzeBtn.classList.remove("is-loading");
        els.analyzeBtn.disabled = false;
        state.analyzing = false;
    }
}

// ── Renderização do resultado ─────────────────────────────────────────────────
function showAnnotated(src) {
    els.resultEmpty.hidden  = true;
    els.annotatedImg.hidden = false;
    els.annotatedImg.src    = src;
}

function renderResult(data) {
    showAnnotated(data.annotated_image);
    els.resultSummary.hidden = false;
    els.downloadBtn.hidden   = false;

    const { score, status } = data.compliance;
    els.scoreValue.textContent = score;
    els.complianceStatus.textContent = COMPLIANCE_STATUS_LABEL[status] || status;
    els.complianceStatus.setAttribute("data-status", status);
    els.summaryMeta.textContent =
        `${data.detections.length} detecções · ${data.processing_time_ms.toFixed(0)} ms`;

    renderChecklist(data.compliance);
    renderDetections(data.detections);
}

function chip(text, state) {
    const li = document.createElement("li");
    li.className = "chip";
    if (state) li.setAttribute("data-state", state);
    li.textContent = text;
    return li;
}

function renderChecklist(compliance) {
    // present = azul · absent = vermelho · unknown = cinza
    const items = compliance.items ?? {};
    els.checklist.replaceChildren(
        ...compliance.required.map((epi) =>
            chip(EPI_LABELS[epi] || epi, items[epi] ?? (compliance.detected.includes(epi) ? "present" : "unknown")))
    );
}

function renderDetections(detections) {
    const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
    els.detectionList.replaceChildren(
        ...sorted.map((d) => chip(`${d.label} ${Math.round(d.confidence * 100)}%`, d.state ?? "present"))
    );
}

// ── Download ──────────────────────────────────────────────────────────────────
function downloadAnnotated() {
    if (!state.currentResult) return;
    const a   = document.createElement("a");
    a.href    = state.currentResult.annotated_image;
    a.download = `sentinela-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
    a.click();
}

// ── Histórico ─────────────────────────────────────────────────────────────────
function pushHistory(data) {
    const entry = {
        id:         crypto.randomUUID(),
        timestamp:  Date.now(),
        thumb:      data.annotated_image,
        detections: data.detections.length,
        score:      data.compliance.score,
        status:     data.compliance.status,
    };
    state.history.unshift(entry);
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    saveHistory();
    renderHistory();
}

function renderHistory() {
    const frag = document.createDocumentFragment();

    if (!state.history.length) {
        const div = document.createElement("div");
        div.className   = "history-empty";
        div.textContent = "Nenhuma análise ainda — o histórico fica salvo apenas no seu navegador.";
        frag.appendChild(div);
        els.historyGrid.innerHTML = "";
        els.historyGrid.appendChild(frag);
        return;
    }

    state.history.forEach((entry) => {
        const card = document.createElement("div");
        card.className = "history-card";

        const img = document.createElement("img");
        img.className   = "history-thumb";
        img.src         = entry.thumb;
        img.alt         = "análise anterior";
        img.loading     = "lazy";           // lazy load dos thumbs

        const info = document.createElement("div");
        info.className = "history-info";
        info.innerHTML = `
            <strong>${new Date(entry.timestamp).toLocaleString("pt-BR")}</strong>
            <span>${entry.detections} detecções</span>
            <span class="history-score" style="${scoreBadgeStyle(entry.status)}">${entry.score} pts · ${COMPLIANCE_STATUS_LABEL[entry.status] || entry.status}</span>
        `;

        card.appendChild(img);
        card.appendChild(info);
        card.addEventListener("click", () => {
            showAnnotated(entry.thumb);
            els.resultFrame.scrollIntoView({ behavior: "smooth", block: "center" });
        });

        frag.appendChild(card);
    });

    els.historyGrid.innerHTML = "";
    els.historyGrid.appendChild(frag);
}

function scoreBadgeStyle(status) {
    const colors = {
        conforme:    ["#2563eb20", "#2563eb"],
        parcial:     ["#8a8f9820", "#6a6e74"],
        nao_conforme:["#dc262620", "#dc2626"],
        nenhum_epi:  ["#dc262620", "#dc2626"],
    };
    const [bg, fg] = colors[status] || ["#8a8f9820", "#6a6e74"];
    return `background:${bg};color:${fg};`;
}

// ── Persistência ──────────────────────────────────────────────────────────────
function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
    catch { return []; }
}

function saveHistory() {
    try {
        // Trunca thumbs muito grandes para não estourar a cota do localStorage
        const safe = state.history.map((e) => ({
            ...e,
            thumb: e.thumb && e.thumb.length > MAX_THUMB_CHARS
                ? e.thumb.slice(0, MAX_THUMB_CHARS)
                : e.thumb,
        }));
        localStorage.setItem(HISTORY_KEY, JSON.stringify(safe));
    } catch (err) {
        console.warn("Histórico: não foi possível salvar no localStorage.", err);
    }
}

// ── Status pill ───────────────────────────────────────────────────────────────
function setStatus(text, kind = "idle", hide = false) {
    if (hide || !text) { els.statusPill.hidden = true; return; }
    els.statusPill.hidden = false;
    els.statusPill.textContent = text;
    els.statusPill.setAttribute("data-kind", kind);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatSize(bytes) {
    if (bytes < 1024)           return `${bytes} B`;
    if (bytes < 1024 * 1024)    return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
