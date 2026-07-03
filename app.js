const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let currentUser = null;
let currentWords = [];
let currentQuestion = null;
let currentLookup = null;
let suggestionTimer = null;
let insightsLoadedAt = 0;
let csrfToken = "";

const levels = {
  english: ["A1","A2","B1","B2","C1","C2"],
  chinese: ["HSK1","HSK2","HSK3","HSK4","HSK5","HSK6"]
};

async function ensureCsrfToken(force = false) {
  if (csrfToken && !force) return csrfToken;
  const res = await fetch('/api/security/csrf', {credentials:'include', cache:'no-store'});
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.csrf_token) throw new Error('Không thể tạo phiên bảo mật. Hãy tải lại trang.');
  csrfToken = data.csrf_token;
  return csrfToken;
}

async function api(url, options = {}, retryCsrf = true) {
  const method = String(options.method || 'GET').toUpperCase();
  const unsafe = ['POST','PUT','PATCH','DELETE'].includes(method);
  const headers = {...(options.headers || {})};
  if (unsafe) headers['X-CSRF-Token'] = await ensureCsrfToken();
  if (!(options.body instanceof FormData) && options.body !== undefined) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  const res = await fetch(url, {credentials:'include', cache:'no-store', ...options, headers});
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && retryCsrf && String(data.error || '').includes('bảo mật')) {
    await ensureCsrfToken(true);
    return api(url, options, false);
  }
  if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra');
  if (data.csrf_token) csrfToken = data.csrf_token;
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
  if (name === "profile") renderProfile();
  if (name === "insights") loadLanguageInsights();
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

function saveLearningPreference() {
  const language = $("#languageSelect")?.value;
  const level = $("#levelSelect")?.value;
  if (language) localStorage.setItem("lingoplay_language", language);
  if (level) localStorage.setItem("lingoplay_level", level);
}

function restoreLearningPreference() {
  const languageEl = $("#languageSelect");
  const levelEl = $("#levelSelect");
  if (!languageEl || !levelEl) return;
  const savedLanguage = localStorage.getItem("lingoplay_language");
  if (savedLanguage && levels[savedLanguage]) languageEl.value = savedLanguage;
  fillLevels();
  const savedLevel = localStorage.getItem("lingoplay_level");
  if (savedLevel && levels[languageEl.value]?.includes(savedLevel)) levelEl.value = savedLevel;
  renderLanguageUI(languageEl.value);
}

function selectLanguage(language) {
  $("#languageSelect").value = language;
  fillLevels();
  saveLearningPreference();
  loadWords();
}

