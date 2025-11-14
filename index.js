const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const fetch = require('node-fetch'); 
const { URLSearchParams } = require('url'); 

require("dotenv").config();

// --- Import Models ---
const User = require('./models/User'); 
const Product = require('./models/Product'); 
const Transaction = require('./models/Transaction'); 

// --- KONFIGURASI DARI ENVIRONMENT VARIABLES ---
const BOT_TOKEN_NEW = process.env.BOT_TOKEN; 
const BOT_TOKEN_OLD = process.env.OLD_BOT_TOKEN; 
const VIOLET_API_KEY = process.env.VIOLET_API_KEY; 
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;

// FIX PORT: Gunakan PORT Heroku atau fallback
const PORT = process.env.PORT || 37761; 

if (!BOT_TOKEN_NEW || !VIOLET_SECRET_KEY || !MONGO_URI || !BOT_TOKEN_OLD) {
    console.error("❌ ERROR: Pastikan semua variabel environment (termasuk OLD_BOT_TOKEN) terisi.");
    process.exit(1);
}

// ====== KONEKSI DATABASE ======
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Callback Server: MongoDB Connected"))
  .catch(err => console.error("❌ Callback Server: MongoDB Error:", err));

const app = express();

// --- FIX MIDDLEWARE: Aktifkan URLENCODED secara Global ---
// VMP mengirim data dalam format ini. Ini adalah cara paling handal.
app.use(bodyParser.json()); 
app.use(bodyParser.urlencoded({ extended: true })); 


// ====== SCHEMA LAMA & BARU (Disederhanakan) ======
const userSchemaOld = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true }, 
    username: String,
    isPremium: { type: Boolean, default: false },
    refId: { type: String, index: true }, 
    premiumUntil: Date,
    email: { type: String, unique: true, sparse: true }
});
const UserOld = mongoose.models.UserOld || mongoose.model("UserOld", userSchemaOld, "users"); 
const TransactionNew = Transaction; 


// ====================================================
// ====== UTILITY FUNCTIONS (Direct API Messaging) ======
// ====================================================

async function sendTelegramMessage(token, userId, message, isMarkdown = true) {
    if (!token) {
        console.error(`❌ Gagal mengirim pesan: Token bot tidak ditemukan untuk user ${userId}.`);
        return;
    }
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const params = new URLSearchParams({
        chat_id: userId,
        text: message,
        parse_mode: isMarkdown ? 'Markdown' : 'HTML',
    });
    
    try {
        await fetch(url, { method: 'POST', body: params });
    } catch (e) {
        console.error(`❌ Gagal kirim notifikasi ke user ${userId}:`, e.message);
    }
}

async function deliverProduct(userId, productId) {
    try {
        const product = await Product.findById(productId);
        if (!product || product.kontenProduk.length <= 0) {
            await sendTelegramMessage(BOT_TOKEN_NEW, userId, '⚠️ Produk yang Anda beli kehabisan stok setelah pembayaran. Silakan hubungi admin.');
            return false;
        }

        const key = product.kontenProduk.shift();
        
        await Product.updateOne({ _id: productId }, { 
            $set: { kontenProduk: product.kontenProduk }, 
            $inc: { stok: -1, totalTerjual: 1 } 
        });
        
        await sendTelegramMessage(BOT_TOKEN_NEW, userId, 
            `🎉 **Pembayaran Sukses! Produk Telah Dikirim!**\n\n` +
            `**Produk:** ${product.namaProduk}\n` +
            `**Konten Anda:**\n\`${key}\``);
            
        return true;
    } catch (error) {
        console.error(`❌ Gagal deliver produk ke user ${userId} di callback:`, error);
        await sendTelegramMessage(BOT_TOKEN_NEW, userId, '❌ Terjadi kesalahan saat mengirim produk Anda. Silakan hubungi admin.');
        return false;
    }
}

