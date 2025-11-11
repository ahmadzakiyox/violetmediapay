const express = require("express");
const { Telegraf, Markup } = require('telegraf');
const mongoose = require("mongoose");
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require("crypto");
const { URLSearchParams } = require("url"); 
const fetch = require('node-fetch'); 

require("dotenv").config();

// ====== KONFIGURASI UMUM ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
const PORT = process.env.PORT || 3000; 
const SERVER_BASE_URL = process.env.SERVER_BASE_URL; 
const MAX_LINKS_NON_PREMIUM = 3; 
const PREMIUM_PRICE = 10000; 
const VIOLET_API_KEY = process.env.VIOLET_API_KEY;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const CALLBACK_URL = process.env.CALLBACK_URL; 
const VIOLET_IP = '202.155.132.37'; 
const WEBHOOK_TELEGRAM_PATH = `/telegram-webhook-${BOT_TOKEN.slice(-5)}`; 

// ====================================================
// ====== DATABASE LINK (JSON) & MONGODB SETUP ======
// ====================================================

const DB_FILE = path.join(__dirname, 'links.json');
let linksDb = {};
function loadDatabase() { /* ... */ }
function saveDatabase() { /* ... */ }
loadDatabase();

mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 30000, 
    socketTimeoutMS: 45000 
})
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: { type: String, default: '' },
    isPremium: { type: Boolean, default: false },
    premiumUntil: { type: Date, default: null },
    refId: { type: String, default: null },
    email: { type: String, unique: true, sparse: true } 
});
const User = mongoose.model("User", userSchema);

// ====================================================
// ====== UTILITY FUNCTIONS ======
// ====================================================
function isPremium(user) { /* ... */ return false; }
async function getUser(ctx) {
    const userId = ctx.from.id;
    let user = await User.findOne({ userId });
    if (!user) {
        const uniqueEmailPlaceholder = `tg_${userId}_${Date.now()}@userbot.co`;
        user = new User({ userId, username: ctx.from.username || ctx.from.first_name, email: uniqueEmailPlaceholder });
        await user.save();
    }
    return user;
}
function generateRandomPhone() { return `081${Math.floor(Math.random() * 900000000) + 100000000}`; }
async function shortenUrl(longUrl) { /* ... */ return longUrl; }
function isAdmin(ctx) { return ADMIN_IDS.includes(ctx.from.id); }
const adminGuard = (ctx, next) => { if (isAdmin(ctx)) { return next(); } ctx.reply('❌ Anda tidak memiliki izin Administrator.'); };


// ====================================================
// ====== TELEGRAF BOT INITALIZATION & EXPRESS SETUP ======
// ====================================================
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Middleware Express
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 


// ----------------------------------------------------
// ====== ENDPOINT 2: TELEGRAM WEBHOOK (FIXED ROUTING) ======
// ----------------------------------------------------

// 🚨 PERBAIKAN KRITIS DI SINI: Gunakan app.post untuk path Webhook yang spesifik.
app.post(WEBHOOK_TELEGRAM_PATH, (req, res) => {
    // Telegraf akan memproses body request yang sudah di-parse oleh middleware di atas
    bot.handleUpdate(req.body, res); 
});


// ----------------------------------------------------
// ====== FUNGSI CALLBACK & NOTIFIKASI PEMBAYARAN ======
// ----------------------------------------------------
async function sendSuccessNotification(refId, transactionData) {
    // ... Logika Notifikasi Sukses sama persis ...
    try {
        const user = await User.findOne({ refId: refId });
        if (!user) return;
        const telegramId = user.userId;
        const premiumDurationDays = 30; 
        let newExpiryDate = user.premiumUntil && user.premiumUntil > new Date() ? user.premiumUntil : new Date();
        newExpiryDate.setDate(newExpiryDate.getDate() + premiumDurationDays);
        await User.updateOne({ userId: telegramId }, { isPremium: true, premiumUntil: newExpiryDate });

        const nominalDisplayed = transactionData.nominal || transactionData.total_amount || '0';
        const message = `🎉 *PEMBAYARAN SUKSES!* 🎉\n\n...` +
                        `💰 Nominal: Rp${parseInt(nominalDisplayed).toLocaleString('id-ID')}\n` +
                        `🌟 Akses premium Anda diaktifkan hingga: *${newExpiryDate.toLocaleDateString("id-ID")}*.`;
        
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown' });

    } catch (error) { console.error("❌ Callback: Error saat mengirim notifikasi sukses:", error); }
}


// ----------------------------------------------------
// ====== ENDPOINT 1: CALLBACK PEMBAYARAN VIOLET (EXPRESS POST) ======
// ----------------------------------------------------