async function loadWords() {
  const languageEl = $("#languageSelect");
  const levelEl = $("#levelSelect");
  const grid = $("#wordGrid");
  if (!languageEl || !levelEl || !grid) return;

  const language = languageEl.value;
  const level = levelEl.value;
  const search = $("#searchInput")?.value.trim() || "";
  grid.innerHTML = `<div class="card empty word-loading">Đang tải từ vựng...</div>`;

  const fetchWords = async (requestedLevel) => {
    const url = `/api/words?language=${encodeURIComponent(language)}&level=${encodeURIComponent(requestedLevel)}&search=${encodeURIComponent(search)}`;
    const data = await api(url);
    return Array.isArray(data.items) ? data.items : [];
  };

  try {
    let items = await fetchWords(level);

    // Một số file CSV cũ dùng "HSK 1", trong khi giao diện dùng "HSK1".
    // Thử cả hai định dạng để không làm người dùng tưởng dữ liệu đã mất.
    if (!items.length && language === "chinese" && /^HSK\d$/i.test(level)) {
      items = await fetchWords(level.replace(/HSK/i, "HSK "));
    }

    currentWords = items;
    if ($("#statWords")) $("#statWords").textContent = String(currentWords.length);
    renderLanguageUI(language);

    grid.innerHTML = currentWords.length ? currentWords.map(w => `
      <article class="card word-card">
        <div class="word-top">
          <div>
            <h3>${escapeHtml(w.word)}</h3>
            <div class="pron">${escapeHtml(w.pronunciation || "")}</div>
          </div>
          <span class="topic">${escapeHtml(w.level || level)} • ${escapeHtml(w.topic || "general")}</span>
        </div>
        <p><b>${escapeHtml(w.meaning || "Chưa có nghĩa")}</b></p>
        <p class="example">${escapeHtml(w.example || "Chưa có ví dụ")}</p>
        <button class="speak" type="button" onclick='speak(${JSON.stringify(w.word || "")})' aria-label="Nghe phát âm">
          <span aria-hidden="true">🔊</span>
        </button>
      </article>
    `).join("") : `
      <div class="card empty vocabulary-empty-state">
        <strong>Không tìm thấy từ vựng ở ${escapeHtml(level)}.</strong>
        <span>Hãy xóa ô tìm kiếm, thử cấp độ khác hoặc nhập lại CSV trong trang Quản trị.</span>
      </div>`;
  } catch (error) {
    console.error("Lỗi tải từ vựng:", error);
    currentWords = [];
    grid.innerHTML = `
      <div class="card empty vocabulary-error-state">
        <strong>Không tải được kho từ vựng.</strong>
        <span>${escapeHtml(error.message || "Vui lòng thử lại.")}</span>
        <button id="retryWordsBtn" class="btn btn-primary btn-small" type="button">Tải lại</button>
      </div>`;
    $("#retryWordsBtn")?.addEventListener("click", loadWords, { once: true });
  }
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
  const value = String(text || "").trim();
  if (!value) return;

  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    alert("Trình duyệt này chưa hỗ trợ đọc từ. Hãy thử Chrome hoặc Edge phiên bản mới.");
    return;
  }

  // Tự nhận biết chữ Trung để các nút ở trang chủ vẫn đọc đúng,
  // không phụ thuộc hoàn toàn vào ô chọn ngôn ngữ.
  const hasChinese = /[\u3400-\u9FFF]/.test(value);
  const languageSelect = document.getElementById("languageSelect");
  const isChinese = hasChinese || languageSelect?.value === "chinese";
  const lang = isChinese ? "zh-CN" : "en-US";

  const synth = window.speechSynthesis;
  synth.cancel();
  synth.resume();

  const play = () => {
    const utterance = new SpeechSynthesisUtterance(value);
    utterance.lang = lang;
    utterance.rate = 0.9;
    utterance.pitch = 1;
    utterance.volume = 1;

    const voices = synth.getVoices();
    const preferredVoice = voices.find(v =>
      v.lang && v.lang.toLowerCase().startsWith(isChinese ? "zh" : "en")
    );
    if (preferredVoice) utterance.voice = preferredVoice;

    utterance.onerror = event => {
      console.error("Không thể phát âm:", event.error);
      if (event.error !== "interrupted" && event.error !== "canceled") {
        alert("Không phát được âm thanh. Hãy tăng âm lượng, tắt chế độ im lặng và thử lại bằng Chrome/Edge.");
      }
    };

    synth.speak(utterance);
  };

  // Một số điện thoại tải danh sách giọng đọc chậm.
  if (synth.getVoices().length) {
    play();
  } else {
    let played = false;
    const playOnce = () => {
      if (played) return;
      played = true;
      play();
    };
    synth.addEventListener("voiceschanged", playOnce, { once: true });
    setTimeout(playOnce, 500);
  }
}

// ===== ÂM THANH GIAO DIỆN & TRÒ CHƠI =====
let soundEnabled = localStorage.getItem("lingoplay-sound") !== "off";
let audioContext = null;
let guestWelcomePlayed = false;
let introMusicPlayed = false;
let introMusicTimer = null;

function getAudioContext() {
  if (!audioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    audioContext = new AudioCtx();
  }
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return audioContext;
}

function playTone(frequency = 440, duration = 0.12, type = "sine", volume = 0.05, delay = 0) {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.03);
}

function playUiSound(kind = "tap") {
  if (!soundEnabled) return;
  if (kind === "welcome") {
    playTone(523.25, 0.13, "sine", 0.045, 0);
    playTone(659.25, 0.13, "sine", 0.045, 0.12);
    playTone(783.99, 0.22, "sine", 0.05, 0.24);
  } else if (kind === "correct") {
    playTone(523.25, 0.11, "triangle", 0.055, 0);
    playTone(659.25, 0.11, "triangle", 0.055, 0.1);
    playTone(880, 0.24, "triangle", 0.06, 0.2);
  } else if (kind === "wrong") {
    playTone(220, 0.16, "sawtooth", 0.035, 0);
    playTone(174.61, 0.22, "sawtooth", 0.03, 0.13);
  } else if (kind === "start") {
    playTone(440, 0.08, "square", 0.025, 0);
    playTone(554.37, 0.11, "square", 0.025, 0.08);
  } else {
    playTone(620, 0.06, "sine", 0.025, 0);
  }
}


