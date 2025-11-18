// FILE: index.js
// Server Callback + Dashboard API + Log Streaming (Fixed Version)

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const fetch = require("node-fetch"); // Kita pakai ini untuk API Heroku juga
const { URLSearchParams } = require("url");
const path = require('path');
const http = require('http'); 
const { Server } = require("socket.io"); 
const stream = require('stream'); 

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
const server = http.createServer(app); 
const io = new Server(server); 

// ========== MIDDLEWARE ==========
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== MODELS ==========
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
    if (!CHANNEL_ID) return;
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
        console.error(`❌ Gagal mengirim notifikasi ke channel: ${error.message}`);
    }
}

// ========== HELPER: PENGIRIMAN PRODUK ==========
async function deliverProductAndNotify(userId, productId, transaction, product) {
    try {
        const productData = await Product.findById(productId);
        if (!productData || productData.kontenProduk.length === 0) {
            const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
            if (ADMIN_IDS.length > 0) {
                sendTelegramMessage(ADMIN_IDS[0], `⚠️ [ADMIN CALLBACK] Stok Habis! User ${userId} beli ${productData?.namaProduk}. Ref: ${transaction.refId}`);
            }
            return sendTelegramMessage(userId, `⚠️ Pembelian Berhasil (Ref: \`${transaction.refId}\`), namun stok konten habis. Hubungi Admin.`);
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
                           `📦 **Sisa Stok:** \`${stokAkhir}\` pcs\n` +
                           `🆔 **Ref ID:** \`${transaction.refId}\``;
        await sendChannelNotification(notifMessage);

        const stickerSetting = await Setting.findOne({ key: 'success_sticker_id' });
        if (stickerSetting && stickerSetting.value) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendSticker`, {
                method: "POST",
                body: new URLSearchParams({ chat_id: userId, sticker: stickerSetting.value })
            }).catch(e => console.log("Gagal kirim stiker:", e.message));
        }

        const date = new Date();
        const dateCreated = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}, ${date.toLocaleTimeString('id-ID')}`;

        let successMessage = `📜 *Pembelian Berhasil*\nTerimakasih telah berbelanja.\n\n` +
        `*Detail:*\n— *Total:* Rp ${transaction.totalBayar.toLocaleString('id-ID')}\n— *Tanggal:* ${dateCreated}\n— *Ref:* ${transaction.refId}\n\n` +
        `*${product.namaProduk}*\n` + "```txt\n" + `${deliveredContent}\n` + "```";
        
        sendTelegramMessage(userId, successMessage);

    } catch (err) {
        console.log("[DELIVER-CB] Error:", err);
        sendTelegramMessage(userId, `❌ Terjadi kesalahan pengiriman produk (Ref: \`${transaction.refId}\`). Hubungi Admin.`);
    }
}

// ========== RUTE: VIOLET CALLBACK ==========
app.post("/violet-callback", async (req, res) => {
    const data = req.body;
    const refid = data.ref || data.ref_id || data.ref_kode;
    const status = (data.status || "").toLowerCase();
    const incomingSignature = data.signature || req.headers["x-callback-signature"] || null;
    const clientIp = getClientIp(req);

    console.log("\n====== CALLBACK MASUK ======");
    console.log(`IP: ${clientIp} | REF: ${refid} | STATUS: ${status}`);

    if (!refid) return res.status(200).send({ status: true });
    if (!refid.startsWith("PROD-") && !refid.startsWith("TOPUP-")) return res.status(200).send({ status: true });

    try {
        const trx = await Transaction.findOne({ refId: refid });
        if (!trx || trx.status === "SUCCESS") return res.status(200).send({ status: true });

        const expectedSignature = crypto.createHmac("sha256", VIOLET_API_KEY).update(refid).digest("hex");
        if (incomingSignature && incomingSignature !== expectedSignature) {
            console.log("🚫 Signature mismatch"); return res.status(200).send({ status: true });
        }
        if (!incomingSignature && !VMP_ALLOWED_IP.has(clientIp)) {
            console.log("🚫 IP Unauthorized"); return res.status(200).send({ status: true });
        }

        if (status === "success") {
            await Transaction.updateOne({ refId: refid }, { status: "SUCCESS", vmpSignature: incomingSignature });
            
            if (trx.produkInfo.type === "TOPUP") {
                await User.updateOne({ userId: trx.userId }, { $inc: { saldo: trx.totalBayar, totalTransaksi: 1 } });
                const u = await User.findOne({ userId: trx.userId });
                const notifMessage = `💰 **TOP-UP SUKSES (QRIS)** 💰\n👤 **User:** [${u.username}](tg://user?id=${trx.userId})\n💰 **Total:** \`Rp ${trx.totalBayar.toLocaleString('id-ID')}\``;
                await sendChannelNotification(notifMessage);
                sendTelegramMessage(trx.userId, `🎉 Top Up Berhasil! Saldo kini: Rp ${u.saldo.toLocaleString("id-ID")}.`);
            } else {
                const product = await Product.findOne({ namaProduk: trx.produkInfo.namaProduk });
                if (product) await deliverProductAndNotify(trx.userId, product._id, trx, product);
                else sendTelegramMessage(trx.userId, `⚠️ Produk tidak ditemukan (Ref: ${refid}).`);
            }
        } else if (status === "failed" || status === "expired") {
            await Transaction.updateOne({ refId: refid }, { status: status.toUpperCase() });
            sendTelegramMessage(trx.userId, `❌ *Transaksi ${status.toUpperCase()}!* (Ref: \`${refid}\`)`);
        }
        return res.status(200).send({ status: true });
    } catch (err) {
        console.error(`[Callback Error] ${err.message}`);
        return res.status(200).send({ status: true });
    }
});

// ========== RUTE: API STATS ==========
function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
}

