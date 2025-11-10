require("dotenv").config(); // Tambahkan ini jika Anda tes lokal
const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// AMBIL DARI ENVIRONMENT VARIABLE (SAMA SEPERTI bot.js)
// ANDA HARUS SET VIOLET_SECRET_KEY DI PENGATURAN HEROKU (CONFIG VARS)
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;

app.post("/violet-callback", async (req, res) => {
  try {
    const data = req.body;
    const refid = data.ref;

    if (!VIOLET_SECRET_KEY) {
      console.error("❌ VIOLET_SECRET_KEY belum di-set di server callback!");
      return res.status(500).send("Server error");
    }

    // Buat signature verifikasi menggunakan SECRET_KEY
    const signature = crypto
      .createHmac("sha256", VIOLET_SECRET_KEY) // <-- Ganti ke SECRET KEY
      .update(refid)
      .digest("hex");

    // Bandingkan signature
    if (signature === data.signature) {
      if (data.status === "success") {
        console.log("✅ Pembayaran sukses:", data);
        // TODO: update status premium / kirim notifikasi ke Telegram
        // (Misal: Cari user berdasarkan data.ref, update isPremium = true)
      } else {
        console.log(`⚠️ Status callback: ${data.status} (Ref: ${refid})`);
      }
    } else {
      console.log("🚫 Signature callback TIDAK VALID!");
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Error di callback:", err);
    res.status(500).send("Error");
  }
});

// Fix untuk Port Heroku
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Callback server jalan di port ${PORT}`));
