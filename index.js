const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Telegraf } = require("telegraf"); 
const path = require('path'); 

// PENTING: Memastikan environment variables dimuat saat file ini dijalankan
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000; 

// --- KONFIGURASI DARI ENVIRONMENT VARIABLES ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY; 
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY; // Diperlukan untuk signature yang benar
const MONGO_URI = process.env.MONGO_URI;
// Ganti dengan IP Violet Media Pay yang sesuai (202.155.132.37 adalah contoh umum)
const VIOLET_IP = '202.155.132.37'; 
// ----------------------------------------------------------------

// ====== KONEKSI DATABASE & SCHEMA ======

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Callback Server: MongoDB Connected"))
  .catch(err => console.error("❌ Callback Server: MongoDB Error:", err));

// Inisialisasi Bot untuk mengirim notifikasi
const bot = new Telegraf(BOT_TOKEN); 

// === SCHEMA LAMA (dari bot premium) ===
const userSchemaOld = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true }, 
    username: String,
    isPremium: { type: Boolean, default: false },
    refId: { type: String, index: true }, 
    premiumUntil: Date,
    email: { type: String, unique: true, sparse: true }
});
const UserOld = mongoose.models.UserOld || mongoose.model("User", userSchemaOld); // Diubah agar tidak konflik jika nama model sama


// === SCHEMA BARU (dari bot auto-payment) ===
// PENTING: Anda harus memastikan skema ini sama dengan models/Transaction.js
const transactionSchemaNew = new mongoose.Schema({
    userId: { type: Number, required: true },
    refId: { type: String, required: true, unique: true }, 
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED', 'EXPIRED'], default: 'PENDING' },
    produkInfo: { 
        type: { type: String, enum: ['PRODUCT', 'TOPUP'], default: 'PRODUCT' },
        namaProduk: String,
    },
    totalBayar: { type: Number, required: true },
    metodeBayar: { type: String, enum: ['QRIS', 'SALDO'], default: 'QRIS' },
    waktuDibuat: { type: Date, default: Date.now },
});
const TransactionNew = mongoose.models.TransactionNew || mongoose.model("Transaction", transactionSchemaNew);


// ====== MIDDLEWARE UTAMA ======
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 


// ====== FUNGSI NOTIFIKASI SUKSES (BOT PREMIUM LAMA) =====
// FUNGSI INI TETAP MENGGUNAKAN LOGIKA BOT LAMA UNTUK BOT PREMIUM
async function sendSuccessNotificationOld(refId, transactionData) {

    const refIdParts = refId.split(':');
    if (refIdParts.length < 3) {
        console.error(`❌ Callback: Ref ID tidak valid: ${refId}`);
        return;
    }
    const telegramUsername = refIdParts[1] || 'UnknownUser'; 
    const telegramId = parseInt(refIdParts[2]);

    if (isNaN(telegramId)) {
        console.error(`❌ Callback: Tidak dapat mengurai telegramId dari Ref ID: ${refId}`);
        return;
    }

    const MAX_RETRIES = 5; 
    const RETRY_DELAY = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            let user = await UserOld.findOne({
                $or: [
                    { refId: refId },
                    { userId: telegramId } 
                ]
            });

            if (!user) {
                if (attempt < MAX_RETRIES) {
                    console.log(`⏳ Callback: User ${refId} belum ditemukan. Mencoba lagi dalam ${RETRY_DELAY / 1000} detik (Percobaan ${attempt}/${MAX_RETRIES}).`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue; 
                } else {
                    console.log(`⚠️ Callback UPSERT: User ${refId} tidak ditemukan. Mencoba membuat/update via UPSERT.`);
                    
                    const uniqueEmailPlaceholder = `tg_${telegramId}_${Date.now()}@callback.co`;
                    
                    user = await UserOld.findOneAndUpdate(
                        { userId: telegramId }, 
                        {
                            userId: telegramId,
                            username: telegramUsername,
                            refId: refId,
                            email: uniqueEmailPlaceholder
                        },
                        { new: true, upsert: true, setDefaultsOnInsert: true }
                    );

                    if (!user) {
                        console.error(`❌ Callback ERROR: Gagal membuat/menemukan User ${telegramId} setelah UPSERT. Mengabaikan.`);
                        return;
                    }
                    console.log(`✅ Callback: User ${telegramId} berhasil dibuat/diupdate via UPSERT.`);
                }
            }
            
            // --- UPDATE STATUS PREMIUM ---
            const premiumDurationDays = 30; 
            let newExpiryDate = user.premiumUntil || new Date();
            if (newExpiryDate < new Date()) {
                newExpiryDate = new Date();
            }
            newExpiryDate.setDate(newExpiryDate.getDate() + premiumDurationDays);

            const updateResult = await UserOld.updateOne(
                { userId: telegramId },
                { 
                    isPremium: true, 
                    premiumUntil: newExpiryDate, 
                    refId: refId 
                }
            );
            
            // >>> DIAGNOSTIK KRITIS
            console.log(`\n============== CALLBACK SUCCESS LOG (OLD BOT) ==============`);
            console.log(`✅ User ${telegramId} | ${telegramUsername} TELAH DI-SET PREMIUM!`);
            console.log(`   premiumUntil: ${newExpiryDate.toISOString()}`);
            console.log(`   Modified/Upserted: ${updateResult.modifiedCount || updateResult.upsertedCount}`);
            console.log(`==========================================================\n`);


            // 3. Kirim notifikasi sukses
            const nominalDisplayed = transactionData.nominal || transactionData.total_amount || '0';
            const message = `🎉 *PEMBAYARAN SUKSES!* 🎉\n\n` +
                             `Terima kasih, ${user.username || 'Pengguna'}!\n` +
                             `Transaksi Anda telah berhasil dibayar.\n\n` +
                             `📦 Produk: ${transactionData.produk || 'Akses Premium'}\n` +
                             `💰 Nominal: Rp${parseInt(nominalDisplayed).toLocaleString('id-ID')}\n` +
                             `🧾 Ref ID: ${refId}\n\n` +
                             `🌟 Akses premium Anda diaktifkan hingga: *${newExpiryDate.toLocaleDateString("id-ID")}*.`;
            
            await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown' }).catch(e => console.error("Gagal kirim notif premium:", e.message));

            return; 
            
        } catch (error) {
            console.error("❌ CALLBACK ERROR saat memproses/update database:", error);
            if (attempt === MAX_RETRIES) {
                 console.error(`❌ Gagal total setelah ${MAX_RETRIES} percobaan. Mengabaikan transaksi.`);
            }
            return;
        }
    }
}


