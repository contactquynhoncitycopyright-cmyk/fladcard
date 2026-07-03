const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let currentUser = null;
let currentWords = [];
let currentQuestion = null;
let currentLookup = null;
let suggestionTimer = null;

const levels = {
  english: ["A1","A2","B1","B2","C1","C2"],
  chinese: ["HSK1","HSK2","HSK3","HSK4","HSK5","HSK6"]
};

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: "include",
    headers: {"Content-Type":"application/json", ...(options.headers || {})},
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Có lỗi xảy ra");
  return data;
}

function showView(name) {
  const targetView = $(`#${name}View`);
  if (!targetView) {
    console.warn("Không tìm thấy view:", name);
    return;
  }
  $$(".view").forEach(v => v.classList.remove("active"));
  targetView.classList.add("active");
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (name === "learn") loadWords();
  if (name === "lookup") setTimeout(() => $("#lookupInput")?.focus(), 100);
  if (name === "phrases") loadPhrases();
  if (name === "admin") loadAdmin();
}

function fillLevels() {
  const language = $("#languageSelect").value;
  $("#levelSelect").innerHTML = levels[language].map(x => `<option value="${x}">${x}</option>`).join("");
  renderLanguageUI(language);
}

function renderLanguageUI(language) {
  $$(".course-card").forEach(c => c.classList.toggle("active", c.dataset.language === language));
  const isZh = language === "chinese";
  $("#catalogBadge").textContent = isZh ? "中文 • HSK" : "ENGLISH • CEFR";
  $("#catalogTitle").textContent = isZh ? "Kho Tiếng Trung" : "Kho Tiếng Anh";
  $("#catalogDescription").textContent = isZh ? "Học Hán tự, Pinyin và nghĩa tiếng Việt theo HSK1–HSK6." : "Học từ giao tiếp đến học thuật theo A1–C2.";
  const selected = $("#levelSelect").value || levels[language][0];
  $("#levelChips").innerHTML = levels[language].map(x => `<button class="level-chip ${x===selected?'active':''}" data-level="${x}">${x}</button>`).join("");
  $$(".level-chip").forEach(btn => btn.onclick = () => { $("#levelSelect").value = btn.dataset.level; renderLanguageUI(language); loadWords(); });
}

function selectLanguage(language) {
  $("#languageSelect").value = language;
  fillLevels();
  loadWords();
}

async function loadWords() {
  const language = $("#languageSelect").value;
  const level = $("#levelSelect").value;
  const search = $("#searchInput").value.trim();
  const data = await api(`/api/words?language=${encodeURIComponent(language)}&level=${encodeURIComponent(level)}&search=${encodeURIComponent(search)}`);
  currentWords = data.items;
  $("#statWords").textContent = currentWords.length + "+";
  renderLanguageUI(language);
  $("#wordGrid").innerHTML = currentWords.length ? currentWords.map(w => `
    <article class="card word-card">
      <div class="word-top">
        <div>
          <h3>${escapeHtml(w.word)}</h3>
          <div class="pron">${escapeHtml(w.pronunciation || "")}</div>
        </div>
        <span class="topic">${escapeHtml(w.level)} • ${escapeHtml(w.topic || "general")}</span>
      </div>
      <p><b>${escapeHtml(w.meaning)}</b></p>
      <p class="example">${escapeHtml(w.example || "Chưa có ví dụ")}</p>
      <button class="speak icon-only" type="button" aria-label="Phát âm ${escapeHtml(w.word)}" onclick='speak(${JSON.stringify(w.word)})'>${iconSvg("volume-2")}</button>
    </article>
  `).join("") : `<div class="card empty">Chưa có dữ liệu phù hợp.</div>`;
}

async function loadPhrases() {
  const language = $("#languageSelect").value;
  const level = $("#levelSelect").value;
  const data = await api(`/api/phrases?language=${language}&level=${level}`);
  $("#phraseList").innerHTML = data.items.length ? data.items.map(p => `
    <div class="card phrase-item">
      <div><strong>${escapeHtml(p.phrase)}</strong><br><span>${escapeHtml(p.meaning)}</span></div>
      <button class="ghost speak-with-label" type="button" onclick='speak(${JSON.stringify(p.phrase)})'>${iconSvg("volume-2")}<span>Nghe</span></button>
    </div>
  `).join("") : `<div class="card empty">Chưa có cụm nói cho cấp này.</div>`;
}

