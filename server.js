import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import {
  addPlayer,
  cleanName,
  createRoom,
  flag,
  parseRules,
  restart,
  reveal,
  toPublic,
} from "./src/game.js";
import { createStore } from "./src/store.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const defaultData = path.join(root, "data", "rooms.json");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function start({ port = 0, dataPath = defaultData } = {}) {
  const store = createStore(dataPath);
  const sockets = new Map();

  const server = createServer((req, res) => {
    serve(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      handle(ws, msg);
    });
    ws.on("close", () => detach(ws));
  });

  function handle(ws, msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "create":
        return onCreate(ws, msg);
      case "join":
        return onJoin(ws, msg);
      case "resume":
        return onResume(ws, msg);
      case "leave":
        return onLeave(ws);
      case "restart":
        return onRestart(ws);
      case "reveal":
        return onReveal(ws, msg);
      case "flag":
        return onFlag(ws, msg);
      default:
        return;
    }
  }

  function onCreate(ws, msg) {
    if (sockets.has(ws)) {
      return send(ws, error("bad_request", "Вы уже в комнате"));
    }
    const rules = parseRules(msg.side, msg.mines);
    if (!rules.ok) return send(ws, error("bad_request", rules.message));
    const player = makePlayer(msg.name);
    const room = createRoom({
      id: roomCode(store.rooms),
      side: rules.width,
      mines: rules.mineCount,
      player,
    });
    store.rooms.set(room.id, room);
    bind(ws, room, player);
    store.schedule();
    console.log(`Комната ${room.id} создана, игрок ${player.name}`);
    send(ws, { type: "hello", you: player.id, state: toPublic(room) });
  }

  function onJoin(ws, msg) {
    if (sockets.has(ws)) {
      return send(ws, error("bad_request", "Вы уже в комнате"));
    }
    const room = store.rooms.get(normalizeCode(msg.roomId));
    if (!room) return send(ws, error("no_room", "Комната не найдена"));
    const player = makePlayer(msg.name);
    const added = addPlayer(room, player);
    if (!added.ok) return send(ws, error(added.code, added.message));
    bind(ws, room, player);
    store.schedule();
    console.log(`${player.name} вошёл в ${room.id}`);
    const state = toPublic(room);
    send(ws, { type: "hello", you: player.id, state });
    broadcast(room.id, { type: "state", state }, ws);
  }

  function onResume(ws, msg) {
    const room = store.rooms.get(normalizeCode(msg.roomId));
    if (!room) return send(ws, error("no_room", "Комната не найдена"));
    const player = room.players.find((item) => item.id === msg.playerId);
    if (!player) return send(ws, error("no_session", "Сессия не найдена"));
    bind(ws, room, player);
    const state = toPublic(room);
    send(ws, { type: "hello", you: player.id, state });
    broadcast(room.id, { type: "state", state }, ws);
    console.log(`${player.name} вернулся в ${room.id}`);
  }

  function onLeave(ws) {
    const meta = sockets.get(ws);
    if (!meta) return send(ws, { type: "bye" });
    const room = store.rooms.get(meta.roomId);
    sockets.delete(ws);
    if (room) {
      room.players = room.players.filter((player) => player.id !== meta.playerId);
      if (room.players.length === 0) store.rooms.delete(room.id);
      else broadcast(room.id, { type: "state", state: toPublic(room) });
      store.schedule();
    }
    send(ws, { type: "bye" });
  }

  function onRestart(ws) {
    const ctx = requireRoom(ws);
    if (!ctx) return send(ws, error("no_session", "Сначала войдите в комнату"));
    const outcome = restart(ctx.room);
    if (!outcome.ok) return send(ws, error("bad_request", outcome.message));
    store.schedule();
    console.log(`Новая партия в ${ctx.room.id}`);
    broadcast(ctx.room.id, { type: "state", state: toPublic(ctx.room) });
  }

  function onReveal(ws, msg) {
    onAction(ws, msg, (room, player, index, version) => reveal(room, player.id, index, version));
  }

  function onFlag(ws, msg) {
    onAction(ws, msg, (room, _player, index, version) => flag(room, index, version));
  }

  function onAction(ws, msg, apply) {
    const ctx = requireRoom(ws);
    if (!ctx) return send(ws, error("no_session", "Сначала войдите в комнату"));
    if (!Number.isInteger(msg.index) || !Number.isInteger(msg.version)) {
      return send(ws, error("bad_request", "Некорректное действие"));
    }
    const outcome = apply(ctx.room, ctx.player, msg.index, msg.version);
    const state = toPublic(ctx.room);
    if (!outcome.ok && outcome.conflict) {
      console.log(`Конфликт в ${ctx.room.id}, клетка ${msg.index}`);
      return send(ws, { type: "result", ok: false, conflict: true, message: outcome.message, index: msg.index, state });
    }
    if (!outcome.ok) {
      return send(ws, { type: "result", ok: false, conflict: false, message: outcome.message, index: msg.index, state });
    }
    if (outcome.changed) {
      store.schedule();
      if (ctx.room.status === "won") console.log(`Победа в ${ctx.room.id}`);
      if (ctx.room.status === "lost") console.log(`Поражение в ${ctx.room.id}`);
      broadcast(ctx.room.id, { type: "state", state }, ws);
    }
    send(ws, { type: "result", ok: true, conflict: false, index: msg.index, state });
  }

  function bind(ws, room, player) {
    sockets.set(ws, { roomId: room.id, playerId: player.id });
    refreshPresence(room);
  }

  function detach(ws) {
    const meta = sockets.get(ws);
    sockets.delete(ws);
    if (!meta) return;
    const room = store.rooms.get(meta.roomId);
    if (!room) return;
    refreshPresence(room);
    broadcast(room.id, { type: "state", state: toPublic(room) });
  }

  function refreshPresence(room) {
    const online = new Set();
    for (const meta of sockets.values()) {
      if (meta.roomId === room.id) online.add(meta.playerId);
    }
    for (const player of room.players) player.connected = online.has(player.id);
  }

  function requireRoom(ws) {
    const meta = sockets.get(ws);
    if (!meta) return null;
    const room = store.rooms.get(meta.roomId);
    if (!room) return null;
    const player = room.players.find((item) => item.id === meta.playerId);
    if (!player) return null;
    return { meta, room, player };
  }

  function broadcast(roomId, msg, except) {
    for (const [ws, meta] of sockets) {
      if (meta.roomId === roomId && ws !== except) send(ws, msg);
    }
  }

  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      resolve({
        server,
        wss,
        store,
        port: typeof address === "object" && address ? address.port : port,
      });
    });
  });
}

export function stop(handle) {
  for (const client of handle.wss.clients) client.terminate();
  handle.store.saveNow();
  return new Promise((resolve, reject) => {
    handle.server.close((err) => (err ? reject(err) : resolve()));
  });
}

function makePlayer(name) {
  return { id: randomUUID(), name: cleanName(name), connected: true };
}

function roomCode(rooms) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let code = "";
    for (let i = 0; i < 4; i += 1) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Не удалось создать код комнаты");
}

function normalizeCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function error(code, message) {
  return { type: "error", code, message };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

async function serve(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.resolve(publicDir, `.${pathname}`);
  const rootWithSep = publicDir.endsWith(path.sep) ? publicDir : publicDir + path.sep;
  if (file !== publicDir && !file.startsWith(rootWithSep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const type = TYPES[path.extname(file)];
  if (!type) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

function launchedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (launchedDirectly()) {
  const port = Number(process.env.PORT) || 3000;
  start({ port }).then(({ port: bound }) => {
    console.log(`Сапёр: http://localhost:${bound}`);
  });
}