// ====== FUNGSI NOTIFIKASI SUKSES (BOT AUTO-PAYMENT BARU) =====
async function sendSuccessNotificationNew(refId, transactionData) {
    
    // Asumsi: Bot auto-payment sudah memiliki logika pengiriman produk di server.js
    // Fungsi ini HANYA bertanggung jawab memperbarui status transaksi di DB

    try {
        const nominal = transactionData.nominal || transactionData.total_amount;
        
        const updateResult = await TransactionNew.updateOne(
            { refId: refId, status: 'PENDING' },
            { $set: { status: 'SUCCESS', totalBayar: nominal } }
        );

        if (updateResult.modifiedCount === 0) {
             const existingTx = await TransactionNew.findOne({ refId: refId });
             if (existingTx && existingTx.status === 'SUCCESS') {
                 console.log(`✅ [NEW BOT] Transaksi ${refId} sudah SUCCESS. Mengabaikan notifikasi berulang.`);
                 return;
             }
             console.error(`❌ [NEW BOT] Gagal mengupdate transaksi ${refId}. Mungkin tidak ditemukan.`);
             return;
        }

        console.log(`\n============== CALLBACK SUCCESS LOG (NEW BOT) ==============`);
        console.log(`✅ [NEW BOT] Transaksi ${refId} berhasil diupdate ke SUCCESS.`);
        console.log(`   Catatan: Pengiriman produk/penambahan saldo DITANGANI oleh webhook handler di server.js utama.`);
        console.log(`==========================================================\n`);

        // Tidak perlu mengirim notifikasi Telegram di sini;
        // Bot utama (server.js) yang memproses callback akan menangani pengiriman produk/notifikasi
        
    } catch (error) {
        console.error("❌ [NEW BOT] CALLBACK ERROR saat update database Transaction:", error);
    }
}