function speak(text) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = $("#languageSelect").value === "chinese" ? "zh-CN" : "en-US";
  speechSynthesis.speak(u);
}

async function refreshUser() {
  const data = await api("/api/auth/me");
  currentUser = data.user;
  const logged = !!currentUser;
  $("#authBtn").classList.toggle("hidden", logged);
  $("#logoutBtn").classList.toggle("hidden", !logged);
  $("#userBadge").classList.toggle("hidden", !logged);
  $$(".admin-only").forEach(x => x.classList.toggle("hidden", currentUser?.role !== "admin"));
  if (logged) $("#userBadge").textContent = `${currentUser.name} • ${currentUser.xp} XP`;
}

function openAuth(mode="login") {
  $("#authModal").classList.remove("hidden");
  switchAuth(mode);
}
function switchAuth(mode) {
  $("#loginForm").classList.toggle("hidden", mode !== "login");
  $("#registerForm").classList.toggle("hidden", mode !== "register");
  $("#loginTab").classList.toggle("active", mode === "login");
  $("#registerTab").classList.toggle("active", mode === "register");
  $("#authMessage").textContent = "";
}

async function submitAuth(form, endpoint) {
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    await api(endpoint, {method:"POST", body:JSON.stringify(body)});
    $("#authMessage").textContent = "Thành công!";
    await refreshUser();
    setTimeout(() => $("#authModal").classList.add("hidden"), 500);
  } catch (e) {
    $("#authMessage").textContent = e.message;
  }
}

function newGame() {
  if (currentWords.length < 2) {
    $("#gameMessage").textContent = "Hãy chọn cấp có ít nhất 2 từ ở mục Học từ.";
    return;
  }
  const answer = currentWords[Math.floor(Math.random()*currentWords.length)];
  const shuffled = [...currentWords].sort(() => Math.random()-.5);
  const opts = [answer, ...shuffled.filter(x=>x.id!==answer.id).slice(0,3)].sort(() => Math.random()-.5);
  currentQuestion = answer;
  $("#gameWord").textContent = answer.word;
  $("#gameOptions").innerHTML = opts.map(o => `<button data-id="${o.id}">${escapeHtml(o.meaning)}</button>`).join("");
  $("#gameMessage").textContent = "";
  $$("#gameOptions button").forEach(btn => btn.onclick = () => answerGame(Number(btn.dataset.id)));
}

async function answerGame(id) {
  if (!currentQuestion) return;
  if (id === currentQuestion.id) {
    $("#gameMessage").textContent = "Chính xác! +10 XP";
    if (currentUser) {
      await api("/api/progress/xp", {method:"POST", body:JSON.stringify({amount:10})});
      await refreshUser();
    }
  } else {
    $("#gameMessage").textContent = `Chưa đúng. Đáp án: ${currentQuestion.meaning}`;
  }
}

async function loadAdmin() {
  if (currentUser?.role !== "admin") return;
  const [stats, users] = await Promise.all([api("/api/admin/stats"), api("/api/admin/users")]);
  $("#adminUsers").textContent = stats.users;
  $("#adminWords").textContent = stats.words;
  $("#adminPhrases").textContent = stats.phrases;
  $("#userTable").innerHTML = users.items.map(u => `
    <div class="user-row">
      <div><b>${escapeHtml(u.name)}</b><br><small>${escapeHtml(u.email)}</small></div>
      <div><b>${u.role}</b><br><small>${u.xp} XP</small></div>
    </div>
  `).join("");
}


function firstDefinition(result) {
  for (const meaning of (result.meanings || [])) {
    for (const item of (meaning.definitions || [])) {
      if (item.definition) return item;
    }
  }
  return null;
}

async function lookupWord(wordOverride) {
  const word = (wordOverride || $("#lookupInput").value).trim();
  if (!word) return;
  $("#lookupInput").value = word;
  $("#suggestionBox").classList.add("hidden");
  $("#lookupStatus").textContent = "Đang tìm từ trên Internet và trong dữ liệu nội bộ...";
  $("#lookupResult").innerHTML = '<div class="empty-state">Đang tải kết quả...</div>';
  try {
    const [result, related] = await Promise.all([
      api(`/api/dictionary?word=${encodeURIComponent(word)}`),
      api(`/api/related?word=${encodeURIComponent(word)}`).catch(() => ({similar:[],synonyms:[],antonyms:[]}))
    ]);
    result.synonyms = [...new Set([...(result.synonyms || []), ...(related.synonyms || []), ...(related.similar || []).slice(0,8)])].slice(0,20);
    result.antonyms = [...new Set([...(result.antonyms || []), ...(related.antonyms || [])])].slice(0,20);
    currentLookup = result;
    renderLookup(result);
    $("#lookupStatus").textContent = result.source === "local" ? "Đang dùng dữ liệu nội bộ." : "Đã lấy dữ liệu trực tuyến thành công.";
  } catch (e) {
    currentLookup = null;
    $("#lookupStatus").textContent = e.message;
    $("#lookupResult").innerHTML = `<div class="empty-state">${escapeHtml(e.message)}<br>Web vẫn có thể tìm trong kho từ vựng nội bộ.</div>`;
  }
}