function playIntroMusicOnce() {
  if (introMusicPlayed || !soundEnabled) return;
  introMusicPlayed = true;

  const ctx = getAudioContext();
  if (!ctx) return;

  // Giai điệu mở đầu nguyên bản theo phong cách nhẹ nhàng/lo-fi.
  // Nhạc chỉ bắt đầu sau lần chạm đầu tiên vì trình duyệt di động chặn autoplay.
  const master = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2400;
  master.gain.setValueAtTime(0.0001, ctx.currentTime);
  master.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.08);
  master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 9.6);
  filter.connect(master);
  master.connect(ctx.destination);

  const begin = ctx.currentTime + 0.04;

  function musicNote(frequency, when, duration, volume = 0.13, type = "sine") {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, begin + when);
    gain.gain.setValueAtTime(0.0001, begin + when);
    gain.gain.exponentialRampToValueAtTime(volume, begin + when + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, begin + when + duration);
    osc.connect(gain);
    gain.connect(filter);
    osc.start(begin + when);
    osc.stop(begin + when + duration + 0.04);
  }

  // Hợp âm: Cmaj7 → Am7 → Fmaj7 → G6.
  const chords = [
    [0.0, [261.63, 329.63, 392.00, 493.88]],
    [2.2, [220.00, 261.63, 329.63, 392.00]],
    [4.4, [174.61, 220.00, 261.63, 329.63]],
    [6.6, [196.00, 246.94, 293.66, 329.63]]
  ];
  chords.forEach(([time, notes]) => {
    notes.forEach((frequency, index) => {
      musicNote(frequency, time + index * 0.07, 2.05, 0.035, index === 0 ? "triangle" : "sine");
    });
  });

  // Giai điệu chính dễ nghe, không dùng bài nhạc có bản quyền.
  const melody = [
    [659.25,0.00,.34],[783.99,.38,.34],[880.00,.76,.62],[783.99,1.46,.30],[659.25,1.82,.36],
    [523.25,2.24,.34],[659.25,2.62,.34],[783.99,3.00,.62],[659.25,3.70,.30],[587.33,4.06,.36],
    [523.25,4.48,.34],[659.25,4.86,.34],[698.46,5.24,.62],[783.99,5.94,.30],[880.00,6.30,.36],
    [783.99,6.72,.34],[659.25,7.10,.34],[587.33,7.48,.34],[523.25,7.86,.90]
  ];
  melody.forEach(([frequency, when, duration], index) => {
    musicNote(frequency, when, duration, 0.085, index % 3 === 0 ? "triangle" : "sine");
  });

  // Nhịp nền rất nhẹ.
  for (let beat = 0; beat < 18; beat += 1) {
    musicNote(130.81, beat * 0.48, 0.10, beat % 2 === 0 ? 0.022 : 0.012, "triangle");
  }
}
function updateSoundButton() {
  const btn = document.getElementById("soundToggle");
  if (!btn) return;
  btn.setAttribute("aria-label", soundEnabled ? "Tắt âm thanh" : "Bật âm thanh");
  btn.setAttribute("title", soundEnabled ? "Tắt âm thanh" : "Bật âm thanh");
  btn.innerHTML = `<i data-lucide="${soundEnabled ? "volume-2" : "volume-x"}"></i>`;
  if (typeof refreshIcons === "function") refreshIcons();
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem("lingoplay-sound", soundEnabled ? "on" : "off");
  updateSoundButton();

  const refreshInsightsBtn = document.getElementById("refreshInsightsBtn");
  if (refreshInsightsBtn) refreshInsightsBtn.addEventListener("click", () => loadLanguageInsights(true));
  if (soundEnabled) {
    playUiSound("welcome");
    playIntroMusicOnce();
  }
}

function playGuestWelcomeOnce() {
  if (guestWelcomePlayed || currentUser || !soundEnabled) return;
  guestWelcomePlayed = true;
  playUiSound("welcome");
  playIntroMusicOnce();
}

