// callback.js
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

const API_KEY = "FCm5Xfjt52D2BdcpR2F91TOt1Y1TkzbW";

app.post("/violet-callback", async (req, res) => {
  const data = req.body;
  const refid = data.ref;
  const signature = crypto
    .createHmac("sha256", API_KEY)
    .update(refid)
    .digest("hex");

  if (signature === data.signature && data.status === "success") {
    console.log("Pembayaran sukses:", data);

    // TODO: update database atau kirim pesan ke Telegram
    // misalnya update user premium status
  }

  res.status(200).send("OK");
});

app.listen(3000, () => console.log("Callback server jalan di port 3000"));
