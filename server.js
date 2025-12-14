const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Render uyumlu CORS ayarı
const io = socketIo(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
}); 

// --- SABİTLER ve OYUN DEĞİŞKENLERİ ---
const MAX_PLAYERS_PER_ROOM = 10;
const ROUND_DURATION = 60;
const WORDS = ["köpek","ev","bilgisayar","güneş","telefon","ayakkabı","gözlük","araba","masa","bardak","sandalye","bulut","kedi","ağaç","deniz","kitap"];

const rooms = {};

function randomWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function getRoom(name) {
  // Eğer oda yoksa, yeni bir oda oluşturur
  if (!rooms[name]) {
    rooms[name] = {
      password: null, // Şifre (opsiyonel)
      players: {}, // Oyuncu bilgileri (nick)
      scores: {}, // Oyuncu skorları
      drawer: null, // Şu an çizen
      word: randomWord(),
      timer: ROUND_DURATION,
      interval: null,
      guessed: new Set(),
      history: [] // Çizim geçmişi
    };
  }
  return rooms[name];
}

function updateLobby() {
  const data = {};
  for (const r in rooms) {
    // Sadece aktif odaları lobide göster
    if (Object.keys(rooms[r].players).length > 0) { 
        data[r] = {
            count: Object.keys(rooms[r].players).length,
            max: MAX_PLAYERS_PER_ROOM,
            locked: !!rooms[r].password
        };
    }
  }
  io.emit('lobby update', data);
}

function startRound(roomName) {
  const room = rooms[roomName];
  const ids = Object.keys(room.players);
  if (ids.length < 2) {
      io.to(roomName).emit('system', 'Oyun için en az 2 oyuncu gerekli.');
      return;
  }

  // Tur hazırlıkları
  room.word = randomWord();
  room.guessed.clear();
  room.history = [];

  // Sıradaki çizenin belirlenmesi
  const next = room.drawer ? ids[(ids.indexOf(room.drawer)+1)%ids.length] : ids[0];
  room.drawer = next;

  io.to(roomName).emit('clear canvas');

  // Çizen ve tahmin eden rolleri atama
  ids.forEach(id => {
    io.to(id).emit('draw state', {
      isDrawer: id === room.drawer,
      word: id === room.drawer ? room.word : undefined
    });
  });

  // Genel oyun durumunu gönderme
  io.to(roomName).emit('game state', {
    drawer: room.players[room.drawer].nick,
    length: room.word.length
  });

  // Zamanlayıcıyı başlatma
  room.timer = ROUND_DURATION;
  clearInterval(room.interval);
  room.interval = setInterval(() => {
    room.timer--;
    io.to(roomName).emit('timer update', room.timer);
    if (room.timer <= 0) {
      clearInterval(room.interval);
      io.to(roomName).emit('system', `Süre doldu! Kelime **${room.word}** idi.`);
      startRound(roomName);
    }
  }, 1000);
}

// Statik dosyalar (public klasörü)
app.use(express.static(path.join(__dirname, 'public')));

// Ana sayfa
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- SOCKET.IO OLAYLARI ---
io.on('connection', socket => {
  updateLobby(); // Bağlanan her yeni kullanıcı lobiyi görsün

  // 1. ODA OLUŞTURMA OLAYI
  socket.on('create room', ({room, password, nick}) => {
    if (rooms[room]) {
      socket.emit('error msg', 'Oda zaten var. Lütfen farklı bir isim deneyin.');
      return;
    }
    const r = getRoom(room);
    r.password = password || null;
    
    // Oda oluşturulduktan sonra, bu socket'i katılma olayına yönlendirir.
    socket.emit('join room', {room, password, nick});
  });

  // 2. ODAYA KATILMA OLAYI (Oluşturma da buradan devam eder)
  socket.on('join room', ({room, password, nick}) => {
    const r = getRoom(room);
    
    // Şifre kontrolü
    if (r.password && r.password !== password) {
      socket.emit('error msg', 'Şifre yanlış!');
      return;
    }

    if (Object.keys(r.players).length >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('error msg', 'Oda dolu.');
      return;
    }

    socket.join(room);
    socket.room = room; // Socket objesine oda adını kaydet
    socket.nick = nick; // Socket objesine nicki kaydet

    r.players[socket.id] = {nick};
    r.scores[socket.id] = r.scores[socket.id] || 0;

    socket.emit('joined', room); // İstemciye başarılı katılımı bildir
    io.to(room).emit('system', `${nick} odaya katıldı.`);
    updateLobby();

    // Eğer 2. kişi ise ve oyun başlamamışsa turu başlat
    if (Object.keys(r.players).length === 2 && !r.drawer) startRound(room);
  });

  // Diğer oyun olayları (draw, chat, disconnect, vs...)
  socket.on('draw', d => {
    const r = rooms[socket.room];
    if (socket.id === r.drawer) {
      r.history.push(d);
      socket.to(socket.room).emit('draw', d);
    }
  });

  socket.on('chat', msg => {
    const r = rooms[socket.room];
    if (!r) return;
    
    const guess = msg.trim().toLowerCase();
    const correctWord = r.word.toLowerCase();
    
    if (guess === correctWord && socket.id !== r.drawer) {
      // Tahmin doğruysa
      if (!r.guessed.has(socket.id)) { // Daha önce bilmediyse
          r.scores[socket.id] += 5; // Bilene puan
          r.scores[r.drawer] = (r.scores[r.drawer] || 0) + 3; // Çizene puan
          r.guessed.add(socket.id); 
          
          io.to(socket.room).emit('system', `🎉 ${socket.nick} kelimeyi bildi!`);
          
          // Eğer çizen hariç herkes bildiyse
          if (r.guessed.size === Object.keys(r.players).length - 1) {
              clearInterval(r.interval);
              io.to(socket.room).emit('system', `Tüm oyuncular bildi! Yeni tur başlıyor...`);
              setTimeout(() => startRound(socket.room), 3000);
          }
          // Bilene özel mesaj (kelimeyi göstererek)
          io.to(socket.id).emit('system', `Kelime **${r.word}** idi. +5 puan.`);
      } else {
          // Zaten bilmişse normal chat mesajı gibi göster
          io.to(socket.room).emit('chat', `${socket.nick}: ${msg}`);
      }
    } else {
      // Yanlış tahmin veya çizenin mesajı
      io.to(socket.room).emit('chat', `${socket.nick}: ${msg}`);
    }
  });

  socket.on('disconnect', () => {
    if (!socket.room) return;
    const r = rooms[socket.room];
    
    delete r.players[socket.id];
    delete r.scores[socket.id];
    
    io.to(socket.room).emit('system', `${socket.nick} oyundan ayrıldı.`);

    // Eğer çizen ayrılırsa veya oyuncu kalmazsa
    if (Object.keys(r.players).length === 0) {
      delete rooms[socket.room];
      if (r.interval) clearInterval(r.interval);
    } else if (socket.id === r.drawer) {
      startRound(socket.room); // Çizen ayrılırsa yeni tur başlat
    }
    updateLobby();
  });
});

// Sunucuyu başlatma (Render'ın sağladığı portu kullanır)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor`));