async function refreshUser() {
  const data = await api("/api/auth/me");
  currentUser = data.user;
  const logged = !!currentUser;
  $("#authBtn").classList.toggle("hidden", logged);
  $("#logoutBtn").classList.toggle("hidden", !logged);
  $("#userBadge").classList.toggle("hidden", !logged);
  $$(".admin-only").forEach(x => x.classList.toggle("hidden", currentUser?.role !== "admin"));
  $$(".auth-only").forEach(x => x.classList.toggle("hidden", !logged));
  if (logged) {
    $("#userBadge").textContent = `${currentUser.name} • ${currentUser.xp} XP`;
    renderProfile();
    renderAccountProgress();
  }
}

function openAuth(mode="login") {
  playUiSound("tap");
  $("#authModal").classList.remove("hidden");
  switchAuth(mode);
}
function switchAuth(mode) {
  $("#loginForm").classList.toggle("hidden", mode !== "login");
  $("#registerForm").classList.toggle("hidden", mode !== "register");
  $("#forgotForm")?.classList.toggle("hidden", mode !== "forgot");
  $("#resetForm")?.classList.toggle("hidden", mode !== "reset");
  $("#loginTab").classList.toggle("active", mode === "login");
  $("#registerTab").classList.toggle("active", mode === "register");
  $(".auth-tabs")?.classList.toggle("hidden", mode === "forgot" || mode === "reset");
  $("#authMessage").textContent = "";
}

async function submitAuth(form, endpoint) {
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    await api(endpoint, {method:"POST", body:JSON.stringify(body)});
    const isRegister = endpoint.includes("register");
    $("#authMessage").textContent = isRegister ? "Đăng ký thành công! Đang mở trang cá nhân..." : "Đăng nhập thành công!";
    await refreshUser();
    setTimeout(() => {
      $("#authModal").classList.add("hidden");
      showView(isRegister ? "profile" : "home");
    }, 450);
  } catch (e) {
    $("#authMessage").textContent = e.message;
  }
}


function getXpProgress(xpValue = 0) {
  const totalXp = Math.max(0, Number(xpValue) || 0);
  const xpPerLevel = 100;
  const level = Math.floor(totalXp / xpPerLevel) + 1;
  const currentXp = totalXp % xpPerLevel;
  const percent = Math.min(100, Math.max(0, (currentXp / xpPerLevel) * 100));
  return { totalXp, xpPerLevel, level, currentXp, percent };
}

function renderAccountProgress() {
  if (!currentUser) return;
  const progress = getXpProgress(currentUser.xp);

  if (document.querySelector('#sidebarAccountLevel')) {
    document.querySelector('#sidebarAccountLevel').textContent = `Lv.${progress.level}`;
  }
  if (document.querySelector('#sidebarAccountXp')) {
    document.querySelector('#sidebarAccountXp').textContent = `${progress.currentXp} / ${progress.xpPerLevel} XP`;
  }
  if (document.querySelector('#sidebarAccountXpBar')) {
    document.querySelector('#sidebarAccountXpBar').style.width = `${progress.percent}%`;
  }
  if (document.querySelector('#profileAccountLevel')) {
    document.querySelector('#profileAccountLevel').textContent = `Lv.${progress.level}`;
  }
  if (document.querySelector('#profileXp')) {
    document.querySelector('#profileXp').textContent = `${progress.totalXp} XP`;
  }
  if (document.querySelector('#profileXpDetail')) {
    document.querySelector('#profileXpDetail').textContent = `${progress.currentXp} / ${progress.xpPerLevel} XP`;
  }
  if (document.querySelector('#profileXpBar')) {
    document.querySelector('#profileXpBar').style.width = `${progress.percent}%`;
  }
}

function profileInitials(name = "LingoPlay") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return (parts.slice(-2).map(part => part[0]).join("") || "LP").toUpperCase();
}

function renderProfile() {
  if (!currentUser) return;
  const language = $("#languageSelect")?.value || "english";
  const level = $("#levelSelect")?.value || (language === "chinese" ? "HSK1" : "A1");
  const roleText = currentUser.role === "admin" ? "Quản trị viên" : "Thành viên";
  const languageText = language === "chinese" ? "Tiếng Trung" : "Tiếng Anh";

  if ($("#profileAvatar")) $("#profileAvatar").textContent = profileInitials(currentUser.name);
  if ($("#profileName")) $("#profileName").textContent = currentUser.name || "Người dùng LingoPlay";
  if ($("#profileEmail")) $("#profileEmail").textContent = currentUser.email || "—";
  if ($("#profileRoleBadge")) $("#profileRoleBadge").textContent = roleText;
  if ($("#profileXp")) $("#profileXp").textContent = `${Number(currentUser.xp || 0)} XP`;
  if ($("#profileFullName")) $("#profileFullName").textContent = currentUser.name || "—";
  if ($("#profileEmailDetail")) $("#profileEmailDetail").textContent = currentUser.email || "—";
  if ($("#profileRole")) $("#profileRole").textContent = roleText;
  if ($("#profileLanguage")) $("#profileLanguage").textContent = languageText;
  if ($("#profileLevel")) $("#profileLevel").textContent = level;
  renderAccountProgress();
}

