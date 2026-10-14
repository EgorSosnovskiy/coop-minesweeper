const TAB_KEY = "minesweeper-tab";
const SAVED_KEY = "minesweeper-saved";
const CACHE_KEY = "minesweeper-cache";

const view = {
  you: null,
  state: null,
  ready: false,
  entry: null,
  leaving: false,
  offset: 0,
};

const queue = [];
let socket = null;
let want = false;
let attempt = 0;
let retryTimer = null;
let leaveTimer = null;
let toastTimer = null;
let link = "offline";

const app = document.querySelector("#app");
const gate = el("section", { class: "panel gate" });
const table = el("section", { class: "panel table" });
table.hidden = true;
app.append(gate, table);

const gateError = el("p", { class: "error", role: "status" });
const nameInput = el("input", { id: "name", maxlength: "16", autocomplete: "nickname", placeholder: "Введите ваше имя" });
const codeInput = el("input", {
  id: "code",
  maxlength: "4",
  autocapitalize: "characters",
  spellcheck: "false",
  placeholder: "Введите код комнаты",
  "aria-label": "Код комнаты",
});
const resumeBox = el("div", { class: "resume" });
const resumeText = el("span", {});
const resumeBtn = el("button", { class: "primary", type: "button" }, ["Вернуться"]);
resumeBox.append(resumeText, resumeBtn);
resumeBox.hidden = true;

const sideInput = el("input", {
  id: "side",
  type: "number",
  min: "5",
  max: "30",
  value: "9",
  inputmode: "numeric",
});
const minesInput = el("input", {
  id: "mines",
  type: "number",
  min: "1",
  value: "10",
  inputmode: "numeric",
});
const rulesHint = el("p", { class: "lede" });
const createBtn = el("button", { class: "primary", type: "button" }, ["Создать комнату"]);
const joinBtn = el("button", { class: "ghost", type: "button" }, ["Войти"]);

gate.append(
  el("div", {}, [el("h1", {}, ["Сапёр"]), el("p", { class: "lede intro" }, [
    "Общее поле на всех. Левая кнопка открывает клетку, правая ставит флажок. Если двое меняют одну клетку сразу, на поле остаётся первая правка.",
  ])]),
  resumeBox,
  el("label", {}, ["Имя", nameInput]),
  el("div", { class: "split" }, [
    el("label", {}, ["Сторона", sideInput]),
    el("label", {}, ["Мины", minesInput]),
  ]),
  rulesHint,
  createBtn,
  el("div", { class: "split" }, [codeInput, joinBtn]),
  gateError,
);

const connEl = el("p", { class: "conn", role: "status" }, ["Нет соединения"]);
const codeEl = el("div", { class: "code" }, ["----"]);
const copyBtn = el("button", { class: "ghost", type: "button" }, ["Копировать код"]);
const playersEl = el("div", { class: "players" });
const minesEl = el("strong", {}, ["0"]);
const timeEl = el("strong", {}, ["00:00"]);
const bannerEl = el("p", { class: "banner" });
const boardEl = el("div", { class: "board" });
const restartBtn = el("button", { class: "primary", type: "button" }, ["Новая партия"]);
const leaveBtn = el("button", { class: "ghost", type: "button" }, ["Покинуть"]);
const hintEl = el("p", { class: "lede" }, ["ЛКМ открывает клетку и снимает флажок. ПКМ ставит и снимает флажок"]);
const toastEl = el("p", { class: "toast", role: "status" });

table.append(
  el("div", { class: "head" }, [
    el("div", {}, [el("h1", {}, ["Сапёр"]), connEl]),
    el("div", {}, [codeEl, copyBtn]),
  ]),
  playersEl,
  el("div", { class: "stats" }, [
    el("div", {}, [el("span", {}, ["Мины"]), minesEl]),
    el("div", {}, [el("span", {}, ["Время"]), timeEl]),
  ]),
  bannerEl,
  el("div", { class: "board-wrap" }, [boardEl]),
  el("div", { class: "row" }, [restartBtn, leaveBtn]),
  hintEl,
  toastEl,
);

