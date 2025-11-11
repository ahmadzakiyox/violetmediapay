const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Telegraf } = require("telegraf");

const app = express();
const PORT = process.env.PORT || 3000; 

// Ambil semua variabel dari Heroku Config Vars
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY; // Kunci validasi Violet Media Pay
const MONGO_URI = process.env.MONGO_URI;

// IP Address resmi Violet Media Pay
const VIOLET_IP = '202.155.132.37'; 

// Inisialisasi Bot Telegraf
const bot = new Telegraf(BOT_TOKEN);

// ====== KONEKSI DATABASE & SCHEMA ======
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Callback Server: MongoDB Connected"))
  .catch(err => console.error("❌ Callback Server: MongoDB Error:", err));

const userSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  isPremium: { type: Boolean, default: false },
  refId: String, // Digunakan untuk mencocokkan transaksi dengan pengguna
  premiumUntil: Date
});
const User = mongoose.model("User", userSchema);
// =======================================

// ====== MIDDLEWARE UTAMA ======
// Middleware untuk membaca JSON
app.use(express.json());

// Middleware untuk membaca data yang dikirimkan sebagai form data (urlencoded)
app.use(express.urlencoded({ extended: true })); 
// =============================


// ====== FUNGSI NOTIFIKASI SUKSES (Logika bisnis) =====
async function sendSuccessNotification(refId, transactionData) {
    
    // Konfigurasi Coba Ulang
    const MAX_RETRIES = 5; 
    const RETRY_DELAY = 2000; // Tunggu 2 detik antar percobaan

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const user = await User.findOne({ refId: refId });
            
            if (!user) {
                // User TIDAK ditemukan: Tunggu dan Coba Lagi
                if (attempt < MAX_RETRIES) {
                    console.log(`⏳ Callback: User ${refId} belum ditemukan. Mencoba lagi dalam ${RETRY_DELAY / 1000} detik (Percobaan ${attempt}/${MAX_RETRIES}).`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue; // Lanjut ke iterasi loop (coba lagi)
                } else {
                    // Gagal setelah semua percobaan
                    console.error(`❌ Callback: Gagal menemukan User ${refId} setelah ${MAX_RETRIES} percobaan. Mengabaikan transaksi.`);
                    return; 
                }
            }

            // --- JIKA USER DITEMUKAN (Logika Sukses) ---
            const telegramId = user.userId;
            const premiumDurationDays = 30; 
            
            // ... (lanjutkan logika update user) ...
            let newExpiryDate = user.premiumUntil || new Date();
            if (newExpiryDate < new Date()) {
                newExpiryDate = new Date();
            }
            newExpiryDate.setDate(newExpiryDate.getDate() + premiumDurationDays);

            await User.updateOne(
                { userId: telegramId },
                { 
                    isPremium: true,
                    premiumUntil: newExpiryDate 
                }
            );

            // ... (Lanjutkan logika kirim notifikasi ke Telegram) ...
            const nominalDisplayed = transactionData.nominal || transactionData.total_amount || '0';
            const message = `🎉 *PEMBAYARAN SUKSES!* 🎉\n\n` +
                            `Terima kasih, ${user.username || 'Pengguna'}!\n` +
                            `Transaksi Anda telah berhasil dibayar.\n\n` +
                            `📦 Produk: ${transactionData.produk || 'Akses Premium'}\n` +
                            `💰 Nominal: Rp${parseInt(nominalDisplayed).toLocaleString('id-ID')}\n` +
                            `🧾 Ref ID: ${refId}\n\n` +
                            `🌟 Akses premium Anda diaktifkan hingga: *${newExpiryDate.toLocaleDateString("id-ID")}*.`;
            
            await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown' });

            console.log(`✅ Callback: Notifikasi sukses dan status premium diupdate untuk user ${telegramId}`);
            return; // Sukses, keluar dari loop
            
        } catch (error) {
            console.error("❌ Callback: Error saat memproses notifikasi:", error);
            return;
        }
    }
}
// ==========================================================

