import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Комнаты живут в памяти и пишутся в один JSON.
 * На диске игроки всегда «не в сети»: живые сокеты известны только процессу.
 */
export function createStore(filePath) {
  const rooms = load(filePath);
  let timer = null;

  function saveNow() {
    if (timer) clearTimeout(timer);
    timer = null;
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot(rooms)));
    copyFileSync(tmp, filePath);
    rmSync(tmp, { force: true });
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(saveNow, 50);
    if (typeof timer.unref === "function") timer.unref();
  }

  return { rooms, schedule, saveNow };
}

function load(filePath) {
  try {
    return revive(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (err) {
    if (err && err.code === "ENOENT") return new Map();
    console.error("Сохранение повреждено, комнаты начнём заново.", err.message);
    try {
      renameSync(filePath, `${filePath}.bad`);
    } catch {
      // Файл уже занят или исчез — продолжаем с пустым набором.
    }
    return new Map();
  }
}

function revive(raw) {
  const rooms = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rooms;
  for (const [id, room] of Object.entries(raw)) {
    if (!room || !Array.isArray(room.cells) || !Array.isArray(room.players)) continue;
    if (!Number.isInteger(room.width) || !Number.isInteger(room.height)) continue;
    for (const player of room.players) player.connected = false;
    rooms.set(id, room);
  }
  return rooms;
}

function snapshot(rooms) {
  const data = {};
  for (const [id, room] of rooms) {
    const copy = structuredClone(room);
    for (const player of copy.players) player.connected = false;
    data[id] = copy;
  }
  return data;
}