function renderLookup(result) {
  const first = firstDefinition(result);
  const vietnamese = result.translation || result.local_items?.[0]?.meaning || "";
  const meaningHtml = (result.meanings || []).map(m => `
    <div class="dictionary-block">
      <h4>${escapeHtml(m.part_of_speech || "Nghĩa")}</h4>
      ${(m.definitions || []).map((d,i) => `
        <div class="definition-item"><b>${i+1}.</b> ${escapeHtml(d.definition)}${d.example ? `<br><small>Ví dụ: ${escapeHtml(d.example)}</small>` : ""}</div>
      `).join("")}
    </div>`).join("");
  const synonymHtml = (result.synonyms || []).length ? `<div class="dictionary-block"><h4>Từ liên quan / đồng nghĩa</h4><div class="word-tags">${result.synonyms.map(x=>`<button class="word-tag" onclick='lookupWord(${JSON.stringify(x)})'>${escapeHtml(x)}</button>`).join("")}</div></div>` : "";
  const antonymHtml = (result.antonyms || []).length ? `<div class="dictionary-block"><h4>Từ trái nghĩa</h4><div class="word-tags">${result.antonyms.map(x=>`<button class="word-tag" onclick='lookupWord(${JSON.stringify(x)})'>${escapeHtml(x)}</button>`).join("")}</div></div>` : "";
  const localHtml = (result.local_items || []).length ? `<div class="local-results">Đã tìm thấy ${result.local_items.length} kết quả liên quan trong SQLite.</div>` : "";
  $("#lookupResult").classList.remove("empty-state");
  $("#lookupResult").innerHTML = `
    <div class="lookup-head">
      <div><h3 class="lookup-word">${escapeHtml(result.word)}</h3><div class="lookup-phonetic">${escapeHtml(result.phonetic || "Chưa có phiên âm")}</div></div>
      <div class="lookup-actions">
        <button class="btn btn-soft" id="lookupSpeakBtn">🔊 Nghe</button>
        <button class="btn btn-primary" id="saveLookupBtn">Lưu vào kho học</button>
      </div>
    </div>
    ${vietnamese ? `<div class="api-translation"><b>Nghĩa tiếng Việt:</b> ${escapeHtml(vietnamese)}</div>` : ""}
    ${meaningHtml || '<div class="dictionary-block">Chưa có định nghĩa tiếng Anh, nhưng có thể dùng bản dịch hoặc dữ liệu nội bộ.</div>'}
    ${synonymHtml}${antonymHtml}${localHtml}`;
  $("#lookupSpeakBtn").onclick = () => {
    if (result.audio) { const audio = new Audio(result.audio); audio.play().catch(() => speak(result.word)); }
    else speak(result.word);
  };
  $("#saveLookupBtn").onclick = saveLookupWord;
}

async function saveLookupWord() {
  if (!currentUser) { openAuth("login"); return; }
  if (!currentLookup) return;
  const first = firstDefinition(currentLookup);
  const meaning = currentLookup.translation || currentLookup.local_items?.[0]?.meaning || first?.definition || "Chưa có nghĩa";
  try {
    const result = await api("/api/words/save", {method:"POST", body:JSON.stringify({
      language:"english", level:"A1", word:currentLookup.word,
      pronunciation:currentLookup.phonetic || "", meaning,
      example:first?.example || "", topic:"tra từ API"
    })});
    $("#lookupStatus").textContent = result.already_exists ? "Từ này đã có trong kho học." : "Đã lưu từ vào SQLite. Có thể dùng trong trò chơi.";
    await loadWords();
  } catch(e) { $("#lookupStatus").textContent = e.message; }
}

