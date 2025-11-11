// callback_server.js
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const mongoose = require('mongoose');

// Import Telegraf untuk notifikasi
const { Telegraf } = require('telegraf'); 

// Pastikan Anda memuat konfigurasi dari .env
require("dotenv").config();

// ====================================================
// ====== KONFIGURASI & SETUP ======
// ====================================================

const MONGO_URI = process.env.MONGO_URI; 
const VIOLET_API_KEY = process.env.VIOLET_API_KEY;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN; 
const PREMIUM_DURATION_DAYS = 30; // Durasi Premium dalam hari

if (!BOT_TOKEN || !VIOLET_API_KEY || !VIOLET_SECRET_KEY) {
    console.error("❌ ERROR: BOT_TOKEN, VIOLET_API_KEY, atau VIOLET_SECRET_KEY belum diatur di .env");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// --- SETUP MONGODB ---
mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 30000, 
    socketTimeoutMS: 45000 
})
  .then(() => console.log("✅ MongoDB Connected for Callback Server"))
  .catch(err => console.error("❌ MongoDB Error for Callback Server:", err));

// --- Mongoose Schema (Harus sama dengan s.js) ---
const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: { type: String, default: '' },
    isPremium: { type: Boolean, default: false },
    premiumUntil: { type: Date, default: null },
    refId: { type: String, default: null },
    email: { type: String, unique: true, sparse: true } 
});
const User = mongoose.model("User", userSchema);

// --- SETUP EXPRESS ---
const app = express();
// Gunakan PORT dari environment atau default ke 3000
const port = process.env.PORT || 3000; 

// Middleware untuk parsing body dari POST request
// ------------------------------------------------------------------
app.use(bodyParser.urlencoded({ extended: true })); // Untuk form data (standard VMP)
app.use(bodyParser.json()); // PERBAIKAN: Untuk memastikan JSON body juga terparse
// ------------------------------------------------------------------

// ====================================================
// ====== ENDPOINT CALLBACK VIOLET MEDIA PAY ======
// ====================================================

app.post('/violet-callback', async (req, res) => {
    // Pastikan CALLBACK_URL Anda menunjuk ke: SERVER_BASE_URL/violet-callback
    
    // Cek dulu apakah body kosong sebelum destructuring
    if (!req.body || Object.keys(req.body).length === 0) {
        console.error("❌ [ERROR BODY] Callback diterima, tetapi req.body kosong/undefined.");
        // Beri respons 400 agar VMP tidak mengulang callback, tapi log error
        return res.status(400).send('Invalid or Empty Body Received');
    }
    
    const { 
        status, // Status pembayaran: sukses, pending, expired, gagal
        ref_kode, // Ref ID unik yang Anda kirim saat checkout
        nominal, 
        signature,
        pesan_api
    } = req.body; // <-- Error terjadi di sini, kini seharusnya sudah aman
    
    // ... (Sisa kode callback, tidak ada perubahan)

    console.log(`[CALLBACK DITERIMA] Status: ${status}, RefID: ${ref_kode}, Nominal: ${nominal}`);

    // 1. Validasi Signature
    const signatureString = ref_kode + VIOLET_API_KEY + nominal;
    const expectedSignature = crypto
        .createHmac("sha256", VIOLET_SECRET_KEY)
        .update(signatureString)
        .digest("hex");
        
    if (signature !== expectedSignature) {
        console.error(`[VALIDASI GAGAL] Signature tidak cocok untuk RefID: ${ref_kode}`);
        return res.status(401).send('Signature Invalid');
    }

    // 2. Cek Status Pembayaran
    if (status !== 'sukses') {
        console.log(`[STATUS TIDAK SUKSES] Pembayaran RefID ${ref_kode} status: ${status}. Pesan: ${pesan_api}`);
        return res.status(200).send('Callback Received, status is not success'); 
    }

    // 3. Proses Transaksi Sukses
    try {
        // Ambil User ID dari ref_kode (Format: NUXYS:USERNAME:ID:TIMESTAMP)
        const parts = ref_kode.split(':');
        const userId = parseInt(parts[2]); // ID ada di index 2
        
        if (isNaN(userId)) {
            console.error(`[ERROR PARSE ID] Gagal mendapatkan User ID dari RefID: ${ref_kode}`);
            return res.status(400).send('Invalid Ref ID format');
        }
        
        const user = await User.findOne({ userId });

        if (!user) {
            console.error(`[ERROR DB] User dengan ID ${userId} tidak ditemukan di DB.`);
            return res.status(404).send('User Not Found');
        }
        
        // --- LOGIKA PERHITUNGAN TANGGAL PREMIUM ---
        let newExpiryDate = user.premiumUntil || new Date();
        
        if (newExpiryDate < new Date()) {
            newExpiryDate = new Date();
        }
        
        // Tambahkan durasi premium (30 hari)
        newExpiryDate.setDate(newExpiryDate.getDate() + PREMIUM_DURATION_DAYS);
        
        // Perbarui status premium secara atomic
        await User.updateOne(
            { userId: userId },
            { 
                isPremium: true,
                premiumUntil: newExpiryDate,
                refId: null 
            }
        );
        
        // --- KIRIM NOTIFIKASI KE PENGGUNA VIA TELEGRAM ---
        const expiryDateString = newExpiryDate.toLocaleDateString("id-ID", { year: 'numeric', month: 'long', day: 'numeric' });
        console.log(`[PREMIUM AKTIF] User ${userId} berhasil di-upgrade hingga ${expiryDateString}`);

        bot.telegram.sendMessage(userId, 
            `🎉 **Pembayaran Premium Berhasil!** 🎉\n\n` +
            `Akses Premium Anda telah diaktifkan selama ${PREMIUM_DURATION_DAYS} hari.\n` +
            `Berlaku hingga: *${expiryDateString}*.\n\n` +
            `Sekarang Anda bisa menggunakan link pelacakan *tanpa batas*!`, 
            { parse_mode: 'Markdown' }
        ).catch(e => console.error(`Gagal kirim notif premium ke ${userId}:`, e.message));

        // WAJIB: Kirim balasan sukses (Status 200 dan 'SUCCESS') ke VMP
        res.status(200).send('SUCCESS'); 

    } catch (error) {
        console.error("❌ Error saat memproses callback sukses:", error);
        res.status(500).send('Internal Server Error');
    }
});


// Endpoint Root untuk pemeriksaan status sederhana
app.get('/', (req, res) => {
    res.send(`Violet Callback Server berjalan pada port ${port}. Endpoint callback: /violet-callback`);
});

// ====================================================
// ====== BOT LAUNCH ======
// ====================================================

app.listen(port, () => {
    console.log(`🚀 Callback Server berjalan di http://localhost:${port}`);
});

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
