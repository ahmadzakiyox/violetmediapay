const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Telegraf } = require("telegraf"); 
const path = require('path'); 

// PENTING: Memastikan environment variables dimuat saat file ini dijalankan
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000; 

// --- KONFIGURASI DARI ENVIRONMENT VARIABLES ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY; 
const MONGO_URI = process.env.MONGO_URI;
const VIOLET_IP = '202.155.132.37'; 
// ----------------------------------------------------------------

// ====== KONEKSI DATABASE & SCHEMA ======

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Callback Server: MongoDB Connected"))
  .catch(err => console.error("❌ Callback Server: MongoDB Error:", err));

// Inisialisasi Bot untuk mengirim notifikasi
const bot = new Telegraf(BOT_TOKEN); 

// Skema harus sama persis dengan yang ada di file bot utama
const userSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  isPremium: { type: Boolean, default: false },
  // PERBAIKAN: refId memiliki indeks untuk pencarian cepat
  refId: { type: String, index: true }, 
  premiumUntil: Date,
  email: { type: String, unique: true, sparse: true }
});

const User = mongoose.models.User || mongoose.model("User", userSchema);


// ====== MIDDLEWARE UTAMA ======
// Middleware untuk membaca JSON dan URL-encoded data dari callback
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 


// ====== FUNGSI NOTIFIKASI SUKSES (DENGAN RETRY LOGIC & UPSERT) =====
async function sendSuccessNotification(refId, transactionData) {

    // 1. Mengurai Ref ID untuk mendapatkan informasi user
    // Format: PREFIX:username:userId:TIMESTAMP
    const refIdParts = refId.split(':');
    if (refIdParts.length < 3) {
        console.error(`❌ Callback: Ref ID tidak valid: ${refId}`);
        return;
    }
    const telegramUsername = refIdParts[1];
    const telegramId = parseInt(refIdParts[2]);

    if (isNaN(telegramId)) {
        console.error(`❌ Callback: Tidak dapat mengurai telegramId dari Ref ID: ${refId}`);
        return;
    }

    // Konfigurasi Coba Ulang (Mengatasi Race Condition/Keterlambatan data)
    const MAX_RETRIES = 5;
    const RETRY_DELAY = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Coba Cari user berdasarkan refId ATAU userId
            let user = await User.findOne({
                $or: [
                    { refId: refId },
                    { userId: telegramId } // Cari berdasarkan userId sebagai fallback
                ]
            });

            if (!user) {
                // User TIDAK ditemukan: Tunggu dan Coba Lagi
                if (attempt < MAX_RETRIES) {
                    console.log(`⏳ Callback: User ${refId} belum ditemukan. Mencoba lagi dalam ${RETRY_DELAY / 1000} detik (Percobaan ${attempt}/${MAX_RETRIES}).`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue;
                } else {
                    // Jika sudah percobaan terakhir dan tetap tidak ditemukan, lakukan UPSERT
                    console.log(`⚠️ Callback: User ${refId} belum ditemukan setelah ${MAX_RETRIES} percobaan. Mencoba membuat/update data user via UPSERT.`);

                    // 2. Lakukan UPSERT (Cari berdasarkan userId, buat jika tidak ada)
                    const uniqueEmailPlaceholder = `tg_${telegramId}_${Date.now()}@userbot.co`;
                    
                    user = await User.findOneAndUpdate(
                        { userId: telegramId }, // Kriteria pencarian unik
                        {
                            userId: telegramId,
                            username: telegramUsername,
                            refId: refId, // Simpan refId yang berhasil
                            email: uniqueEmailPlaceholder // Pastikan email ada
                        },
                        { new: true, upsert: true, setDefaultsOnInsert: true } // Opsi UPSERT
                    );

                    if (!user) {
                        console.error(`❌ Callback: Gagal membuat/menemukan User ${telegramId} setelah UPSERT. Mengabaikan transaksi.`);
                        return;
                    }
                    console.log(`✅ Callback: User ${telegramId} berhasil dibuat/diupdate via UPSERT.`);
                }
            }

            // --- JIKA USER DITEMUKAN (Logika Sukses) ---
            const premiumDurationDays = 30;

            let newExpiryDate = user.premiumUntil || new Date();
            if (newExpiryDate < new Date()) {
                newExpiryDate = new Date();
            }
            newExpiryDate.setDate(newExpiryDate.getDate() + premiumDurationDays);
            
            // Lakukan update status premium
            await User.updateOne(
                { userId: telegramId },
                {
                    isPremium: true,
                    premiumUntil: newExpiryDate,
                    // Pastikan refId terupdate ke yang terbaru dari transaksi ini
                    refId: refId 
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

            await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown' }).catch(e => console.error("Gagal kirim notif premium:", e.message));

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
    
    const refid = data.ref || data.ref_kode; 
    const headerSignature = req.headers['x-callback-signature'];
    const incomingSignature = headerSignature || data.signature;

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

        // 3. Pembuatan signature 
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
        const isSignatureValid = (calculatedSignature === incomingSignature);
        const shouldBypassSignature = !incomingSignature; 

        if (isSignatureValid || shouldBypassSignature) {
            
            if (shouldBypassSignature) {
                console.log("⚠️ PERHATIAN: Signature tidak diterima (undefined). Melewati validasi dan memproses berdasarkan status.");
                console.log("   *** Segera hubungi Violet Media Pay untuk memperbaiki pengiriman signature. ***");
            }
            
            // 6. Cek Status Pembayaran
            if (data.status === "success") {
                console.log("✅ Transaksi SUCCESS diterima. Memproses notifikasi...");
                await sendSuccessNotification(refid, data); 
            } else if (data.status === "failed" || data.status === "kadaluarsa" || data.status === "refund") {
                console.log(`⚠️ Status callback non-sukses diterima: ${data.status} (Ref: ${refid})`);
            } else {
                 console.log(`⚠️ Status callback lain diterima: ${data.status} (Ref: ${refid})`);
            }
        } else {
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
