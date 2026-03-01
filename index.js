require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.set('trust proxy', true);

const ADMIN_ID = process.env.ADMIN_ID; 
let isMaintenance = false;

const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });

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

const addProductWizard = new Scenes.WizardScene('ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('🛒 1. Product Name?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('💵 2. Price in USD?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = ctx.message.text; ctx.reply('🪄 3. Description?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.stock = parseInt(ctx.message.text) || 1; ctx.reply('📸 4. Send Product Photo:'); return ctx.wizard.next(); },
  (ctx) => { if (!ctx.message.photo) return ctx.reply('❌ Valid photo required!'); ctx.wizard.state.imageId = ctx.message.photo[ctx.message.photo.length - 1].file_id; ctx.reply('🔗 5. Download Link:'); return ctx.wizard.next(); },
  async (ctx) => { ctx.wizard.state.driveLink = ctx.message.text; const { name, price, abilities, stock, imageId, driveLink } = ctx.wizard.state; await prisma.product.create({ data: { name, price, abilities, stock, imageId, driveLink } }); ctx.reply(`✅ *Product Published!*`, { parse_mode: 'Markdown' }); return ctx.scene.leave(); }
);
const stage = new Scenes.Stage([addProductWizard]); bot.use(session()); bot.use(stage.middleware());
bot.start((ctx) => { ctx.reply(`🌟 *Welcome to AURA DIGITAL STORE*\nYour ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🌐 Visit Website', url: 'https://bot-shop-production.up.railway.app/' }]] }}); });
bot.command('addproduct', (ctx) => { if (ctx.from.id.toString() !== ADMIN_ID) return; ctx.scene.enter('ADD_PRODUCT_SCENE'); });

// 🔥 FIXED: DEPOSIT CALCULATION ALWAYS USES BDT RATE FOR ACCURACY
async function processDeposit(id, action) {
  const dep = await prisma.deposit.findUnique({ where: { id }, include: { user: true } });
  if (dep && dep.status === 'PENDING') {
    if (action === 'APPROVE') {
      const rates = await getAllRates(); 
      const bdtRate = rates.BDT || 120;
      const usdAmount = dep.amountBdt / bdtRate; 
      
      if (dep.user.referredBy && !dep.user.referralRewardPaid) {
          const pastDeps = await prisma.deposit.findMany({ where: { userId: dep.userId, status: 'APPROVED' } });
          const totalUsd = (pastDeps.reduce((sum, d) => sum + d.amountBdt, 0) + dep.amountBdt) / bdtRate;
          if (totalUsd >= 4.0) { const referrer = await prisma.user.findUnique({ where: { refCode: dep.user.referredBy } }); if (referrer) await prisma.user.update({ where: { id: referrer.id }, data: { balanceUsd: { increment: 1.0 } } }); await prisma.user.update({ where: { id: dep.userId }, data: { referralRewardPaid: true } }); }
      }
      await prisma.user.update({ where: { id: dep.userId }, data: { balanceUsd: { increment: usdAmount } } }); await prisma.deposit.update({ where: { id }, data: { status: 'APPROVED' } }); return { success: true, msg: `Approved: $${usdAmount.toFixed(2)}` };
    } else { await prisma.deposit.update({ where: { id }, data: { status: 'REJECTED' } }); return { success: true, msg: 'Rejected' }; }
  } return { success: false, msg: 'Error' };
}
bot.action(/approve_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'APPROVE'); ctx.editMessageText(`✅ ${res.msg}`); });
bot.action(/reject_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'REJECT'); ctx.editMessageText(`❌ ${res.msg}`); });

const emailHeader = `<div style="max-width: 600px; margin: 0 auto; background-color: #0b1121; border-radius: 16px; overflow: hidden; border: 1px solid #1e293b; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,0.5);"><div style="background: linear-gradient(135deg, #2563eb, #7c3aed); padding: 30px 20px; text-align: center;"><h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 2px; font-weight: 900;">AURA <span style="color: #bfdbfe;">DIGITAL</span></h1><p style="color: #e0e7ff; margin-top: 5px; font-size: 14px;">Premium Digital Marketplace</p></div><div style="padding: 40px 30px; color: #e2e8f0;">`;
const emailFooter = `</div><div style="background-color: #0f172a; padding: 20px; text-align: center; border-top: 1px solid #1e293b;"><p style="color: #64748b; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} AURA DIGITAL STORE. All rights reserved.</p><p style="color: #64748b; font-size: 12px; margin-top: 5px;">Secure automated system email.</p></div></div>`;

app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, country, refCode } = req.body;
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress; if(ip && ip.includes(',')) ip = ip.split(',')[0];
        const ipCount = await prisma.user.count({ where: { ipAddress: ip } });
        if (ipCount >= 5) return res.status(400).json({ success: false, error: 'Device limit reached (Max 5).' });

        let referredBy = null;
        if (refCode) { const r = await prisma.user.findUnique({ where: { refCode: refCode.toUpperCase() } }); if (r) { referredBy = r.refCode; await prisma.user.update({ where: { id: r.id }, data: { refCount: { increment: 1 } } }); } }

        const verifyToken = crypto.randomBytes(32).toString('hex');
        await prisma.user.create({ data: { firstName: name, email, password, country, refCode: generateRefCode(), referredBy, ipAddress: ip, verifyToken, isVerified: false } });

        const verifyLink = `https://${req.get('host')}/api/verify-email/${verifyToken}`;
        const mailOptions = { from: `"AURA DIGITAL" <${process.env.EMAIL_USER}>`, to: email, subject: 'Welcome to AURA - Verify Your Identity', html: `${emailHeader}<h2 style="color: #ffffff; font-size: 22px; margin-bottom: 20px;">Welcome, ${name}! 🎉</h2><p style="color: #cbd5e1; font-size: 15px; line-height: 1.6;">Thank you for joining AURA DIGITAL STORE. To ensure the highest level of security for our premium codes and your future vault, please verify your email address.</p><div style="text-align: center; margin: 35px 0;"><a href="${verifyLink}" style="display: inline-block; background: linear-gradient(to right, #3b82f6, #6366f1); color: #ffffff; padding: 14px 35px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px; letter-spacing: 1px;">VERIFY MY ACCOUNT</a></div><p style="color: #94a3b8; font-size: 13px; text-align: center;">Or copy and paste this link into your browser:<br><br><a href="${verifyLink}" style="color: #3b82f6; word-break: break-all;">${verifyLink}</a></p>${emailFooter}` };
        if(process.env.EMAIL_USER && process.env.EMAIL_PASS) { await transporter.sendMail(mailOptions); }
        res.json({ success: true, message: 'Please check your email inbox (or spam) to verify your account.' });
    } catch(e) { res.status(400).json({ success: false, error: 'Email already exists or invalid.' }); }
});

