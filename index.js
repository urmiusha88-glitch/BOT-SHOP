require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto'); // Built-in Node module

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.set('trust proxy', true);

const ADMIN_ID = process.env.ADMIN_ID; 
let isMaintenance = false;

// 🔥 EMAIL TRANSPORTER CONFIGURATION
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // e.g., yourgmail@gmail.com
        pass: process.env.EMAIL_PASS  // e.g., 16-digit App Password
    }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/admin') || req.path === '/admin') return next();
  if (isMaintenance) {
      if (req.path.startsWith('/api/')) return res.status(503).json({ success: false, error: 'Maintenance Mode is ON' });
      return res.status(503).sendFile(__dirname + '/maintenance.html');
  }
  next();
});

const generateRefCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();
async function getAllRates() { try { const res = await fetch('https://open.er-api.com/v6/latest/USD'); const data = await res.json(); return data.rates; } catch (e) { return { BDT: 120, INR: 83, PKR: 278 }; } }

// --- BOT WIZARD (Product Add) ---
const addProductWizard = new Scenes.WizardScene('ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('🛒 1. Product Name?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('💵 2. Price in USD?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = ctx.message.text; ctx.reply('🪄 3. Description?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.abilities = ctx.message.text; ctx.reply('📦 4. Stock Count?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.stock = parseInt(ctx.message.text) || 1; ctx.reply('📸 5. Send Product Photo:'); return ctx.wizard.next(); },
  (ctx) => { if (!ctx.message.photo) return ctx.reply('❌ Valid photo required!'); ctx.wizard.state.imageId = ctx.message.photo[ctx.message.photo.length - 1].file_id; ctx.reply('🔗 6. Download Link:'); return ctx.wizard.next(); },
  async (ctx) => { ctx.wizard.state.driveLink = ctx.message.text; const { name, price, abilities, stock, imageId, driveLink } = ctx.wizard.state; await prisma.product.create({ data: { name, price, abilities, stock, imageId, driveLink } }); ctx.reply(`✅ *Product Published!*`, { parse_mode: 'Markdown' }); return ctx.scene.leave(); }
);
const stage = new Scenes.Stage([addProductWizard]); bot.use(session()); bot.use(stage.middleware());

bot.start((ctx) => { ctx.reply(`🌟 *Welcome to AURA DIGITAL STORE*\nYour ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🌐 Visit Website', url: 'https://bot-shop-production.up.railway.app/' }]] }}); });
bot.command('addproduct', (ctx) => { if (ctx.from.id.toString() !== ADMIN_ID) return; ctx.scene.enter('ADD_PRODUCT_SCENE'); });

async function processDeposit(id, action) {
  const dep = await prisma.deposit.findUnique({ where: { id }, include: { user: true } });
  if (dep && dep.status === 'PENDING') {
    if (action === 'APPROVE') {
      const rates = await getAllRates(); const userRate = dep.user.country === 'IN' ? rates.INR : (dep.user.country === 'PK' ? rates.PKR : rates.BDT); const usdAmount = dep.amountBdt / userRate; 
      if (dep.user.referredBy && !dep.user.referralRewardPaid) {
          const pastDeps = await prisma.deposit.findMany({ where: { userId: dep.userId, status: 'APPROVED' } });
          const totalPastBdt = pastDeps.reduce((sum, d) => sum + d.amountBdt, 0); const totalUsdDeposited = (totalPastBdt + dep.amountBdt) / userRate;
          if (totalUsdDeposited >= 4.0) { const referrer = await prisma.user.findUnique({ where: { refCode: dep.user.referredBy } }); if (referrer) await prisma.user.update({ where: { id: referrer.id }, data: { balanceUsd: { increment: 1.0 } } }); await prisma.user.update({ where: { id: dep.userId }, data: { referralRewardPaid: true } }); }
      }
      await prisma.user.update({ where: { id: dep.userId }, data: { balanceUsd: { increment: usdAmount } } }); await prisma.deposit.update({ where: { id }, data: { status: 'APPROVED' } }); return { success: true, msg: `Approved: $${usdAmount.toFixed(2)}` };
    } else { await prisma.deposit.update({ where: { id }, data: { status: 'REJECTED' } }); return { success: true, msg: 'Rejected' }; }
  } return { success: false, msg: 'Error' };
}
bot.action(/approve_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'APPROVE'); ctx.editMessageText(`✅ ${res.msg}`); });
bot.action(/reject_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'REJECT'); ctx.editMessageText(`❌ ${res.msg}`); });

// --- EMAIL & AUTH APIs ---
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, country, refCode } = req.body;
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress; if(ip && ip.includes(',')) ip = ip.split(',')[0];
        const ipCount = await prisma.user.count({ where: { ipAddress: ip } });
        if (ipCount >= 5) return res.status(400).json({ success: false, error: 'Device limit reached (Max 5).' });

        let referredBy = null;
        if (refCode) { const referrer = await prisma.user.findUnique({ where: { refCode: refCode.toUpperCase() } }); if (referrer) { referredBy = referrer.refCode; await prisma.user.update({ where: { id: referrer.id }, data: { refCount: { increment: 1 } } }); } }

        const verifyToken = crypto.randomBytes(32).toString('hex');
        await prisma.user.create({ data: { firstName: name, email, password, country, refCode: generateRefCode(), referredBy, ipAddress: ip, verifyToken, isVerified: false } });

        // Send Verification Email
        const verifyLink = `https://${req.get('host')}/api/verify-email/${verifyToken}`;
        const mailOptions = {
            from: `"AURA DIGITAL" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Verify Your Email - AURA DIGITAL STORE',
            html: `<div style="font-family: Arial; padding: 20px; background: #0b1121; color: white; border-radius: 10px;">
                    <h2 style="color: #3b82f6;">Welcome to AURA DIGITAL!</h2>
                    <p>Hello ${name},</p>
                    <p>Thank you for registering. To ensure the security of our premium marketplace, please verify your email address by clicking the button below:</p>
                    <a href="${verifyLink}" style="display: inline-block; padding: 12px 25px; background: #3b82f6; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 15px;">Verify My Email</a>
                    <p style="margin-top: 20px; font-size: 12px; color: #94a3b8;">If you did not request this, please ignore this email.</p>
                   </div>`
        };
        if(process.env.EMAIL_USER && process.env.EMAIL_PASS) { await transporter.sendMail(mailOptions); }
        
        res.json({ success: true, message: 'Please check your email to verify your account.' });
    } catch(e) { res.status(400).json({ success: false, error: 'Email already exists or invalid.' }); }
});

app.get('/api/verify-email/:token', async (req, res) => {
    const user = await prisma.user.findFirst({ where: { verifyToken: req.params.token } });
    if (!user) return res.status(400).send('<h2 style="text-align:center; margin-top:20%; font-family:sans-serif; color:red;">Invalid or Expired Token!</h2>');
    await prisma.user.update({ where: { id: user.id }, data: { isVerified: true, verifyToken: null } });
    res.send('<h2 style="text-align:center; margin-top:20%; font-family:sans-serif; color:green;">Email Verified Successfully! Redirecting...</h2><script>setTimeout(()=>window.location.href="/login", 2000);</script>');
});

app.post('/api/login', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (user && user.password === req.body.password) {
        if(user.isBanned) return res.status(403).json({ success: false, error: 'Account Banned' });
        if(!user.isVerified) return res.status(403).json({ success: false, error: 'Please verify your email first. Check your inbox/spam folder.' });
        res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd, country: user.country, refCode: user.refCode, isVip: user.isVip, role: user.role, avatar: user.avatar, refCount: user.refCount } });
    } else res.status(401).json({ success: false, error: 'Invalid credentials' });
});

// 🔥 FORGOT PASSWORD APIs
app.post('/api/forgot-password', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (!user) return res.json({ success: false, error: 'Email not found.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpiry = new Date(Date.now() + 3600000); // 1 Hour Expiry
    await prisma.user.update({ where: { id: user.id }, data: { resetToken, resetExpiry } });

    const resetLink = `https://${req.get('host')}/reset-password/${resetToken}`;
    const mailOptions = {
        from: `"AURA DIGITAL" <${process.env.EMAIL_USER}>`, to: user.email, subject: 'Password Reset Request',
        html: `<div style="font-family: Arial; padding: 20px; background: #0b1121; color: white; border-radius: 10px;">
                <h2 style="color: #ef4444;">Password Reset</h2>
                <p>Hello ${user.firstName},</p>
                <p>We received a request to reset your password. Click below to create a new one (Valid for 1 hour):</p>
                <a href="${resetLink}" style="display: inline-block; padding: 12px 25px; background: #ef4444; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 15px;">Reset Password</a>
               </div>`
    };
    try { await transporter.sendMail(mailOptions); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'Failed to send email. Admin needs to configure SMTP.' }); }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    const user = await prisma.user.findFirst({ where: { resetToken: token, resetExpiry: { gt: new Date() } } });
    if (!user) return res.json({ success: false, error: 'Token is invalid or expired.' });
    await prisma.user.update({ where: { id: user.id }, data: { password: newPassword, resetToken: null, resetExpiry: null } });
    res.json({ success: true });
});

// Dynamic Reset Password Page
app.get('/reset-password/:token', (req, res) => {
    res.send(`
    <!DOCTYPE html><html lang="en" class="dark"><head><title>Reset Password</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script></head>
    <body class="bg-[#050b14] h-screen flex justify-center items-center text-white"><div class="bg-slate-900 p-8 rounded-[32px] w-full max-w-md text-center border border-slate-800"><h2 class="text-3xl font-black mb-6">New Password</h2>
    <input type="password" id="nPass" placeholder="Enter new password" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 font-bold outline-none focus:border-blue-500 mb-4">
    <button onclick="resetP()" class="w-full bg-blue-600 py-3 rounded-xl font-black uppercase">Update Password</button></div>
    <script>async function resetP() { const pass = document.getElementById('nPass').value; if(!pass)return; const res = await fetch('/api/reset-password', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:'${req.params.token}', newPassword:pass})}); const data = await res.json(); if(data.success) {Swal.fire('Success','Password updated!','success').then(()=>window.location.href='/login');} else Swal.fire('Error',data.error,'error'); }</script></body></html>
    `);
});

// Other APIs (Rate, Products, Checkout, etc.)
app.get('/api/rate', async (req, res) => res.json({ rates: await getAllRates() }));
app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } })));
app.get('/api/products', async (req, res) => res.json(await prisma.product.findMany({ orderBy: { createdAt: 'desc' } })));
app.get('/api/user/:id', async (req, res) => { const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } }); if(user) res.json({ success: true, ...user }); else res.json({ success: false }); });
app.post('/api/user/update', async (req, res) => { const { userId, email, password, avatar } = req.body; try { const data = {}; if (email) data.email = email; if (password) data.password = password; if (avatar !== undefined) data.avatar = avatar; await prisma.user.update({ where: { id: parseInt(userId) }, data }); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'Update failed.' }); } });
app.get('/api/library/:userId', async (req, res) => { res.json(await prisma.purchase.findMany({ where: { userId: parseInt(req.params.userId) }, include: { product: true }, orderBy: { createdAt: 'desc' } })); });
app.get('/api/history/:userId', async (req, res) => { res.json(await prisma.deposit.findMany({ where: { userId: parseInt(req.params.userId) }, orderBy: { createdAt: 'desc' } })); });
app.post('/api/deposit', async (req, res) => { const { userId, method, amountBdt, senderNumber, trxId } = req.body; try { const dep = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } }); const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } }); if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `💰 *FUND REQUEST*\n\n👤 User: ${user.firstName}\n💵 Amount: ${amountBdt} BDT\n💳 Gateway: ${method.toUpperCase()}\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${dep.id}` }, { text: '❌ Reject', callback_data: `reject_${dep.id}` }]] } }); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'TrxID already exists' }); } });
app.post('/api/promo', async (req, res) => { const p = await prisma.promo.findUnique({ where: { code: req.body.code.toUpperCase() } }); if(p && p.isActive) res.json({ success: true, discount: p.discount }); else res.json({ success: false, error: 'Invalid Code!' }); });
app.post('/api/buy-vip', async (req, res) => { const u = await prisma.user.findUnique({ where: { id: parseInt(req.body.userId) } }); if(!u || u.balanceUsd < 30) return res.json({ success: false, error: 'Insufficient funds.' }); const expiry = new Date(); expiry.setDate(expiry.getDate() + 30); await prisma.user.update({ where: { id: u.id }, data: { balanceUsd: { decrement: 30 }, isVip: true, vipExpiry: expiry } }); res.json({ success: true, newBalance: u.balanceUsd - 30 }); });
app.post('/api/checkout', async (req, res) => { const { userId, cartItems, promoCode } = req.body; try { const user = await prisma.user.findUnique({ where: { id: parseInt(userId) }, include: { purchases: true } }); if(user.isBanned) return res.status(403).json({ success: false, error: 'Banned!' }); const isVip = user.isVip && user.vipExpiry && new Date(user.vipExpiry) > new Date(); let disc = 1; if(promoCode && !isVip) { const p = await prisma.promo.findUnique({ where: { code: promoCode.toUpperCase() } }); if(p) disc = 1 - (p.discount/100); } let total = 0; let itemsToBuy = []; for (let pId of [...new Set(cartItems)]) { const prod = await prisma.product.findUnique({ where: { id: parseInt(pId) } }); if(!prod || prod.stock <= 0 || user.purchases.some(p => p.productId === prod.id)) continue; let pPrice = isVip ? 0 : parseFloat(prod.price) * disc; total += pPrice; itemsToBuy.push(prod); } if(user.balanceUsd < total) return res.json({ success: false, error: 'Insufficient Funds' }); await prisma.user.update({ where: { id: user.id }, data: { balanceUsd: { decrement: total } } }); for (let itm of itemsToBuy) { await prisma.purchase.create({ data: { userId: user.id, productId: itm.id, pricePaid: isVip?0:parseFloat(itm.price)*disc } }); await prisma.product.update({ where: { id: itm.id }, data: { stock: { decrement: 1 } } }); } res.json({ success: true, newBalance: user.balanceUsd - total }); } catch(e) { res.status(500).json({ success: false }); } });

