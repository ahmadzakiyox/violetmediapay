const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Telegraf } = require("telegraf");

const app = express();
const PORT = process.env.PORT || 3000; 

// Ambil semua variabel dari Heroku Config Vars
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY; // <-- Digunakan sebagai bagian dari data
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY; // <-- Kunci HMAC
const MONGO_URI = process.env.MONGO_URI;

const bot = new Telegraf(BOT_TOKEN);

// ====== KONEKSI DATABASE & SCHEMA ======
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
// =======================================

app.use(express.json());

// ===== FUNGSI NOTIFIKASI SUKSES (Tidak Berubah) =====
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
// ===================================================

app.post("/violet-callback", async (req, res) => {
  const data = req.body;
  const refid = data.ref_kode || data.ref; 
  const incomingSignature = data.signature;

  try {
    if (!VIOLET_SECRET_KEY || !VIOLET_API_KEY) {
      console.error("❌ Callback: Key tidak lengkap!");
      return res.status(500).send({ status: false, message: "Server API Key Missing" });
    }
    
    if (!refid || !data.nominal) {
        console.error("❌ Callback: Parameter penting (refid atau nominal) tidak ditemukan di body.");
        return res.status(400).send({ status: false, message: "Missing required data" });
    }

    // ====================== PERBAIKAN AKHIR ======================
    // Menerapkan formula transaksi penuh (ref_kode + apikey + amount)
    const dataString = refid + VIOLET_API_KEY + data.nominal;

    const calculatedSignature = crypto
      .createHmac("sha256", VIOLET_SECRET_KEY) 
      .update(dataString) // Data adalah refid + API_KEY + Nominal
      .digest("hex");
    // ============================================================

    if (calculatedSignature === incomingSignature) {
      if (data.status === "success") {
        console.log("✅ Callback SUCCESS diterima. Validasi Signature Berhasil.");
        await sendSuccessNotification(refid, data); 
      } else {
        console.log(`⚠️ Status callback diterima: ${data.status} (Ref: ${refid})`);
      }
    } else {
        console.log(`🚫 Signature callback TIDAK VALID!`);
        console.log(`- Dikirim: ${incomingSignature}`);
        console.log(`- Hitungan Server: ${calculatedSignature}`);
        console.log("--- Signature mismatch ---");
    }

    res.status(200).send({ status: true }); 
    
  } catch (error) {
    console.error("❌ Callback: Error saat memproses callback:", error);
    res.status(500).send({ status: false });
  }
});

app.listen(PORT, () => console.log(`🚀 Callback server jalan di port ${PORT}`));
