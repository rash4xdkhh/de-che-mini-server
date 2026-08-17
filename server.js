// ====== ĐẾ CHẾ MINI - MULTIPLAYER SERVER ======
// Server thật (Node.js + WebSocket) điều khiển toàn bộ zombie/boss/wave — không còn khái niệm
// "ai đó làm chủ phòng bằng trình duyệt" nữa, nên loại bỏ hết các lỗi đồng bộ do độ trễ mạng
// hay trình duyệt bị hệ điều hành tạm dừng.

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.get('/', (req, res) => res.send('De Che Mini multiplayer server dang chay OK'));

const PORT = process.env.PORT || 3000;
const WORLD_SIZE = 1000;
const TICK_MS = 50; // ~20 lần/giây

const rooms = {}; // roomCode -> room state

function newRoom(code) {
  return {
    code,
    players: {},   // playerId -> {ws, name, x, y, hp, maxHp, wave, level, swordsLevel, swordsUpgraded, giants, lastAttackCooldown:{} }
    enemies: {},   // enemyId -> {id,x,y,hp,maxHp,isBoss,meleeRange,atkCdMax,dmgBonus,speed,attackCooldown,arrowCooldown,lastAttackedPlayerId}
    walls: {},     // wallId -> {id,x,y,type,hp,maxHp,ownerId}
    wave: 1,
    enemyIdCounter: 0,
    wallIdCounter: 0,
    bossKills: 0,
    vologicCount: 0,
    vologicUntil: 0,
    vologicIncludeEpx: false,
  };
}
function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = newRoom(code);
    spawnWave(rooms[code], 1);
  }
  return rooms[code];
}

// ====== CÔNG THỨC WAVE (khớp với công thức phía client) ======
function spawnWave(room, wave) {
  room.wave = wave;
  room.enemies = {};
  const count = Math.min(4 + wave * 2, 79);
  const bossCount = Math.min(Math.floor(wave / 5), count);
  const wavePast10 = Math.max(0, wave - 10);
  const dmgScale = wavePast10 * 15;
  const hpScale = wavePast10 * 20;
  const milestones = Math.floor(wave / 100);
  const milestoneDmg = milestones * 1000000;
  const milestoneHp = milestones * 5000;
  const milestoneSpd = milestones * 10;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 350 + Math.random() * 200;
    const x = Math.max(50, Math.min(950, 500 + Math.cos(angle) * dist));
    const y = Math.max(50, Math.min(950, 500 + Math.sin(angle) * dist));
    const isBoss = i < bossCount;
    const normalHp = 30 + wave * 10 + hpScale + milestoneHp;
    const normalSpdRaw = 35 + wave * 3 + milestoneSpd;
    const hp = isBoss ? (150 + hpScale + milestoneHp) : normalHp;
    const spdRaw = isBoss ? Math.round(normalSpdRaw * 0.9) : normalSpdRaw;
    const speed = Math.min(1000, spdRaw);
    const id = 'w' + wave + '_' + (room.enemyIdCounter++);
    room.enemies[id] = {
      id, x, y, hp, maxHp: hp, isBoss,
      meleeRange: isBoss ? 50 : 42,
      atkCdMax: isBoss ? 2600 : 1500,
      dmgBonus: dmgScale + milestoneDmg,
      speed,
      attackCooldown: 0,
      arrowCooldown: isBoss ? Date.now() + Math.random() * 3500 : 0,
    };
  }
  broadcastWaveText(room, wave, bossCount);
}

function broadcastWaveText(room, wave, bossCount) {
  broadcast(room, { type: 'waveText', wave, bossCount });
}

function alivePlayers(room) {
  return Object.values(room.players).filter(p => p.hp > 0);
}
function nearestPlayer(room, x, y) {
  let best = null, bestDist = Infinity;
  alivePlayers(room).forEach(p => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDist) { bestDist = d; best = p; }
  });
  return best ? { player: best, dist: bestDist } : null;
}

