const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Telegraf } = require("telegraf"); 
const bodyParser = require("body-parser");
require("dotenv").config();

// --- Import Models (Untuk Bot Auto-Payment Baru) ---
const User = require('./models/User'); 
const Product = require('./models/Product'); 
const Transaction = require('./models/Transaction'); 

const app = express();
const PORT = process.env.PORT || 37761; 

// Middleware untuk parsing body dari callback VMP
app.use(bodyParser.urlencoded({ extended: true })); 
app.use(bodyParser.json()); 

// --- KONFIGURASI DARI ENVIRONMENT VARIABLES ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;

// ====== KONEKSI DATABASE ======
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Callback Server: MongoDB Connected"))
  .catch(err => console.error("❌ Callback Server: MongoDB Error:", err));

// Inisialisasi Bot untuk mengirim notifikasi
const bot = new Telegraf(BOT_TOKEN); 

// ====== SCHEMA LAMA & BARU ======

// === SCHEMA LAMA (dari bot premium - Untuk Ref ID NUXYS:) ===
const userSchemaOld = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true }, 
    username: String,
    isPremium: { type: Boolean, default: false },
    refId: { type: String, index: true }, 
    premiumUntil: Date,
    email: { type: String, unique: true, sparse: true }
});
const UserOld = mongoose.models.UserOld || mongoose.model("UserOld", userSchemaOld, "users"); 


// === SCHEMA BARU (menggunakan model yang diimpor) ===
const TransactionNew = Transaction; 

// ====== HELPER FUNCTIONS (Diperlukan untuk Delivery) ======

// Fungsi untuk mengirim produk (Diambil dari bot.js)
async function deliverProduct(userId, productId) {
    try {
        const product = await Product.findById(productId);
        if (!product || product.kontenProduk.length <= 0) {
            bot.telegram.sendMessage(userId, '⚠️ Produk yang Anda beli kehabisan stok setelah pembayaran. Silakan hubungi admin.', { parse_mode: 'Markdown' });
            return false;
        }

        const key = product.kontenProduk.shift();
        
        await Product.updateOne({ _id: productId }, { 
            $set: { kontenProduk: product.kontenProduk }, 
            $inc: { stok: -1, totalTerjual: 1 } 
        });
        
        bot.telegram.sendMessage(userId, 
            `🎉 **Pembayaran Sukses! Produk Telah Dikirim!**\n\n` +
            `**Produk:** ${product.namaProduk}\n` +
            `**Konten Anda:**\n\`${key}\``, 
            { parse_mode: 'Markdown' }
        );
        return true;
    } catch (error) {
        console.error(`❌ Gagal deliver produk ke user ${userId} di callback:`, error);
        bot.telegram.sendMessage(userId, '❌ Terjadi kesalahan saat mengirim produk Anda. Silakan hubungi admin.', { parse_mode: 'Markdown' });
        return false;
    }
}


// ====== FUNGSI NOTIFIKASI SUKSES (BOT PREMIUM LAMA - NUXYS) =====
async function sendSuccessNotificationOld(refId, transactionData) {
    
    const refIdParts = refId.split(':');
    const telegramUsername = refIdParts[1] || 'UnknownUser'; 
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
        
        // --- UPDATE STATUS PREMIUM ---
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
        
        console.log(`\n============== CALLBACK SUCCESS LOG (OLD BOT) ==============`);
        console.log(`✅ User ${telegramId} | ${telegramUsername} TELAH DI-SET PREMIUM!`);
        console.log(`==========================================================\n`);

        const nominalDisplayed = transactionData.total || transactionData.nominal || '0';
        const message = `🎉 *PEMBAYARAN SUKSES!* 🎉\n\n` +
                         `📦 Produk: Akses Premium\n` +
                         `💰 Nominal: Rp${parseInt(nominalDisplayed).toLocaleString('id-ID')}\n` +
                         `🌟 Akses premium Anda diaktifkan hingga: *${newExpiryDate.toLocaleDateString("id-ID")}*.`;
        
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown' }).catch(e => console.error("Gagal kirim notif premium:", e.message));
        
    } catch (error) {
        console.error("❌ CALLBACK ERROR saat memproses/update database OLD BOT:", error);
    }
}