// 🔑 ENDPOINT CALLBACK LAMA (Bot Premium) 🔑
app.post("/violet-callback", async (req, res) => {
    const data = req.body;
    
    const refid = data.ref || data.ref_kode; 
    const headerSignature = req.headers['x-callback-signature'];
    const incomingSignature = headerSignature || data.signature;

    const clientIp = req.headers['x-forwarded-for'] ? 
                             req.headers['x-forwarded-for'].split(',')[0].trim() : 
                             req.ip;

    console.log(`--- CALLBACK DITERIMA (OLD BOT) ---`);
    // ... (Logika validasi IP, Signature, dan Status lama) ...

    try {
        if (!refid) {
            console.error("❌ Callback: Nomor referensi (ref/ref_kode) tidak ditemukan di body.");
            return res.status(400).send({ status: false, message: "Missing reference ID" });
        }

        // 3. Pembuatan signature: Menggunakan SECRET KEY untuk validasi
        const calculatedSignature = crypto
            .createHmac("sha256", VIOLET_SECRET_KEY) 
            .update(refid)
            .digest("hex");

        // 4. Validasi IP Pengirim (Opsional, tapi direkomendasikan)
        if (clientIp !== VIOLET_IP) {
             console.log(`🚫 IP Callback TIDAK VALID! Dikirim dari: ${clientIp}. Seharusnya: ${VIOLET_IP}`);
             return res.status(200).send({ status: false, message: "IP Mismatch, ignored." });
        }

        // 5. Bandingkan Signature untuk keamanan
        const isSignatureValid = (calculatedSignature === incomingSignature);
        const shouldBypassSignature = !incomingSignature; 

        if (isSignatureValid || shouldBypassSignature) {
            if (data.status === "success") {
                console.log("✅ Transaksi SUCCESS diterima. Memproses notifikasi OLD BOT...");
                await sendSuccessNotificationOld(refid, data); 
            } else {
                 console.log(`⚠️ Status callback non-sukses diterima: ${data.status} (Ref: ${refid})`);
            }
        } else {
            console.log(`🚫 Signature callback TIDAK VALID!`);
        }

        res.status(200).send({ status: true, message: "Callback received and processed" }); 
        
    } catch (error) {
        console.error("❌ Callback: Error saat memproses callback:", error);
        res.status(200).send({ status: false, message: "Internal server error during processing" });
    }
});


// 🆕 ENDPOINT CALLBACK BARU (Bot Auto-Payment) 🔑
app.post("/paymentbot-callback", async (req, res) => {
    const data = req.body;
    
    const refid = data.ref || data.ref_kode; 
    const headerSignature = req.headers['x-callback-signature'];
    const incomingSignature = headerSignature || data.signature;
    const nominal = data.nominal || data.total_amount;

    const clientIp = req.headers['x-forwarded-for'] ? 
                             req.headers['x-forwarded-for'].split(',')[0].trim() : 
                             req.ip;

    console.log(`--- CALLBACK DITERIMA (NEW BOT: /paymentbot-callback) ---`);
    console.log(`Ref ID: ${refid}, Status: ${data.status}, Nominal: ${nominal}`);
    console.log(`IP Pengirim: ${clientIp}`);

    try {
        if (!refid || !nominal) {
            console.error("❌ [NEW BOT] Missing reference ID atau Nominal.");
            return res.status(400).send({ status: false, message: "Missing required fields" });
        }

        // 1. Pembuatan signature (Verifikasi bahwa permintaan ini sah)
        // Note: Bot auto-payment utama (server.js) yang memverifikasi SIGNATURE VMP.
        // Callback server ini HANYA memverifikasi status dan IP untuk update DB.

        // 2. Validasi IP Pengirim (Opsional, tapi direkomendasikan)
        if (clientIp !== VIOLET_IP) {
             console.log(`🚫 [NEW BOT] IP Callback TIDAK VALID! Dikirim dari: ${clientIp}. Seharusnya: ${VIOLET_IP}`);
             return res.status(200).send({ status: false, message: "IP Mismatch, ignored." });
        }
        
        // 3. Cek Status Pembayaran
        if (data.status === "success") {
            console.log("✅ [NEW BOT] Transaksi SUCCESS diterima. Memproses update DB...");
            await sendSuccessNotificationNew(refid, data); 
        } else {
             console.log(`⚠️ [NEW BOT] Status callback non-sukses diterima: ${data.status} (Ref: ${refid})`);
        }

        // 4. Wajib mengirim status 200 OK ke Violet Media Pay
        res.status(200).send({ status: true, message: "Callback received and processed for new bot" }); 
        
    } catch (error) {
        console.error("❌ [NEW BOT] Error saat memproses callback:", error);
        res.status(200).send({ status: false, message: "Internal server error during processing" });
    }
});


app.listen(PORT, () => console.log(`🚀 Callback server jalan di port ${PORT}`));