// ====== VÒNG LẶP GAME (server tick) ======
function tick() {
  const now = Date.now();
  for (const code in rooms) {
    const room = rooms[code];
    if (Object.keys(room.players).length === 0) continue; // phòng trống, bỏ qua (dọn sau)
    const hadEnemies = Object.keys(room.enemies).length > 0;
    let allDead = true;
    for (const id in room.enemies) {
      const e = room.enemies[id];
      if (e.hp <= 0) continue; // đã chết (nhưng vẫn còn nằm trong danh sách 1 khung hình để tick này nhận biết đúng "đã hết")
      allDead = false;
      const target = nearestPlayer(room, e.x, e.y);
      if (target && target.dist > 36) {
        const dx = target.player.x - e.x, dy = target.player.y - e.y;
        let nx = e.x + (dx / target.dist) * e.speed * (TICK_MS / 1000);
        let ny = e.y + (dy / target.dist) * e.speed * (TICK_MS / 1000);
        // Va chạm tường
        let blocked = false;
        for (const wid in room.walls) {
          const w = room.walls[wid];
          if (w.hp <= 0) continue;
          if (Math.hypot(nx - w.x, ny - w.y) < 20 + 16) {
            blocked = true;
            if (!w.lastHit || now - w.lastHit > 1000) {
              w.lastHit = now;
              const wallDmg = e.isBoss ? (w.type === 'wood' ? 40 : 67) : ((wave => wave > 10 ? 24 : 8)(room.wave));
              w.hp = Math.max(0, w.hp - wallDmg);
              if (w.hp <= 0) delete room.walls[wid];
            }
          }
        }
        if (!blocked) { e.x = nx; e.y = ny; }
      }
      // Tấn công cận chiến người chơi gần nhất trong tầm đánh
      if (target && target.dist < e.meleeRange && now - e.attackCooldown > e.atkCdMax) {
        e.attackCooldown = now;
        let dmg;
        if (e.isBoss) {
          const baseDmg = room.wave > 10 ? Math.max(1, Math.round(target.player.maxHp * 0.5)) : 36 + Math.floor(Math.random() * 6);
          dmg = baseDmg + e.dmgBonus;
        } else {
          dmg = 8 + Math.floor(Math.random() * 4) + e.dmgBonus;
        }
        target.player.hp = Math.max(0, target.player.hp - dmg);
        target.player.lastAttackedAt = now;
        broadcast(room, { type: 'playerHit', playerId: target.player.id, dmg, hp: target.player.hp });
      }
      // Boss bắn mũi tên thần
      if (e.isBoss && now - e.arrowCooldown > 3500) {
        e.arrowCooldown = now;
        fireArrowVolley(room, e);
      }
    }
    // FIX QUAN TRỌNG: trước đây zombie bị xóa khỏi room.enemies NGAY khi chết (trong handler
    // 'attack'), nên tới lúc con CUỐI CÙNG chết thì room.enemies đã rỗng SẴN -> điều kiện
    // "allDead && còn zombie trong danh sách" không bao giờ đồng thời đúng được -> wave KHÔNG
    // BAO GIỜ tự lên. Giờ khi hạ gục chỉ đánh dấu hp=0 (không xóa ngay), để tick này nhận biết
    // đúng "cả wave đã chết hết" rồi mới dọn dẹp + chuyển wave mới.
    if (allDead && hadEnemies) {
      const nextWave = room.wave + 1;
      room.enemies = {}; // trống tạm trong lúc chờ wave mới
      setTimeout(() => { if (rooms[code]) spawnWave(rooms[code], nextWave); }, 2000);
    }
    broadcastState(room);
  }
}
setInterval(tick, TICK_MS);

// ====== MŨI TÊN THẦN CỦA BOSS ======
function fireArrowVolley(room, boss) {
  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      if (!rooms[room.code] || boss.hp <= 0) return;
      const target = nearestPlayer(room, boss.x, boss.y);
      if (!target) return;
      const arrowDmg = 100 + boss.dmgBonus;
      // Điểm rơi được chốt NGAY LÚC BẮN (vị trí người chơi lúc đó) — đây chính là chỗ người chơi
      // cần né ra khỏi trong lúc mũi tên đang bay tới.
      const impactX = target.player.x, impactY = target.player.y;
      const targetPlayerId = target.player.id;
      const ev = { type: 'arrowEvent', startX: boss.x, startY: boss.y, targetX: impactX, targetY: impactY, targetPlayerId, dmg: arrowDmg };
      broadcast(room, ev);
      setTimeout(() => {
        if (!rooms[room.code]) return;
        const p = room.players[targetPlayerId];
        if (!p || p.hp <= 0) return;
        // FIX: trước đây gây sát thương LUÔN LUÔN cho người bị nhắm, không kiểm tra lại vị trí
        // hiện tại -> không thể né được vì dù có di chuyển đi đâu vẫn bị trúng. Giờ kiểm tra lại:
        // chỉ trúng nếu người chơi VẪN CÒN GẦN đúng điểm rơi lúc mũi tên bay tới nơi — di chuyển
        // ra khỏi bán kính này trong 460ms bay là né được.
        const dist = Math.hypot(p.x - impactX, p.y - impactY);
        if (dist < 44) {
          p.hp = Math.max(0, p.hp - arrowDmg);
          p.lastAttackedAt = Date.now();
          broadcast(room, { type: 'playerHit', playerId: p.id, dmg: arrowDmg, hp: p.hp });
        }
      }, 460);
    }, i * 90);
  }
}

