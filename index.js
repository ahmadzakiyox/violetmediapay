const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// Ganti dengan API key kamu
const API_KEY = "39QDt7fVWUuPqLsPDAF3XkuDQEKiZkxN9z";

app.post("/violet-callback", async (req, res) => {
  const data = req.body;
  const refid = data.ref;

  // Buat signature verifikasi
  const signature = crypto
    .createHmac("sha256", API_KEY)
    .update(refid)
    .digest("hex");

  if (signature === data.signature && data.status === "success") {
    console.log("✅ Pembayaran sukses:", data);

    // TODO: update status premium / kirim notifikasi ke Telegram
  } else {
    console.log("⚠️ Callback tidak valid atau status bukan success");
  }

  res.status(200).send("OK");
});

app.listen(3000, () => console.log("🚀 Callback server jalan di port 3000"));