async function sendSuccessNotificationOld(refId, transactionData) {
    
    const refIdParts = refId.split(':');
    const telegramId = parseInt(refIdParts[2]);

    if (isNaN(telegramId)) {
        console.error(`❌ Callback: Tidak dapat mengurai telegramId dari Ref ID lama: ${refId}`);
        return;
    }

    try {
        let user = await UserOld.findOne({ $or: [{ refId: refId }, { userId: telegramId }] });
        
        if (!user) { 
             console.error(`❌ User lama dengan ID ${telegramId} tidak ditemukan.`);
             return;
        } 
        
        const premiumDurationDays = 30; 
        let newExpiryDate = user.premiumUntil || new Date();
        if (newExpiryDate < new Date()) {
            newExpiryDate = new Date();
        }
        newExpiryDate.setDate(newExpiryDate.getDate() + premiumDurationDays);

        await UserOld.updateOne(
            { userId: telegramId },
            { isPremium: true, premiumUntil: newExpiryDate, refId: refId }
        );
        
        const nominalDisplayed = transactionData.total || transactionData.nominal || '0';
        const message = `🎉 *PEMBAYARAN SUKSES!* 🎉\n\n` +
                         `📦 Produk: Akses Premium\n` +
                         `💰 Nominal: Rp${parseInt(nominalDisplayed).toLocaleString('id-ID')}\n` +
                         `🌟 Akses premium Anda diaktifkan hingga: *${newExpiryDate.toLocaleDateString("id-ID")}*.`;
        
        await sendTelegramMessage(BOT_TOKEN_OLD, telegramId, message);
        
    } catch (error) {
        console.error("❌ CALLBACK ERROR saat memproses/update database OLD BOT:", error);
    }
}