app.post("/violet-callback", async (req, res) => {
    const data = req.body;
    const refid = data.ref || data.ref_kode; 
    const headerSignature = req.headers['x-callback-signature'];
    const incomingSignature = headerSignature || data.signature;
    const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.ip;
    
    try {
        if (clientIp !== VIOLET_IP) { return res.status(200).send({ status: false, message: "IP Mismatch, ignored." }); }
        
        if (!VIOLET_API_KEY || !refid) { return res.status(400).send({ status: false, message: "Missing key or refId" }); }
        
        const calculatedSignature = crypto.createHmac("sha256", VIOLET_API_KEY).update(refid).digest("hex");
        const isSignatureValid = (calculatedSignature === incomingSignature);

        if (isSignatureValid || !incomingSignature) {
            if (data.status === "success") { await sendSuccessNotification(refid, data); }
        } else { console.log(`🚫 Signature callback TIDAK VALID!`); }

        res.status(200).send({ status: true, message: "Callback processed" }); 
    } catch (error) {
        console.error("❌ Callback Error:", error);
        res.status(200).send({ status: false, message: "Internal server error" });
    }
});


// ----------------------------------------------------
// ====== BOT COMMANDS (LOGIKA TELEGRAM) ======
// ----------------------------------------------------

const mainKeyboard = Markup.keyboard([
    ['/buatlink', '/listlink'],
    ['/premium', '/help']
]).resize();

bot.start(async (ctx) => {
    await getUser(ctx);
    ctx.replyWithHTML(`👋 <b>Halo ${ctx.from.first_name || 'Pengguna'}!</b>\n\n...`, mainKeyboard);
});

bot.command('help', (ctx) => {
    let message = `<b>Perintah yang tersedia:</b>\n\n...`; 
    if (isAdmin(ctx)) { message += `\n\n👑 <b>Perintah Admin:</b>\n...`; }
    ctx.replyWithHTML(message);
});

// Perintah: /buatlink
bot.command('buatlink', async (ctx) => {
    const user = await getUser(ctx);
    const adminId = user.userId.toString();
    const isUserPremium = isPremium(user);
    const userLinks = linksDb[adminId];
    const currentLinkCount = userLinks ? Object.keys(userLinks).length : 0;
    
    if (!isUserPremium && currentLinkCount >= MAX_LINKS_NON_PREMIUM) {
        return ctx.replyWithMarkdown(`⚠️ *Batas Tercapai!* ⚠️\n\n...`);
    }
    
    const args = ctx.message.text.split(' '); args.shift(); 
    const name = args.join(' ').trim();

    if (!name) { return ctx.reply('⚠️ Gagal! Mohon masukkan nama.'); }
    if (userLinks && userLinks[name]) { return ctx.reply(`⚠️ Link dengan nama [${name}] sudah ada.`); }

    let originalTrackingLink = `${SERVER_BASE_URL}/?alias=${encodeURIComponent(name)}&uid=${adminId}`;
    let shortenedLink = await shortenUrl(originalTrackingLink); 

    if (!linksDb[adminId]) { linksDb[adminId] = {}; }
    linksDb[adminId][name] = shortenedLink; saveDatabase();

    ctx.replyWithHTML(
        `✨ <b>Link berhasil dibuat untuk [${name}]</b>` +
        (!isUserPremium ? ` (Link ke ${currentLinkCount + 1} dari ${MAX_LINKS_NON_PREMIUM})` : `(👑 Premium)`) +
        `\n\nBerikan link ini kepadanya. Saat dibuka, Anda akan menerima info lokasi & foto.` +
        `\n\n🔗 <b>Link:</b>\n<code>${shortenedLink}</code>`, 
        { disable_web_page_preview: true, ...Markup.inlineKeyboard([Markup.button.callback('🗑️ Hapus Link Ini', `delete:${name}`)]) }
    );
});

// Perintah: /listlink
bot.command('listlink', async (ctx) => {
    const user = await getUser(ctx);
    const userLinks = linksDb[user.userId.toString()];
    if (!userLinks || Object.keys(userLinks).length === 0) { return ctx.reply('Anda belum membuat link apapun.'); }
    let message = '📋 <b>Daftar Link Aktif Anda:</b>\n\n';
    for (const name in userLinks) { message += `• <b>${name}</b>:\n  <code>${userLinks[name]}</code>\n`; }
    ctx.replyWithHTML(message, { disable_web_page_preview: true });
});

