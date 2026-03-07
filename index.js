require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const prisma = new PrismaClient();

// 🔥 MULTI-BOT ARCHITECTURE
const mainBot = new Telegraf(process.env.BOT_TOKEN);
const logBot = process.env.LOG_BOT_TOKEN ? new Telegraf(process.env.LOG_BOT_TOKEN) : mainBot;
const feedbackBot = process.env.FEEDBACK_BOT_TOKEN ? new Telegraf(process.env.FEEDBACK_BOT_TOKEN) : logBot;

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.set('trust proxy', true);

const ADMIN_ID = process.env.ADMIN_ID; 
let isMaintenance = false;
const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });

app.use((req, res, next) => {
  if (req.path.startsWith('/api/admin') || req.path === '/admin' || req.path.startsWith('/api/rider') || req.path === '/rider') return next();
  if (isMaintenance) { if (req.path.startsWith('/api/')) return res.status(503).json({ success: false }); return res.status(503).sendFile(__dirname + '/maintenance.html'); }
  next();
});

const generateRefCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

const addProductWizard = new Scenes.WizardScene('ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('🛍️ 1. Product Name?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('💵 2. Price in BDT (৳)?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = parseFloat(ctx.message.text); ctx.reply('🪄 3. Description?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.stock = parseInt(ctx.message.text) || 1; ctx.reply('📏 4. Sizes? (Comma separated or "none")'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.sizes = ctx.message.text.toLowerCase() === 'none' ? [] : ctx.message.text.split(',').map(s=>s.trim()); ctx.reply('🎨 5. Colors? (Comma separated or "none")'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.colors = ctx.message.text.toLowerCase() === 'none' ? [] : ctx.message.text.split(',').map(s=>s.trim()); ctx.wizard.state.imageIds = []; ctx.reply('📸 6. Send Photos one by one.\n✅ Type /finish when done.'); return ctx.wizard.next(); },
  async (ctx) => { 
      if (ctx.message.text === '/finish') {
          if (ctx.wizard.state.imageIds.length === 0) { ctx.reply('❌ Send at least 1 photo!'); return; }
          const { name, price, abilities, stock, sizes, colors, imageIds } = ctx.wizard.state; 
          try { await prisma.product.create({ data: { name, price, abilities, stock, sizes, colors, imageIds } }); ctx.reply(`🎉 *Product Added!*`, { parse_mode: 'Markdown' }); } catch(e) { ctx.reply(`❌ Error: ${e.message}`); }
          return ctx.scene.leave(); 
      }
      if (ctx.message.photo) { ctx.wizard.state.imageIds.push(ctx.message.photo[ctx.message.photo.length - 1].file_id); ctx.reply(`🖼️ Photo received! (${ctx.wizard.state.imageIds.length} total). Send another or /finish`); return; }
  }
);
const stage = new Scenes.Stage([addProductWizard]); mainBot.use(session()); mainBot.use(stage.middleware());
mainBot.start((ctx) => { ctx.reply(`🌟 *AURA MAIN BOT*\nUse /addproduct to add items.`, { parse_mode: 'Markdown' }); });
mainBot.command('addproduct', (ctx) => { if (ctx.from.id.toString() !== ADMIN_ID) return; ctx.scene.enter('ADD_PRODUCT_SCENE'); });

async function processDeposit(id, action) {
  const dep = await prisma.deposit.findUnique({ where: { id }, include: { user: true } });
  if (dep && dep.status === 'PENDING') {
    if (action === 'APPROVE') {
      if (dep.user.referredBy && !dep.user.referralRewardPaid) {
          const pastDeps = await prisma.deposit.findMany({ where: { userId: dep.userId, status: 'APPROVED' } });
          const totalDeps = pastDeps.reduce((sum, d) => sum + d.amountBdt, 0) + dep.amountBdt;
          if (totalDeps >= 500.0) { const referrer = await prisma.user.findUnique({ where: { refCode: dep.user.referredBy } }); if (referrer) await prisma.user.update({ where: { id: referrer.id }, data: { balanceBdt: { increment: 100.0 } } }); await prisma.user.update({ where: { id: dep.userId }, data: { referralRewardPaid: true } }); }
      }
      await prisma.user.update({ where: { id: dep.userId }, data: { balanceBdt: { increment: dep.amountBdt } } }); await prisma.deposit.update({ where: { id }, data: { status: 'APPROVED' } }); return { success: true, msg: `Approved: ৳${dep.amountBdt}` };
    } else { await prisma.deposit.update({ where: { id }, data: { status: 'REJECTED' } }); return { success: true, msg: 'Rejected' }; }
  } return { success: false, msg: 'Error' };
}
logBot.action(/approve_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'APPROVE'); ctx.editMessageText(`✅ ${res.msg}`); });
logBot.action(/reject_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'REJECT'); ctx.editMessageText(`❌ ${res.msg}`); });
async function updateOrderTelegram(ctx, status, icon) { const id = parseInt(ctx.match[1]); await prisma.purchase.update({ where: { id }, data: { status } }); const msgText = ctx.callbackQuery.message.text; ctx.editMessageText(`${msgText}\n\n${icon} *STATUS UPDATED: ${status}*`, { parse_mode: 'Markdown' }).catch(()=>{}); ctx.answerCbQuery(`Marked as ${status}`); }
logBot.action(/receive_(.+)/, (ctx) => updateOrderTelegram(ctx, 'RECEIVED', '📥'));
logBot.action(/ship_(.+)/, (ctx) => updateOrderTelegram(ctx, 'SHIPPED', '🚚'));
logBot.action(/deliver_(.+)/, (ctx) => updateOrderTelegram(ctx, 'DELIVERED', '✅'));

