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

// 💡 PENTING: Middleware untuk membaca data yang dikirimkan sebagai form data (urlencoded)
// Ini adalah solusi untuk mengatasi masalah 'signature: undefined' jika payment gateway mengirim sebagai form data.
app.use(express.urlencoded({ extended: true })); 
// =============================


// ===== FUNGSI NOTIFIKASI SUKSES (Logika bisnis) =====
async function sendSuccessNotification(refId, transactionData) {
    try {
        const user = await User.findOne({ refId: refId });
        if (!user) {
            console.error(`❌ Callback: User dengan refId ${refId} tidak ditemukan di DB.`);
            return;
        }

        const telegramId = user.userId;
        const premiumDurationDays = 30; 
        let newExpiryDate = user.premiumUntil || new Date();
        
        // Atur tanggal mulai perpanjangan
        if (newExpiryDate < new Date()) {
            newExpiryDate = new Date();
        }
        newExpiryDate.setDate(newExpiryDate.getDate() + premiumDurationDays);

        // Update status premium di database
        await User.updateOne(
            { userId: telegramId },
            { 
                isPremium: true,
                premiumUntil: newExpiryDate 
            }
        );

        // Menggunakan data dari callback untuk pesan notifikasi
        const nominalDisplayed = transactionData.nominal || transactionData.amount || '0';

        const message = `🎉 *PEMBAYARAN SUKSES!* 🎉\n\n` +
                        `Terima kasih, ${user.username || 'Pengguna'}!\n` +
                        `Transaksi Anda telah berhasil dibayar.\n\n` +
                        `📦 Produk: ${transactionData.produk || 'Akses Premium'}\n` +
                        `💰 Nominal: Rp${parseInt(nominalDisplayed).toLocaleString('id-ID')}\n\n` +
                        `🌟 Akses premium Anda diaktifkan hingga: *${newExpiryDate.toLocaleDateString("id-ID")}*.`;
        
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown' });

        console.log(`✅ Callback: Notifikasi sukses dan status premium diupdate untuk user ${telegramId}`);

    } catch (error) {
        console.error("❌ Callback: Error saat mengirim notifikasi sukses:", error);
    }
}
// ==========================================================

// 🔑 ENDPOINT CALLBACK UTAMA 🔑
app.post("/violet-callback", async (req, res) => {
    // req.body sekarang bisa berupa JSON atau Form Data (urlencoded)
    const data = req.body;
    
    // 1. Ambil refid.
    const refid = data.ref || data.ref_kode; 
    
    // 2. Ambil signature yang dikirim.
    const incomingSignature = data.signature;

    console.log(`--- CALLBACK DITERIMA ---`);
    console.log(`Data Body:`, data);

    try {
        if (!VIOLET_API_KEY) {
            console.error("❌ Callback: VIOLET_API_KEY belum diset!");
            return res.status(500).send({ status: false, message: "Server API Key Missing" });
        }
        
        if (!refid) {
            console.error("❌ Callback: Nomor referensi (ref/ref_kode) tidak ditemukan di body.");
            return res.status(400).send({ status: false, message: "Missing reference ID" });
        }

        // 3. Pembuatan signature (SESUAI DOKUMENTASI Violet Media Pay)
        // Formula: hash_hmac('sha256', $refid, $apikey)
        const calculatedSignature = crypto
            .createHmac("sha256", VIOLET_API_KEY) // Kunci: API KEY
            .update(refid) // Data yang di-hash: refid
            .digest("hex");

        // 4. Bandingkan Signature untuk keamanan
        if (calculatedSignature === incomingSignature) {
            
            // 5. Cek Status Pembayaran
            if (data.status === "success") {
                console.log("✅ Callback SUCCESS diterima. Validasi Signature Berhasil.");
                await sendSuccessNotification(refid, data); 
            } else if (data.status === "failed") {
                console.log(`⚠️ Status callback GAGAL diterima. Ref: ${refid}`);
                // Tambahkan logika untuk transaksi gagal (misalnya, notifikasi ke admin)
            } else {
                 console.log(`⚠️ Status callback diterima: ${data.status} (Ref: ${refid})`);
            }
        } else {
            // Jika Signature tidak valid, JANGAN PROSES
            console.log(`🚫 Signature callback TIDAK VALID!`);
            console.log(`- Dikirim: ${incomingSignature}`);
            console.log(`- Hitungan Server: ${calculatedSignature}`);
            console.log("--- Signature mismatch ---");
        }

        // 6. Wajib mengirim status 200 OK ke Violet Media Pay
        res.status(200).send({ status: true, message: "Callback received and processed" }); 
        
    } catch (error) {
        console.error("❌ Callback: Error saat memproses callback:", error);
        // Kirim 200 OK meskipun ada error internal agar tidak terjadi pengiriman ulang callback.
        res.status(200).send({ status: false, message: "Internal server error during processing" });
    }
});

app.listen(PORT, () => console.log(`🚀 Callback server jalan di port ${PORT}`));