// ====== TRẠNG THÁI GỬI ĐỊNH KỲ ======
function broadcastState(room) {
  const playersOut = {};
  for (const id in room.players) {
    const p = room.players[id];
    playersOut[id] = { id, name: p.name, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, wave: room.wave, level: p.level, swordsLevel: p.swordsLevel, swordsUpgraded: p.swordsUpgraded, giants: p.giants || [] };
  }
  const enemiesOut = {};
  for (const id in room.enemies) {
    const e = room.enemies[id];
    enemiesOut[id] = { id: e.id, x: Math.round(e.x), y: Math.round(e.y), hp: e.hp, maxHp: e.maxHp, isBoss: e.isBoss };
  }
  const wallsOut = {};
  for (const id in room.walls) {
    const w = room.walls[id];
    wallsOut[id] = { id: w.id, x: w.x, y: w.y, type: w.type, hp: w.hp, maxHp: w.maxHp };
  }
  broadcast(room, {
    type: 'state', wave: room.wave, players: playersOut, enemies: enemiesOut, walls: wallsOut,
    bossKills: room.bossKills, vologicUntil: room.vologicUntil, vologicIncludeEpx: room.vologicIncludeEpx,
  });
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const id in room.players) {
    const p = room.players[id];
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

// ====== XỬ LÝ HẠ GỤC (được gọi khi 1 zombie/boss về 0 máu) ======
function onEnemyKilled(room, enemy, killerPlayerId) {
  if (!enemy.isBoss) return;
  room.bossKills++;
  if (room.bossKills % 10 === 0) {
    if (room.vologicCount < 10) {
      room.vologicCount++;
      room.vologicUntil = Date.now() + 10000;
      room.vologicIncludeEpx = room.vologicCount >= 5;
      broadcast(room, { type: 'vologic', until: room.vologicUntil, includeEpx: room.vologicIncludeEpx });
    }
  }
}

// ====== KẾT NỐI WEBSOCKET ======
let playerIdCounter = 0;
wss.on('connection', (ws) => {
  let roomCode = null, playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'join') {
      roomCode = String(msg.room || 'phong-mac-dinh').trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'phong-mac-dinh';
      playerId = 'p' + (playerIdCounter++) + '_' + Date.now();
      const room = getRoom(roomCode);
      room.players[playerId] = {
        id: playerId, ws, name: String(msg.name || 'Người chơi').slice(0, 16),
        x: 500, y: 500, hp: 100, maxHp: 100, level: 1, wave: room.wave,
        swordsLevel: 0, swordsUpgraded: false, giants: [],
      };
      ws.send(JSON.stringify({ type: 'joined', playerId, wave: room.wave }));
      broadcastState(room);
      return;
    }

    if (!roomCode || !playerId || !rooms[roomCode] || !rooms[roomCode].players[playerId]) return;
    const room = rooms[roomCode];
    const me = room.players[playerId];

    if (msg.type === 'move') {
      me.x = clamp(msg.x, 0, WORLD_SIZE); me.y = clamp(msg.y, 0, WORLD_SIZE);
      if (typeof msg.hp === 'number') me.hp = msg.hp;
      if (typeof msg.maxHp === 'number') me.maxHp = msg.maxHp;
      if (typeof msg.level === 'number') me.level = msg.level;
      if (typeof msg.swordsLevel === 'number') me.swordsLevel = msg.swordsLevel;
      if (typeof msg.swordsUpgraded === 'boolean') me.swordsUpgraded = msg.swordsUpgraded;
      if (Array.isArray(msg.giants)) me.giants = msg.giants;
    }

    else if (msg.type === 'attack') {
      const e = room.enemies[msg.enemyId];
      if (e && e.hp > 0) {
        const dmg = Math.max(0, Math.floor(msg.dmg || 0));
        const wasAlive = e.hp > 0;
        e.hp = Math.max(0, e.hp - dmg);
        if (wasAlive && e.hp <= 0) {
          onEnemyKilled(room, e, playerId);
          broadcast(room, { type: 'enemyKilled', enemyId: e.id, isBoss: e.isBoss, killerPlayerId: playerId });
          // KHÔNG xóa khỏi room.enemies ngay ở đây nữa — để hàm tick() tự dọn dẹp đúng lúc kiểm
          // tra "cả wave đã chết hết chưa", tránh bug wave không tự lên (xem ghi chú trong tick()).
        }
      }
    }

    else if (msg.type === 'buildWall') {
      const wallHp = { wood: 300, steel: 1000000, titanium: 1000000000 }[msg.wallType] || 300;
      const id = 'wall' + (room.wallIdCounter++);
      room.walls[id] = { id, x: msg.x, y: msg.y, type: msg.wallType, hp: wallHp, maxHp: wallHp, ownerId: playerId };
      broadcast(room, { type: 'wallBuilt', wall: room.walls[id] });
    }

    else if (msg.type === 'damageWall') {
      const w = room.walls[msg.wallId];
      if (w && w.hp > 0) {
        w.hp = Math.max(0, w.hp - Math.max(0, Math.floor(msg.dmg || 0)));
        if (w.hp <= 0) delete room.walls[msg.wallId];
      }
    }

    else if (msg.type === 'restart') {
      me.hp = 100; me.maxHp = 100; me.x = 500; me.y = 500;
    }
  });

  ws.on('close', () => {
    if (roomCode && playerId && rooms[roomCode]) {
      delete rooms[roomCode].players[playerId];
      broadcastState(rooms[roomCode]);
      if (Object.keys(rooms[roomCode].players).length === 0) {
        setTimeout(() => { if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length === 0) delete rooms[roomCode]; }, 60000);
      }
    }
  });
});

function clamp(v, min, max) { return Math.max(min, Math.min(max, typeof v === 'number' ? v : min)); }

server.listen(PORT, () => console.log('Server dang chay tren cong ' + PORT));
