// FILE: index.js
// Server Callback + Dashboard API + Log Streaming

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { URLSearchParams } = require("url");
const path = require('path');
const http = require('http'); // Untuk Socket.io
const { Server } = require("socket.io"); // Server Socket.io
const Heroku = require('heroku'); // Klien API Heroku
const stream = require('stream'); // Utility stream Node.js

require("dotenv").config();

// ========== ENV ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 37761;
const HEROKU_API_TOKEN = process.env.HEROKU_API_TOKEN;
const HEROKU_APP_NAME = process.env.HEROKU_APP_NAME;

// Validasi ENV
if (!BOT_TOKEN || !MONGO_URI || !VIOLET_API_KEY || !VIOLET_SECRET_KEY) {
    console.error("❌ ERROR: Pastikan BOT_TOKEN, MONGO_URI, VIOLET_API_KEY, dan VIOLET_SECRET_KEY terisi di .env");
    process.exit(1);
}
if (!HEROKU_API_TOKEN || !HEROKU_APP_NAME) {
    console.warn("⚠️ PERINGATAN: HEROKU_API_TOKEN atau HEROKU_APP_NAME tidak diatur di .env. Streaming log akan dinonaktifkan.");
}

// ========== KONEKSI DB ==========
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Callback Server Connected to MongoDB"))
    .catch(err => console.error("❌ Mongo Error:", err));

// ========== INISIASI SERVER & SOCKET ==========
const app = express();
const server = http.createServer(app); // Buat server HTTP dari Express
const io = new Server(server); // Pasang Socket.io ke server HTTP

// ========== MIDDLEWARE ==========
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// Sajikan file statis dari folder 'public'
app.use(express.static(path.join(__dirname, 'public')));

// ========== MODELS ==========
// Pastikan path ini benar sesuai struktur folder Anda
const User = require('./models/User');
const Product = require('./models/Product');
const Transaction = require('./models/Transaction');
const Setting = require('./models/Setting'); 

// ========== HELPER: IP & TELEGRAM ==========
const VMP_ALLOWED_IP = new Set([
    "202.155.132.37",
    "2001:df7:5300:9::122"
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

// ========== HELPER: PENGIRIMAN PRODUK ==========
async function deliverProductAndNotify(userId, productId, transaction, product) {
    try {
        const productData = await Product.findById(productId);
        if (!productData || productData.kontenProduk.length === 0) {
            console.warn(`[DELIVER-CB] Stok habis saat callback untuk ID: ${productId}`);
            const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
            if (ADMIN_IDS.length > 0) {
                sendTelegramMessage(ADMIN_IDS[0], `⚠️ [ADMIN CALLBACK] User ${userId} membeli ${productData?.namaProduk} TAPI STOK HABIS saat dieksekusi! (Ref: ${transaction.refId})`);
            }
            return sendTelegramMessage(
                userId,
                `⚠️ Pembelian Berhasil (Ref: \`${transaction.refId}\`), namun stok konten habis. Harap hubungi Admin.`
            );
        }

        const deliveredContent = productData.kontenProduk.shift();
        await Product.updateOne({ _id: productId }, {
            $set: { kontenProduk: productData.kontenProduk },
            $inc: { stok: -1, totalTerjual: 1 }
        });
        
        const stokAkhir = productData.kontenProduk.length;
        const stokAwal = stokAkhir + 1;

        const notifMessage = `🎉 **PENJUALAN BARU (QRIS)** 🎉\n\n` +
                           `👤 **Pembeli:** [${transaction.userId}](tg://user?id=${transaction.userId})\n` +
                           `🛍️ **Produk:** \`${product.namaProduk}\`\n` +
                           `💰 **Total:** \`Rp ${product.harga.toLocaleString('id-ID')}\`\n\n` +
                           `--- *Info Tambahan* ---\n` +
                           `📦 **Sisa Stok:** \`${stokAkhir}\` pcs (dari ${stokAwal})\n` +
                           `🏦 **Metode:** QRIS (VioletPay)\n` +
                           `🆔 **Ref ID:** \`${transaction.refId}\``;
        await sendChannelNotification(notifMessage);

        const stickerSetting = await Setting.findOne({ key: 'success_sticker_id' });
        if (stickerSetting && stickerSetting.value) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendSticker`, {
                method: "POST",
                body: new URLSearchParams({ chat_id: userId, sticker: stickerSetting.value })
            }).catch(e => console.log("Gagal kirim stiker CB:", e.message));
        }

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

// ====================================================================
// ===================== RUTE: VIOLET CALLBACK ========================
// ====================================================================
app.post("/violet-callback", async (req, res) => {
    const data = req.body;
    const refid = data.ref || data.ref_id || data.ref_kode;
    const status = (data.status || "").toLowerCase();
    const incomingSignature =
        data.signature || data.sign || data.sig ||
        req.headers["x-callback-signature"] || req.headers["x-signature"] ||
        req.headers["signature"] || req.headers["x-hmac-sha256"] || null;
    const clientIp = getClientIp(req);

    console.log("\n====== CALLBACK MASUK ======");
    console.log("IP:", clientIp);
    console.log("REF:", refid);
    console.log("STATUS:", status);

    if (!refid) return res.status(200).send({ status: true });
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
            if (incomingSignature !== expectedSignature) {
                console.log(`🚫 Signature mismatch. (Ref: ${refid}). Ditolak.`);
                return res.status(200).send({ status: true });
            }
            console.log(`✔ Signature VALID (Ref: ${refid})`);
        } else {
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
                    sendTelegramMessage(trx.userId, `⚠️ Produk \`${trx.produkInfo.namaProduk}\` tidak ditemukan (Ref: ${refid}). Hubungi Admin.`);
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
        return res.status(200).send({ status: true });
    }
});