app.get('/api/verify-email/:token', async (req, res) => {
    const user = await prisma.user.findFirst({ where: { verifyToken: req.params.token } });
    if (!user) return res.status(400).send('<div style="background:#050b14; height:100vh; display:flex; justify-content:center; align-items:center;"><h2 style="color:#ef4444; font-family:sans-serif;">❌ Invalid or Expired Verification Link!</h2></div>');
    await prisma.user.update({ where: { id: user.id }, data: { isVerified: true, verifyToken: null } });
    res.send('<div style="background:#050b14; height:100vh; display:flex; justify-content:center; align-items:center;"><h2 style="color:#10b981; font-family:sans-serif;">✅ Email Verified Successfully! Redirecting to login...</h2><script>setTimeout(()=>window.location.href="/login", 2000);</script></div>');
});

app.post('/api/forgot-password', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (!user) return res.json({ success: false, error: 'Email not found.' });
    const resetToken = crypto.randomBytes(32).toString('hex'); const resetCode = Math.floor(100000 + Math.random() * 900000).toString(); const resetExpiry = new Date(Date.now() + 3600000);
    await prisma.user.update({ where: { id: user.id }, data: { resetToken, resetCode, resetExpiry } });
    const resetLink = `https://${req.get('host')}/reset-password/${resetToken}`;
    const mailOptions = { from: `"AURA DIGITAL SECURITY" <${process.env.EMAIL_USER}>`, to: user.email, subject: 'AURA DIGITAL - Password Reset Request', html: `${emailHeader}<h2 style="color: #ef4444; font-size: 22px; margin-bottom: 20px;">Password Reset Request 🔐</h2><p style="color: #cbd5e1; font-size: 15px; line-height: 1.6;">Hello ${user.firstName},<br><br>We received a request to reset the password for your AURA DIGITAL account. You can use the 6-digit secure code below in the app, or directly click the button to set a new password.</p><div style="text-align: center; margin: 30px 0; padding: 20px; background-color: #1e293b; border-radius: 12px;"><p style="margin:0; color:#94a3b8; font-size:12px; text-transform:uppercase; letter-spacing:2px; font-weight:bold;">Your Reset Code</p><h1 style="color: #3b82f6; margin: 10px 0 0 0; font-size: 40px; letter-spacing: 5px;">${resetCode}</h1></div><div style="text-align: center; margin: 35px 0;"><a href="${resetLink}" style="display: inline-block; background: linear-gradient(to right, #ef4444, #b91c1c); color: #ffffff; padding: 14px 35px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px; letter-spacing: 1px;">RESET VIA LINK</a></div><p style="color: #64748b; font-size: 13px; text-align: center;">This request is valid for 1 hour.</p>${emailFooter}` };
    try { await transporter.sendMail(mailOptions); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'SMTP Error. Contact Admin.' }); }
});