// Perintah /hapuslink & bot.action
bot.command('hapuslink', async (ctx) => {
    const args = ctx.message.text.split(' '); args.shift(); 
    const name = args.join(' ').trim();
    if (!name) { return ctx.reply('⚠️ Mohon masukkan nama link yang akan dihapus.'); }
    if (linksDb[ctx.chat.id] && linksDb[ctx.chat.id][name]) { delete linksDb[ctx.chat.id][name]; saveDatabase(); ctx.reply(`✅ Link untuk [${name}] berhasil dihapus.`); } else { ctx.reply(`❌ Link dengan nama [${name}] tidak ditemukan.`); }
});
bot.action(/delete:(.+)/, (ctx) => {
    const name = ctx.match[1]; const adminId = ctx.chat.id.toString();
    if (linksDb[adminId] && linksDb[adminId][name]) { delete linksDb[adminId][name]; saveDatabase(); ctx.editMessageText(`✅ Link untuk [${name}] telah dihapus.`); ctx.answerCbQuery('Link berhasil dihapus'); } else { ctx.answerCbQuery('Link tidak ditemukan', { show_alert: true }); }
});

// Perintah: /premium & checkout logic
bot.command('premium', async (ctx) => {
    const user = await getUser(ctx);
    if (isPremium(user)) { const expiry = user.premiumUntil.toLocaleDateString("id-ID", { year: 'numeric', month: 'long', day: 'numeric' }); return ctx.reply(`👑 Anda sudah Premium!\nPremium Anda berlaku hingga: *${expiry}*.`, { parse_mode: 'Markdown' }); }
    const premiumMessage = `💳 *Akses Premium Bot Pelacak* 💳\n\nUpgrade ke Premium...\n\n💰 *Harga:* Rp${PREMIUM_PRICE.toLocaleString('id-ID')} (Untuk 30 hari)\nTekan tombol di bawah untuk melakukan pembayaran.`;
    ctx.reply(premiumMessage, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('Lanjutkan Pembayaran', 'checkout_premium')]) });
});
bot.action('checkout_premium', async (ctx) => {
    // Logika Checkout
    await ctx.answerCbQuery('Membuat transaksi...');
    if (!VIOLET_API_KEY || !VIOLET_SECRET_KEY || !CALLBACK_URL) { return ctx.reply("❌ Konfigurasi Pembayaran tidak lengkap. Hubungi Admin."); }
    try {
        const userId = ctx.from.id; const amount = PREMIUM_PRICE.toString(); const ref_kode = `PREMIUM-${userId}-${Date.now()}`;
        const telegramUsername = ctx.from.username || `tguser_${userId}`; const uniqueEmail = `${telegramUsername}_${Date.now()}@telegram.me`; 
        const placeholderPhone = generateRandomPhone();
        const signatureString = ref_kode + VIOLET_API_KEY + amount;
        const signature = crypto.createHmac("sha256", VIOLET_SECRET_KEY).update(signatureString).digest("hex");
        const params = new URLSearchParams({ api_key: VIOLET_API_KEY, secret_key: VIOLET_SECRET_KEY, channel_payment: "QRIS", ref_kode: ref_kode, nominal: amount, cus_nama: ctx.from.first_name || "User Telegram", cus_email: uniqueEmail, cus_phone: placeholderPhone, produk: "Akses Premium 30 Hari", url_redirect: SERVER_BASE_URL + '/thanks', url_callback: CALLBACK_URL, expired_time: Math.floor(Date.now() / 1000) + 86400, signature: signature });
        
        const res = await fetch("https://violetmediapay.com/api/live/create", { method: "POST", body: params });
        const data = await res.json();
        
        if (data.status === true && data.data?.payment_status !== 'Expired') {
            const info = data.data; 
            await User.findOneAndUpdate({ userId: userId }, { refId: ref_kode, email: uniqueEmail }, { new: true, upsert: true });
            ctx.editMessageCaption(`💳 *Pembayaran Premium* 💳\n\n...`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([Markup.button.url('🔗 Bayar Sekarang', info.checkout_url)]) });
        } else { console.error("Gagal membuat transaksi Violet:", data); ctx.reply(`❌ Gagal membuat link pembayaran: ${data.msg || "Server Error"}`); }
    } catch (err) { console.error("❌ Error saat checkout premium:", err); ctx.reply("⚠️ Terjadi kesalahan server saat memproses pembayaran."); }
});