async function newGame() {
  playUiSound('start');
  const language = $('#languageSelect')?.value || 'english';
  const level = $('#levelSelect')?.value || (language === 'chinese' ? 'HSK1' : 'A1');
  $('#gameMessage').textContent = 'Đang tạo câu hỏi...';
  try {
    const data = await api('/api/game/start', {method:'POST', body:JSON.stringify({language, level})});
    currentQuestion = {token:data.token};
    $('#gameWord').textContent = data.word;
    $('#gameOptions').innerHTML = data.options.map(o => `<button data-id="${o.id}">${escapeHtml(o.meaning)}</button>`).join('');
    $('#gameMessage').textContent = '';
    $$('#gameOptions button').forEach(btn => btn.onclick = () => answerGame(Number(btn.dataset.id)));
  } catch (e) {
    $('#gameMessage').textContent = e.message;
  }
}

async function answerGame(id) {
  if (!currentQuestion?.token) return;
  const buttons = $$('#gameOptions button');
  buttons.forEach(b => b.disabled = true);
  try {
    const data = await api('/api/game/answer', {method:'POST', body:JSON.stringify({token:currentQuestion.token, answer_id:id})});
    if (data.correct) {
      playUiSound('correct');
      $('#gameMessage').textContent = data.earned_xp ? `Chính xác! +${data.earned_xp} XP` : 'Chính xác! Đăng nhập để nhận XP.';
      if (currentUser) await refreshUser();
    } else {
      playUiSound('wrong');
      $('#gameMessage').textContent = `Chưa đúng. Đáp án: ${data.correct_meaning}`;
    }
  } catch (e) {
    $('#gameMessage').textContent = e.message;
  } finally {
    currentQuestion = null;
  }
}

async function loadAdmin() {
  if (currentUser?.role !== "admin") return;
  const q = encodeURIComponent($("#adminUserSearch")?.value?.trim() || "");
  const role = $("#adminUserRoleFilter")?.value || "all";
  const status = $("#adminUserStatusFilter")?.value || "all";
  const [stats, users] = await Promise.all([
    api("/api/admin/stats"),
    api(`/api/admin/users?q=${q}&role=${encodeURIComponent(role)}&status=${encodeURIComponent(status)}`)
  ]);
  $("#adminUsers").textContent = stats.users;
  $("#adminWords").textContent = stats.words;
  $("#adminPhrases").textContent = stats.phrases;
  const table = $("#userTable");
  if (!users.items.length) {
    table.innerHTML = '<div class="card empty">Không tìm thấy người dùng phù hợp.</div>';
    return;
  }
  table.innerHTML = users.items.map(u => `
    <article class="admin-user-card" data-user-id="${u.id}">
      <div class="admin-user-main">
        <div class="admin-user-avatar">${escapeHtml((u.name || "U").slice(0,1).toUpperCase())}</div>
        <div class="admin-user-info">
          <b>${escapeHtml(u.name)}</b>
          <small>${escapeHtml(u.email)}</small>
          <span>${u.xp} XP • Tạo ${new Date(u.created_at).toLocaleDateString("vi-VN")}</span>
        </div>
      </div>
      <div class="admin-user-state">
        <span class="status-pill ${u.is_active ? "active" : "locked"}">${u.is_active ? "Đang hoạt động" : "Đã khóa"}</span>
        <select class="admin-role-select" ${u.id === currentUser.id ? "disabled" : ""}>
          <option value="user" ${u.role === "user" ? "selected" : ""}>Thành viên</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>Quản trị viên</option>
        </select>
      </div>
      <div class="admin-user-actions">
        <button class="btn btn-secondary admin-toggle-user" type="button" ${u.id === currentUser.id ? "disabled" : ""}>${u.is_active ? "Khóa tài khoản" : "Mở khóa"}</button>
        <button class="btn btn-secondary admin-reset-password" type="button">Đặt lại mật khẩu</button>
      </div>
    </article>
  `).join("");

  $$(".admin-role-select", table).forEach(select => select.onchange = async () => {
    const card = select.closest(".admin-user-card");
    try {
      await api(`/api/admin/users/${card.dataset.userId}`, {method:"PATCH", body:JSON.stringify({role:select.value})});
      showAdminUserMessage("Đã cập nhật quyền người dùng.");
      await loadAdmin();
    } catch (e) { showAdminUserMessage(e.message, true); await loadAdmin(); }
  });
  $$(".admin-toggle-user", table).forEach(button => button.onclick = async () => {
    const card = button.closest(".admin-user-card");
    const isLocking = button.textContent.includes("Khóa");
    if (!confirm(isLocking ? "Khóa tài khoản này và đăng xuất các phiên hiện tại?" : "Mở khóa tài khoản này?")) return;
    try {
      await api(`/api/admin/users/${card.dataset.userId}`, {method:"PATCH", body:JSON.stringify({is_active:!isLocking})});
      showAdminUserMessage(isLocking ? "Đã khóa tài khoản." : "Đã mở khóa tài khoản.");
      await loadAdmin();
    } catch (e) { showAdminUserMessage(e.message, true); }
  });
  $$(".admin-reset-password", table).forEach(button => button.onclick = async () => {
    const card = button.closest(".admin-user-card");
    const password = prompt("Nhập mật khẩu tạm thời mới (ít nhất 10 ký tự, có chữ hoa, chữ thường, số và ký tự đặc biệt):");
    if (password === null) return;
    try {
      const result = await api(`/api/admin/users/${card.dataset.userId}/reset-password`, {method:"POST", body:JSON.stringify({new_password:password})});
      showAdminUserMessage(result.message || "Đã đặt lại mật khẩu.");
    } catch (e) { showAdminUserMessage(e.message, true); }
  });
}

