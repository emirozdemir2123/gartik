// Gerekli kütüphaneleri dahil ediyoruz
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server); 

// --- SABİTLER ve OYUN DEĞİŞKENLERİ ---
const MAX_PLAYERS_PER_ROOM = 10;
const ROUND_DURATION = 60; // Saniye
const WORDS = [
    "köpek", "ev", "bilgisayar", "güneş", "telefon", "ayakkabı",
    "gözlük", "araba", "masa", "bardak", "sandalye", "bulut",
    "kedi", "ağaç", "deniz", "kitap"
];

const rooms = {}; 

function selectNewWord() {
    const randomIndex = Math.floor(Math.random() * WORDS.length);
    return WORDS[randomIndex];
}

function getRoomState(roomName) {
    if (!rooms[roomName]) {
        rooms[roomName] = {
            currentWord: selectNewWord(),
            drawerId: null,
            history: [],
            connections: {}, 
            score: {}, // { 'socketId': 50, ... }
            playerCount: 0,
            timer: ROUND_DURATION,
            interval: null, // Zamanlayıcı intervalini tutar
            guessedPlayers: new Set() // Bu turda kelimeyi bilen oyuncular
        };
    }
    return rooms[roomName];
}

function updateLobby() {
    const lobbyData = {};
    for (const name in rooms) {
        const room = rooms[name];
        lobbyData[name] = {
            playerCount: room.playerCount,
            maxPlayers: MAX_PLAYERS_PER_ROOM,
            drawer: room.drawerId ? room.connections[room.drawerId].nickname : "Boş"
        };
    }
    io.emit('lobby update', lobbyData); 
}

// Zamanlayıcıyı başlatma fonksiyonu
function startTimer(roomName) {
    const room = getRoomState(roomName);
    
    // Önceki zamanlayıcıyı temizle
    if (room.interval) {
        clearInterval(room.interval);
    }
    
    room.timer = ROUND_DURATION;
    
    // 1 saniyelik interval
    room.interval = setInterval(() => {
        room.timer--;
        
        // Odaya zamanlayıcı durumunu gönder
        io.to(roomName).emit('timer update', room.timer);
        
        if (room.timer <= 0) {
            clearInterval(room.interval);
            
            // Eğer kimse bilemediyse, çizen de puan alamaz
            io.to(roomName).emit('system message', `Süre doldu! Kelime **${room.currentWord}** idi. Yeni tur başlıyor...`);
            
            // Turu bitir ve yeni tur başlat
            startNewRound(roomName);
        }
    }, 1000);
}

// Yeni tur başlatma fonksiyonu (Odaya özel)
function startNewRound(roomName) {
    const room = getRoomState(roomName);
    
    // Eğer sadece bir kişi varsa tur başlamasın
    if (room.playerCount <= 1) {
        room.drawerId = null;
        if (room.interval) clearInterval(room.interval);
        io.to(roomName).emit('system message', `Oyun için en az 2 oyuncu gerekli. Yeni oyuncu bekleniyor.`);
        updateLeaderboard(roomName);
        return;
    }
    
    // --- TUR BAŞLANGICI ---
    
    room.currentWord = selectNewWord();
    room.history = [];
    room.guessedPlayers = new Set(); // Yeni turda tahmin edenleri temizle
    io.to(roomName).emit('clear canvas'); 

    
    // 1. Yeni Çizeni Belirle (Sıra mantığı: Şu anki çizenin sıradaki komşusu)
    const ids = Object.keys(room.connections);
    let nextDrawerId;

    if (room.drawerId) {
        // Mevcut çizenin dizideki indeksini bul
        const currentIndex = ids.indexOf(room.drawerId);
        // Bir sonraki indeksi seç (son oyuncu ise başa dön)
        const nextIndex = (currentIndex + 1) % ids.length;
        nextDrawerId = ids[nextIndex];
    } else {
        // İlk tur ise rastgele birini seç
        nextDrawerId = ids[Math.floor(Math.random() * ids.length)]; 
    }

    room.drawerId = nextDrawerId;
    
    // Çizim durumlarını gönder
    io.to(room.drawerId).emit('draw state', { isDrawer: true, word: room.currentWord });
    
    // Diğer tüm oyunculara izleme durumunu gönder
    ids.forEach(id => {
        if (id !== room.drawerId) {
            io.to(id).emit('draw state', { isDrawer: false });
        }
    });

    // Genel oyun durumunu gönder
    io.to(roomName).emit('game state', {
        wordLength: room.currentWord.length,
        drawer: room.connections[room.drawerId].nickname
    });
    
    io.to(roomName).emit('system message', `Yeni Tur Başladı! Sıra **${room.connections[room.drawerId].nickname}**'da. Kelime: ${'_ '.repeat(room.currentWord.length)}`);
    
    updateLeaderboard(roomName);
    startTimer(roomName); // Zamanlayıcıyı başlat
    updateLobby(); 
}

