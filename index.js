require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const express = require('express');

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ADMIN_ID = process.env.ADMIN_ID; 
let isMaintenance = false;

app.use((req, res, next) => {
  if (req.path.startsWith('/auraminato') || req.path.startsWith('/api/admin') || req.path === '/admin') return next();
  if (isMaintenance) {
    if (req.path.startsWith('/api/')) return res.status(503).json({ success: false, error: 'Maintenance Mode is ON' });
    return res.sendFile(__dirname + '/maintenance.html');
  }
  next();
});

async function getAllRates() {
  try { const res = await fetch('https://open.er-api.com/v6/latest/USD'); const data = await res.json(); return data.rates; } 
  catch (e) { return { BDT: 120, INR: 83, PKR: 278 }; }
}

const generateRefCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// --- TELEGRAM BOT LOGIC ---
bot.command('start', (ctx) => { ctx.reply(`🌟 *Welcome to AURA STORE* 🌟\n\nHello ${ctx.from.first_name}!\nYour ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🌐 Visit Web Store', url: 'https://onontorshop.up.railway.app/' }]] } }); });

async function processDeposit(depositId, action) {
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId }, include: { user: true } });
  if (deposit && deposit.status === 'PENDING') {
    if (action === 'APPROVE') {
      const rates = await getAllRates(); const userRate = deposit.user.country === 'IN' ? rates.INR : (deposit.user.country === 'PK' ? rates.PKR : rates.BDT); const usdAmount = deposit.amountBdt / userRate; 
      await prisma.user.update({ where: { id: deposit.userId }, data: { balanceUsd: { increment: usdAmount } } });
      await prisma.deposit.update({ where: { id: depositId }, data: { status: 'APPROVED' } });
      return { success: true, msg: `Approved: $${usdAmount.toFixed(2)}` };
    } else {
      await prisma.deposit.update({ where: { id: depositId }, data: { status: 'REJECTED' } }); return { success: true, msg: 'Rejected' };
    }
  } return { success: false, msg: 'Already processed' };
}
bot.action(/approve_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'APPROVE'); ctx.editMessageText(res.success ? `✅ ${res.msg}` : `⚠️ ${res.msg}`); });
bot.action(/reject_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'REJECT'); ctx.editMessageText(res.success ? `❌ ${res.msg}` : `⚠️ ${res.msg}`); });

// --- PUBLIC APIs ---
app.get('/api/rate', async (req, res) => res.json({ rates: await getAllRates() }));
app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } })));
app.get('/api/photo/:fileId', async (req, res) => { try { const link = await bot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } catch(e) { res.status(404).send('Not found'); } });
app.get('/api/products', async (req, res) => { const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } }); res.json(products); });

app.post('/api/promo', async (req, res) => { const promo = await prisma.promo.findUnique({ where: { code: req.body.code.toUpperCase() } }); if(promo && promo.isActive) res.json({ success: true, discount: promo.discount }); else res.json({ success: false, error: 'Invalid Code!' }); });
app.post('/api/buy-vip', async (req, res) => { const user = await prisma.user.findUnique({ where: { id: parseInt(req.body.userId) } }); if(!user || user.balanceUsd < 30) return res.json({ success: false, error: 'Insufficient funds.' }); const expiry = new Date(); expiry.setDate(expiry.getDate() + 30); await prisma.user.update({ where: { id: user.id }, data: { balanceUsd: { decrement: 30 }, isVip: true, vipExpiry: expiry } }); res.json({ success: true, newBalance: user.balanceUsd - 30 }); });

// CHECKOUT
app.post('/api/checkout', async (req, res) => {
  const { userId, cartItems, promoCode } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) }, include: { purchases: true } });
    const isVipActive = user.isVip && user.vipExpiry && new Date(user.vipExpiry) > new Date();
    let discountMulti = 1;
    if(promoCode && !isVipActive) { const p = await prisma.promo.findUnique({ where: { code: promoCode } }); if(p && p.isActive) discountMulti = 1 - (p.discount / 100); }
    const ownedProductIds = user.purchases.map(p => p.productId);
    let totalCost = 0; let productsToBuy = []; const uniqueCartItems = [...new Set(cartItems)];

    for (let pId of uniqueCartItems) {
      const parsedId = parseInt(pId); const product = await prisma.product.findUnique({ where: { id: parsedId } });
      if (!product || product.stock <= 0) return res.json({ success: false, error: `Product out of stock!` });
      if (ownedProductIds.includes(parsedId)) return res.json({ success: false, error: `You already own '${product.name}'!` });
      let priceNum = parseFloat(product.price.replace(/[^0-9.]/g, '')); if(isVipActive) priceNum = 0; else priceNum = priceNum * discountMulti;
      totalCost += priceNum; productsToBuy.push({ product, priceNum });
    }
    
    if (user.balanceUsd < totalCost) return res.json({ success: false, error: `Insufficient Balance.` });
    await prisma.user.update({ where: { id: user.id }, data: { balanceUsd: { decrement: totalCost } } });
    let purchasedLinks = [];
    for (let item of productsToBuy) {
      await prisma.product.update({ where: { id: item.product.id }, data: { stock: { decrement: 1 } } });
      await prisma.purchase.create({ data: { userId: user.id, productId: item.product.id, pricePaid: item.priceNum } });
      purchasedLinks.push({ name: item.product.name, link: item.product.driveLink });
    }
    res.json({ success: true, newBalance: user.balanceUsd - totalCost, items: purchasedLinks });
  } catch (e) { res.status(500).json({ success: false, error: 'Checkout failed' }); }
});

app.get('/api/library/:userId', async (req, res) => { try { const purchases = await prisma.purchase.findMany({ where: { userId: parseInt(req.params.userId) }, include: { product: true }, orderBy: { createdAt: 'desc' } }); res.json(purchases); } catch(e) { res.status(500).json([]); } });

app.post('/api/register', async (req, res) => { 
  try { 
    const { name, email, password, country, refCode } = req.body; let newRef = generateRefCode();
    const newUser = await prisma.user.create({ data: { firstName: name, email, password, country, refCode: newRef } }); 
    if(refCode) { const referrer = await prisma.user.findUnique({ where: { refCode: refCode.toUpperCase() }}); if(referrer) await prisma.user.update({ where: { id: referrer.id }, data: { balanceUsd: { increment: 2.0 } } }); }
    res.json({ success: true }); 
  } catch (e) { res.status(400).json({ success: false, error: 'Email exists' }); } 
});

app.post('/api/login', async (req, res) => { 
  const user = await prisma.user.findUnique({ where: { email: req.body.email } }); 
  if (user && user.password === req.body.password) { 
    let userRef = user.refCode; if(!userRef) { userRef = generateRefCode(); await prisma.user.update({where: {id: user.id}, data: {refCode: userRef}}); }
    const isVipActive = user.isVip && user.vipExpiry && new Date(user.vipExpiry) > new Date(); 
    res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd, country: user.country, refCode: userRef, isVip: isVipActive } }); 
  } else res.status(401).json({ success: false, error: 'Invalid login' }); 
});

app.get('/api/user/:id', async (req, res) => { 
  const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } }); 
  if (user) { 
    let userRef = user.refCode; if(!userRef) { userRef = generateRefCode(); await prisma.user.update({where: {id: user.id}, data: {refCode: userRef}}); }
    const isVipActive = user.isVip && user.vipExpiry && new Date(user.vipExpiry) > new Date(); 
    res.json({ success: true, balanceUsd: user.balanceUsd, country: user.country, refCode: userRef, isVip: isVipActive }); 
  } else res.json({ success: false }); 
});

app.get('/api/history/:userId', async (req, res) => { res.json(await prisma.deposit.findMany({ where: { userId: parseInt(req.params.userId) }, orderBy: { createdAt: 'desc' } })); });

app.post('/api/deposit', async (req, res) => {
  const { userId, method, amountBdt, senderNumber, trxId } = req.body;
  try {
    const deposit = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } });
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } }); const currency = user.country === 'IN' ? 'INR' : (user.country === 'PK' ? 'PKR' : 'BDT');
    if (ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `💰 *New Deposit*\n👤 User: ${user.firstName} (${user.country})\n💵 Amount: ${amountBdt} ${currency}\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${deposit.id}` }, { text: '❌ Reject', callback_data: `reject_${deposit.id}` }]]}});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Duplicate TrxID.' }); }
});

// --- ADMIN APIs ---
app.post('/api/admin/login', (req, res) => { if (req.body.password === (process.env.ADMIN_PASSWORD || 'Ananto01@$')) res.json({ success: true, token: 'auth' }); else res.status(401).json({ success: false }); });
app.get('/api/admin/stats', async (req, res) => { const users = await prisma.user.count(); const deposits = await prisma.deposit.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { user: true } }); const userList = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }); const allProducts = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } }); const promos = await prisma.promo.findMany({ orderBy: { id: 'desc' }}); const recentPurchases = await prisma.purchase.findMany({ take: 30, orderBy: { createdAt: 'desc' }}); let revenue = recentPurchases.reduce((acc, p) => acc + p.pricePaid, 0); res.json({ users, deposits, userList, products: allProducts, promos, revenue }); });
app.post('/api/admin/deposit/action', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); const result = await processDeposit(parseInt(req.body.id), req.body.action); res.json(result); });
app.post('/api/admin/notice', async (req, res) => { await prisma.notice.create({ data: { text: req.body.text } }); res.json({ success: true }); });
app.post('/api/admin/notice/delete/:id', async (req, res) => { await prisma.notice.delete({ where: { id: parseInt(req.params.id) } }); res.json({ success: true }); });
app.get('/api/admin/settings', (req, res) => res.json({ isMaintenance }));
app.post('/api/admin/settings', (req, res) => { isMaintenance = req.body.status; res.json({ success: true }); });
app.post('/api/admin/product', async (req, res) => { try { const { name, price, abilities, stock, driveLink } = req.body; await prisma.product.create({ data: { name, price, abilities, stock: parseInt(stock), driveLink } }); res.json({ success: true }); } catch(e) { res.status(500).json({ success: false }); } });
app.delete('/api/admin/product/:id', async (req, res) => { try { await prisma.product.delete({ where: { id: parseInt(req.params.id) } }); res.json({ success: true }); } catch(e) { res.status(500).json({ success: false }); } });
app.post('/api/admin/promo', async (req, res) => { await prisma.promo.create({ data: { code: req.body.code.toUpperCase(), discount: parseInt(req.body.discount) } }); res.json({success:true}); });
app.delete('/api/admin/promo/:id', async (req, res) => { await prisma.promo.delete({ where: { id: parseInt(req.params.id) } }); res.json({success:true}); });

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/maintenance.html', (req, res) => res.sendFile(__dirname + '/maintenance.html'));
app.get('/auraminato', (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/admin', (req, res) => res.status(403).send("ACCESS DENIED"));

const PORT = process.env.PORT || 8080; app.listen(PORT, () => console.log(`Running`)); bot.launch(); process.once('SIGINT', () => bot.stop('SIGINT'));