app.post('/api/reset-password', async (req, res) => {
    const { identifier, newPassword } = req.body;
    const user = await prisma.user.findFirst({ where: { OR: [{ resetToken: identifier }, { resetCode: identifier }], resetExpiry: { gt: new Date() } } });
    if (!user) return res.json({ success: false, error: 'Invalid or Expired Code/Token.' });
    await prisma.user.update({ where: { id: user.id }, data: { password: newPassword, resetToken: null, resetCode: null, resetExpiry: null } });
    res.json({ success: true });
});

app.get('/reset-password/:token', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en" class="dark"><head><title>Reset Password</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script></head><body class="bg-[#050b14] h-screen flex justify-center items-center text-white"><div class="bg-slate-900 p-8 rounded-[32px] w-full max-w-md text-center border border-slate-800 shadow-2xl"><div class="w-16 h-16 bg-blue-600 rounded-2xl mx-auto flex items-center justify-center mb-6"><svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg></div><h2 class="text-3xl font-black mb-2">New Password</h2><p class="text-slate-400 mb-6 text-sm">Create a strong, new password for your vault.</p><input type="password" id="nPass" placeholder="Enter new password" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-5 py-4 font-bold outline-none focus:border-blue-500 mb-6 text-center tracking-widest"><button onclick="resetP()" class="w-full bg-blue-600 hover:bg-blue-500 transition-colors py-4 rounded-xl font-black uppercase tracking-widest">Update Password</button></div><script>async function resetP() { const pass = document.getElementById('nPass').value; if(!pass)return; const res = await fetch('/api/reset-password', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({identifier:'${req.params.token}', newPassword:pass})}); const data = await res.json(); if(data.success) {Swal.fire({title:'Success',text:'Password updated!',icon:'success',background:'#1e293b',color:'#fff'}).then(()=>window.location.href='/login');} else Swal.fire({title:'Error',text:data.error,icon:'error',background:'#1e293b',color:'#fff'}); }</script></body></html>`);
});