const emailHeader = `<div style="max-width: 600px; margin: 0 auto; background-color: #0b1121; border-radius: 10px; overflow: hidden; border: 1px solid #1e293b; font-family: Arial, sans-serif;"><div style="background-color: #2563eb; padding: 20px; text-align: center;"><h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">AURA STORE</h1></div><div style="padding: 30px; color: #e2e8f0;">`;
const emailFooter = `</div><div style="background-color: #0f172a; padding: 15px; text-align: center; border-top: 1px solid #1e293b;"><p style="color: #64748b; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} AURA STORE.</p></div></div>`;

// 🔥 FIXED: INSTANT FEEDBACK API (No hanging/loading)
app.post('/api/feedback', (req, res) => {
    const { userId, subject, message } = req.body;
    
    // 1. Send success response to user INSTANTLY
    res.json({ success: true });

    // 2. Process Emails and Telegram in Background (Async)
    (async () => {
        try {
            const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
            if (!user) return;
            const targetEmail = process.env.MAIN_EMAIL || process.env.EMAIL_USER;
            
            // Email
            if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
                const mailOptions = {
                    from: `"AURA FEEDBACK" <${process.env.EMAIL_USER}>`, to: targetEmail, subject: `Feedback: ${subject}`,
                    html: `<div style="font-family: Arial; padding: 20px; background: #0f172a; color: #fff; border-radius: 10px; border: 1px solid #1e293b;"><h2 style="color: #3b82f6; margin-top: 0;">New User Feedback</h2><p><strong>User:</strong> ${user.firstName}</p><p><strong>Email:</strong> ${user.email}</p><p><strong>Subject:</strong> ${subject}</p><hr style="border-color: #334155; margin: 20px 0;"><p style="white-space: pre-wrap; font-size: 15px; color: #cbd5e1; line-height: 1.6;">${message}</p></div>`
                };
                transporter.sendMail(mailOptions).catch(()=>{});
            }
            
            // Telegram Bot
            if (ADMIN_ID) {
                const tgMsg = `📢 *NEW FEEDBACK*\n\n👤 *User:* ${user.firstName} (${user.email})\n📌 *Subject:* ${subject}\n\n📝 *Details:*\n${message}`;
                feedbackBot.telegram.sendMessage(ADMIN_ID, tgMsg, { parse_mode: 'Markdown' }).catch(()=>{});
            }
        } catch(e) {}
    })();
});

