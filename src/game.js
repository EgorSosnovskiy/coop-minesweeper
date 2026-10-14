export const MIN_SIDE = 5;
export const MAX_SIDE = 30;
export const MAX_PLAYERS = 4;

/** Сторона 5–30, мины от 1 до N² − 1. Поле квадратное. */
export function parseRules(side, mines) {
  const n = Number(side);
  const count = Number(mines);
  if (!Number.isInteger(n) || n < MIN_SIDE || n > MAX_SIDE) {
    return { ok: false, message: `Сторона поля от ${MIN_SIDE} до ${MAX_SIDE}` };
  }
  const cells = n * n;
  if (!Number.isInteger(count) || count < 1 || count >= cells) {
    return { ok: false, message: `Мин от 1 до ${cells - 1}` };
  }
  return { ok: true, width: n, height: n, mineCount: count };
}

const CONFLICT = "Клетку уже изменил другой игрок";

export function cleanName(raw) {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 16);
  return name || "Игрок";
}

export function createRoom({ id, side = 9, mines = 10, player }) {
  const rules = parseRules(side, mines);
  if (!rules.ok) throw new Error(rules.message);
  const room = { id, players: [] };
  applySpec(room, rules);
  if (player) room.players.push(player);
  return room;
}

export function addPlayer(room, player) {
  if (room.players.some((item) => item.id === player.id)) return { ok: true };
  if (room.players.length >= MAX_PLAYERS) {
    return { ok: false, code: "full", message: "В комнате уже четыре игрока" };
  }
  room.players.push(player);
  return { ok: true };
}

export function restart(room) {
  if (room.status !== "won" && room.status !== "lost") {
    return { ok: false, message: "Партия ещё идёт" };
  }
  applySpec(room, { width: room.width, height: room.height, mineCount: room.mineCount });
  return { ok: true, changed: true };
}

/**
 * Открыть клетку. Версия — оптимистичная блокировка: сервер принимает правку,
 * только если игрок видел то же состояние клетки, что и сервер.
 * Повторное открытие уже открытой клетки ошибкой не считается.
 */
export function reveal(room, playerId, index, version) {
  const bounds = checkIndex(room, index);
  if (bounds) return bounds;
  const done = ended(room);
  if (done) return done;

  const cell = room.cells[index];
  if (cell.state === "revealed") return { ok: true, changed: false };
  if (!Number.isInteger(version) || cell.v !== version) {
    return conflict(index);
  }
  if (cell.state === "flagged") {
    return { ok: false, conflict: false, message: "Сначала снимите флажок", index };
  }

  if (!room.minesPlaced) {
    placeMines(room, index);
    room.minesPlaced = true;
    room.status = "playing";
    room.startedAt = Date.now();
  }

  open(room, index, playerId);

  if (room.status === "playing" && allSafeOpened(room)) {
    room.status = "won";
    room.finishedAt = Date.now();
  }
  return { ok: true, changed: true };
}

/** Поставить или снять флажок. Чужая версия клетки отклоняется. */
export function flag(room, index, version) {
  const bounds = checkIndex(room, index);
  if (bounds) return bounds;
  const done = ended(room);
  if (done) return done;

  const cell = room.cells[index];
  if (cell.state === "revealed") {
    return { ok: false, conflict: false, message: "Клетка уже открыта", index };
  }
  if (!Number.isInteger(version) || cell.v !== version) {
    return conflict(index);
  }
  cell.state = cell.state === "flagged" ? "hidden" : "flagged";
  cell.v += 1;
  return { ok: true, changed: true };
}

/** Фиксированная раскладка мин. Нужна проверкам правил, сервер ею не пользуется. */
export function layMines(room, indexes) {
  for (const cell of room.cells) {
    cell.mine = false;
    cell.adj = 0;
    cell.state = "hidden";
    cell.v = 0;
  }
  for (const index of indexes) room.cells[index].mine = true;
  computeAdj(room);
  room.minesPlaced = true;
  room.status = "playing";
  room.startedAt = Date.now();
  room.finishedAt = null;
  room.explodedIndex = null;
  room.loserId = null;
  room.loserName = null;
}