// ====== ENDPOINT CALLBACK VIOLET MEDIA PAY PUSAT ======
app.post("/violet-callback", async (req, res) => {
    
    // FIX 4: Data sekarang ada di req.body berkat middleware global
    const data = req.body; 

    const refid = data.ref_id || data.ref_kode || data.ref; 
    const incomingStatus = data.status;
    const incomingSignature = data.signature;
    
    console.log(`\n--- CALLBACK DITERIMA PUSAT ---`);
    console.log(`Ref ID: ${refid}, Status: ${incomingStatus}, Signature Found: ${!!incomingSignature}`);

    // Validasi Awal
    if (!refid || !incomingStatus) {
        console.error("❌ Callback: Missing essential data (refid atau status).");
        return res.status(400).send({ status: false, message: "Missing essential data" });
    }
    
    // Periksa Signature: Kami hanya menerima jika signature ada dan cocok, atau jika tidak ada, 
    // kami hanya memproses status failed/expired tanpa validasi signature ketat.
    if (!incomingSignature) {
        console.warn("⚠️ Signature hilang! Memproses hanya jika status FAILED/EXPIRED.");
        if (incomingStatus.toLowerCase() !== 'failed' && incomingStatus.toLowerCase() !== 'expired') {
            console.error("❌ Callback: Signature hilang dan status bukan GAGAL/EXPIRED. Ditolak.");
            return res.status(200).send({ status: false, message: "Signature missing. Ditolak." });
        }
    }
    
    try {
        if (refid.startsWith('PROD-') || refid.startsWith('TOPUP-')) {
            // --- LOGIKA BOT BARU (HMAC SHA256 & DB NOMINAL CHECK) ---
            
            const transaction = await TransactionNew.findOne({ refId: refid });

            if (!transaction) {
                console.log(`❌ [BOT BARU] Gagal: Transaksi ${refid} TIDAK DITEMUKAN.`);
                return res.status(200).send({ status: true, message: "Transaction not found" });
            }

            if (transaction.status === 'SUCCESS') {
                console.log(`⚠️ [BOT BARU] Transaksi ${refid} sudah SUCCESS. Abaikan.`);
                return res.status(200).send({ status: true, message: "Already processed" });
            }

            const nominalDB = transaction.totalBayar; 
            const userId = transaction.userId;

            // Verifikasi Signature HMACS SHA256 (Menggunakan Nominal DB)
            const mySignatureString = refid + VIOLET_API_KEY + nominalDB;
            const calculatedSignature = crypto
                .createHmac("sha256", VIOLET_SECRET_KEY)
                .update(mySignatureString)
                .digest("hex");

            if (calculatedSignature !== incomingSignature) {
                console.warn(`🚫 [BOT BARU] Signature TIDAK VALID! Nominal Cek: ${nominalDB}.`);
                return res.status(200).send({ status: false, message: "Invalid signature ignored" });
            }
            
            // --- Signature Valid, Lanjutkan Pemrosesan ---
            if (incomingStatus.toLowerCase() === 'success') {
                await TransactionNew.updateOne({ refId: refid }, { status: 'SUCCESS' });

                if (transaction.produkInfo.type === 'TOPUP') {
                    await User.updateOne({ userId }, { $inc: { saldo: nominalDB, totalTransaksi: 1 } });
                    const updatedUser = await User.findOne({ userId });
                    
                    await sendTelegramMessage(BOT_TOKEN_NEW, userId, 
                        `🎉 **Top Up Saldo Berhasil!**\nSaldo kini: Rp ${updatedUser.saldo.toLocaleString('id-ID')}.`);
                    
                } else if (transaction.produkInfo.type === 'PRODUCT') {
                    const productData = await Product.findOne({ namaProduk: transaction.produkInfo.namaProduk }).select('_id');
                    if (productData) {
                        await deliverProduct(userId, productData._id); 
                        await User.updateOne({ userId }, { $inc: { totalTransaksi: 1 } });
                    } else {
                        await sendTelegramMessage(BOT_TOKEN_NEW, userId, `⚠️ Produk ${transaction.produkInfo.namaProduk} tidak ditemukan saat delivery. Hubungi admin.`);
                    }
                }
                console.log(`✅ [BOT BARU] Transaksi ${refid} berhasil diupdate ke SUCCESS.`);

            } else if (incomingStatus.toLowerCase() === 'failed' || incomingStatus.toLowerCase() === 'expired') {
                await TransactionNew.updateOne({ refId: refid, status: 'PENDING' }, { status: incomingStatus.toUpperCase() });
                await sendTelegramMessage(BOT_TOKEN_NEW, userId, `❌ **Transaksi Gagal/Dibatalkan:** Pembayaran Anda berstatus **${incomingStatus.toUpperCase()}**.`, true);
            }
            
        } else if (refid.includes(':')) {
            // --- LOGIKA BOT LAMA (MD5 Signature Check) ---
            
            // Verifikasi Signature MD5 (Dipertahankan sesuai kode lama)
            const calculatedSignatureOld = crypto.createHash('md5').update(VIOLET_SECRET_KEY + refid).digest('hex'); 
            
            if (calculatedSignatureOld === incomingSignature) {
                 if (incomingStatus.toLowerCase() === "success") {
                    console.log("✅ Mengalihkan ke pemrosesan BOT LAMA (NUXYS)...");
                    await sendSuccessNotificationOld(refid, data);
                 } else {
                     console.log(`⚠️ Status callback non-sukses diterima untuk BOT LAMA: ${incomingStatus} (Ref: ${refid})`);
                 }
            } else {
                 console.log(`🚫 Signature callback BOT LAMA TIDAK VALID! Mengabaikan.`);
            }

        } else {
            console.log(`⚠️ Ref ID format tidak dikenali: ${refid}`);
        }
        
        // --- Wajib mengirim status 200 OK ke VMP ---
        res.status(200).send({ status: true, message: "Callback received and processed" }); 
        
    } catch (error) {
        console.error("❌ Callback: Error saat memproses callback:", error);
        res.status(200).send({ status: false, message: "Internal server error during processing" });
    }
});


// ====== SERVER LAUNCH ======
app.listen(PORT, () => {
    console.log(`🚀 Callback server berjalan di port ${PORT}. Url Callback: /violet-callback`);
});