// --- CUSTOMER APIs ---
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, country, refCode } = req.body;
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress; if(ip && ip.includes(',')) ip = ip.split(',')[0];
        const ipCount = await prisma.user.count({ where: { ipAddress: ip } });
        if (ipCount >= 5) return res.status(400).json({ success: false, error: 'Device limit reached.' });
        let referredBy = null;
        if (refCode) { const r = await prisma.user.findUnique({ where: { refCode: refCode.toUpperCase() } }); if (r) { referredBy = r.refCode; await prisma.user.update({ where: { id: r.id }, data: { refCount: { increment: 1 } } }); } }
        const verifyToken = crypto.randomBytes(32).toString('hex');
        await prisma.user.create({ data: { firstName: name, email, password, country, refCode: generateRefCode(), referredBy, ipAddress: ip, verifyToken, isVerified: false } });
        if(ADMIN_ID) logBot.telegram.sendMessage(ADMIN_ID, `🆕 *NEW USER*\nName: ${name}\nEmail: ${email}\nIP: \`${ip}\``, { parse_mode: 'Markdown' }).catch(e => {});
        const host = req.headers['x-forwarded-host'] || req.get('host'); const verifyLink = `https://${host}/api/verify-email/${verifyToken}`;
        const mailOptions = { from: `"AURA STORE" <${process.env.EMAIL_USER}>`, to: email, subject: 'Verify Your Identity', html: `${emailHeader}<h2 style="color: #ffffff;">Welcome, ${name}!</h2><p>Please verify your email:</p><div style="text-align: center; margin: 30px 0;"><a href="${verifyLink}" style="display: inline-block; background-color: #3b82f6; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">VERIFY ACCOUNT</a></div><p style="background-color: #1e293b; padding: 10px; border-radius: 5px; word-break: break-all; color: #3b82f6; font-size: 12px;">${verifyLink}</p>${emailFooter}` };
        if(process.env.EMAIL_USER && process.env.EMAIL_PASS) transporter.sendMail(mailOptions).catch(e=>{});
        res.json({ success: true, message: 'Check email to verify account.' });
    } catch(e) { res.status(400).json({ success: false, error: 'Email exists or invalid.' }); }
});

app.get('/api/verify-email/:token', async (req, res) => {
    const user = await prisma.user.findFirst({ where: { verifyToken: req.params.token } });
    if (!user) return res.status(400).send('<h2 style="color:#ef4444;text-align:center;margin-top:20%;">❌ Invalid Token!</h2>');
    await prisma.user.update({ where: { id: user.id }, data: { isVerified: true, verifyToken: null } });
    res.send('<h2 style="color:#10b981;text-align:center;margin-top:20%;">✅ Verified! Redirecting...</h2><script>setTimeout(()=>window.location.href="/login", 2000);</script>');
});

app.post('/api/login', async (req, res) => {
    try {
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress; if(ip && ip.includes(',')) ip = ip.split(',')[0];
        const user = await prisma.user.findUnique({ where: { email: req.body.email } });
        if (user && user.password === req.body.password) { 
            if(user.isBanned) return res.status(403).json({ success: false, error: 'Banned' }); 
            if(!user.isVerified) return res.status(403).json({ success: false, error: 'Please verify your email.' }); 
            if(ADMIN_ID) logBot.telegram.sendMessage(ADMIN_ID, `🔑 *LOGIN*\nName: ${user.firstName}\nEmail: ${user.email}\nWallet: ৳${user.balanceBdt}\nIP: \`${ip}\``, { parse_mode: 'Markdown' }).catch(e => {});
            res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceBdt: user.balanceBdt, refCode: user.refCode, role: user.role, avatar: user.avatar, refCount: user.refCount } }); 
        } else { res.status(401).json({ success: false, error: 'Invalid credentials' }); }
    } catch(e) { res.status(500).json({ success: false, error: 'Server error' }); }
});