// ====================================================================
// ===================== RUTE: DASHBOARD API ==========================
// ====================================================================

function formatUptime(seconds) {
    function pad(s) { return (s < 10 ? '0' : '') + s; }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${pad(hours)}h ${pad(minutes)}m ${pad(secs)}s`;
}

app.get('/api/stats', async (req, res) => {
    try {
        const [
            totalUsers, totalProducts, totalTransactions,
            successTransactions, pendingTransactions, failedTransactions
        ] = await Promise.all([
            User.countDocuments(),
            Product.countDocuments(),
            Transaction.countDocuments(),
            Transaction.countDocuments({ status: 'SUCCESS' }),
            Transaction.countDocuments({ status: 'PENDING' }),
            Transaction.countDocuments({ status: { $in: ['FAILED', 'EXPIRED'] } })
        ]);

        const dbState = mongoose.connection.readyState;
        let dbStatus = 'DISCONNECTED';
        if (dbState === 1) dbStatus = 'CONNECTED';
        if (dbState === 2) dbStatus = 'CONNECTING';

        const uptimeSeconds = process.uptime();
        const uptimeFormatted = formatUptime(uptimeSeconds);

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

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ====================================================================
// ================= LOGIKA: SOCKET.IO LOG STREAM =====================
// ====================================================================

// Jadikan fungsi callback ini 'async' untuk menunggu stream
io.on('connection', async (socket) => {
    console.log('🔌 Dashboard Admin terhubung via WebSocket');
    socket.emit('log', { line: '=== [Log Stream] Berhasil terhubung ke server WebSocket ===\n', source: 'server' });

    // Cek apakah variabel .env ada
    if (HEROKU_API_TOKEN && HEROKU_APP_NAME) {
        try {
            // 1. Inisialisasi klien Heroku
            const heroku = new Heroku({ token: HEROKU_API_TOKEN });
            
            console.log(`📡 Meminta stream log dari Heroku untuk: ${HEROKU_APP_NAME}...`);
            
            // 2. Minta stream log (100 baris terakhir & stream baru)
            const logStream = await heroku.stream(
                `/apps/${HEROKU_APP_NAME}/log-stream?tail=true&lines=100`
            );

            console.log(`✅ Stream log terhubung.`);

            // 3. Buat 'logProcessor' untuk menangani chunk stream
            const logProcessor = new stream.Transform({
                _lastLineData: '', // Simpan sisa data dari chunk sebelumnya
                
                transform(chunk, encoding, callback) {
                    // Gabungkan sisa data lama dengan chunk baru, lalu pisah per baris
                    let data = (this._lastLineData + chunk.toString('utf8')).split('\n');
                    
                    // Baris terakhir adalah sisa data baru (mungkin tidak utuh)
                    this._lastLineData = data.pop();

                    // Proses semua baris yang utuh
                    for (const line of data) {
                        if (line.trim() === '') continue; // Skip baris kosong
                        
                        let source = 'app';
                        if (line.includes('heroku[router]')) source = 'router';
                        else if (line.includes('heroku[scheduler]')) source = 'scheduler';
                        
                        // Kirim baris utuh + newline ke dashboard
                        io.emit('log', { line: line + '\n', source: source });
                    }
                    callback();
                },
                
                // Kirim sisa data terakhir jika stream ditutup
                flush(callback) {
                    if (this._lastLineData) {
                        let source = 'app';
                        if (this._lastLineData.includes('heroku[router]')) source = 'router';
                        io.emit('log', { line: this._lastLineData + '\n', source: source });
                    }
                    callback();
                }
            });

            // 4. Salurkan stream dari Heroku ke processor kita
            logStream.pipe(logProcessor);

            // 5. Tangani error pada stream
            logStream.on('error', (err) => {
                console.error("Error streaming log Heroku:", err.message);
                io.emit('log', { line: `=== [Log Stream] ERROR: ${err.message} ===\n`, source: 'error' });
            });

            // 6. Hentikan stream jika klien dashboard terputus
            socket.on('disconnect', () => {
                console.log('🔌 Dashboard Admin terputus');
                logStream.destroy(); // Matikan stream
            });

        } catch (err) {
            console.error("Gagal memulai stream Heroku:", err);
            let errorMsg = err.message;
            // Beri pesan error yang lebih jelas
            if (err.statusCode === 401) {
                errorMsg = "Authentication failed. Periksa HEROKU_API_TOKEN.";
            } else if (err.statusCode === 404) {
                errorMsg = "App not found. Periksa HEROKU_APP_NAME.";
            }
            io.emit('log', { line: `=== [Log Stream] Gagal memulai stream: ${errorMsg} ===\n`, source: 'error' });
        }
    } else {
        // Jika .env tidak diatur
        socket.emit('log', { line: '=== [Log Stream] HEROKU_API_TOKEN atau HEROKU_APP_NAME tidak diatur. Streaming log dinonaktifkan. ===\n', source: 'error' });
    }
});


// ========== START SERVER ==========
server.listen(PORT, () => {
    console.log(`🚀 Callback server (Dashboard & Logs) berjalan di port ${PORT}`);
});
