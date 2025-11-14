// FILE: index.js — VIOLET CALLBACK (MEDIUM SECURITY MODE)

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { URLSearchParams } = require("url");

require("dotenv").config();

// ========== ENV ==========
const BOT_TOKEN_NEW = process.env.BOT_TOKEN;
const BOT_TOKEN_OLD = process.env.OLD_BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 37761;

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Callback Server Connected"))
    .catch(err => console.error("❌ Mongo Error:", err));

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ========== MODELS ==========
const User = require('./models/User');
const Product = require('./models/Product');
const Transaction = require('./models/Transaction');

// ✓ WHITELIST IP VIOLET MEDIAPAY
const VMP_ALLOWED_IP = new Set([
    "202.155.132.37",        // IPv4 resmi
    "2001:df7:5300:9::122"   // IPv6 resmi
]);

function getClientIp(req) {
    return (
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        "UNKNOWN"
    );
}

// ========== SEND TELEGRAM ==========
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

// ========== DELIVER PRODUCT ==========
async function deliverProduct(userId, productId) {
    try {
        const product = await Product.findById(productId);

        if (!product || product.kontenProduk.length === 0) {
            return sendTelegramMessage(
                BOT_TOKEN_NEW,
                userId,
                "⚠️ Produk sedang kosong, hubungi Admin!"
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

        sendTelegramMessage(
            BOT_TOKEN_NEW,
            userId,
            `🎉 *Produk Berhasil Dikirim!*\n\n*Produk:* ${product.namaProduk}\n*Konten:* \`${key}\``
        );
    } catch (err) {
        console.log("Deliver error:", err);
        sendTelegramMessage(
            BOT_TOKEN_NEW,
            userId,
            "❌ Terjadi kesalahan pengiriman produk."
        );
    }
}

// ====================================================================
// ======================= MEDIUM SECURITY CALLBACK ===================
// ====================================================================

app.post("/violet-callback", async (req, res) => {
    const data = req.body;

    const refid = data.ref || data.ref_id || data.ref_kode;
    const status = (data.status || "").toLowerCase();

    const incomingSignature =
        data.signature ||
        data.sign ||
        data.sig ||
        req.headers["x-callback-signature"] ||
        req.headers["x-signature"] ||
        req.headers["signature"] ||
        req.headers["x-hmac-sha256"] ||
        null;

    const clientIp = getClientIp(req);

    console.log("\n====== CALLBACK MASUK ======");
    console.log("IP:", clientIp);
    console.log("REF:", refid);
    console.log("STATUS:", status);
    console.log("SIGNATURE:", incomingSignature);

    if (!refid) return res.status(200).send({ status: true });

    try {
        // BOT BARU
        if (refid.startsWith("PROD-") || refid.startsWith("TOPUP-")) {

            const trx = await Transaction.findOne({ refId: refid });

            if (!trx) {
                console.log("❌ Transaksi tidak ada.");
                return res.status(200).send({ status: true });
            }

            if (trx.status === "SUCCESS") {
                console.log("✔ Sudah sukses, skip");
                return res.status(200).send({ status: true });
            }

            // ========== HITUNG SIGNATURE SESUAI DOK VMP ==========
            // hash_hmac('sha256', $refid, $apikey)
            const expectedSignature = crypto
                .createHmac("sha256", VIOLET_API_KEY)
                .update(refid)
                .digest("hex");

            // ===================================================================
            // =================== MEDIUM SECURITY VALIDATION ====================
            // ===================================================================

            if (incomingSignature) {
                // Jika signature ADA → harus valid
                if (incomingSignature !== expectedSignature) {
                    console.log("🚫 Signature mismatch. Callback ditolak.");
                    return res.status(200).send({ status: true });
                }
                console.log("✔ Signature VALID");
            } else {
                // Jika signature TIDAK ADA → cek IP
                if (!VMP_ALLOWED_IP.has(clientIp)) {
                    console.log("🚫 Signature hilang & IP bukan IP resmi → REJECT");
                    return res.status(200).send({ status: true });
                }
                console.log("⚠ Signature tidak ada, tapi IP resmi → CONTINUE");
            }

            // ===================================================================
            //                             SUCCESS
            // ===================================================================
            if (status === "success") {
                await Transaction.updateOne(
                    { refId: refid },
                    { status: "SUCCESS", vmpSignature: incomingSignature }
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
                        `🎉 *Top Up Berhasil!*\nSaldo sekarang: *Rp ${u.saldo.toLocaleString("id-ID")}*`
                    );
                } else {
                    const product = await Product.findOne({ namaProduk: trx.produkInfo.namaProduk });
                    if (product) deliverProduct(trx.userId, product._id);
                    else sendTelegramMessage(BOT_TOKEN_NEW, trx.userId, "⚠️ Produk tidak ditemukan saat pengiriman.");
                }
            }

            // ===================================================================
            //                        FAILED / EXPIRED
            // ===================================================================
            else if (status === "failed" || status === "expired") {
                await Transaction.updateOne(
                    { refId: refid },
                    { status: status.toUpperCase() }
                );

                sendTelegramMessage(
                    BOT_TOKEN_NEW,
                    trx.userId,
                    `❌ *Transaksi ${status.toUpperCase()}!*`
                );
            }

            return res.status(200).send({ status: true });
        }

        // BOT LAMA
        if (refid.includes(":")) {
            console.log("➡ Callback BOT LAMA");
            return res.status(200).send({ status: true });
        }

        console.log("⚠ Format ref tidak dikenal.");
        return res.status(200).send({ status: true });

    } catch (err) {
        console.error("Callback Error:", err);
        return res.status(200).send({ status: true });
    }
});


// ========== START SERVER ==========
app.listen(PORT, () => {
    console.log(`🚀 Callback server berjalan di port ${PORT}`);
});