app.post('/api/checkout', async (req, res) => {
    const { userId, cartItems, address } = req.body;
    try {
      const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
      if(user.isBanned) return res.status(403).json({ success: false, error: 'Account Banned!' });
      
      const ADVANCE_FEE = 200;
      if(user.balanceBdt < ADVANCE_FEE) return res.json({ success: false, error: 'Insufficient Balance! You need at least ৳200 advance booking money.' });
      
      let total = 0; let itemsToBuy = []; let receiptItemsHtml = '';
      for (let item of cartItems) {
        const prod = await prisma.product.findUnique({ where: { id: parseInt(item.id) } });
        if(!prod || prod.stock <= 0) continue;
        total += prod.price; 
        itemsToBuy.push({ prod, size: item.size, color: item.color });
        let varTxt = []; if(item.size) varTxt.push(item.size); if(item.color) varTxt.push(item.color);
        receiptItemsHtml += `<p style="margin: 5px 0; color: #cbd5e1;">• ${prod.name} ${varTxt.length>0 ? `[${varTxt.join(', ')}]` : ''} - <b>৳${prod.price}</b></p>`;
      }
      
      if(itemsToBuy.length === 0) return res.json({ success: false, error: 'Items out of stock.' });
      let actualAdvance = Math.min(ADVANCE_FEE, total); let totalDue = total - actualAdvance;

      await prisma.user.update({ where: { id: user.id }, data: { balanceBdt: { decrement: actualAdvance } } });
      
      let adminOrderMsg = `📦 *NEW ORDER RECEIVED*\n\n👤 *Customer:* ${user.firstName}\n📞 *Phone:* ${address.phone}\n🏠 *Address:* ${address.street}, ${address.city} - ${address.postcode}\n\n🛒 *Items Ordered:*\n`;

      let purchaseRecords = [];
      for (let itm of itemsToBuy) { 
          let itemAdvance = actualAdvance / itemsToBuy.length; let itemDue = totalDue / itemsToBuy.length;
          let p = await prisma.purchase.create({ data: { userId: user.id, productId: itm.prod.id, selectedSize: itm.size, selectedColor: itm.color, priceTotal: itm.prod.price, advancePaid: itemAdvance, dueCod: itemDue, phone: address.phone, street: address.street, city: address.city, postcode: address.postcode, status: 'PENDING' } }); 
          purchaseRecords.push(p.id); await prisma.product.update({ where: { id: itm.prod.id }, data: { stock: { decrement: 1 } } });
          adminOrderMsg += `- ${itm.prod.name} [Size: ${itm.size || 'N/A'}, Color: ${itm.color || 'N/A'}] (৳${itm.prod.price})\n`;
      }
      adminOrderMsg += `\n💰 *Total:* ৳${total}\n✅ *Advance Paid:* ৳${actualAdvance}\n🚚 *Due (COD):* ৳${totalDue}`;

      if(ADMIN_ID) { logBot.telegram.sendMessage(ADMIN_ID, adminOrderMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: '📥 Receive Order', callback_data: `receive_${purchaseRecords[0]}` }], [{ text: '🚚 Mark Shipped', callback_data: `ship_${purchaseRecords[0]}` }, { text: '✅ Delivered', callback_data: `deliver_${purchaseRecords[0]}` }] ] } }).catch(e=>{}); }

      const receiptMail = { from: `"AURA STORE" <${process.env.EMAIL_USER}>`, to: user.email, subject: 'Order Confirmed - Your Receipt', html: `${emailHeader}<h2 style="color: #10b981; margin-bottom: 5px;">Order Confirmed! 🎉</h2><p style="color: #94a3b8; font-size: 14px;">Thank you for shopping with AURA STORE. Your order is now pending for review.</p><div style="background-color: #1e293b; padding: 20px; border-radius: 12px; margin: 25px 0;"><h3 style="color: #ffffff; margin-top: 0; border-bottom: 1px solid #334155; padding-bottom: 10px;">Order Details</h3>${receiptItemsHtml}<div style="margin-top: 15px; border-top: 1px dashed #334155; padding-top: 15px;"><p style="margin: 5px 0; color: #e2e8f0;"><strong>Total Price:</strong> ৳${total}</p><p style="margin: 5px 0; color: #34d399;"><strong>Advance Paid:</strong> ৳${actualAdvance}</p><p style="margin: 5px 0; color: #ef4444; font-size: 18px;"><strong>Due on Delivery (COD):</strong> ৳${totalDue}</p></div></div><div style="background-color: #0f172a; padding: 15px; border-radius: 8px;"><p style="margin: 0; color: #94a3b8; font-size: 12px;"><strong>Delivery Address:</strong><br>${address.street}, ${address.city} - ${address.postcode}<br>Phone: ${address.phone}</p></div>${emailFooter}` };
      if(process.env.EMAIL_USER && process.env.EMAIL_PASS) transporter.sendMail(receiptMail).catch(e=>{});
      res.json({ success: true, newBalance: user.balanceBdt - actualAdvance, advance: actualAdvance, due: totalDue });
    } catch(e) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