// Perintah ADMIN
bot.command('addpremium', adminGuard, async (ctx) => {
    const args = ctx.message.text.split(/\s+/); args.shift(); const targetId = parseInt(args[0]); let durationDays = parseInt(args[1]);
    if (isNaN(targetId) || isNaN(durationDays) || durationDays <= 0) { return ctx.reply('⚠️ Format salah.', { parse_mode: 'Markdown' }); }
    try {
        let user = await User.findOne({ userId: targetId });
        if (!user) { user = new User({ userId: targetId, username: `Manual_${targetId}`, email: `manual_${targetId}_${Date.now()}@bot.co` }); await user.save(); }
        let newExpiryDate = user.premiumUntil || new Date(); if (newExpiryDate < new Date()) { newExpiryDate = new Date(); }
        newExpiryDate.setDate(newExpiryDate.getDate() + durationDays);
        await User.updateOne({ userId: targetId }, { isPremium: true, premiumUntil: newExpiryDate });
        const expiryDateString = newExpiryDate.toLocaleDateString("id-ID", { year: 'numeric', month: 'long', day: 'numeric' });
        ctx.reply(`✅ Premium ditambahkan untuk User ID *${targetId}* selama ${durationDays} hari.\nKedaluwarsa: ${expiryDateString}.`, { parse_mode: 'Markdown' });
        bot.telegram.sendMessage(targetId, `🎉 Akses Premium Anda telah diaktifkan secara manual oleh Admin hingga *${expiryDateString}*!`, { parse_mode: 'Markdown' }).catch(e => console.error("Gagal kirim notif:", e.message));
    } catch (error) { console.error("❌ Error /addpremium:", error); ctx.reply(`❌ Gagal memproses: ${error.message}`); }
});

bot.command('listusers', adminGuard, async (ctx) => {
    try {
        const users = await User.find({}).sort({ isPremium: -1, premiumUntil: -1 });
        let message = '📊 <b>Daftar Semua Pengguna</b> 📊\n\n'; let premiumCount = 0;
        const displayUsers = users.slice(0, 50);
        displayUsers.forEach(user => {
            const status = isPremium(user) ? '👑 PREMIUM' : '👤 Biasa';
            const expiry = isPremium(user) && user.premiumUntil ? ` (hingga ${user.premiumUntil.toLocaleDateString("id-ID")})` : '';
            const userIdDisplay = user.userId ? user.userId : 'UNDEFINED_ID'; 
            const usernameDisplay = user.username && !user.username.startsWith('Manual_') ? `@${user.username}` : 'N/A';
            message += `[${status}] ID: <code>${userIdDisplay}</code> | ${usernameDisplay}${expiry}\n`; 
            if (isPremium(user)) premiumCount++; else basicCount++;
        });
        message += `\n--- Total: ${users.length} ---\n👑 Premium: ${premiumCount}\n👤 Biasa: ${users.length - premiumCount}`;
        ctx.reply(message, { parse_mode: 'HTML' }); 
    } catch (error) { console.error("❌ Error /listusers:", error); ctx.reply(`❌ Gagal mengambil data pengguna: ${error.message}`); }
});

bot.command('deleteuser', adminGuard, async (ctx) => {
    const args = ctx.message.text.split(/\s+/); args.shift(); const targetId = parseInt(args[0]);
    if (isNaN(targetId)) { return ctx.reply('⚠️ Format salah.', { parse_mode: 'Markdown' }); }
    if (targetId === ctx.from.id) { return ctx.reply('❌ Anda tidak dapat menghapus akun Anda sendiri.'); }
    try {
        const result = await User.deleteOne({ userId: targetId });
        const deletedLinks = linksDb[targetId] ? Object.keys(linksDb[targetId]).length : 0;
        if (linksDb[targetId]) { delete linksDb[targetId]; saveDatabase(); }
        if (result.deletedCount > 0) { ctx.reply(`✅ Pengguna ID *${targetId}* berhasil dihapus...`, { parse_mode: 'Markdown' }); } else { ctx.reply(`❌ Pengguna ID *${targetId}* tidak ditemukan.`); }
    } catch (error) { console.error("❌ Error /deleteuser:", error); ctx.reply(`❌ Gagal menghapus pengguna: ${error.message}`); }
});


// ----------------------------------------------------
// ====== SERVER LAUNCH & WEBHOOK SETUP ======
// ----------------------------------------------------

app.listen(PORT, async () => {
    console.log(`🚀 Server Express berjalan di port ${PORT}`);
    
    if (!SERVER_BASE_URL) {
        console.error("❌ SERVER_BASE_URL tidak diset! Webhook tidak akan bekerja.");
        return;
    }
    
    // Set Webhook ke Telegram API
    const webhookUrl = `${SERVER_BASE_URL}${WEBHOOK_TELEGRAM_PATH}`;
    
    try {
        await bot.telegram.deleteWebhook();
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`✅ Telegram Webhook diset ke: ${webhookUrl}`);
    } catch (e) {
        console.error("❌ Gagal mengatur Webhook Telegram:", e.message);
    }
});
