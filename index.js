const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Telegraf } = require("telegraf"); // Digunakan untuk mengirim notifikasi

const app = express();
const PORT = process.env.PORT || 3000; // Port Heroku

// Pastikan variabel ini diset di Heroku Config Vars
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;

// Inisialisasi Bot Client untuk mengirim pesan (bukan untuk menerima)
const bot = new Telegraf(BOT_TOKEN);

// ====== KONEKSI DATABASE & SCHEMA (Diambil dari bot.js) ======
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Callback Server: MongoDB Connected"))
  .catch(err => console.error("❌ Callback Server: MongoDB Error:", err));

const userSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  isPremium: { type: Boolean, default: false },
  refId: String,
  premiumUntil: Date
});
const User = mongoose.model("User", userSchema);
// ==========================================================

app.use(express.json());

// ===== FUNGSI NOTIFIKASI SUKSES (Di dalam server Heroku) =====
async function sendSuccessNotification(refId, transactionData) {
    try {
        // Cari pengguna berdasarkan refId transaksi
        const user = await User.findOne({ refId: refId });

        if (!user) {
            console.error(`❌ Callback: User dengan refId ${refId} tidak ditemukan di DB.`);
            return;
        }

        const telegramId = user.userId;
        const premiumDurationDays = 30; 

        // 1. Hitung tanggal kedaluwarsa baru (Logika yang sama seperti di bot.js)
        let newExpiryDate = user.premiumUntil || new Date();
        if (newExpiryDate < new Date()) {
            newExpiryDate = new Date();
        }
        newExpiryDate.setDate(newExpiryDate.getDate() + premiumDurationDays);

        // 2. Update status pengguna di database
        await User.updateOne(
            { userId: telegramId },
            { 
                isPremium: true,
                premiumUntil: newExpiryDate 
            }
        );

        // 3. Kirim notifikasi sukses menggunakan BOT_TOKEN
        const message = `🎉 *PEMBAYARAN SUKSES!* 🎉\n\n` +
                        `Terima kasih, ${user.username || 'Pengguna'}!\n` +
                        `Transaksi Anda telah berhasil dibayar.\n\n` +
                        `📦 Produk: ${transactionData.produk}\n` +
                        `💰 Nominal: Rp${parseInt(transactionData.nominal).toLocaleString('id-ID')}\n\n` +
                        `🌟 Akses premium Anda diaktifkan hingga: *${newExpiryDate.toLocaleDateString("id-ID")}*.`;
        
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown' });

        console.log(`✅ Callback: Notifikasi sukses dan status premium diupdate untuk user ${telegramId}`);

    } catch (error) {
        console.error("❌ Callback: Error saat mengirim notifikasi sukses:", error);
    }
}
// ==========================================================

app.post("/violet-callback", async (req, res) => {
  const data = req.body;
  const refid = data.ref_kode; // Gunakan ref_kode

  try {
    // 1. Validasi Secret Key
    if (!VIOLET_SECRET_KEY) {
      console.error("❌ Callback: VIOLET_SECRET_KEY belum diset!");
      return res.status(500).send("Server error");
    }

    // 2. Buat dan Bandingkan Signature
    const signature = crypto
      .createHmac("sha256", VIOLET_SECRET_KEY)
      .update(refid) 
      .digest("hex");

    if (signature === data.signature) {
      if (data.status === "success") {
        console.log("✅ Callback SUCCESS diterima.");
        
        // Panggil fungsi notifikasi
        await sendSuccessNotification(refid, data); 

      } else {
        console.log(`⚠️ Status callback diterima: ${data.status} (Ref: ${refid})`);
      }
    } else {
      console.log("🚫 Signature callback TIDAK VALID!");
    }

    // Wajib kirim 200 OK
    res.status(200).send({ status: true }); 
    
  } catch (error) {
    console.error("❌ Callback: Error saat memproses callback:", error);
    res.status(500).send({ status: false });
  }
});

app.listen(PORT, () => console.log(`🚀 Callback server jalan di port ${PORT}`));