app.get('/api/stats', async (req, res) => {
    try {
        const [users, products, allTrx, successTrx, pendingTrx, failedTrx] = await Promise.all([
            User.countDocuments(), Product.countDocuments(), Transaction.countDocuments(),
            Transaction.countDocuments({ status: 'SUCCESS' }),
            Transaction.countDocuments({ status: 'PENDING' }),
            Transaction.countDocuments({ status: { $in: ['FAILED', 'EXPIRED'] } })
        ]);

        res.json({
            dbStatus: mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED',
            serverUptime: formatUptime(process.uptime()),
            totalUsers: users, totalProducts: products, totalTransactions: allTrx,
            successTransactions: successTrx, pendingTransactions: pendingTrx, failedTransactions: failedTrx
        });
    } catch (e) { res.status(500).json({ error: "Stats Error" }); }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ====================================================================
// ============ LOGIKA STREAMING LOG (MENGGUNAKAN FETCH) ==============
// ====================================================================
io.on('connection', async (socket) => {
    console.log('🔌 Dashboard terhubung via WebSocket');
    socket.emit('log', { line: '=== [Log Stream] Menghubungkan ke Heroku... ===\n', source: 'server' });

    let active = true;
    let controller = new AbortController(); // Untuk membatalkan fetch jika disconnect

    if (HEROKU_API_TOKEN && HEROKU_APP_NAME) {
        try {
            // Gunakan FETCH (bukan package heroku) untuk menghindari error constructor
            const response = await fetch(`https://api.heroku.com/apps/${HEROKU_APP_NAME}/log-stream?tail=true&lines=100`, {
                headers: {
                    'Authorization': `Bearer ${HEROKU_API_TOKEN}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                },
                signal: controller.signal
            });

            if (!response.ok) throw new Error(`Heroku API: ${response.status} ${response.statusText}`);

            console.log(`✅ Log stream terhubung ke ${HEROKU_APP_NAME}`);
            socket.emit('log', { line: '=== [Log Stream] Terhubung! ===\n', source: 'server' });

            // Proses stream body
            const bodyStream = response.body;
            const logProcessor = new stream.Transform({
                transform(chunk, encoding, callback) {
                    const lines = chunk.toString('utf8').split('\n');
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        let source = 'app';
                        if (line.includes('heroku[router]')) source = 'router';
                        else if (line.includes('heroku[scheduler]')) source = 'scheduler';
                        socket.emit('log', { line: line + '\n', source: source });
                    }
                    callback();
                }
            });

            // Pipe stream fetch ke processor
            bodyStream.pipe(logProcessor);

            // Handle Error Stream
            bodyStream.on('error', (err) => {
                if (active) socket.emit('log', { line: `=== [Stream Error] ${err.message} ===\n`, source: 'error' });
            });

        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error("Gagal Stream Heroku:", err.message);
                socket.emit('log', { line: `=== [Log Error] Gagal memulai: ${err.message} ===\n`, source: 'error' });
            }
        }
    } else {
        socket.emit('log', { line: '=== [Config Error] HEROKU_API_TOKEN/APP_NAME belum diatur ===\n', source: 'error' });
    }

    socket.on('disconnect', () => {
        console.log('🔌 Dashboard terputus');
        active = false;
        controller.abort(); // Matikan koneksi fetch ke Heroku
    });
});


// ========== START SERVER ==========
server.listen(PORT, () => {
    console.log(`🚀 Server berjalan di port ${PORT}`);
});
