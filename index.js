require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const express = require('express');

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Eita khub jroruri, Railway theke asbe
const ADMIN_ID = process.env.ADMIN_ID; 

let isMaintenance = false;

// --- MAINTENANCE MIDDLEWARE ---
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin')) return next();
  if (isMaintenance && req.path !== '/maintenance.html') {
    return res.sendFile(__dirname + '/maintenance.html');
  }
  next();
});

// Exchange Rate
async function getExchangeRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    return data.rates.BDT; 
  } catch (e) { return 120; }
}

// --- BOT SCENES ---
const addProductWizard = new Scenes.WizardScene(
  'ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('Product Name?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('Price? (e.g. 30)'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = ctx.message.text; ctx.reply('Abilities? (Comma separated)'); return ctx.wizard.next(); },
  async (ctx) => {
    ctx.wizard.state.abilities = ctx.message.text;
    const { name, price, abilities } = ctx.wizard.state;
    try {
      await prisma.product.create({ data: { name, price, abilities } });
      ctx.reply('✅ Product added successfully!');
    } catch (error) { ctx.reply('❌ Error saving product.'); }
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([addProductWizard]);
bot.use(session());
bot.use(stage.middleware());
bot.command('addproduct', (ctx) => ctx.scene.enter('ADD_PRODUCT_SCENE'));
bot.command('start', (ctx) => ctx.reply(`Welcome! Your bot is running.\nYour Telegram ID is: ${ctx.from.id}`));

// --- ADMIN APPROVE/REJECT DEPOSIT ---
bot.action(/approve_(.+)/, async (ctx) => {
  const depositId = parseInt(ctx.match[1]);
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId }, include: { user: true } });

  if (deposit && deposit.status === 'PENDING') {
    const rate = await getExchangeRate();
    const usdAmount = deposit.amountBdt / rate; 

    await prisma.user.update({ where: { id: deposit.userId }, data: { balanceUsd: { increment: usdAmount } } });
    await prisma.deposit.update({ where: { id: depositId }, data: { status: 'APPROVED' } });
    ctx.editMessageText(`✅ *Deposit Approved!*\nTrxID: ${deposit.trxId}\nAdded: $${usdAmount.toFixed(2)} to user.`, { parse_mode: 'Markdown' });
  }
});

bot.action(/reject_(.+)/, async (ctx) => {
  const depositId = parseInt(ctx.match[1]);
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
  if (deposit && deposit.status === 'PENDING') {
    await prisma.deposit.update({ where: { id: depositId }, data: { status: 'REJECTED' } });
    ctx.editMessageText(`❌ *Deposit Rejected!*\nTrxID: ${deposit.trxId}`, { parse_mode: 'Markdown' });
  }
});

// --- APIS ---
app.get('/api/rate', async (req, res) => { res.json({ rate: await getExchangeRate() }); });
app.get('/api/products', async (req, res) => { res.json(await prisma.product.findMany({ orderBy: { createdAt: 'desc' } })); });
app.get('/api/user/:id', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
  if (user) res.json({ success: true, balanceUsd: user.balanceUsd }); else res.json({ success: false });
});

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL || 'mdananto01@gmail.com';
  const adminPass = process.env.ADMIN_PASSWORD || 'Ananto01@$';
  if (email === adminEmail && password === adminPass) res.json({ success: true, token: 'admin_auth_success' });
  else res.status(401).json({ success: false, error: 'Invalid Credentials' });
});

app.get('/api/admin/settings', (req, res) => { res.json({ isMaintenance }); });
app.post('/api/admin/settings', (req, res) => {
  const { password, status } = req.body;
  if (password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' });
  isMaintenance = status; res.json({ success: true, isMaintenance });
});

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    await prisma.user.create({ data: { firstName: name, email, password } });
    res.json({ success: true, message: 'Registration Successful' });
  } catch (error) { res.status(400).json({ success: false, error: 'Email already exists or invalid data' }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.password === password) res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd } });
  else res.status(401).json({ success: false, error: 'Invalid email or password' });
});

app.post('/api/deposit', async (req, res) => {
  const { userId, method, amountBdt, senderNumber, trxId } = req.body;
  try {
    const deposit = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } });
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });

    // Send to Telegram with explicit Error Handling
    if (ADMIN_ID) {
      try {
        await bot.telegram.sendMessage(ADMIN_ID, 
          `💰 *New Deposit Request*\n\n👤 User: ${user.firstName}\n🏦 Method: ${method.toUpperCase()}\n💵 Amount: ${amountBdt} BDT\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, 
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${deposit.id}` }, { text: '❌ Reject', callback_data: `reject_${deposit.id}` }]]}}
        );
      } catch (err) { console.error("Telegram Notification Error:", err.message); }
    }
    res.json({ success: true, message: 'Request sent to admin!' });
  } catch (error) { res.status(500).json({ error: 'TrxID may already exist.' }); }
});

// --- WEB PAGES ROUTING ---
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/maintenance.html', (req, res) => res.sendFile(__dirname + '/maintenance.html'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
bot.launch().then(() => console.log('Bot running...'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