/** Публичный снимок: пока партия идёт, координаты мин не уходят клиенту. */
export function toPublic(room, serverNow = Date.now()) {
  const showMines = room.status === "won" || room.status === "lost";
  return {
    id: room.id,
    status: room.status,
    width: room.width,
    height: room.height,
    mineCount: room.mineCount,
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
    serverNow,
    explodedIndex: room.explodedIndex,
    loserId: room.loserId,
    loserName: room.loserName,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected === true,
    })),
    cells: room.cells.map((cell) => {
      const visible = cell.state === "revealed" || showMines;
      const pub = { v: cell.v, state: cell.state };
      if (visible) {
        pub.mine = cell.mine;
        pub.adj = cell.adj;
      }
      return pub;
    }),
  };
}

function applySpec(room, spec) {
  room.width = spec.width;
  room.height = spec.height;
  room.mineCount = spec.mineCount;
  room.status = "lobby";
  room.minesPlaced = false;
  room.startedAt = null;
  room.finishedAt = null;
  room.explodedIndex = null;
  room.loserId = null;
  room.loserName = null;
  room.cells = Array.from({ length: spec.width * spec.height }, () => ({
    v: 0,
    mine: false,
    adj: 0,
    state: "hidden",
  }));
}

function checkIndex(room, index) {
  if (!Number.isInteger(index) || index < 0 || index >= room.cells.length) {
    return { ok: false, conflict: false, message: "Нет такой клетки" };
  }
  return null;
}

function ended(room) {
  if (room.status === "won" || room.status === "lost") {
    return { ok: false, conflict: false, message: "Игра уже закончена" };
  }
  return null;
}

function conflict(index) {
  return { ok: false, conflict: true, message: CONFLICT, index };
}

function allSafeOpened(room) {
  return room.cells.every((cell) => cell.mine || cell.state === "revealed");
}

function open(room, index, playerId) {
  const stack = [index];
  while (stack.length > 0) {
    const current = stack.pop();
    const cell = room.cells[current];
    if (cell.state !== "hidden") continue;
    cell.state = "revealed";
    cell.v += 1;
    if (cell.mine) {
      room.status = "lost";
      room.finishedAt = Date.now();
      room.explodedIndex = current;
      room.loserId = playerId;
      room.loserName = room.players.find((player) => player.id === playerId)?.name ?? "Игрок";
      return;
    }
    if (cell.adj === 0) {
      for (const near of neighbors(room.width, room.height, current)) {
        if (room.cells[near].state === "hidden") stack.push(near);
      }
    }
  }
}

function placeMines(room, safeIndex) {
  const reserved = new Set([safeIndex, ...neighbors(room.width, room.height, safeIndex)]);
  let spots = [];
  for (let i = 0; i < room.cells.length; i += 1) {
    if (!reserved.has(i)) spots.push(i);
  }
  if (spots.length < room.mineCount) {
    spots = [];
    for (let i = 0; i < room.cells.length; i += 1) {
      if (i !== safeIndex) spots.push(i);
    }
  }
  shuffle(spots);
  for (const cell of room.cells) {
    cell.mine = false;
    cell.adj = 0;
  }
  for (const spot of spots.slice(0, room.mineCount)) room.cells[spot].mine = true;
  computeAdj(room);
}

function computeAdj(room) {
  for (let i = 0; i < room.cells.length; i += 1) {
    const cell = room.cells[i];
    if (cell.mine) {
      cell.adj = 0;
      continue;
    }
    cell.adj = neighbors(room.width, room.height, i).reduce(
      (sum, near) => sum + (room.cells[near].mine ? 1 : 0),
      0,
    );
  }
}

function neighbors(width, height, index) {
  const x = index % width;
  const y = Math.floor(index / width);
  const list = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      list.push(ny * width + nx);
    }
  }
  return list;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}