async function loadSuggestions() {
  const q = $("#lookupInput").value.trim();
  if (q.length < 2) { $("#suggestionBox").classList.add("hidden"); return; }
  try {
    const data = await api(`/api/suggestions?q=${encodeURIComponent(q)}`);
    if (!data.items.length) { $("#suggestionBox").classList.add("hidden"); return; }
    $("#suggestionBox").innerHTML = data.items.map(x => `<button class="suggestion-item" data-word="${escapeHtml(x.word)}">${escapeHtml(x.word)}</button>`).join("");
    $("#suggestionBox").classList.remove("hidden");
    $$(".suggestion-item").forEach(btn => btn.onclick = () => lookupWord(btn.dataset.word));
  } catch (_) { $("#suggestionBox").classList.add("hidden"); }
}

async function translateText() {
  const text = $("#translateInput").value.trim();
  if (!text) return;
  $("#translateResult").textContent = "Đang dịch...";
  try {
    const from = $("#translateFrom").value;
    const to = $("#translateTo").value;
    const data = await api(`/api/translate?text=${encodeURIComponent(text)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    $("#translateResult").innerHTML = `<b>Bản dịch:</b><br>${escapeHtml(data.translated)}<br><small>Nguồn: ${escapeHtml(data.source || "API")}</small>`;
  } catch(e) { $("#translateResult").textContent = e.message; }
}

function escapeHtml(s="") {
  return String(s).replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}

$$(".nav-btn").forEach(b => b.onclick = () => showView(b.dataset.view));
$$("[data-go]").forEach(b => b.onclick = () => showView(b.dataset.go));
if ($("#authBtn")) $("#authBtn").onclick = () => openAuth("login");
if ($("#openRegister")) $("#openRegister").onclick = () => openAuth("register");
if ($("#closeModal")) $("#closeModal").onclick = () => $("#authModal")?.classList.add("hidden");
if ($("#loginTab")) $("#loginTab").onclick = () => switchAuth("login");
if ($("#registerTab")) $("#registerTab").onclick = () => switchAuth("register");
if ($("#loginForm")) $("#loginForm").onsubmit = e => { e.preventDefault(); submitAuth(e.currentTarget, "/api/auth/login"); };
if ($("#registerForm")) $("#registerForm").onsubmit = e => { e.preventDefault(); submitAuth(e.currentTarget, "/api/auth/register"); };
if ($("#logoutBtn")) $("#logoutBtn").onclick = async () => { await api("/api/auth/logout",{method:"POST"}); currentUser=null; await refreshUser(); showView("home"); };
if ($("#languageSelect")) $("#languageSelect").onchange = () => { fillLevels(); loadWords(); };
$$(".course-card").forEach(card => card.onclick = () => selectLanguage(card.dataset.language));
if ($("#levelSelect")) $("#levelSelect").onchange = () => { renderLanguageUI($("#languageSelect").value); loadWords(); };
if ($("#searchBtn")) $("#searchBtn").onclick = loadWords;
if ($("#searchInput")) $("#searchInput").onkeydown = e => { if (e.key === "Enter") loadWords(); };
if ($("#startGameBtn")) $("#startGameBtn").onclick = newGame;
if ($("#lookupBtn")) $("#lookupBtn").onclick = () => lookupWord();
if ($("#lookupInput")) $("#lookupInput").onkeydown = e => { if (e.key === "Enter") lookupWord(); };
if ($("#lookupInput")) $("#lookupInput").oninput = () => { clearTimeout(suggestionTimer); suggestionTimer = setTimeout(loadSuggestions, 300); };
if ($("#translateBtn")) $("#translateBtn").onclick = translateText;
if ($("#wordForm")) $("#wordForm").onsubmit = async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    await api("/api/admin/words",{method:"POST",body:JSON.stringify(body)});
    $("#adminMessage").textContent = "Đã thêm từ mới.";
    form.reset();
    loadAdmin();
  } catch(err) { $("#adminMessage").textContent = err.message; }
};

if ($("#languageSelect") && $("#levelSelect")) fillLevels();
refreshUser()
  .then(() => {
    if ($("#languageSelect") && $("#levelSelect") && $("#wordGrid")) return loadWords();
  })
  .catch(err => console.error("Lỗi khởi tạo:", err));


async function downloadAdminFile(url, filename) {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Không thể tải file");
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    $("#csvImportMessage").textContent = err.message;
  }
}

if ($("#downloadTemplateBtn")) $("#downloadTemplateBtn").onclick = () => downloadAdminFile("/api/admin/words/template.csv", "lingoplay-vocabulary-template.csv");
if ($("#exportWordsBtn")) $("#exportWordsBtn").onclick = () => downloadAdminFile("/api/admin/words/export.csv", "lingoplay-vocabulary-export.csv");
if ($("#csvImportForm")) $("#csvImportForm").onsubmit = async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const file = $("#csvFile").files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("update_existing", $("#updateExisting").checked ? "true" : "false");
  $("#csvImportMessage").textContent = "Đang nhập dữ liệu...";
  $("#csvImportErrors").innerHTML = "";
  try {
    const res = await fetch("/api/admin/words/import", { method: "POST", body: fd, credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Nhập CSV thất bại");
    $("#csvImportMessage").textContent = `Hoàn tất: thêm ${data.added}, cập nhật ${data.updated}, bỏ qua ${data.skipped}. Tổng kho: ${data.total} từ.`;
    if (data.errors?.length) {
      $("#csvImportErrors").innerHTML = `<b>Một số dòng lỗi:</b>${data.errors.map(x => `<div>Dòng ${x.line}: ${escapeHtml(x.error)}</div>`).join("")}`;
    }
    form.reset();
    await loadAdmin();
    await loadWords();
  } catch (err) {
    $("#csvImportMessage").textContent = err.message;
  }
};



// Giao diện mới: icon nội bộ, theme, menu mobile và tìm kiếm nhanh.
const LOCAL_ICONS = {
  "menu": '<path d="M4 6h16M4 12h16M4 18h16"/>',
  "messages-square": '<path d="M7 8h10M7 12h6"/><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
  "search": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
  "moon": '<path d="M20 15.5A8 8 0 1 1 8.5 4 6.5 6.5 0 0 0 20 15.5z"/>',
  "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>',
  "house": '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
  "book-open": '<path d="M2 5.5A3.5 3.5 0 0 1 5.5 2H11v18H5.5A3.5 3.5 0 0 0 2 23z"/><path d="M22 5.5A3.5 3.5 0 0 0 18.5 2H13v18h5.5A3.5 3.5 0 0 1 22 23z"/>',
  "gamepad-2": '<path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M7 5h10a5 5 0 0 1 4.8 6.4l-1.2 4A3 3 0 0 1 17.7 18l-2.2-2H8.5l-2.2 2a3 3 0 0 1-4.9-2.6l-1.2-4A5 5 0 0 1 5 5z"/>',
  "languages": '<path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1"/><path d="m14 20 4-9 4 9M16 16h4"/>',
  "shield-cog": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="12" r="2"/><path d="M12 8v2M12 14v2M8 12h2M14 12h2"/>',
  "rocket": '<path d="M4.5 16.5c-1.5 1.3-2 4-2 4s2.7-.5 4-2M9 15l-3-3a22 22 0 0 1 10-9l5-1-1 5a22 22 0 0 1-9 10z"/><circle cx="15" cy="8" r="1.5"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "play": '<path d="m6 4 14 8-14 8z"/>',
  "heart": '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
  "brain": '<path d="M9.5 4A3.5 3.5 0 0 0 6 7.5v.2A3.5 3.5 0 0 0 4 14a3.5 3.5 0 0 0 3.5 3.5H9V4zM14.5 4A3.5 3.5 0 0 1 18 7.5v.2A3.5 3.5 0 0 1 20 14a3.5 3.5 0 0 1-3.5 3.5H15V4z"/><path d="M9 8H7M15 8h2M9 13H6M15 13h3M9 17v3M15 17v3"/>',
  "volume-2": '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12"/>',
  "plus": '<path d="M12 5v14M5 12h14"/>',
  "upload": '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v5h16v-5"/>',
  "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'
};

function iconSvg(name, className = "local-icon") {
  const body = LOCAL_ICONS[name] || LOCAL_ICONS["plus"];
  return `<svg class="${className}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function refreshIcons(root = document) {
  root.querySelectorAll("[data-lucide]").forEach(node => {
    const name = node.getAttribute("data-lucide");
    const wrapper = document.createElement("span");
    wrapper.innerHTML = iconSvg(name);
    const svg = wrapper.firstElementChild;
    node.replaceWith(svg);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  refreshIcons();

  const sidebar = document.getElementById("sidebar");
  const mobileMenuBtn = document.getElementById("mobileMenuBtn");
  if (mobileMenuBtn && sidebar) {
    mobileMenuBtn.addEventListener("click", () => sidebar.classList.toggle("open"));
    document.querySelectorAll(".nav-btn").forEach(btn => {
      btn.addEventListener("click", () => sidebar.classList.remove("open"));
    });
  }

  const themeToggle = document.getElementById("themeToggle");
  const savedTheme = localStorage.getItem("lingoplay-theme");
  if (savedTheme === "dark") document.body.classList.add("dark");

  function updateThemeIcon() {
    if (!themeToggle) return;
    themeToggle.innerHTML = document.body.classList.contains("dark")
      ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
    refreshIcons();
  }
  updateThemeIcon();

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      document.body.classList.toggle("dark");
      localStorage.setItem("lingoplay-theme", document.body.classList.contains("dark") ? "dark" : "light");
      updateThemeIcon();
    });
  }

  document.querySelectorAll("[data-quick-language]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-quick-language]").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      selectLanguage(btn.dataset.quickLanguage);
      showView("learn");
    });
  });

  const globalSearchInput = document.getElementById("globalSearchInput");
  const globalSearchBtn = document.getElementById("globalSearchBtn");
  const runGlobalSearch = () => {
    const value = globalSearchInput?.value.trim();
    if (!value) return;
    showView("learn");
    const target = document.getElementById("searchInput");
    if (target) {
      target.value = value;
      loadWords();
    }
  };
  if (globalSearchBtn) globalSearchBtn.addEventListener("click", runGlobalSearch);
  if (globalSearchInput) globalSearchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") runGlobalSearch();
  });
});


