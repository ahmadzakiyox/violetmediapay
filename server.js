const path = require('path');
const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { URLSearchParams } = require("url");

require("dotenv").config();

// ========== ENV ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 37761;

// Validasi ENV
if (!BOT_TOKEN || !MONGO_URI || !VIOLET_API_KEY || !VIOLET_SECRET_KEY) {
    console.error("❌ ERROR: Pastikan BOT_TOKEN, MONGO_URI, VIOLET_API_KEY, dan VIOLET_SECRET_KEY terisi di .env");
    process.exit(1);
}

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Callback Server Connected to MongoDB"))
    .catch(err => console.error("❌ Mongo Error:", err));

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ========== MODELS ==========
const User = require('./models/User');
const Product = require('./models/Product');
const Transaction = require('./models/Transaction');
// (Pastikan Setting.js juga di-import jika Anda membutuhkannya untuk notifikasi channel)
const Setting = require('./models/Setting'); 

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

async function sendTelegramMessage(userId, msg) {
    if (!BOT_TOKEN) return;
    
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        body: new URLSearchParams({
            chat_id: userId,
            text: msg,
            parse_mode: "Markdown"
        })
    }).catch(e => console.log("[TG SEND ERROR]:", e.message));
}

async function sendChannelNotification(message) {
    const CHANNEL_ID = process.env.CHANNEL_ID;
    if (!CHANNEL_ID) {
        console.warn("[WARN] CHANNEL_ID tidak diatur, notifikasi penjualan/topup dibatalkan.");
        return;
    }

    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            body: new URLSearchParams({
                chat_id: CHANNEL_ID,
                text: message,
                parse_mode: "Markdown"
            })
        });
    } catch (error) {
        console.error(`❌ Gagal mengirim notifikasi ke channel ${CHANNEL_ID}: ${error.message}`);
    }
}

