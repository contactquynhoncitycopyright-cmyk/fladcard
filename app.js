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
  $("#levelSelect").innerHTML = levels[language].map(x => `<option>${x}</option>`).join("");
}

async function loadWords() {
  const language = $("#languageSelect").value;
  const level = $("#levelSelect").value;
  const search = $("#searchInput").value.trim();
  const data = await api(`/api/words?language=${encodeURIComponent(language)}&level=${encodeURIComponent(level)}&search=${encodeURIComponent(search)}`);
  currentWords = data.items;
  $("#statWords").textContent = currentWords.length;
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
\n\nfunction firstDefinition(result) {\n  for (const meaning of (result.meanings || [])) {\n    for (const item of (meaning.definitions || [])) {\n      if (item.definition) return item;\n    }\n  }\n  return null;\n}\n\nasync function lookupWord(wordOverride) {\n  const word = (wordOverride || $("#lookupInput").value).trim();\n  if (!word) return;\n  $("#lookupInput").value = word;\n  $("#suggestionBox").classList.add("hidden");\n  $("#lookupStatus").textContent = "Đang tìm từ trên Internet và trong dữ liệu nội bộ...";\n  $("#lookupResult").innerHTML = '<div class="empty-state">Đang tải kết quả...</div>';\n  try {\n    const [result, related] = await Promise.all([\n      api(`/api/dictionary?word=${encodeURIComponent(word)}`),\n      api(`/api/related?word=${encodeURIComponent(word)}`).catch(() => ({similar:[],synonyms:[],antonyms:[]}))\n    ]);\n    result.synonyms = [...new Set([...(result.synonyms || []), ...(related.synonyms || []), ...(related.similar || []).slice(0,8)])].slice(0,20);\n    result.antonyms = [...new Set([...(result.antonyms || []), ...(related.antonyms || [])])].slice(0,20);\n    currentLookup = result;\n    renderLookup(result);\n    $("#lookupStatus").textContent = result.source === "local" ? "Đang dùng dữ liệu nội bộ." : "Đã lấy dữ liệu trực tuyến thành công.";\n  } catch (e) {\n    currentLookup = null;\n    $("#lookupStatus").textContent = e.message;\n    $("#lookupResult").innerHTML = `<div class="empty-state">${escapeHtml(e.message)}<br>Web vẫn có thể tìm trong kho từ vựng nội bộ.</div>`;\n  }\n}\n\nfunction renderLookup(result) {\n  const first = firstDefinition(result);\n  const vietnamese = result.translation || result.local_items?.[0]?.meaning || "";\n  const meaningHtml = (result.meanings || []).map(m => `\n    <div class="dictionary-block">\n      <h4>${escapeHtml(m.part_of_speech || "Nghĩa")}</h4>\n      ${(m.definitions || []).map((d,i) => `\n        <div class="definition-item"><b>${i+1}.</b> ${escapeHtml(d.definition)}${d.example ? `<br><small>Ví dụ: ${escapeHtml(d.example)}</small>` : ""}</div>\n      `).join("")}\n    </div>`).join("");\n  const synonymHtml = (result.synonyms || []).length ? `<div class="dictionary-block"><h4>Từ liên quan / đồng nghĩa</h4><div class="word-tags">${result.synonyms.map(x=>`<button class="word-tag" onclick='lookupWord(${JSON.stringify(x)})'>${escapeHtml(x)}</button>`).join("")}</div></div>` : "";\n  const antonymHtml = (result.antonyms || []).length ? `<div class="dictionary-block"><h4>Từ trái nghĩa</h4><div class="word-tags">${result.antonyms.map(x=>`<button class="word-tag" onclick='lookupWord(${JSON.stringify(x)})'>${escapeHtml(x)}</button>`).join("")}</div></div>` : "";\n  const localHtml = (result.local_items || []).length ? `<div class="local-results">Đã tìm thấy ${result.local_items.length} kết quả liên quan trong SQLite.</div>` : "";\n  $("#lookupResult").classList.remove("empty-state");\n  $("#lookupResult").innerHTML = `\n    <div class="lookup-head">\n      <div><h3 class="lookup-word">${escapeHtml(result.word)}</h3><div class="lookup-phonetic">${escapeHtml(result.phonetic || "Chưa có phiên âm")}</div></div>\n      <div class="lookup-actions">\n        <button class="btn btn-soft" id="lookupSpeakBtn">🔊 Nghe</button>\n        <button class="btn btn-primary" id="saveLookupBtn">Lưu vào kho học</button>\n      </div>\n    </div>\n    ${vietnamese ? `<div class="api-translation"><b>Nghĩa tiếng Việt:</b> ${escapeHtml(vietnamese)}</div>` : ""}\n    ${meaningHtml || '<div class="dictionary-block">Chưa có định nghĩa tiếng Anh, nhưng có thể dùng bản dịch hoặc dữ liệu nội bộ.</div>'}\n    ${synonymHtml}${antonymHtml}${localHtml}`;\n  $("#lookupSpeakBtn").onclick = () => {\n    if (result.audio) { const audio = new Audio(result.audio); audio.play().catch(() => speak(result.word)); }\n    else speak(result.word);\n  };\n  $("#saveLookupBtn").onclick = saveLookupWord;\n}\n\nasync function saveLookupWord() {\n  if (!currentUser) { openAuth("login"); return; }\n  if (!currentLookup) return;\n  const first = firstDefinition(currentLookup);\n  const meaning = currentLookup.translation || currentLookup.local_items?.[0]?.meaning || first?.definition || "Chưa có nghĩa";\n  try {\n    const result = await api("/api/words/save", {method:"POST", body:JSON.stringify({\n      language:"english", level:"A1", word:currentLookup.word,\n      pronunciation:currentLookup.phonetic || "", meaning,\n      example:first?.example || "", topic:"tra từ API"\n    })});\n    $("#lookupStatus").textContent = result.already_exists ? "Từ này đã có trong kho học." : "Đã lưu từ vào SQLite. Có thể dùng trong trò chơi.";\n    await loadWords();\n  } catch(e) { $("#lookupStatus").textContent = e.message; }\n}\n\nasync function loadSuggestions() {\n  const q = $("#lookupInput").value.trim();\n  if (q.length < 2) { $("#suggestionBox").classList.add("hidden"); return; }\n  try {\n    const data = await api(`/api/suggestions?q=${encodeURIComponent(q)}`);\n    if (!data.items.length) { $("#suggestionBox").classList.add("hidden"); return; }\n    $("#suggestionBox").innerHTML = data.items.map(x => `<button class="suggestion-item" data-word="${escapeHtml(x.word)}">${escapeHtml(x.word)}</button>`).join("");\n    $("#suggestionBox").classList.remove("hidden");\n    $$(".suggestion-item").forEach(btn => btn.onclick = () => lookupWord(btn.dataset.word));\n  } catch (_) { $("#suggestionBox").classList.add("hidden"); }\n}\n\nasync function translateText() {\n  const text = $("#translateInput").value.trim();\n  if (!text) return;\n  $("#translateResult").textContent = "Đang dịch...";\n  try {\n    const from = $("#translateFrom").value;\n    const to = $("#translateTo").value;\n    const data = await api(`/api/translate?text=${encodeURIComponent(text)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);\n    $("#translateResult").innerHTML = `<b>Bản dịch:</b><br>${escapeHtml(data.translated)}<br><small>Nguồn: ${escapeHtml(data.source || "API")}</small>`;\n  } catch(e) { $("#translateResult").textContent = e.message; }\n}\n
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
$("#levelSelect").onchange = loadWords;
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