// ===== FINAL INTERACTION FIX =====
document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav) {
    event.preventDefault();
    showView(nav.dataset.view);
    document.getElementById("sidebar")?.classList.remove("open");
    return;
  }

  const go = event.target.closest("[data-go]");
  if (go) {
    event.preventDefault();
    showView(go.dataset.go);
    return;
  }

  const languageButton = event.target.closest(".language-choice[data-language], .course-card[data-language]");
  if (languageButton) {
    event.preventDefault();
    const language = languageButton.dataset.language;
    if (document.getElementById("languageSelect")) {
      selectLanguage(language);
    }
    showView("learn");
    return;
  }

});

// Các nút cấp độ ở trang chủ cũng điều hướng đúng tới kho học.
document.querySelectorAll(".static-levels").forEach(group => {
  group.querySelectorAll("button").forEach(button => {
    button.addEventListener("click", () => {
      const isChinese = group.classList.contains("chinese");
      const language = isChinese ? "chinese" : "english";
      const raw = button.textContent.trim().replace(/\s+/g, "");
      const level = isChinese ? raw : raw;
      if (document.getElementById("languageSelect")) {
        document.getElementById("languageSelect").value = language;
        fillLevels();
        if (levels[language].includes(level)) {
          document.getElementById("levelSelect").value = level;
          renderLanguageUI(language);
          loadWords();
        }
      }
      group.querySelectorAll("button").forEach(x => x.classList.remove("active"));
      button.classList.add("active");
      showView("learn");
    });
  });
});