createBtn.addEventListener("click", () => {
  const problem = rulesError(sideInput.value, minesInput.value);
  if (problem) {
    showGate(problem);
    return;
  }
  sendEntry({
    type: "create",
    name: nameInput.value,
    side: Number(sideInput.value),
    mines: Number(minesInput.value),
  });
});
joinBtn.addEventListener("click", () => {
  sendEntry({ type: "join", name: nameInput.value, roomId: codeInput.value });
});
resumeBtn.addEventListener("click", () => {
  const saved = readJSON(localStorage, SAVED_KEY);
  if (!saved) return;
  writeJSON(sessionStorage, TAB_KEY, saved);
  view.you = saved.playerId;
  restoreCache(saved.roomId);
  showTable();
  connect();
});
copyBtn.addEventListener("click", copyCode);
restartBtn.addEventListener("click", () => sendRaw({ type: "restart" }));
leaveBtn.addEventListener("click", leave);
codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
});

sideInput.addEventListener("input", paintRulesHint);
minesInput.addEventListener("input", paintRulesHint);
paintRulesHint();
window.addEventListener("offline", () => {
  view.ready = false;
  clearTimeout(retryTimer);
  setConn("offline");
  if (!socket) return;
  const current = socket;
  socket = null;
  current.close();
});
window.addEventListener("online", () => {
  if (want) connect();
});
setInterval(() => {
  if (view.state?.status === "playing") timeEl.textContent = formatElapsed(view.state);
}, 1000);

boot();

function boot() {
  const tab = readJSON(sessionStorage, TAB_KEY);
  const saved = readJSON(localStorage, SAVED_KEY);
  if (!nameInput.value && (tab?.name || saved?.name)) nameInput.value = tab?.name || saved?.name;
  if (tab?.roomId && tab?.playerId) {
    view.you = tab.playerId;
    restoreCache(tab.roomId);
    showTable();
    connect();
    return;
  }
  showGate("");
}

function rulesError(side, mines) {
  const n = Number(side);
  const count = Number(mines);
  if (!Number.isInteger(n) || n < 5 || n > 30) return "Сторона поля от 5 до 30";
  const cells = n * n;
  if (!Number.isInteger(count) || count < 1 || count >= cells) return `Мин от 1 до ${cells - 1}`;
  return "";
}

function paintRulesHint() {
  const n = Number(sideInput.value);
  if (Number.isInteger(n) && n >= 5 && n <= 30) {
    rulesHint.textContent = `Клеток ${n * n}. Мин от 1 до ${n * n - 1}.`;
    minesInput.max = String(n * n - 1);
    return;
  }
  rulesHint.textContent = "Сторона от 5 до 30.";
}

function showGate(message) {
  gate.hidden = false;
  table.hidden = true;
  gateError.textContent = message ?? "";
  const saved = readJSON(localStorage, SAVED_KEY);
  resumeBox.hidden = !saved;
  if (saved) resumeText.textContent = `Комната ${saved.roomId}, ${saved.name}`;
}

function showTable() {
  gate.hidden = true;
  table.hidden = false;
  if (!view.state) {
    const tab = readJSON(sessionStorage, TAB_KEY);
    codeEl.textContent = tab?.roomId ?? "----";
    bannerEl.textContent = "Ждём поле с сервера…";
  }
  paint();
}