function formatUptime(seconds) {
    function pad(s) {
        return (s < 10 ? '0' : '') + s;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${pad(hours)}h ${pad(minutes)}m ${pad(secs)}s`;
}

async function deliverProductAndNotify(userId, productId, transaction, product) {
    try {
        // Logika pengiriman (mengambil 1 stok)
        // (Harus identik dengan fungsi deliverProduct di bot.js)
        const productData = await Product.findById(productId);

        if (!productData || productData.kontenProduk.length === 0) {
            console.warn(`[DELIVER-CB] Stok habis saat callback untuk ID: ${productId}`);
            // Kirim notif ke admin jika stok habis saat pengiriman?
            const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
            if (ADMIN_IDS.length > 0) {
                sendTelegramMessage(ADMIN_IDS[0], `⚠️ [ADMIN CALLBACK] User ${userId} membeli ${productData?.namaProduk} TAPI STOK HABIS saat dieksekusi! (Ref: ${transaction.refId})`);
            }
            return sendTelegramMessage(
                userId,
                `⚠️ Pembelian Berhasil (Ref: \`${transaction.refId}\`), namun stok konten habis. Harap hubungi Admin.`
            );
        }

        const deliveredContent = productData.kontenProduk.shift(); // Ambil 1 konten

        // Update DB: kurangi stok & konten, tambah terjual
        await Product.updateOne({ _id: productId }, {
            $set: { kontenProduk: productData.kontenProduk },
            $inc: { stok: -1, totalTerjual: 1 }
        });
        
        // Dapatkan stok terbaru (stok awal - 1)
        const stokAkhir = productData.kontenProduk.length; // Ini adalah stok akhir
        const stokAwal = stokAkhir + 1; // Ini adalah stok awal sebelum .shift()

        // Kirim notifikasi ke Channel
        const notifMessage = `🎉 **PENJUALAN BARU (QRIS)** 🎉\n\n` +
                           `👤 **Pembeli:** [${transaction.userId}](tg://user?id=${transaction.userId})\n` + // Asumsi user ada
                           `🛍️ **Produk:** \`${product.namaProduk}\`\n` +
                           `💰 **Total:** \`Rp ${product.harga.toLocaleString('id-ID')}\`\n\n` +
                           `--- *Info Tambahan* ---\n` +
                           `📦 **Sisa Stok:** \`${stokAkhir}\` pcs (dari ${stokAwal})\n` +
                           `🏦 **Metode:** QRIS (VioletPay)\n` +
                           `🆔 **Ref ID:** \`${transaction.refId}\``;
        await sendChannelNotification(notifMessage);

        // Dapatkan Stiker Sukses
        const stickerSetting = await Setting.findOne({ key: 'success_sticker_id' });
        if (stickerSetting && stickerSetting.value) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendSticker`, {
                method: "POST",
                body: new URLSearchParams({ chat_id: userId, sticker: stickerSetting.value })
            }).catch(e => console.log("Gagal kirim stiker CB:", e.message));
        }

        // Kirim pesan sukses ke user
        const date = new Date();
        const dateCreated = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}, ${date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/:/g, '.')}`;

        let successMessage = `📜 *Pembelian Berhasil*\n`;
        successMessage += `Terimakasih telah Melakukan pembelian di store kami\n\n`;
        successMessage += `*Informasi Pembelian:*\n`;
        successMessage += `— *Total Dibayar:* Rp ${transaction.totalBayar.toLocaleString('id-ID')}\n`;
        successMessage += `— *Date Created:* ${dateCreated}\n`;
        successMessage += `— *Metode Pembayaran:* QRIS (VioletPay)\n`;
        successMessage += `— *Jumlah Item:* 1x\n`;
        successMessage += `— *ID transaksi:* ${transaction.refId}\n\n`;
        successMessage += `*${product.namaProduk}*\n`;
        successMessage += "```txt\n";
        successMessage += `1. ${deliveredContent}\n`;
        successMessage += "```";

        sendTelegramMessage(userId, successMessage);

    } catch (err) {
        console.log("[DELIVER-CB] Error:", err);
        sendTelegramMessage(
            userId,
            `❌ Terjadi kesalahan pengiriman produk (Ref: \`${transaction.refId}\`). Hubungi Admin.`
        );
    }
}

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


    if (!refid) {
        console.log("Ref ID kosong, skip.");
        return res.status(200).send({ status: true });
    }


    if (!refid.startsWith("PROD-") && !refid.startsWith("TOPUP-")) {
        console.log(`⚠ Format ref tidak dikenal: ${refid}. Skip.`);
        return res.status(200).send({ status: true });
    }

    try {
    
        const trx = await Transaction.findOne({ refId: refid });

        if (!trx) {
            console.log(`❌ Transaksi ${refid} tidak ada di DB.`);
            return res.status(200).send({ status: true });
        }

        if (trx.status === "SUCCESS") {
            console.log(`✔ Ref ${refid} sudah sukses, skip.`);
            return res.status(200).send({ status: true });
        }

 
        const expectedSignature = crypto
            .createHmac("sha256", VIOLET_API_KEY)
            .update(refid)
            .digest("hex");

        if (incomingSignature) {
            // Jika signature ADA → harus valid
            if (incomingSignature !== expectedSignature) {
                console.log(`🚫 Signature mismatch. (Ref: ${refid}). Callback ditolak.`);
                console.log(`   Expected: ${expectedSignature}`);
                console.log(`   Received: ${incomingSignature}`);
                return res.status(200).send({ status: true });
            }
            console.log(`✔ Signature VALID (Ref: ${refid})`);
        } else {
            // Jika signature TIDAK ADA → cek IP
            if (!VMP_ALLOWED_IP.has(clientIp)) {
                console.log(`🚫 Signature hilang & IP (${clientIp}) bukan IP resmi → REJECT (Ref: ${refid})`);
                return res.status(200).send({ status: true });
            }
            console.log(`⚠ Signature tidak ada, tapi IP (${clientIp}) resmi → CONTINUE (Ref: ${refid})`);
        }

        if (status === "success") {
            await Transaction.updateOne(
                { refId: refid },
                { status: "SUCCESS", vmpSignature: incomingSignature }
            );

            console.log(`✅ PROSES SUCCESS (Ref: ${refid})`);

            if (trx.produkInfo.type === "TOPUP") {
                await User.updateOne(
                    { userId: trx.userId },
                    { $inc: { saldo: trx.totalBayar, totalTransaksi: 1 } }
                );

                const u = await User.findOne({ userId: trx.userId });
                const saldoAkhir = u ? u.saldo : trx.totalBayar;
           
                const notifMessage = `💰 **TOP-UP SUKSES (QRIS)** 💰\n\n` +
                                   `👤 **User:** [${u.username || trx.userId}](tg://user?id=${trx.userId})\n` +
                                   `💰 **Total:** \`Rp ${trx.totalBayar.toLocaleString('id-ID')}\`\n` +
                                   `🆔 **Ref ID:** \`${trx.refId}\``;
                await sendChannelNotification(notifMessage);
                
                const stickerSetting = await Setting.findOne({ key: 'success_sticker_id' });
                if (stickerSetting && stickerSetting.value) {
                    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendSticker`, {
                        method: "POST",
                        body: new URLSearchParams({ chat_id: trx.userId, sticker: stickerSetting.value })
                    }).catch(e => console.log("Gagal kirim stiker CB:", e.message));
                }

              
                sendTelegramMessage(
                    trx.userId,
                    `╭─────────────────────────\n│ 🎉 Top Up Saldo Berhasil!\n│ Saldo kini: Rp ${saldoAkhir.toLocaleString("id-ID")}.\n╰─────────────────────────`
                );
            
    
            } else {
                const product = await Product.findOne({ namaProduk: trx.produkInfo.namaProduk });
                if (product) {
                  
                    await deliverProductAndNotify(trx.userId, product._id, trx, product);
                } else {
                    sendTelegramMessage(trx.userId, `⚠️ Produk \`${trx.produkInfo.namaProduk}\` tidak ditemukan saat pengiriman (Ref: ${refid}). Hubungi Admin.`);
                }
            }
   
        } else if (status === "failed" || status === "expired") {
            await Transaction.updateOne(
                { refId: refid },
                { status: status.toUpperCase() }
            );

            console.log(`❌ PROSES ${status.toUpperCase()} (Ref: ${refid})`);

            sendTelegramMessage(
                trx.userId,
                `❌ *Transaksi ${status.toUpperCase()}!* (Ref: \`${refid}\`)`
            );
        }

        return res.status(200).send({ status: true });

    } catch (err) {
        console.error(`[Callback Error] Ref: ${refid} | Error: ${err.message}`);
        console.error(err); // Log stack trace
        return res.status(200).send({ status: true });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        // 1. Dapatkan data secara paralel
        const [
            totalUsers,
            totalProducts,
            totalTransactions,
            successTransactions,
            pendingTransactions,
            failedTransactions
        ] = await Promise.all([
            User.countDocuments(),
            Product.countDocuments(),
            Transaction.countDocuments(),
            Transaction.countDocuments({ status: 'SUCCESS' }),
            Transaction.countDocuments({ status: 'PENDING' }),
            Transaction.countDocuments({ status: { $in: ['FAILED', 'EXPIRED'] } })
        ]);

        // 2. Dapatkan status DB
        // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
        const dbState = mongoose.connection.readyState;
        let dbStatus = 'DISCONNECTED';
        if (dbState === 1) dbStatus = 'CONNECTED';
        if (dbState === 2) dbStatus = 'CONNECTING';

        // 3. Dapatkan Uptime Server (dari process)
        const uptimeSeconds = process.uptime();
        const uptimeFormatted = formatUptime(uptimeSeconds);

        // 4. Kirim sebagai JSON
        res.json({
            dbStatus: dbStatus,
            serverUptime: uptimeFormatted,
            totalUsers: totalUsers,
            totalProducts: totalProducts,
            totalTransactions: totalTransactions,
            successTransactions: successTransactions,
            pendingTransactions: pendingTransactions,
            failedTransactions: failedTransactions
        });

    } catch (error) {
        console.error("Error fetching stats:", error);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Callback server (Hanya Bot Baru) berjalan di port ${PORT}`);
});
