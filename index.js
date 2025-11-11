const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Telegraf } = require("telegraf"); 
const path = require('path'); 

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000; 

// --- KONFIGURASI DARI ENVIRONMENT VARIABLES ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY; 
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const VIOLET_IP = '202.155.132.37'; 

// ====== KONEKSI DATABASE & SCHEMA ======

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Callback Server: MongoDB Connected"))
  .catch(err => console.error("❌ Callback Server: MongoDB Error:", err));

const bot = new Telegraf(BOT_TOKEN); 

// === SCHEMA LAMA (dari bot premium) ===
// Digunakan untuk menangani callback lama
const userSchemaOld = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true }, 
    username: String,
    isPremium: { type: Boolean, default: false },
    refId: { type: String, index: true }, 
    premiumUntil: Date,
    email: { type: String, unique: true, sparse: true }
});
const UserOld = mongoose.models.UserOld || mongoose.model("User", userSchemaOld); 


// === SCHEMA BARU (dari bot auto-payment) - HARUS SAMA DENGAN models/Transaction.js ===
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
const TransactionNew = mongoose.models.TransactionNew || mongoose.model("TransactionNew", transactionSchemaNew); // Ubah nama model agar unik


// ====== MIDDLEWARE UTAMA ======
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 


// ====== FUNGSI NOTIFIKASI SUKSES (BOT PREMIUM LAMA) =====
async function sendSuccessNotificationOld(refId, transactionData) {
    // Fungsi ini hanya boleh dipanggil jika format Ref ID adalah NUXYS:username:userId:TIMESTAMP
    
    // 1. Mengurai Ref ID
    const refIdParts = refId.split(':');
    if (refIdParts.length < 3) {
        console.error(`❌ Callback: Ref ID lama tidak valid: ${refId}`);
        return;
    }
    const telegramUsername = refIdParts[1] || 'UnknownUser'; 
    const telegramId = parseInt(refIdParts[2]);

    if (isNaN(telegramId)) {
        console.error(`❌ Callback: Tidak dapat mengurai telegramId dari Ref ID lama: ${refId}`);
        return;
    }

    const MAX_RETRIES = 5; 
    const RETRY_DELAY = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Coba Cari user berdasarkan refId ATAU userId
            let user = await UserOld.findOne({
                $or: [
                    { refId: refId },
                    { userId: telegramId } 
                ]
            });
            
            // ... (Logika UPSERT dan Update Premium yang panjang) ...
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
            
            console.log(`\n============== CALLBACK SUCCESS LOG (OLD BOT) ==============`);
            console.log(`✅ User ${telegramId} | ${telegramUsername} TELAH DI-SET PREMIUM!`);
            console.log(`   premiumUntil: ${newExpiryDate.toISOString()}`);
            console.log(`==========================================================\n`);


            const nominalDisplayed = transactionData.nominal || transactionData.total_amount || '0';
            const message = `🎉 *PEMBAYARAN SUKSES!* 🎉\n\n` +
                             `📦 Produk: ${transactionData.produk || 'Akses Premium'}\n` +
                             `💰 Nominal: Rp${parseInt(nominalDisplayed).toLocaleString('id-ID')}\n` +
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
    
    // Fungsi ini HANYA bertanggung jawab memperbarui status transaksi di DB
    // Logika pengiriman produk/saldo DITANGANI oleh server.js utama melalui webhook

    try {
        const nominal = transactionData.nominal || transactionData.total_amount;
        
        // Cari transaksi PENDING dan update ke SUCCESS
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
             console.error(`❌ [NEW BOT] Gagal mengupdate transaksi ${refId}. Mungkin tidak ditemukan atau status sudah berubah.`);
             return;
        }

        console.log(`\n============== CALLBACK SUCCESS LOG (NEW BOT) ==============`);
        console.log(`✅ [NEW BOT] Transaksi ${refId} berhasil diupdate ke SUCCESS.`);
        console.log(`==========================================================\n`);
        
    } catch (error) {
        console.error("❌ [NEW BOT] CALLBACK ERROR saat update database Transaction:", error);
    }
}


