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

// Dynamic Rate
async function getExchangeRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    return data.rates.BDT; 
  } catch (e) {
    return 120; // Default 120 taka
  }
}

// --- BOT SCENES & COMMANDS ---
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
    } catch (error) {
      ctx.reply('❌ Error saving product.');
    }
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([addProductWizard]);
bot.use(session());
bot.use(stage.middleware());
bot.command('addproduct', (ctx) => ctx.scene.enter('ADD_PRODUCT_SCENE'));
bot.command('start', (ctx) => ctx.reply('Welcome Admin! Your bot is running.'));

// --- ADMIN APPROVE/REJECT ---
bot.action(/approve_(.+)/, async (ctx) => {
  const depositId = parseInt(ctx.match[1]);
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId }, include: { user: true } });

  if (deposit && deposit.status === 'PENDING') {
    const rate = await getExchangeRate();
    const usdAmount = deposit.amountBdt / rate; 

    await prisma.user.update({
      where: { id: deposit.userId },
      data: { balanceUsd: { increment: usdAmount } }
    });
    await prisma.deposit.update({ where: { id: depositId }, data: { status: 'APPROVED' } });

    ctx.editMessageText(`✅ *Deposit Approved!*\nTrxID: ${deposit.trxId}\nAdded: $${usdAmount.toFixed(2)} to ${deposit.user.firstName}.`, { parse_mode: 'Markdown' });
  }
});

bot.action(/reject_(.+)/, async (ctx) => {
  const depositId = parseInt(ctx.match[1]);
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId }, include: { user: true } });

  if (deposit && deposit.status === 'PENDING') {
    await prisma.deposit.update({ where: { id: depositId }, data: { status: 'REJECTED' } });
    ctx.editMessageText(`❌ *Deposit Rejected!*\nTrxID: ${deposit.trxId}`, { parse_mode: 'Markdown' });
  }
});

// --- APIS ---
app.get('/api/rate', async (req, res) => { res.json({ rate: await getExchangeRate() }); });
app.get('/api/products', async (req, res) => {
  const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(products);
});

// Update User Session API (For live balance check)
app.get('/api/user/:id', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
  if (user) res.json({ success: true, balanceUsd: user.balanceUsd });
  else res.json({ success: false });
});

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL || 'mdananto01@gmail.com';
  const adminPass = process.env.ADMIN_PASSWORD || 'Ananto01@$';
  if (email === adminEmail && password === adminPass) res.json({ success: true, token: 'admin_auth_success' });
  else res.status(401).json({ success: false, error: 'Invalid Admin Credentials' });
});

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ success: false, error: 'Email already registered' });
    await prisma.user.create({ data: { firstName: name, email, password } });
    res.json({ success: true, message: 'Registration Successful' });
  } catch (error) { res.status(500).json({ success: false, error: 'Registration failed' }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.password === password) {
      res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd } });
    } else res.status(401).json({ success: false, error: 'Invalid email or password' });
  } catch (error) { res.status(500).json({ success: false, error: 'Login failed' }); }
});

// Deposit Request API
app.post('/api/deposit', async (req, res) => {
  const { userId, method, amountBdt, senderNumber, trxId } = req.body;
  try {
    const deposit = await prisma.deposit.create({
      data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId }
    });
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });

    if (ADMIN_ID) {
      bot.telegram.sendMessage(ADMIN_ID, 
        `💰 *New Deposit Request*\n\nUser: ${user.firstName}\nMethod: ${method.toUpperCase()}\nAmount: ${amountBdt} BDT\nSender: ${senderNumber}\nTrxID: ${trxId}`, 
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Approve', callback_data: `approve_${deposit.id}` }, { text: '❌ Reject', callback_data: `reject_${deposit.id}` }]
            ]
          }
        }
      );
    }
    res.json({ success: true, message: 'Request sent to admin!' });
  } catch (error) { res.status(500).json({ error: 'TrxID may already exist.' }); }
});

// --- WEB PAGES ---
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/admin-login', (req, res) => res.sendFile(__dirname + '/admin-login.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  bot.launch().then(() => console.log('Bot running...'));
});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