function showAdminUserMessage(text, isError=false) {
  const box = $("#adminUserMessage");
  if (!box) return;
  box.textContent = text;
  box.classList.toggle("error", isError);
}



function formatCompactNumber(value) {
  const n = Number(value) || 0;
  return new Intl.NumberFormat("vi-VN", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function formatUpdateTime(value) {
  if (!value) return "Chưa có dữ liệu";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Chưa có dữ liệu";
  return `Cập nhật ${date.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}`;
}

function escapeAttribute(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

async function loadLanguageInsights(force = false) {
  const newsList = $("#languageNewsList");
  const rankingList = $("#languageRankingList");
  if (!newsList || !rankingList) return;

  const now = Date.now();
  if (!force && insightsLoadedAt && now - insightsLoadedAt < 15 * 60 * 1000) return;

  newsList.innerHTML = '<div class="insights-loading">Đang tải tin tức…</div>';
  rankingList.innerHTML = '<div class="insights-loading">Đang tải bảng xếp hạng…</div>';

  try {
    const [news, ranking] = await Promise.all([
      api("/api/language-news"),
      api("/api/language-ranking")
    ]);

    const newsItems = Array.isArray(news.items) ? news.items : [];
    newsList.innerHTML = newsItems.length ? newsItems.map(item => `
      <a class="language-news-card" href="${escapeAttribute(item.url)}" target="_blank" rel="noopener noreferrer">
        <span class="news-source">${escapeHtml(item.source || "Tin ngoại ngữ")}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <div><time>${item.published_at ? new Date(item.published_at).toLocaleDateString("vi-VN") : "Mới cập nhật"}</time><span>Xem tin <span aria-hidden="true">→</span></span></div>
      </a>
    `).join("") : `<div class="insights-empty">${escapeHtml(news.warning || "Chưa có tin mới. Hãy thử cập nhật lại sau.")}</div>`;

    const rankingItems = Array.isArray(ranking.items) ? ranking.items : [];
    const maxViews = Math.max(...rankingItems.map(item => Number(item.views) || 0), 1);
    rankingList.innerHTML = rankingItems.length ? rankingItems.map(item => {
      const percent = Math.max(4, Math.round(((Number(item.views) || 0) / maxViews) * 100));
      return `
        <div class="language-ranking-row">
          <span class="ranking-position">${item.rank}</span>
          <span class="ranking-flag">${escapeHtml(item.flag || "🌐")}</span>
          <div class="ranking-language"><strong>${escapeHtml(item.language)}</strong><div class="ranking-bar"><i style="width:${percent}%"></i></div></div>
          <span class="ranking-value">${formatCompactNumber(item.views)} lượt xem</span>
        </div>
      `;
    }).join("") : `<div class="insights-empty">${escapeHtml(ranking.warning || "Chưa có dữ liệu xếp hạng.")}</div>`;

    if ($("#newsUpdatedAt")) $("#newsUpdatedAt").textContent = formatUpdateTime(news.updated_at);
    if ($("#rankingUpdatedAt")) $("#rankingUpdatedAt").textContent = formatUpdateTime(ranking.updated_at);
    if ($("#rankingMetric") && ranking.metric) $("#rankingMetric").textContent = ranking.metric;
    insightsLoadedAt = Date.now();
  } catch (error) {
    const message = escapeHtml(error.message || "Không thể cập nhật dữ liệu.");
    newsList.innerHTML = `<div class="insights-empty">${message}</div>`;
    rankingList.innerHTML = `<div class="insights-empty">${message}</div>`;
  }
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
if ($("#soundToggle")) $("#soundToggle").onclick = toggleSound;
if ($("#openRegister")) $("#openRegister").onclick = () => openAuth("register");
if ($("#closeModal")) $("#closeModal").onclick = () => $("#authModal")?.classList.add("hidden");
if ($("#loginTab")) $("#loginTab").onclick = () => switchAuth("login");
if ($("#registerTab")) $("#registerTab").onclick = () => switchAuth("register");
if ($("#loginForm")) $("#loginForm").onsubmit = e => { e.preventDefault(); submitAuth(e.currentTarget, "/api/auth/login"); };
if ($("#registerForm")) $("#registerForm").onsubmit = e => { e.preventDefault(); submitAuth(e.currentTarget, "/api/auth/register"); };
if ($("#logoutBtn")) $("#logoutBtn").onclick = async () => { await api("/api/auth/logout",{method:"POST"}); currentUser=null; await refreshUser(); showView("home"); };
if ($("#userBadge")) $("#userBadge").onclick = () => showView("profile");
if ($("#profileLearnBtn")) $("#profileLearnBtn").onclick = () => showView("learn");
if ($("#profileLogoutBtn")) $("#profileLogoutBtn").onclick = async () => {
  await api("/api/auth/logout", {method:"POST"});
  currentUser = null;
  await refreshUser();
  showView("home");
};
if ($('#changePasswordForm')) $('#changePasswordForm').onsubmit = async e => {
  e.preventDefault();
  const form=e.currentTarget;
  const body=Object.fromEntries(new FormData(form).entries());
  const message=$('#securityMessage');
  try {
    const data=await api('/api/auth/change-password',{method:'POST',body:JSON.stringify(body)});
    message.textContent=data.message || 'Đổi mật khẩu thành công.';
    message.classList.remove('error'); form.reset();
  } catch(err) { message.textContent=err.message; message.classList.add('error'); }
};
if ($('#logoutAllBtn')) $('#logoutAllBtn').onclick = async () => {
  if (!confirm('Đăng xuất tài khoản khỏi tất cả thiết bị?')) return;
  try { await api('/api/auth/logout-all',{method:'POST'}); csrfToken=''; currentUser=null; await ensureCsrfToken(true); await refreshUser(); showView('home'); }
  catch(err) { $('#securityMessage').textContent=err.message; }
};
if ($("#languageSelect")) $("#languageSelect").onchange = () => { fillLevels(); saveLearningPreference(); renderProfile(); loadWords(); };
$$(".course-card").forEach(card => card.onclick = () => selectLanguage(card.dataset.language));
if ($("#levelSelect")) $("#levelSelect").onchange = () => { saveLearningPreference(); renderLanguageUI($("#languageSelect").value); renderProfile(); loadWords(); };
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

if ($("#languageSelect") && $("#levelSelect")) restoreLearningPreference();
ensureCsrfToken()
  .then(() => refreshUser())
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

if ($("#adminUserRefreshBtn")) $("#adminUserRefreshBtn").onclick = loadAdmin;
if ($("#adminUserRoleFilter")) $("#adminUserRoleFilter").onchange = loadAdmin;
if ($("#adminUserStatusFilter")) $("#adminUserStatusFilter").onchange = loadAdmin;
let adminSearchTimer;
if ($("#adminUserSearch")) $("#adminUserSearch").oninput = () => { clearTimeout(adminSearchTimer); adminSearchTimer=setTimeout(loadAdmin,350); };
if ($("#adminCreateUserForm")) $("#adminCreateUserForm").onsubmit = async e => {
  e.preventDefault();
  const form=e.currentTarget;
  const body=Object.fromEntries(new FormData(form));
  try {
    await api('/api/admin/users',{method:'POST',body:JSON.stringify(body)});
    form.reset(); showAdminUserMessage('Đã tạo tài khoản mới.'); await loadAdmin();
  } catch(err) { showAdminUserMessage(err.message,true); }
};

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
    const token = await ensureCsrfToken();
    const res = await fetch("/api/admin/words/import", { method: "POST", body: fd, credentials: "same-origin", headers:{"X-CSRF-Token":token} });
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
  "volume-x": '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m16 9 5 5M21 9l-5 5"/>',
  "newspaper": '<path d="M4 4h13v16H4z"/><path d="M8 8h5M8 12h5M8 16h3"/><path d="M17 8h3v10a2 2 0 0 1-2 2h-1"/>',
  "bar-chart-3": '<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16V5"/>',
  "refresh-cw": '<path d="M20 11a8 8 0 1 0 2 5"/><path d="M20 4v7h-7"/>',
  "plus": '<path d="M12 5v14M5 12h14"/>',
  "upload": '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v5h16v-5"/>',
  "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  "user-round": '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  "mail": '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  "award": '<circle cx="12" cy="8" r="5"/><path d="m8.5 12.5-1 8 4.5-2.5 4.5 2.5-1-8"/>'
};

function refreshIcons() {
  document.querySelectorAll("[data-lucide]").forEach(node => {
    const name = node.getAttribute("data-lucide");
    const body = LOCAL_ICONS[name] || LOCAL_ICONS["plus"];

    const svg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );

    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("local-lucide-icon");

    svg.innerHTML = body;
    node.replaceWith(svg);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  refreshIcons();
  updateSoundButton();

  const refreshInsightsBtn = document.getElementById("refreshInsightsBtn");
  if (refreshInsightsBtn) refreshInsightsBtn.addEventListener("click", () => loadLanguageInsights(true));

  const unlockGuestSound = () => {
    getAudioContext();
    playGuestWelcomeOnce();
  };
  document.addEventListener("pointerdown", unlockGuestSound, { once: true, passive: true });
  document.addEventListener("keydown", unlockGuestSound, { once: true });

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

  const quickLookup = event.target.closest(".quick-lookup, .quick-lookup-box");
  if (quickLookup) {
    event.preventDefault();
    showView("lookup");
    setTimeout(() => document.getElementById("lookupInput")?.focus(), 100);
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
    const data = await api(`/api/lookup?word=${encodeURIComponent(word)}`);
    const item = data?.word || data?.result || data;
    const displayWord = item?.word || word;
    const pronunciation = item?.pronunciation || item?.phonetic || "";
    const meaning = item?.meaning || item?.vietnamese || item?.translation || "Chưa có nghĩa tiếng Việt.";

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
if ($("#forgotPasswordBtn")) $("#forgotPasswordBtn").onclick = () => switchAuth("forgot");
if ($("#backToLoginBtn")) $("#backToLoginBtn").onclick = () => switchAuth("login");
if ($("#resetBackBtn")) $("#resetBackBtn").onclick = () => switchAuth("login");
if ($("#forgotForm")) $("#forgotForm").onsubmit = async e => {
  e.preventDefault(); const form=e.currentTarget; const body=Object.fromEntries(new FormData(form).entries());
  try { const data=await api('/api/auth/forgot-password',{method:'POST',body:JSON.stringify(body)}); $("#authMessage").textContent=data.message;
    $("#resetForm input[name=email]").value=body.email; switchAuth('reset'); $("#authMessage").textContent=data.message;
  } catch(err) { $("#authMessage").textContent=err.message; }
};
if ($("#resetForm")) $("#resetForm").onsubmit = async e => {
  e.preventDefault(); const form=e.currentTarget; const body=Object.fromEntries(new FormData(form).entries());
  try { const data=await api('/api/auth/reset-password',{method:'POST',body:JSON.stringify(body)}); $("#authMessage").textContent=data.message; form.reset(); setTimeout(()=>switchAuth('login'),900); }
  catch(err) { $("#authMessage").textContent=err.message; }
};