function connect() {
  want = true;
  if (!navigator.onLine) {
    setConn("offline");
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  setConn("connecting");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const current = new WebSocket(`${proto}//${location.host}`);
  socket = current;
  current.addEventListener("open", () => {
    if (socket !== current) return;
    attempt = 0;
    setConn("online");
    const tab = readJSON(sessionStorage, TAB_KEY);
    if (tab?.playerId && tab?.roomId) {
      current.send(JSON.stringify({ type: "resume", playerId: tab.playerId, roomId: tab.roomId }));
      return;
    }
    if (view.entry) current.send(JSON.stringify(view.entry));
  });
  current.addEventListener("message", (event) => {
    if (socket !== current) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    onMessage(msg);
  });
  current.addEventListener("close", () => {
    if (socket !== current) return;
    view.ready = false;
    setConn("offline");
    if (!want) return;
    const delay = Math.min(8000, 500 * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(connect, delay);
  });
}

function disconnect() {
  want = false;
  clearTimeout(retryTimer);
  view.ready = false;
  if (socket) {
    const current = socket;
    socket = null;
    current.close();
  }
  setConn("offline");
}

function sendEntry(msg) {
  view.entry = msg;
  view.leaving = false;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  else connect();
}

function sendRaw(msg) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  else toast("Нет соединения");
}

function sendAction(msg) {
  if (view.ready && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
    return;
  }
  queue.push(msg);
  if (queue.length > 20) queue.shift();
  if (!want) connect();
}

function flush() {
  if (!view.ready || socket?.readyState !== WebSocket.OPEN) return;
  while (queue.length > 0) socket.send(JSON.stringify(queue.shift()));
}

function onMessage(msg) {
  if (view.leaving && msg.type !== "bye" && msg.type !== "error") return;
  if (msg.type === "hello") {
    const me = msg.state.players.find((player) => player.id === msg.you);
    const session = { playerId: msg.you, roomId: msg.state.id, name: me?.name ?? "Игрок" };
    writeJSON(sessionStorage, TAB_KEY, session);
    writeJSON(localStorage, SAVED_KEY, session);
    view.you = msg.you;
    view.entry = null;
    view.ready = true;
    applyState(msg.state);
    showTable();
    flush();
    return;
  }
  if (msg.type === "state") {
    applyState(msg.state);
    return;
  }
  if (msg.type === "result") {
    if (msg.state) applyState(msg.state);
    if (msg.conflict) showConflict(msg.index, msg.message);
    else if (!msg.ok && msg.message) toast(msg.message);
    return;
  }
  if (msg.type === "error") {
    if (msg.code === "no_room" || msg.code === "no_session") {
      forget();
      view.state = null;
      view.ready = false;
      disconnect();
      showGate(msg.message);
      return;
    }
    if (view.state) toast(msg.message);
    else showGate(msg.message);
    return;
  }
  if (msg.type === "bye") finishLeave();
}

function applyState(state) {
  view.state = state;
  view.offset = state.serverNow - Date.now();
  const tab = readJSON(sessionStorage, TAB_KEY);
  if (tab?.roomId === state.id) writeJSON(sessionStorage, CACHE_KEY, state);
  paint();
}

function restoreCache(roomId) {
  const cached = readJSON(sessionStorage, CACHE_KEY);
  if (cached?.id === roomId) {
    view.state = cached;
    view.offset = 0;
  }
}

function leave() {
  if (view.leaving) return;
  view.leaving = true;
  queue.length = 0;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "leave" }));
    leaveTimer = setTimeout(finishLeave, 800);
    return;
  }
  finishLeave();
}

function finishLeave() {
  if (!view.leaving) return;
  view.leaving = false;
  clearTimeout(leaveTimer);
  forget();
  view.state = null;
  view.ready = false;
  view.entry = null;
  disconnect();
  showGate("");
}

function forget() {
  sessionStorage.removeItem(TAB_KEY);
  sessionStorage.removeItem(CACHE_KEY);
  localStorage.removeItem(SAVED_KEY);
}

function paint() {
  const state = view.state;
  if (!state) return;
  codeEl.textContent = state.id;
  const flags = state.cells.filter((cell) => cell.state === "flagged").length;
  minesEl.textContent = String(state.mineCount - flags);
  timeEl.textContent = formatElapsed(state);
  paintPlayers(state);
  paintBanner(state);
  paintBoard(state);
  paintChrome();
}

function paintChrome() {
  const state = view.state;
  const over = state?.status === "won" || state?.status === "lost";
  restartBtn.hidden = !over;
}

function paintPlayers(state) {
  playersEl.replaceChildren();
  for (const player of state.players) {
    const online = player.id === view.you ? link === "online" : player.connected;
    const dot = el("i", { class: online ? "dot on" : "dot" });
    const chip = el("span", { class: player.id === view.you ? "player you" : "player" }, [
      dot,
      player.name + (player.id === view.you ? " · вы" : ""),
    ]);
    playersEl.append(chip);
  }
}

function paintBanner(state) {
  bannerEl.className = "banner";
  if (state.status === "lobby") {
    bannerEl.textContent = `Поле ${state.width}×${state.height}, мин ${state.mineCount}. Откройте любую клетку: первая будет пустой.`;
    return;
  }
  if (state.status === "won") {
    bannerEl.classList.add("won");
    bannerEl.textContent = "Поле разминировано.";
    return;
  }
  if (state.status === "lost") {
    bannerEl.classList.add("lost");
    bannerEl.textContent = `Мина. Её открыл ${state.loserName || "игрок"}.`;
    return;
  }
  bannerEl.textContent = "Разминируйте поле вместе! Открытая мина заканчивает партию для всех.";
}