app.post('/api/checkout', async (req, res) => {
    const { userId, cartItems, promoCode } = req.body;
    try {
      const user = await prisma.user.findUnique({ where: { id: parseInt(userId) }, include: { purchases: true } });
      if(user.isBanned) return res.status(403).json({ success: false, error: 'Account Banned!' });
      const isVip = user.isVip && user.vipExpiry && new Date(user.vipExpiry) > new Date();
      let disc = 1; if(promoCode && !isVip) { const p = await prisma.promo.findUnique({ where: { code: promoCode.toUpperCase() } }); if(p) disc = 1 - (p.discount/100); }
      
      let total = 0; let itemsToBuy = [];
      for (let pId of [...new Set(cartItems)]) {
        const prod = await prisma.product.findUnique({ where: { id: parseInt(pId) } });
        if(!prod) continue;
        if(user.purchases.some(p => p.productId === prod.id)) return res.json({ success: false, error: `You already own ${prod.name} in your Vault!` });
        if(prod.stock <= 0) return res.json({ success: false, error: `${prod.name} is currently OUT OF STOCK!` });
        
        let pPrice = isVip ? 0 : parseFloat(prod.price) * disc;
        total += pPrice; itemsToBuy.push(prod);
      }
      
      if(itemsToBuy.length === 0) return res.json({ success: false, error: 'No valid items in request.' });
      if(user.balanceUsd < total) return res.json({ success: false, error: 'Insufficient Funds! Please add balance.' });
      
      await prisma.user.update({ where: { id: user.id }, data: { balanceUsd: { decrement: total } } });
      for (let itm of itemsToBuy) {
          await prisma.purchase.create({ data: { userId: user.id, productId: itm.id, pricePaid: isVip?0:parseFloat(itm.price)*disc } });
          await prisma.product.update({ where: { id: itm.id }, data: { stock: { decrement: 1 } } });
      }
      res.json({ success: true, newBalance: user.balanceUsd - total });
    } catch(e) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

app.post('/api/login', async (req, res) => { const user = await prisma.user.findUnique({ where: { email: req.body.email } }); if (user && user.password === req.body.password) { if(user.isBanned) return res.status(403).json({ success: false, error: 'Banned' }); if(!user.isVerified) return res.status(403).json({ success: false, error: 'Please verify your email first.' }); res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd, country: user.country, refCode: user.refCode, isVip: user.isVip, role: user.role, avatar: user.avatar, refCount: user.refCount } }); } else res.status(401).json({ success: false, error: 'Invalid credentials' }); });
app.get('/api/rate', async (req, res) => res.json({ rates: await getAllRates() })); app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } }))); app.get('/api/products', async (req, res) => res.json(await prisma.product.findMany({ orderBy: { createdAt: 'desc' } }))); app.get('/api/photo/:fileId', async (req, res) => { try { const link = await bot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } catch(e) { res.status(404).send('Not found'); } });
app.post('/api/promo', async (req, res) => { const p = await prisma.promo.findUnique({ where: { code: req.body.code.toUpperCase() } }); if(p && p.isActive) res.json({ success: true, discount: p.discount }); else res.json({ success: false, error: 'Invalid Code!' }); });
app.post('/api/buy-vip', async (req, res) => { const u = await prisma.user.findUnique({ where: { id: parseInt(req.body.userId) } }); if(!u || u.balanceUsd < 30) return res.json({ success: false, error: 'Insufficient funds.' }); const expiry = new Date(); expiry.setDate(expiry.getDate() + 30); await prisma.user.update({ where: { id: u.id }, data: { balanceUsd: { decrement: 30 }, isVip: true, vipExpiry: expiry } }); res.json({ success: true, newBalance: u.balanceUsd - 30 }); });
app.get('/api/user/:id', async (req, res) => { const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } }); if(user) res.json({ success: true, balanceUsd: user.balanceUsd, country: user.country, refCode: user.refCode, isVip: user.isVip, isBanned: user.isBanned, role: user.role, avatar: user.avatar, refCount: user.refCount }); else res.json({ success: false }); });
app.post('/api/user/update', async (req, res) => { const { userId, email, password, avatar } = req.body; try { const data = {}; if (email) data.email = email; if (password) data.password = password; if (avatar !== undefined) data.avatar = avatar; await prisma.user.update({ where: { id: parseInt(userId) }, data }); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'Update failed.' }); } });
app.get('/api/library/:userId', async (req, res) => { res.json(await prisma.purchase.findMany({ where: { userId: parseInt(req.params.userId) }, include: { product: true }, orderBy: { createdAt: 'desc' } })); });
app.get('/api/history/:userId', async (req, res) => { res.json(await prisma.deposit.findMany({ where: { userId: parseInt(req.params.userId) }, orderBy: { createdAt: 'desc' } })); });
app.post('/api/deposit', async (req, res) => { const { userId, method, amountBdt, senderNumber, trxId } = req.body; try { const dep = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } }); const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } }); if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `💰 *FUND REQUEST*\n\n👤 User: ${user.firstName}\n💵 Amount: ${amountBdt} BDT\n💳 Gateway: ${method.toUpperCase()}\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${dep.id}` }, { text: '❌ Reject', callback_data: `reject_${dep.id}` }]] } }); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'TrxID already exists' }); } });

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

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html')); 

app.listen(8080);
bot.launch();