// --- APIs ---
app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } }))); 
app.get('/api/products', async (req, res) => res.json(await prisma.product.findMany({ orderBy: { createdAt: 'desc' } }))); 
app.get('/api/photo/:fileId', async (req, res) => { try { const link = await mainBot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } catch(e) { res.status(404).send('Not found'); } });
app.get('/api/user/:id', async (req, res) => { const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } }); if(user) res.json({ success: true, balanceBdt: user.balanceBdt, refCode: user.refCode, role: user.role, avatar: user.avatar, refCount: user.refCount }); else res.json({ success: false }); });
app.post('/api/user/update', async (req, res) => { const { userId, email, password, avatar } = req.body; try { const data = {}; if (email) data.email = email; if (password) data.password = password; if (avatar !== undefined) data.avatar = avatar; await prisma.user.update({ where: { id: parseInt(userId) }, data }); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'Update failed.' }); } });
app.get('/api/library/:userId', async (req, res) => { res.json(await prisma.purchase.findMany({ where: { userId: parseInt(req.params.userId) }, include: { product: true }, orderBy: { createdAt: 'desc' } })); });
app.get('/api/history/:userId', async (req, res) => { res.json(await prisma.deposit.findMany({ where: { userId: parseInt(req.params.userId) }, orderBy: { createdAt: 'desc' } })); });
app.post('/api/deposit', async (req, res) => { const { userId, method, amountBdt, senderNumber, trxId } = req.body; try { const dep = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } }); const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } }); if(ADMIN_ID) logBot.telegram.sendMessage(ADMIN_ID, `💰 *FUND REQUEST*\n\n👤 User: ${user.firstName}\n💵 Amount: ৳${amountBdt}\n💳 Gateway: ${method.toUpperCase()}\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${dep.id}` }, { text: '❌ Reject', callback_data: `reject_${dep.id}` }]] } }).catch(e=>{}); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'TrxID already exists' }); } });

// --- ROUTING ---
app.get('/manifest.json', (req, res) => res.sendFile(__dirname + '/manifest.json'));
app.get('/sw.js', (req, res) => res.sendFile(__dirname + '/sw.js'));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html')); 
app.get('/rider', (req, res) => res.sendFile(__dirname + '/rider.html')); 

mainBot.launch();
if(process.env.LOG_BOT_TOKEN) { logBot.launch(); console.log("Log Bot Active"); }
if(process.env.FEEDBACK_BOT_TOKEN) { feedbackBot.launch(); console.log("Feedback Bot Active"); }

app.listen(8080);
