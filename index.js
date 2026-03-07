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
  if (isMaintenance) { if (req.path.startsWith('/api/')) return res.status(503).json({ success: false }); return res.status(503).sendFile(__dirname + '/maintenance.html'); }
  next();
});

const generateRefCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// --- 🔥 PHYSICAL PRODUCT BOT WIZARD ---
const addProductWizard = new Scenes.WizardScene('ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('🛍️ 1. Product Name (e.g. Premium T-Shirt)?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('💵 2. Price in BDT (৳)?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = parseFloat(ctx.message.text); ctx.reply('🪄 3. Description (Fabric, Size details)?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.abilities = ctx.message.text; ctx.reply('📦 4. Available Stock Quantity?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.stock = parseInt(ctx.message.text) || 1; ctx.reply('📸 5. Send Product Photo:'); return ctx.wizard.next(); },
  async (ctx) => { 
      if (!ctx.message.photo) { ctx.reply('❌ Valid photo required! Try /addproduct again.'); return ctx.scene.leave(); }
      ctx.wizard.state.imageId = ctx.message.photo[ctx.message.photo.length - 1].file_id; 
      const { name, price, abilities, stock, imageId } = ctx.wizard.state; 
      try {
          await prisma.product.create({ data: { name, price, abilities, stock, imageId } }); 
          ctx.reply(`✅ *Product Added to Store Successfully!*`, { parse_mode: 'Markdown' }); 
      } catch(e) { ctx.reply(`❌ Error: ${e.message}`); }
      return ctx.scene.leave(); 
  }
);
const stage = new Scenes.Stage([addProductWizard]); bot.use(session()); bot.use(stage.middleware());
bot.start((ctx) => { ctx.reply(`🌟 *STORE ADMIN*\nYour ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' }); });
bot.command('addproduct', (ctx) => { if (ctx.from.id.toString() !== ADMIN_ID) return; ctx.scene.enter('ADD_PRODUCT_SCENE'); });

async function processDeposit(id, action) {
  const dep = await prisma.deposit.findUnique({ where: { id }, include: { user: true } });
  if (dep && dep.status === 'PENDING') {
    if (action === 'APPROVE') {
      if (dep.user.referredBy && !dep.user.referralRewardPaid) {
          const pastDeps = await prisma.deposit.findMany({ where: { userId: dep.userId, status: 'APPROVED' } });
          const totalDeps = pastDeps.reduce((sum, d) => sum + d.amountBdt, 0) + dep.amountBdt;
          if (totalDeps >= 500.0) { 
              const referrer = await prisma.user.findUnique({ where: { refCode: dep.user.referredBy } }); 
              if (referrer) await prisma.user.update({ where: { id: referrer.id }, data: { balanceBdt: { increment: 100.0 } } }); 
              await prisma.user.update({ where: { id: dep.userId }, data: { referralRewardPaid: true } }); 
          }
      }
      await prisma.user.update({ where: { id: dep.userId }, data: { balanceBdt: { increment: dep.amountBdt } } }); 
      await prisma.deposit.update({ where: { id }, data: { status: 'APPROVED' } }); return { success: true, msg: `Approved: ৳${dep.amountBdt}` };
    } else { await prisma.deposit.update({ where: { id }, data: { status: 'REJECTED' } }); return { success: true, msg: 'Rejected' }; }
  } return { success: false, msg: 'Error' };
}
bot.action(/approve_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'APPROVE'); ctx.editMessageText(`✅ ${res.msg}`); });
bot.action(/reject_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'REJECT'); ctx.editMessageText(`❌ ${res.msg}`); });

// Order Actions for Admin
bot.action(/ship_(.+)/, async (ctx) => { await prisma.purchase.update({ where: { id: parseInt(ctx.match[1]) }, data: { status: 'SHIPPED' } }); ctx.editMessageText(`📦 Status updated to SHIPPED!`); });
bot.action(/deliver_(.+)/, async (ctx) => { await prisma.purchase.update({ where: { id: parseInt(ctx.match[1]) }, data: { status: 'DELIVERED' } }); ctx.editMessageText(`✅ Status updated to DELIVERED!`); });

const emailHeader = `<div style="max-width: 600px; margin: 0 auto; background-color: #0b1121; border-radius: 10px; overflow: hidden; border: 1px solid #1e293b; font-family: Arial, sans-serif;"><div style="background-color: #2563eb; padding: 20px; text-align: center;"><h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">AURA DIGITAL STORE</h1></div><div style="padding: 30px; color: #e2e8f0;">`;
const emailFooter = `</div><div style="background-color: #0f172a; padding: 15px; text-align: center; border-top: 1px solid #1e293b;"><p style="color: #64748b; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} AURA STORE.</p></div></div>`;

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
        
        const host = req.headers['x-forwarded-host'] || req.get('host');
        const verifyLink = `https://${host}/api/verify-email/${verifyToken}`;
        
        const mailOptions = { 
            from: `"AURA DIGITAL" <${process.env.EMAIL_USER}>`, to: email, subject: 'Verify Your Identity', 
            html: `${emailHeader}<h2 style="color: #ffffff;">Welcome, ${name}!</h2><p>Please verify your email address by clicking the button below:</p><div style="text-align: center; margin: 30px 0;"><a href="${verifyLink}" style="display: inline-block; background-color: #3b82f6; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">VERIFY ACCOUNT</a></div><p style="color: #94a3b8; font-size: 13px;">If the button doesn't work, copy and paste this link into your browser:</p><p style="background-color: #1e293b; padding: 10px; border-radius: 5px; word-break: break-all; color: #3b82f6; font-size: 12px;">${verifyLink}</p>${emailFooter}` 
        };
        if(process.env.EMAIL_USER && process.env.EMAIL_PASS) await transporter.sendMail(mailOptions);
        res.json({ success: true, message: 'Check your email to verify account.' });
    } catch(e) { res.status(400).json({ success: false, error: 'Email exists or invalid.' }); }
});

app.get('/api/verify-email/:token', async (req, res) => {
    const user = await prisma.user.findFirst({ where: { verifyToken: req.params.token } });
    if (!user) return res.status(400).send('<h2 style="color:#ef4444;text-align:center;margin-top:20%;">❌ Invalid Token!</h2>');
    await prisma.user.update({ where: { id: user.id }, data: { isVerified: true, verifyToken: null } });
    res.send('<h2 style="color:#10b981;text-align:center;margin-top:20%;">✅ Verified! Redirecting...</h2><script>setTimeout(()=>window.location.href="/login", 2000);</script>');
});

// 🔥 THE 200 TK ADVANCE CHECKOUT LOGIC
app.post('/api/checkout', async (req, res) => {
    const { userId, cartItems, address } = req.body;
    try {
      const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
      if(user.isBanned) return res.status(403).json({ success: false, error: 'Account Banned!' });
      
      const ADVANCE_FEE = 200; // Flat 200 TK Booking Money
      if(user.balanceBdt < ADVANCE_FEE) return res.json({ success: false, error: 'Insufficient Balance! You need at least ৳200 advance booking money.' });
      
      let total = 0; let itemsToBuy = [];
      for (let pId of [...new Set(cartItems)]) {
        const prod = await prisma.product.findUnique({ where: { id: parseInt(pId) } });
        if(!prod) continue;
        if(prod.stock <= 0) return res.json({ success: false, error: `${prod.name} is OUT OF STOCK!` });
        total += prod.price; itemsToBuy.push(prod);
      }
      
      if(itemsToBuy.length === 0) return res.json({ success: false, error: 'No valid items.' });
      
      // Deduct exactly 200 TK Advance
      let actualAdvance = Math.min(ADVANCE_FEE, total); // Just in case product is less than 200tk
      let totalDue = total - actualAdvance;

      await prisma.user.update({ where: { id: user.id }, data: { balanceBdt: { decrement: actualAdvance } } });
      
      let adminOrderMsg = `📦 *NEW PHYSICAL ORDER*\n\n👤 *Customer:* ${user.firstName} (${user.email})\n📞 *Phone:* ${address.phone}\n🏠 *Address:* ${address.street}, ${address.city} - ${address.postcode}\n\n🛒 *Items Ordered:*\n`;

      let purchaseRecords = [];
      for (let itm of itemsToBuy) { 
          // Distribute advance/due across items for database records (simple division)
          let itemAdvance = actualAdvance / itemsToBuy.length;
          let itemDue = totalDue / itemsToBuy.length;

          let p = await prisma.purchase.create({ 
              data: { userId: user.id, productId: itm.id, priceTotal: itm.price, advancePaid: itemAdvance, dueCod: itemDue, phone: address.phone, street: address.street, city: address.city, postcode: address.postcode, status: 'PROCESSING' } 
          }); 
          purchaseRecords.push(p.id);
          await prisma.product.update({ where: { id: itm.id }, data: { stock: { decrement: 1 } } });
          adminOrderMsg += `- ${itm.name} (৳${itm.price})\n`;
      }

      adminOrderMsg += `\n💰 *Total Price:* ৳${total}\n✅ *Advance Paid:* ৳${actualAdvance}\n🚚 *Due on Delivery (COD):* ৳${totalDue}`;

      // Notify Admin on Telegram
      if(ADMIN_ID) {
          bot.telegram.sendMessage(ADMIN_ID, adminOrderMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚚 Mark as Shipped', callback_data: `ship_${purchaseRecords[0]}` }, { text: '✅ Delivered', callback_data: `deliver_${purchaseRecords[0]}` }]] } });
      }

      res.json({ success: true, newBalance: user.balanceBdt - actualAdvance, advance: actualAdvance, due: totalDue });
    } catch(e) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

app.post('/api/login', async (req, res) => { const user = await prisma.user.findUnique({ where: { email: req.body.email } }); if (user && user.password === req.body.password) { if(user.isBanned) return res.status(403).json({ success: false, error: 'Banned' }); if(!user.isVerified) return res.status(403).json({ success: false, error: 'Please verify your email.' }); res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceBdt: user.balanceBdt, refCode: user.refCode, isVip: user.isVip, role: user.role, avatar: user.avatar, refCount: user.refCount } }); } else res.status(401).json({ success: false, error: 'Invalid credentials' }); });
app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } }))); 
app.get('/api/products', async (req, res) => res.json(await prisma.product.findMany({ orderBy: { createdAt: 'desc' } }))); 
app.get('/api/photo/:fileId', async (req, res) => { try { const link = await bot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } catch(e) { res.status(404).send('Not found'); } });
app.get('/api/user/:id', async (req, res) => { const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } }); if(user) res.json({ success: true, balanceBdt: user.balanceBdt, refCode: user.refCode, isVip: user.isVip, isBanned: user.isBanned, role: user.role, avatar: user.avatar, refCount: user.refCount }); else res.json({ success: false }); });
app.post('/api/user/update', async (req, res) => { const { userId, email, password, avatar } = req.body; try { const data = {}; if (email) data.email = email; if (password) data.password = password; if (avatar !== undefined) data.avatar = avatar; await prisma.user.update({ where: { id: parseInt(userId) }, data }); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'Update failed.' }); } });
app.get('/api/library/:userId', async (req, res) => { res.json(await prisma.purchase.findMany({ where: { userId: parseInt(req.params.userId) }, include: { product: true }, orderBy: { createdAt: 'desc' } })); });
app.get('/api/history/:userId', async (req, res) => { res.json(await prisma.deposit.findMany({ where: { userId: parseInt(req.params.userId) }, orderBy: { createdAt: 'desc' } })); });
app.post('/api/deposit', async (req, res) => { const { userId, method, amountBdt, senderNumber, trxId } = req.body; try { const dep = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } }); const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } }); if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `💰 *FUND REQUEST*\n\n👤 User: ${user.firstName}\n💵 Amount: ৳${amountBdt}\n💳 Gateway: ${method.toUpperCase()}\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${dep.id}` }, { text: '❌ Reject', callback_data: `reject_${dep.id}` }]] } }); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'TrxID already exists' }); } });

app.get('/manifest.json', (req, res) => res.sendFile(__dirname + '/manifest.json'));
app.get('/sw.js', (req, res) => res.sendFile(__dirname + '/sw.js'));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html')); 

app.listen(8080);
bot.launch();
