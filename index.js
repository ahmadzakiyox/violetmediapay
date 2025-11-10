const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Telegraf } = require("telegraf");

const app = express();
const PORT = process.env.PORT || 3000; 

// Ambil semua variabel dari Heroku Config Vars
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY; // Dipakai untuk kunci validasi
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY; // Dipakai untuk membuat transaksi (tidak wajib di sini, tapi bagus jika ada)
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

// ===== FUNGSI NOTIFIKASI SUKSES (Tidak berubah) =====
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
  
  // 1. Ambil Signature dari Header atau Body
  // Nama header seringkali 'x-callback-signature' atau 'X-Signature'
  const incomingSignature = req.headers['x-callback-signature'] || data.signature;

  try {
    if (!VIOLET_API_KEY) {
      console.error("❌ Callback: VIOLET_API_KEY belum diset!");
      return res.status(500).send({ status: false, message: "Server API Key Missing" });
    }
    
    if (!refid) {
        console.error("❌ Callback: Nomor referensi (ref_kode/ref) tidak ditemukan.");
        return res.status(400).send({ status: false, message: "Missing reference ID" });
    }

    // 2. Hitung Signature Lokal
    const calculatedSignature = crypto
      .createHmac("sha256", VIOLET_API_KEY) // Kunci adalah API KEY (Bukan Secret Key)
      .update(refid) 
      .digest("hex");

    // 3. Bandingkan
    if (calculatedSignature === incomingSignature) {
      if (data.status === "success") {
        console.log("✅ Callback SUCCESS diterima. Validasi Signature Berhasil.");
        
        await sendSuccessNotification(refid, data); 

      } else {
        console.log(`⚠️ Status callback diterima: ${data.status} (Ref: ${refid})`);
      }
    } else {
        // Kirim log detail jika gagal
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
