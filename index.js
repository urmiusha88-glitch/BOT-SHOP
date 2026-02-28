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

// Webhook/Logic Safety
async function getAllRates() {
  try { const res = await fetch('https://open.er-api.com/v6/latest/USD'); const data = await res.json(); return data.rates; } 
  catch (e) { return { BDT: 120, INR: 83, PKR: 278 }; }
}

const generateRefCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// --- TELEGRAM BOT (FIXED) ---
bot.start(async (ctx) => {
    const welcomeMsg = `🌟 *Welcome to AURA STORE* 🌟\n\nHello ${ctx.from.first_name}!\nYour Telegram ID: \`${ctx.from.id}\`\n\nInstant premium source codes and auto-delivery. Use the buttons below to explore.`;
    ctx.reply(welcomeMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🌐 Visit Web Store', url: 'https://onontorshop.up.railway.app/' }],
                [{ text: '📦 View Products', callback_data: 'bot_products' }],
                [{ text: '👨‍💻 Contact Support', url: 'https://t.me/minato_namikaze143' }]
            ]
        }
    });
});

bot.action('bot_products', async (ctx) => {
    const products = await prisma.product.findMany({ take: 5 });
    if(products.length === 0) return ctx.answerCbQuery('Store is empty!', { show_alert: true });
    let text = '🔥 *Latest Products:*\n\n';
    products.forEach(p => text += `▪️ *${p.name}* - $${p.price}\n`);
    ctx.reply(text, { parse_mode: 'Markdown' });
    ctx.answerCbQuery();
});

// --- ADMIN DEPOSIT ACTIONS ---
async function processDeposit(depositId, action) {
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId }, include: { user: true } });
  if (deposit && deposit.status === 'PENDING') {
    if (action === 'APPROVE') {
      const rates = await getAllRates();
      const userRate = deposit.user.country === 'IN' ? rates.INR : (deposit.user.country === 'PK' ? rates.PKR : rates.BDT);
      const usdAmount = deposit.amountBdt / userRate; 
      await prisma.user.update({ where: { id: deposit.userId }, data: { balanceUsd: { increment: usdAmount } } });
      await prisma.deposit.update({ where: { id: depositId }, data: { status: 'APPROVED' } });
      return { success: true, msg: `Approved: $${usdAmount.toFixed(2)}` };
    } else {
      await prisma.deposit.update({ where: { id: depositId }, data: { status: 'REJECTED' } });
      return { success: true, msg: 'Rejected' };
    }
  } return { success: false, msg: 'Error processing' };
}

bot.action(/approve_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'APPROVE'); ctx.editMessageText(`✅ ${res.msg}`); });
bot.action(/reject_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'REJECT'); ctx.editMessageText(`❌ ${res.msg}`); });

// --- PUBLIC APIs ---
app.get('/api/rate', async (req, res) => res.json({ rates: await getAllRates() }));
app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } })));
app.get('/api/products', async (req, res) => res.json(await prisma.product.findMany({ orderBy: { createdAt: 'desc' } })));
app.get('/api/photo/:fileId', async (req, res) => { try { const link = await bot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } catch(e) { res.status(404).send('Not found'); } });

app.post('/api/register', async (req, res) => { 
  try { 
    const { name, email, password, country, refCode } = req.body;
    const newUser = await prisma.user.create({ data: { firstName: name, email, password, country, refCode: generateRefCode() } }); 
    if(refCode) {
        const referrer = await prisma.user.findUnique({ where: { refCode: refCode.toUpperCase() }});
        if(referrer) await prisma.user.update({ where: { id: referrer.id }, data: { balanceUsd: { increment: 2.0 } } });
    }
    res.json({ success: true }); 
  } catch (e) { res.status(400).json({ success: false, error: 'Email already exists' }); } 
});

app.post('/api/login', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email } });
  if (user && user.password === req.body.password) {
    if(user.isBanned) return res.status(403).json({ success: false, error: 'Account Banned' });
    res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd, country: user.country, refCode: user.refCode, isVip: user.isVip } });
  } else res.status(401).json({ success: false, error: 'Invalid login credentials' });
});

app.get('/api/user/:id', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
  if (user) res.json({ success: true, balanceUsd: user.balanceUsd, country: user.country, refCode: user.refCode, isVip: user.isVip, isBanned: user.isBanned });
  else res.json({ success: false });
});

app.post('/api/deposit', async (req, res) => {
  const { userId, method, amountBdt, senderNumber, trxId } = req.body;
  try {
    const deposit = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } });
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    if (ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `💰 *New Deposit*\n👤 User: ${user.firstName}\n💵 Amount: ${amountBdt} BDT\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${deposit.id}` }, { text: '❌ Reject', callback_data: `reject_${deposit.id}` }]]}});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Duplicate TrxID' }); }
});

// Admin Control
app.post('/api/admin/login', (req, res) => { if (req.body.password === (process.env.ADMIN_PASSWORD || 'Ananto01@$')) res.json({ success: true }); else res.status(401).json({ success: false }); });
app.get('/api/admin/stats', async (req, res) => { 
  const users = await prisma.user.count(); 
  const deposits = await prisma.deposit.findMany({ include: { user: true }, take: 20 });
  const allProducts = await prisma.product.findMany();
  res.json({ users, deposits, products: allProducts, revenue: 0 }); 
});

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/auraminato', (req, res) => res.sendFile(__dirname + '/admin.html'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server Live on ${PORT}`));
bot.launch();