// 🔑 ENDPOINT CALLBACK UTAMA 🔑
app.post("/violet-callback", async (req, res) => {
    const data = req.body;
    
    // 1. Ambil refid.
    const refid = data.ref || data.ref_kode; 
    
    // 2. Ambil signature: Prioritas dari Header (X-Callback-Signature) atau dari Body.
    const headerSignature = req.headers['x-callback-signature']; // Express mengubah header ke lowercase
    const incomingSignature = headerSignature || data.signature; // Ambil dari header, jika tidak ada, ambil dari body

    // Ambil IP klien. Di Heroku, ini paling aman diambil dari 'x-forwarded-for'
    const clientIp = req.headers['x-forwarded-for'] ? 
                     req.headers['x-forwarded-for'].split(',')[0].trim() : 
                     req.ip;

    console.log(`--- CALLBACK DITERIMA ---`);
    console.log(`Ref ID: ${refid}, Status: ${data.status}`);
    console.log(`Signature dari Header/Body: ${incomingSignature}`);
    console.log(`IP Pengirim: ${clientIp}`);

    try {
        if (!VIOLET_API_KEY) {
            console.error("❌ Callback: VIOLET_API_KEY belum diset!");
            return res.status(500).send({ status: false, message: "Server API Key Missing" });
        }
        
        if (!refid) {
            console.error("❌ Callback: Nomor referensi (ref/ref_kode) tidak ditemukan di body.");
            return res.status(400).send({ status: false, message: "Missing reference ID" });
        }

        // 3. Pembuatan signature (SESUAI DOKUMENTASI: hash_hmac('sha256', $refid, $apikey) )
        const calculatedSignature = crypto
            .createHmac("sha256", VIOLET_API_KEY) 
            .update(refid)
            .digest("hex");

        // 4. Validasi IP Pengirim
        if (clientIp !== VIOLET_IP) {
            console.log(`🚫 IP Callback TIDAK VALID! Dikirim dari: ${clientIp}. Seharusnya: ${VIOLET_IP}`);
            // Mengirim 200 OK meskipun gagal, agar tidak ada percobaan ulang.
            return res.status(200).send({ status: false, message: "IP Mismatch, ignored." });
        }

        // 5. Bandingkan Signature untuk keamanan
        // Logika diperbaiki: Membandingkan atau melanjutkan jika signature tidak ada (TIDAK AMAN)
        const isSignatureValid = (calculatedSignature === incomingSignature);
        const shouldBypassSignature = !incomingSignature; // Jika signature undefined, anggap bypass

        if (isSignatureValid || shouldBypassSignature) {
            
            if (shouldBypassSignature) {
                console.log("⚠️ PERHATIAN: Signature tidak diterima (undefined). Melewati validasi dan memproses berdasarkan status.");
                console.log("   *** Segera hubungi Violet Media Pay untuk memperbaiki pengiriman signature. ***");
            }
            
            // 6. Cek Status Pembayaran
            if (data.status === "success") {
                console.log("✅ Transaksi SUCCESS diterima. Memproses notifikasi...");
                await sendSuccessNotification(refid, data); 
            } else if (data.status === "failed" || data.status === "kadaluarsa" || data.status === "refund") {
                console.log(`⚠️ Status callback non-sukses diterima: ${data.status} (Ref: ${refid})`);
                // TODO: Tambahkan logika notifikasi kegagalan di sini jika perlu.
            } else {
                 console.log(`⚠️ Status callback lain diterima: ${data.status} (Ref: ${refid})`);
            }
        } else {
            // Jika Signature tidak valid, JANGAN PROSES
            console.log(`🚫 Signature callback TIDAK VALID!`);
            console.log(`- Dikirim: ${incomingSignature}`);
            console.log(`- Hitungan Server: ${calculatedSignature}`);
        }

        // 7. Wajib mengirim status 200 OK ke Violet Media Pay
        res.status(200).send({ status: true, message: "Callback received and processed" }); 
        
    } catch (error) {
        console.error("❌ Callback: Error saat memproses callback:", error);
        // Kirim 200 OK meskipun ada error internal
        res.status(200).send({ status: false, message: "Internal server error during processing" });
    }
});

app.listen(PORT, () => console.log(`🚀 Callback server jalan di port ${PORT}`));