// Admin APIs
app.post('/api/admin/login', (req, res) => { if (req.body.password === (process.env.ADMIN_PASSWORD || 'Ananto01@$')) res.json({ success: true }); else res.status(401).json({ success: false }); });
app.get('/api/admin/stats', async (req, res) => { const recentPurchases = await prisma.purchase.findMany({ take: 30 }); let revenue = recentPurchases.reduce((acc, p) => acc + p.pricePaid, 0); res.json({ users: await prisma.user.count(), deposits: await prisma.deposit.findMany({ include: { user: true }, take: 20, orderBy: { createdAt: 'desc' } }), products: await prisma.product.findMany(), promos: await prisma.promo.findMany(), userList: await prisma.user.findMany({ take: 20, orderBy: { createdAt: 'desc' } }), revenue }); });
app.post('/api/admin/user/action', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); if(req.body.action === 'ban') { const u = await prisma.user.findUnique({where:{id:parseInt(req.body.id)}}); await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{isBanned:!u.isBanned}}); } else if(req.body.action === 'balance') { await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{balanceUsd:parseFloat(req.body.amount)}}); } else if(req.body.action === 'role') { await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{role:req.body.role}}); } res.json({success:true}); });
app.post('/api/admin/deposit/action', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); const result = await processDeposit(parseInt(req.body.id), req.body.action); res.json(result); });
app.post('/api/admin/product', async (req, res) => { try { const { name, price, abilities, stock, driveLink } = req.body; await prisma.product.create({ data: { name, price, abilities, stock: parseInt(stock), driveLink } }); res.json({ success: true }); } catch(e) { res.status(500).json({ success: false }); } });
app.delete('/api/admin/product/:id', async (req, res) => { try { await prisma.product.delete({ where: { id: parseInt(req.params.id) } }); res.json({ success: true }); } catch(e) { res.status(500).json({ success: false }); } });
app.post('/api/admin/promo', async (req, res) => { await prisma.promo.create({ data: { code: req.body.code.toUpperCase(), discount: parseInt(req.body.discount) } }); res.json({success:true}); });
app.delete('/api/admin/promo/:id', async (req, res) => { await prisma.promo.delete({ where: { id: parseInt(req.params.id) } }); res.json({success:true}); });
app.post('/api/admin/notice', async (req, res) => { await prisma.notice.create({ data: { text: req.body.text } }); res.json({ success: true }); });
app.get('/api/admin/settings', (req, res) => res.json({ isMaintenance }));
app.post('/api/admin/settings', (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); isMaintenance = req.body.status; res.json({ success: true }); });

// 🔥 Routing
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html')); 

app.listen(8080);
bot.launch();
