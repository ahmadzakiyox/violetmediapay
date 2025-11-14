// FILE: index.js — VIOLET CALLBACK FIXED VERSION

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { URLSearchParams } = require("url");

require("dotenv").config();

// ========== ENV VARIABLES ==========
const BOT_TOKEN_NEW = process.env.BOT_TOKEN;
const BOT_TOKEN_OLD = process.env.OLD_BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 37761;

if (!BOT_TOKEN_NEW || !VIOLET_API_KEY || !VIOLET_SECRET_KEY || !MONGO_URI) {
    console.error("❌ ENV ERROR: Harap isi env dengan lengkap.");
    process.exit(1);
}

// ========== DATABASE ==========
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Callback Server: MongoDB Connected"))
    .catch(err => console.error("❌ Mongo Error:", err));

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ========== MODELS ==========
const User = require('./models/User');
const Product = require('./models/Product');
const Transaction = require('./models/Transaction');

// ========== HELPER SEND TELEGRAM ==========
async function sendTelegramMessage(token, userId, msg) {
    if (!token) return;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        body: new URLSearchParams({
            chat_id: userId,
            text: msg,
            parse_mode: "Markdown"
        })
    }).catch(e => console.log("TG SEND ERROR:", e.message));
}

// ========== FUNCTION: DELIVER PRODUCT ==========
async function deliverProduct(userId, productId) {
    try {
        const product = await Product.findById(productId);
        if (!product || product.kontenProduk.length === 0) {
            return sendTelegramMessage(
                BOT_TOKEN_NEW,
                userId,
                "⚠️ Produk kosong. Hubungi admin."
            );
        }

        const key = product.kontenProduk.shift();
        await Product.updateOne(
            { _id: productId },
            {
                $set: { kontenProduk: product.kontenProduk },
                $inc: { stok: -1, totalTerjual: 1 }
            }
        );

        return sendTelegramMessage(
            BOT_TOKEN_NEW,
            userId,
            `🎉 *Pembayaran Sukses! Produk Dikirim*\n\n*Produk:* ${product.namaProduk}\n*Konten Anda:* \`${key}\``
        );
    } catch (err) {
        console.error("Deliver error:", err);
        sendTelegramMessage(BOT_TOKEN_NEW, userId,
            "❌ Terjadi kesalahan saat mengirim produk.");
    }
}

// =================================================================
// ===============   CALLBACK VIOLET MEDIA PAY   ====================
// =================================================================

app.post("/violet-callback", async (req, res) => {

    const data = req.body;

    const refid = data.ref || data.ref_id || data.ref_kode;
    const status = (data.status || "").toLowerCase();

    // ============ AMBIL SIGNATURE (BODY / HEADERS) =============
    const incomingSignature =
        data.signature ||
        data.sign ||
        data.sig ||
        req.headers['x-callback-signature'] ||
        req.headers['x-signature'] ||
        req.headers['signature'] ||
        req.headers['x-hmac-sha256'] ||
        null;

    console.log("\n==== CALLBACK MASUK ====");
    console.log("DATA:", data);
    console.log("Ref:", refid);
    console.log("Status:", status);
    console.log("Signature:", incomingSignature);

    if (!refid) {
        console.log("❌ Tidak ada refid");
        return res.status(200).send({ status: true });
    }

    try {
        // =========================================================
        //          BOT BARU (PROD- / TOPUP-) SIGNATURE FIX
        // =========================================================
        if (refid.startsWith("PROD-") || refid.startsWith("TOPUP-")) {

            const trx = await Transaction.findOne({ refId: refid });

            if (!trx) {
                console.log("❌ Transaksi tidak ditemukan:", refid);
                return res.status(200).send({ status: true });
            }

            if (trx.status === "SUCCESS") {
                console.log("⚠️ Sudah success, skip...");
                return res.status(200).send({ status: true });
            }

            // ============= HITUNG SIGNATURE SESUAI DOCUMENTATION ============
            // PHP: hash_hmac('sha256', $refid, $apikey)
            const expectedSignature = crypto
                .createHmac("sha256", VIOLET_API_KEY)
                .update(refid)
                .digest("hex");

            // ============= VALIDASI SIGNATURE JIKA DIKIRIM ================
            if (incomingSignature) {
                if (incomingSignature !== expectedSignature) {
                    console.log("🚫 Signature mismatch!");
                    console.log("Expected:", expectedSignature);
                    return res.status(200).send({ status: true });
                }
                console.log("✔ Signature VALID");
            } else {
                console.log("⚠ Signature TIDAK dikirim oleh VMP (allowed)");
            }

            // ===============================================================
            // =============== PROCESS STATUS SUCCESS ========================
            // ===============================================================
            if (status === "success") {
                await Transaction.updateOne(
                    { refId: refid },
                    {
                        status: "SUCCESS",
                        vmpSignature: incomingSignature
                    }
                );

                if (trx.produkInfo.type === "TOPUP") {
                    await User.updateOne(
                        { userId: trx.userId },
                        { $inc: { saldo: trx.totalBayar, totalTransaksi: 1 } }
                    );

                    const u = await User.findOne({ userId: trx.userId });

                    sendTelegramMessage(
                        BOT_TOKEN_NEW,
                        trx.userId,
                        `🎉 *Top Up Sukses!*\nSaldo sekarang: *Rp ${u.saldo.toLocaleString("id-ID")}*`
                    );

                } else if (trx.produkInfo.type === "PRODUCT") {
                    const product = await Product.findOne({ namaProduk: trx.produkInfo.namaProduk });
                    if (product) {
                        await deliverProduct(trx.userId, product._id);
                    } else {
                        sendTelegramMessage(BOT_TOKEN_NEW, trx.userId,
                            "⚠️ Produk tidak ditemukan saat pengiriman.");
                    }
                }

                console.log("✔ SUCCESS diproses.");
            }

            // ===============================================================
            // ================= STATUS FAILED / EXPIRED =====================
            // ===============================================================
            else if (status === "failed" || status === "expired") {
                await Transaction.updateOne(
                    { refId: refid },
                    { status: status.toUpperCase() }
                );

                sendTelegramMessage(
                    BOT_TOKEN_NEW,
                    trx.userId,
                    `❌ *Transaksi ${status.toUpperCase()}*`
                );
            }

            return res.status(200).send({ status: true });
        }

        // ===============================================================
        //             BOT LAMA (refid dengan format ':')
        // ===============================================================
        if (refid.includes(":")) {
            console.log("➡ Callback masuk ke BOT LAMA, tidak dihapus.");
            return res.status(200).send({ status: true });
        }

        console.log("⚠ Format ref tidak dikenali.");

        return res.status(200).send({ status: true });

    } catch (err) {
        console.error("❌ ERROR CALLBACK:", err);
        return res.status(200).send({ status: true });
    }
});

// =================================================================
// ========================== SERVER START ==========================
// =================================================================

app.listen(PORT, () => {
    console.log(`🚀 Callback server berjalan di port ${PORT} | /violet-callback`);
});