// ===== QUICK LOOKUP REAL INTERACTION =====
async function runQuickLookup() {
  const input = document.getElementById("quickLookupInput");
  const result = document.getElementById("quickLookupResult");
  const word = input?.value.trim();
  if (!word || !result) return;

  result.classList.add("loading");
  result.innerHTML = "Đang tra từ...";

  try {
    const data = await api(`/api/dictionary?word=${encodeURIComponent(word)}`);
    const item = data?.result || data;
    const displayWord = item?.word || word;
    const pronunciation = item?.phonetic || item?.pronunciation || item?.local_items?.[0]?.pronunciation || "";
    const first = firstDefinition(item);
    const meaning = item?.translation || item?.local_items?.[0]?.meaning || first?.definition || "Chưa có nghĩa tiếng Việt.";

    result.innerHTML = `
      <b>${escapeHtml(displayWord)}</b>
      ${pronunciation ? `<small>${escapeHtml(pronunciation)}</small>` : ""}
      <p><strong>Nghĩa tiếng Việt:</strong> ${escapeHtml(meaning)}</p>
    `;
  } catch (error) {
    result.innerHTML = `<p>Không tra được từ này. Hãy thử lại.</p>`;
  } finally {
    result.classList.remove("loading");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const quickInput = document.getElementById("quickLookupInput");
  const quickBtn = document.getElementById("quickLookupBtn");

  quickBtn?.addEventListener("click", runQuickLookup);
  quickInput?.addEventListener("keydown", e => {
    if (e.key === "Enter") runQuickLookup();
  });
});