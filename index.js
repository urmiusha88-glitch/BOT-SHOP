require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const express = require('express');

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const ADMIN_ID = process.env.ADMIN_ID; 
let isMaintenance = false;

// 🔥 Maintenance Middleware (Loads your maintenance.html)
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

// --- 🤖 BOT LOGIC ---
const addProductWizard = new Scenes.WizardScene('ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('🛒 1. Product Name?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('💵 2. Price in USD? (e.g. 15)'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = ctx.message.text; ctx.reply('🪄 3. Description?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.abilities = ctx.message.text; ctx.reply('📦 4. Stock Count?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.stock = parseInt(ctx.message.text) || 1; ctx.reply('📸 5. Send Product Photo:'); return ctx.wizard.next(); },
  (ctx) => {
    if (!ctx.message.photo) return ctx.reply('❌ Send a valid photo!');
    ctx.wizard.state.imageId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    ctx.reply('🔗 6. Download Link:'); return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.driveLink = ctx.message.text;
    const { name, price, abilities, stock, imageId, driveLink } = ctx.wizard.state;
    await prisma.product.create({ data: { name, price, abilities, stock, imageId, driveLink } });
    ctx.reply(`✅ *Product Published Successfully!*`, { parse_mode: 'Markdown' });
    return ctx.scene.leave();
  }
);
const stage = new Scenes.Stage([addProductWizard]); bot.use(session()); bot.use(stage.middleware());

bot.start((ctx) => { ctx.reply(`🌟 *Welcome to AURA DIGITAL STORE* 🌟\nYour ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🌐 Visit Website', url: 'https://bot-shop-production.up.railway.app/' }]] }}); });
bot.command('addproduct', (ctx) => { if (ctx.from.id.toString() !== ADMIN_ID) return; ctx.scene.enter('ADD_PRODUCT_SCENE'); });

async function processDeposit(id, action) {
  const dep = await prisma.deposit.findUnique({ where: { id }, include: { user: true } });
  if (dep && dep.status === 'PENDING') {
    if (action === 'APPROVE') {
      const rates = await getAllRates(); const userRate = dep.user.country === 'IN' ? rates.INR : (dep.user.country === 'PK' ? rates.PKR : rates.BDT); const usdAmount = dep.amountBdt / userRate; 
      await prisma.user.update({ where: { id: dep.userId }, data: { balanceUsd: { increment: usdAmount } } });
      await prisma.deposit.update({ where: { id }, data: { status: 'APPROVED' } });
      return { success: true, msg: `Approved: $${usdAmount.toFixed(2)}` };
    } else {
      await prisma.deposit.update({ where: { id }, data: { status: 'REJECTED' } }); return { success: true, msg: 'Rejected' };
    }
  } return { success: false, msg: 'Error' };
}
bot.action(/approve_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'APPROVE'); ctx.editMessageText(`✅ ${res.msg}`); });
bot.action(/reject_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'REJECT'); ctx.editMessageText(`❌ ${res.msg}`); });

// --- PUBLIC APIs ---
app.get('/api/rate', async (req, res) => res.json({ rates: await getAllRates() }));
app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } })));
app.get('/api/products', async (req, res) => res.json(await prisma.product.findMany({ orderBy: { createdAt: 'desc' } })));
app.get('/api/photo/:fileId', async (req, res) => { try { const link = await bot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } catch(e) { res.status(404).send('Not found'); } });

app.post('/api/promo', async (req, res) => { const p = await prisma.promo.findUnique({ where: { code: req.body.code.toUpperCase() } }); if(p && p.isActive) res.json({ success: true, discount: p.discount }); else res.json({ success: false, error: 'Invalid Code!' }); });
app.post('/api/buy-vip', async (req, res) => { const u = await prisma.user.findUnique({ where: { id: parseInt(req.body.userId) } }); if(!u || u.balanceUsd < 30) return res.json({ success: false, error: 'Insufficient funds.' }); const expiry = new Date(); expiry.setDate(expiry.getDate() + 30); await prisma.user.update({ where: { id: u.id }, data: { balanceUsd: { decrement: 30 }, isVip: true, vipExpiry: expiry } }); res.json({ success: true, newBalance: u.balanceUsd - 30 }); });

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
        if(!prod || prod.stock <= 0 || user.purchases.some(p => p.productId === prod.id)) continue;
        let pPrice = isVip ? 0 : parseFloat(prod.price) * disc;
        total += pPrice; itemsToBuy.push(prod);
      }
      if(user.balanceUsd < total) return res.json({ success: false, error: 'Insufficient Funds' });
      await prisma.user.update({ where: { id: user.id }, data: { balanceUsd: { decrement: total } } });
      for (let itm of itemsToBuy) {
          await prisma.purchase.create({ data: { userId: user.id, productId: itm.id, pricePaid: isVip?0:parseFloat(itm.price)*disc } });
          await prisma.product.update({ where: { id: itm.id }, data: { stock: { decrement: 1 } } });
      }
      res.json({ success: true, newBalance: user.balanceUsd - total });
    } catch(e) { res.status(500).json({ success: false }); }
});

app.get('/api/library/:userId', async (req, res) => { res.json(await prisma.purchase.findMany({ where: { userId: parseInt(req.params.userId) }, include: { product: true }, orderBy: { createdAt: 'desc' } })); });
app.get('/api/history/:userId', async (req, res) => { res.json(await prisma.deposit.findMany({ where: { userId: parseInt(req.params.userId) }, orderBy: { createdAt: 'desc' } })); });

app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, country, refCode } = req.body;
        await prisma.user.create({ data: { firstName: name, email, password, country, refCode: generateRefCode() } });
        if(refCode) { const r = await prisma.user.findUnique({where:{refCode:refCode.toUpperCase()}}); if(r) await prisma.user.update({where:{id:r.id}, data:{balanceUsd:{increment:2.0}}}); }
        res.json({ success: true });
    } catch(e) { res.status(400).json({ success: false, error: 'Email exists' }); }
});

app.post('/api/login', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (user && user.password === req.body.password) {
        if(user.isBanned) return res.status(403).json({ success: false, error: 'Banned' });
        res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd, country: user.country, refCode: user.refCode, isVip: user.isVip, role: user.role, avatar: user.avatar } });
    } else res.status(401).json({ success: false });
});

app.get('/api/user/:id', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
    if(user) res.json({ success: true, balanceUsd: user.balanceUsd, country: user.country, refCode: user.refCode, isVip: user.isVip, isBanned: user.isBanned, role: user.role, avatar: user.avatar });
    else res.json({ success: false });
});

app.post('/api/user/update', async (req, res) => {
    const { userId, email, password, avatar } = req.body;
    try {
        const data = {}; if (email) data.email = email; if (password) data.password = password; if (avatar !== undefined) data.avatar = avatar;
        await prisma.user.update({ where: { id: parseInt(userId) }, data });
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: 'Update failed.' }); }
});

app.post('/api/deposit', async (req, res) => {
    const { userId, method, amountBdt, senderNumber, trxId } = req.body;
    try {
        const dep = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } });
        const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
        if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `💰 *FUND REQUEST*\n\n👤 User: ${user.firstName}\n💵 Amount: ${amountBdt} BDT\n💳 Gateway: ${method.toUpperCase()}\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, {
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${dep.id}` }, { text: '❌ Reject', callback_data: `reject_${dep.id}` }]] }
        });
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: 'TrxID already exists' }); }
});

// --- ADMIN APIs ---
app.post('/api/admin/login', (req, res) => { if (req.body.password === (process.env.ADMIN_PASSWORD || 'Ananto01@$')) res.json({ success: true }); else res.status(401).json({ success: false }); });
app.get('/api/admin/stats', async (req, res) => { 
    const recentPurchases = await prisma.purchase.findMany({ take: 30 }); let revenue = recentPurchases.reduce((acc, p) => acc + p.pricePaid, 0);
    res.json({ users: await prisma.user.count(), deposits: await prisma.deposit.findMany({ include: { user: true }, take: 20, orderBy: { createdAt: 'desc' } }), products: await prisma.product.findMany(), promos: await prisma.promo.findMany(), userList: await prisma.user.findMany({ take: 20, orderBy: { createdAt: 'desc' } }), revenue }); 
});
app.post('/api/admin/user/action', async (req, res) => {
    if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' });
    if(req.body.action === 'ban') { const u = await prisma.user.findUnique({where:{id:parseInt(req.body.id)}}); await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{isBanned:!u.isBanned}}); }
    else if(req.body.action === 'balance') { await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{balanceUsd:parseFloat(req.body.amount)}}); }
    else if(req.body.action === 'role') { await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{role:req.body.role}}); }
    res.json({success:true});
});
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