// Puan Tablosunu güncelleme fonksiyonu
function updateLeaderboard(roomName) {
    const room = getRoomState(roomName);
    const leaderboard = [];
    
    for (const id in room.connections) {
        leaderboard.push({
            nickname: room.connections[id].nickname,
            score: room.score[id] || 0
        });
    }

    // Skora göre sırala (yüksekten düşüğe)
    leaderboard.sort((a, b) => b.score - a.score);
    
    io.to(roomName).emit('leaderboard update', leaderboard);
}


// --- EXPRESS VE STATİK DOSYALAR ---
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- SOCKET.IO BAĞLANTILARI ---
io.on('connection', (socket) => {
    
    updateLobby(); 
    
    socket.on('join room', (data) => {
        const nickname = data.nickname;
        const roomName = data.room;

        if (!roomName || !nickname) {
            socket.emit('join error', 'Geçersiz isim veya oda.');
            return;
        }

        const room = getRoomState(roomName);

        if (room.playerCount >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('join error', `Oda (${roomName}) dolu. Maksimum ${MAX_PLAYERS_PER_ROOM} kişi.`);
            return;
        }

        // Odaya Katılma İşlemi
        socket.join(roomName);
        socket.nickname = nickname;
        socket.room = roomName;

        room.connections[socket.id] = { nickname: nickname, id: socket.id };
        room.score[socket.id] = room.score[socket.id] || 0; // Skoru sıfırla/başlat
        room.playerCount++; 

        console.log(`${nickname} (${roomName}) bağlandı.`);
        
        socket.emit('joined', roomName);

        io.to(socket.id).emit('drawing history', room.history);
        
        
        // Oyun başlamıyorsa (ilk kişi)
        if (room.playerCount === 1) {
            io.to(roomName).emit('system message', `Oyunun başlaması için en az 2 oyuncu gerekiyor.`);
        }
        
        // Eğer 2. kişi ise veya tur devam ediyorsa
        if (room.playerCount >= 2 && room.drawerId === null) {
            // İlk oyuncu bağlandıysa, turu hemen başlat
            startNewRound(roomName);
            return;
        } 
        
        // Tur devam ediyorsa güncel durumu gönder
        if (room.drawerId) {
             // Yeni gelen çizense, kelimesini gönder
            io.to(socket.id).emit('draw state', { 
                isDrawer: socket.id === room.drawerId, 
                word: socket.id === room.drawerId ? room.currentWord : undefined
            });

             // Genel oyun durumunu gönder
            io.to(socket.id).emit('game state', {
                wordLength: room.currentWord.length,
                drawer: room.connections[room.drawerId].nickname
            });
            // Yeni gelen oyuncuya kalan süreyi gönder
            io.to(socket.id).emit('timer update', room.timer);
        }


        io.to(roomName).emit('system message', `${nickname} oyuna katıldı.`);
        updateLeaderboard(roomName);
        updateLobby();
    });
    
    // Çizim Verilerini Senkronize Etme
    socket.on('draw', (data) => {
        if (!socket.room) return;
        const room = getRoomState(socket.room);
        if (socket.id === room.drawerId) { 
            room.history.push(data);
            socket.to(socket.room).emit('draw', data); 
        }
    });

    // Tuvali Temizleme İsteğini İşleme
    socket.on('clear canvas', () => {
        if (!socket.room) return;
        const room = getRoomState(socket.room);
        if (socket.id === room.drawerId) { 
            room.history = [];
            io.to(socket.room).emit('clear canvas'); 
        }
    });

    // Sohbet ve Tahmin Mesajlarını İşleme
    socket.on('chat message', (msg) => {
        if (!socket.room) return;
        const room = getRoomState(socket.room);
        const guess = msg.trim().toLowerCase();
        const correctWord = room.currentWord.toLowerCase();
        
        if (socket.id === room.drawerId) {
             // Çizenin mesajını normal sohbete aktar
             io.to(socket.room).emit('chat message', `${socket.nickname}: ${msg}`);
             return;
        }
        
        if (guess === correctWord) {
            if (room.guessedPlayers.has(socket.id)) {
                 // Zaten tahmin ettiyse bir şey yapma
                 io.to(socket.room).emit('chat message', `${socket.nickname}: ${msg}`);
                 return;
            }
            
            // --- PUANLAMA MANTIĞI ---
            
            // 1. Bilene Puan
            room.score[socket.id] += 5; // Bilene 5 puan
            room.guessedPlayers.add(socket.id); // Tahmin edenler listesine ekle
            
            // 2. Çizene Puan (Kelimeyi bilen herkes çizene 3 puan kazandırır)
            room.score[room.drawerId] += 3; // Çizene 3 puan
            
            
            io.to(socket.room).emit('system message', `🎉 **${socket.nickname}** kelimeyi bildi! Kelime: **${room.currentWord}**`);
            updateLeaderboard(socket.room);
            
            // Eğer tahmin edenler sayısı (toplam oyuncu - çizen) sayısına ulaşırsa tur bitsin
            if (room.guessedPlayers.size >= room.playerCount - 1) {
                io.to(socket.room).emit('system message', `Tüm oyuncular kelimeyi bildi! Yeni tur başlıyor...`);
                clearInterval(room.interval); // Zamanlayıcıyı durdur
                setTimeout(() => startNewRound(socket.room), 3000); // 3 saniye sonra yeni tur
            }
            
            // Kelimeyi bilen oyuncu için özel bildirim (Diğer bilmeyenler tahmin etmeye devam etmeli)
            io.to(socket.id).emit('system message', `Tebrikler! +5 Puan kazandın.`);

        } else {
            // Yanlış Tahmin veya Normal Sohbet
            io.to(socket.room).emit('chat message', `${socket.nickname}: ${msg}`);
        }
    });

    // Kullanıcı ayrıldığında
    socket.on('disconnect', () => {
        if (!socket.room) return;
        
        const room = getRoomState(socket.room);
        const disconnectedNickname = socket.nickname;

        if (room.connections[socket.id]) {
            delete room.connections[socket.id];
            room.playerCount--; 
            
            io.to(socket.room).emit('system message', `${disconnectedNickname} oyundan ayrıldı.`);

            // Ayrılan kişi çizen ise veya oyuncu sayısı 2'nin altına düşerse
            if (socket.id === room.drawerId || room.playerCount < 2) {
                startNewRound(socket.room);
            } else {
                 updateLeaderboard(socket.room);
            }
        }
        
        // Eğer oda tamamen boşalırsa
        if (room.playerCount <= 0) {
            delete rooms[socket.room];
            if (room.interval) clearInterval(room.interval);
        }
        updateLobby(); 
    });
});

// Sunucuyu 3000 portunda başlat
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
});