function paintBoard(state) {
  boardEl.style.setProperty("--cols", String(state.width));
  boardEl.style.setProperty("--cell", `${cellPx(state.width)}px`);
  const key = `${state.width}x${state.height}`;
  if (boardEl.dataset.key !== key) {
    boardEl.dataset.key = key;
    boardEl.replaceChildren();
    for (let i = 0; i < state.cells.length; i += 1) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cell";
      btn.dataset.i = String(i);
      btn.addEventListener("click", () => onLeft(i));
      btn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        onRight(i);
      });
      boardEl.append(btn);
    }
  }
  state.cells.forEach((cell, index) => paintCell(boardEl.children[index], cell, index, state));
}

function paintCell(btn, cell, index, state) {
  const over = state.status === "won" || state.status === "lost";
  btn.className = "cell";
  btn.replaceChildren();
  btn.disabled = false;

  if (cell.state === "revealed") {
    btn.classList.add("revealed");
    btn.disabled = true;
    if (cell.mine) {
      btn.classList.add(index === state.explodedIndex ? "exploded" : "mine");
      btn.append(svgMine());
    } else if (cell.adj > 0) {
      btn.append(el("span", { class: `n n${cell.adj}` }, [String(cell.adj)]));
    }
  } else if (cell.state === "flagged") {
    btn.classList.add("flagged");
    if (over && cell.mine === false) btn.classList.add("bad-flag");
    btn.append(svgFlag());
  } else if (over && cell.mine) {
    btn.classList.add("revealed", "mine");
    btn.disabled = true;
    btn.append(svgMine());
  }

  btn.setAttribute("aria-label", cellLabel(cell, index, state));
}

function onLeft(index) {
  const cell = view.state?.cells[index];
  if (!cell || !canPlay()) return;
  if (cell.state === "flagged") {
    sendAction({ type: "flag", index, version: cell.v });
    return;
  }
  if (cell.state !== "hidden") return;
  sendAction({ type: "reveal", index, version: cell.v });
}

function onRight(index) {
  const cell = view.state?.cells[index];
  if (!cell || !canPlay() || cell.state === "revealed") return;
  sendAction({ type: "flag", index, version: cell.v });
}

function canPlay() {
  return view.state && view.state.status !== "won" && view.state.status !== "lost";
}

function showConflict(index, message) {
  toast(message);
  const btn = boardEl.querySelector(`[data-i="${index}"]`);
  if (!btn) return;
  btn.classList.add("shake");
  setTimeout(() => btn.classList.remove("shake"), 700);
}

function toast(message) {
  toastEl.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.textContent = "";
  }, 3200);
}

async function copyCode() {
  if (!view.state) return;
  try {
    await navigator.clipboard.writeText(view.state.id);
    toast("Код скопирован");
  } catch {
    toast(`Код комнаты: ${view.state.id}`);
  }
}

function setConn(mode) {
  link = mode;
  table.classList.toggle("offline", mode === "offline");
  connEl.className = `conn ${mode}`;
  connEl.textContent = mode === "online" ? "В сети" : mode === "connecting" ? "Подключение…" : "Нет соединения";
  if (view.state) paintPlayers(view.state);
}

function formatElapsed(state) {
  if (!state.startedAt) return "00:00";
  const end = state.finishedAt ?? Date.now() + view.offset;
  const total = Math.max(0, Math.floor((end - state.startedAt) / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function cellLabel(cell, index, state) {
  const column = (index % state.width) + 1;
  const row = Math.floor(index / state.width) + 1;
  let what = "закрыта";
  if (cell.state === "flagged") what = "флажок";
  else if (cell.state === "revealed" && cell.mine) what = "мина";
  else if (cell.state === "revealed") what = cell.adj ? `число ${cell.adj}` : "пусто";
  return `Ряд ${row}, столбец ${column}, ${what}`;
}

function cellPx(side) {
  if (side <= 9) return 40;
  if (side <= 16) return 32;
  if (side <= 22) return 26;
  return 22;
}

function svgFlag() {
  return svg(`<path d="M7 3v18" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 4h9l-2.2 4L17 12H8z" fill="currentColor"/>`);
}

function svgMine() {
  return svg(`<circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5 19 19M19 5l-2.5 2.5M7.5 16.5 5 19" stroke="currentColor" stroke-width="2" fill="none"/>`);
}

function svg(body) {
  const ns = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(ns, "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("class", "icon");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = body;
  return node;
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children || []) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

function readJSON(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function writeJSON(storage, key, value) {
  storage.setItem(key, JSON.stringify(value));
}
