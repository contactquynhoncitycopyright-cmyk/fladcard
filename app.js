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
  $$(".view").forEach(v => v.classList.remove("active"));
  $(`#${name}View`).classList.add("active");
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
      <button class="speak" onclick='speak(${JSON.stringify(w.word)})'>🔊</button>
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
      <button class="ghost" onclick='speak(${JSON.stringify(p.phrase)})'>🔊 Nghe</button>
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
$("#authBtn").onclick = () => openAuth("login");
$("#openRegister").onclick = () => openAuth("register");
$("#closeModal").onclick = () => $("#authModal").classList.add("hidden");
$("#loginTab").onclick = () => switchAuth("login");
$("#registerTab").onclick = () => switchAuth("register");
$("#loginForm").onsubmit = e => { e.preventDefault(); submitAuth(e.currentTarget, "/api/auth/login"); };
$("#registerForm").onsubmit = e => { e.preventDefault(); submitAuth(e.currentTarget, "/api/auth/register"); };
$("#logoutBtn").onclick = async () => { await api("/api/auth/logout",{method:"POST"}); currentUser=null; await refreshUser(); showView("home"); };
$("#languageSelect").onchange = () => { fillLevels(); loadWords(); };
$$(".course-card").forEach(card => card.onclick = () => selectLanguage(card.dataset.language));
$("#levelSelect").onchange = () => { renderLanguageUI($("#languageSelect").value); loadWords(); };
$("#searchBtn").onclick = loadWords;
$("#searchInput").onkeydown = e => { if (e.key === "Enter") loadWords(); };
$("#startGameBtn").onclick = newGame;
$("#lookupBtn").onclick = () => lookupWord();
$("#lookupInput").onkeydown = e => { if (e.key === "Enter") lookupWord(); };
$("#lookupInput").oninput = () => { clearTimeout(suggestionTimer); suggestionTimer = setTimeout(loadSuggestions, 300); };
$("#translateBtn").onclick = translateText;
$("#wordForm").onsubmit = async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.currentTarget).entries());
  try {
    await api("/api/admin/words",{method:"POST",body:JSON.stringify(body)});
    $("#adminMessage").textContent = "Đã thêm từ mới.";
    e.currentTarget.reset();
    loadAdmin();
  } catch(err) { $("#adminMessage").textContent = err.message; }
};

fillLevels();
refreshUser().then(loadWords);


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

$("#downloadTemplateBtn").onclick = () => downloadAdminFile("/api/admin/words/template.csv", "lingoplay-vocabulary-template.csv");
$("#exportWordsBtn").onclick = () => downloadAdminFile("/api/admin/words/export.csv", "lingoplay-vocabulary-export.csv");
$("#csvImportForm").onsubmit = async e => {
  e.preventDefault();
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
    e.currentTarget.reset();
    await loadAdmin();
    await loadWords();
  } catch (err) {
    $("#csvImportMessage").textContent = err.message;
  }
};


// Giao diện mới: icon, theme, menu mobile và tìm kiếm nhanh.
function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
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
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      document.body.classList.toggle("dark");
      localStorage.setItem("lingoplay-theme", document.body.classList.contains("dark") ? "dark" : "light");
      themeToggle.innerHTML = document.body.classList.contains("dark")
        ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
      refreshIcons();
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