// FUNGSI INTI UNTUK MEMPROSES CALLBACK TRANSAKSI BARU (PROD/TOPUP)
async function processNewBotTransaction(refId, data) {
    try {
        const status = data.status.toLowerCase(); 
        // Menggunakan data.total atau data.nominal karena ini yang tersedia di callback VMP
        const totalBayarCallback = parseFloat(data.total || data.nominal || 0); 
        
        // 1. Cari Transaksi PENDING di DB
        const transaction = await TransactionNew.findOne({ refId: refId });

        if (!transaction) {
            console.log(`❌ [CALLBACK] Gagal: Transaksi ${refId} TIDAK DITEMUKAN.`);
            return;
        }

        if (transaction.status === 'SUCCESS') {
            console.log(`⚠️ [CALLBACK] Transaksi ${refId} sudah SUCCESS. Abaikan.`);
            return;
        }

        const userId = transaction.userId;
        const itemType = transaction.produkInfo.type;

        if (status === 'success') {
            
            // 2. Pastikan jumlah pembayaran sesuai
            if (totalBayarCallback !== transaction.totalBayar) {
                console.log(`⚠️ [CALLBACK] Jumlah pembayaran tidak sesuai. DB: ${transaction.totalBayar}, Callback: ${totalBayarCallback}.`);
                await TransactionNew.updateOne({ refId }, { status: 'FAILED' });
                bot.telegram.sendMessage(userId, `❌ **Pembayaran Gagal:** Jumlah yang dibayarkan tidak sesuai (Ref: ${refId}).`, { parse_mode: 'Markdown' });
                return;
            }

            // 3. Update Status ke SUCCESS
            const updateResult = await TransactionNew.updateOne({ refId, status: 'PENDING' }, { status: 'SUCCESS' });

            if (updateResult.modifiedCount > 0) {
                console.log(`✅ [CALLBACK] Status Transaksi ${refId} berhasil diupdate ke SUCCESS.`);
                
                // 4. Lakukan Delivery Produk/Top Up
                const user = await User.findOne({ userId }); 
                if (!user) return console.error(`❌ [CALLBACK] User ${userId} tidak ditemukan untuk delivery.`);

                if (itemType === 'TOPUP') {
                    user.saldo += transaction.totalBayar;
                    user.totalTransaksi += 1;
                    await user.save();
                    
                    bot.telegram.sendMessage(userId, 
                        `🎉 **Top Up Berhasil!**\nSaldo kini: Rp ${user.saldo.toLocaleString('id-ID')}.`, 
                        { parse_mode: 'Markdown' }
                    );
                    
                } else if (itemType === 'PRODUCT') {
                    const productData = await Product.findOne({ namaProduk: transaction.produkInfo.namaProduk }).select('_id');
                    if (productData) {
                        await deliverProduct(userId, productData._id); 
                    } else {
                        bot.telegram.sendMessage(userId, `⚠️ Produk ${transaction.produkInfo.namaProduk} tidak ditemukan saat delivery. Hubungi admin.`, { parse_mode: 'Markdown' });
                    }
                }
            } 

        } else if (status === 'failed' || status === 'expired') {
            await TransactionNew.updateOne({ refId, status: 'PENDING' }, { status: status.toUpperCase() });
            bot.telegram.sendMessage(userId, `❌ **Transaksi Gagal/Dibatalkan:** Pembayaran Anda berstatus **${status.toUpperCase()}**.`, { parse_mode: 'Markdown' });
        }

    } catch (error) {
        console.error(`❌ [CALLBACK ERROR] Gagal memproses transaksi ${refId}:`, error);
    }
}


// ====== ENDPOINT CALLBACK VIOLET MEDIA PAY PUSAT ======
app.post("/violet-callback", async (req, res) => {
    
    const data = req.body; 
    
    // PERBAIKAN KRITIS: Mencari Ref ID di beberapa kemungkinan key (ref_id, ref_kode, ref)
    const refid = data.ref_id || data.ref_kode || data.ref; 
    
    const incomingSignature = data.signature;
    
    console.log(`\n--- CALLBACK DITERIMA PUSAT ---`);
    console.log(`Ref ID: ${refid}, Status: ${data.status}`);
    
    // 1. Verifikasi Signature (Dibiarkan MD5 seperti yang ada di kode lama Anda)
    const nominal = data.total || data.nominal || '0';
    const calculatedSignature = crypto.createHash('md5').update(VIOLET_SECRET_KEY + refid).digest('hex'); 
    
    const isSignatureValid = (incomingSignature === calculatedSignature);
    const shouldBypassSignature = !incomingSignature || incomingSignature.length < 5; 

    if (!isSignatureValid && !shouldBypassSignature) {
        console.log(`🚫 Signature callback TIDAK VALID! Mengabaikan.`);
        return res.status(200).send({ status: false, message: "Invalid signature ignored" });
    }
    
    try {
        if (!refid) {
            console.error("❌ Callback: Nomor referensi (ref_id/ref_kode) tidak ditemukan.");
            // Mengembalikan status 400 karena permintaan tidak valid (Missing reference ID)
            return res.status(400).send({ status: false, message: "Missing reference ID" }); 
        }

        // --- LOGIKA PEMISAHAN REF ID ---
        if (data.status === "success") {
            if (refid.startsWith('PROD-') || refid.startsWith('TOPUP-')) {
                // FORMAT BARU (Bot Auto Payment)
                console.log("✅ Mengalihkan ke pemrosesan BOT BARU (PROD/TOPUP)...");
                await processNewBotTransaction(refid, data);
            } else if (refid.includes(':')) {
                // FORMAT LAMA (Bot Premium, misal: NUXYS:user:id:ts)
                console.log("✅ Mengalihkan ke pemrosesan BOT LAMA (NUXYS)...");
                await sendSuccessNotificationOld(refid, data);
            } else {
                console.log(`⚠️ Ref ID format tidak dikenali: ${refid}`);
            }
        } else if (refid && data.status) {
             // Tangani status FAILED/EXPIRED untuk BOT BARU
             if (refid.startsWith('PROD-') || refid.startsWith('TOPUP-')) {
                 await processNewBotTransaction(refid, data);
             } else {
                 console.log(`⚠️ Status callback non-sukses diterima untuk Ref ID lama/tidak dikenal: ${data.status} (Ref: ${refid})`);
             }
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
    console.log(`🚀 Callback server berjalan di port ${PORT}`);
});