// 🔑 ENDPOINT CALLBACK LAMA (TERIMA SEMUA DAN PISAHKAN LOGIKA) 🔑
app.post("/violet-callback", async (req, res) => {
    const data = req.body;
    
    const refid = data.ref || data.ref_kode; 
    const incomingSignature = req.headers['x-callback-signature'] || data.signature;
    const nominal = data.nominal || data.total_amount || '0';

    const clientIp = req.headers['x-forwarded-for'] ? 
                             req.headers['x-forwarded-for'].split(',')[0].trim() : 
                             req.ip;

    console.log(`--- CALLBACK DITERIMA ---`);
    console.log(`Ref ID: ${refid}, Status: ${data.status}`);
    console.log(`IP Pengirim: ${clientIp}`);

    try {
        if (!refid) {
            console.error("❌ Callback: Nomor referensi (ref/ref_kode) tidak ditemukan.");
            return res.status(400).send({ status: false, message: "Missing reference ID" });
        }

        // --- 1. VALIDASI SIGNATURE ---
        const calculatedSignature = crypto
            .createHmac("sha256", VIOLET_SECRET_KEY) 
            .update(refid)
            .digest("hex");

        const isSignatureValid = (calculatedSignature === incomingSignature);
        
        if (!isSignatureValid) {
            console.log(`🚫 Signature callback TIDAK VALID! Dikirim: ${incomingSignature}, Hitungan Server: ${calculatedSignature}`);
        }

        // --- 2. CEK STATUS SUKSES ---
        if (data.status === "success" && isSignatureValid) {
            
            // --- 3. LOGIKA PEMISAHAN REF ID ---
            if (refid.startsWith('PROD-') || refid.startsWith('TOPUP-')) {
                // FORMAT BARU (Bot Auto Payment)
                console.log("✅ Mengalihkan ke pemrosesan BOT BARU...");
                await sendSuccessNotificationNew(refid, data);
            } else if (refid.includes(':')) {
                // FORMAT LAMA (Bot Premium, misal: NUXYS:user:id:ts)
                console.log("✅ Mengalihkan ke pemrosesan BOT LAMA...");
                await sendSuccessNotificationOld(refid, data);
            } else {
                console.log(`⚠️ Ref ID format tidak dikenali: ${refid}`);
            }

        } else if (data.status !== "success") {
            console.log(`⚠️ Status callback non-sukses diterima: ${data.status} (Ref: ${refid})`);
        }
        
        // --- 4. Wajib mengirim status 200 OK ---
        res.status(200).send({ status: true, message: "Callback received and processed" }); 
        
    } catch (error) {
        console.error("❌ Callback: Error saat memproses callback:", error);
        res.status(200).send({ status: false, message: "Internal server error during processing" });
    }
});


// 🔑 ENDPOINT CALLBACK BARU (Bot Auto-Payment) 🔑
// Endpoint ini tidak perlu diubah, tapi harus ada untuk menerima callback dari server.js utama
app.post("/paymentbot-callback", async (req, res) => {
    const data = req.body;
    
    const refid = data.ref || data.ref_kode; 
    const nominal = data.nominal || data.total_amount;

    console.log(`--- CALLBACK DITERIMA (NEW BOT: /paymentbot-callback) ---`);

    try {
        if (data.status === "success") {
            await sendSuccessNotificationNew(refid, data); 
        }

        res.status(200).send({ status: true, message: "Callback received and processed for new bot" }); 
        
    } catch (error) {
        console.error("❌ [NEW BOT] Error saat memproses callback:", error);
        res.status(200).send({ status: false, message: "Internal server error during processing" });
    }
});


app.listen(PORT, () => console.log(`🚀 Callback server jalan di port ${PORT}`));
