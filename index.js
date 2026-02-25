require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const express = require('express');

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Admin ID (Jar kache deposit request jabe)
const ADMIN_ID = process.env.ADMIN_ID; 

// --- DYNAMIC EXCHANGE RATE FUNCTION ---
async function getExchangeRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    return data.rates.BDT; // Live market rate
  } catch (e) {
    return 120; // API fail korle default rate
  }
}

// --- BOT COMMANDS ---

// Start Command: User ke database e save korbe ar website link dibe
bot.command('start', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const firstName = ctx.from.first_name;

  // Database e user na thakle toiri korbe
  let user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) {
    user = await prisma.user.create({
      data: { telegramId, firstName }
    });
  }

  ctx.reply(`Welcome to Bot Store, ${firstName}!\n\n🌐 Login to your account on our website to view your wallet and buy source codes.\n\nYour User ID: \`${telegramId}\``, {
    parse_mode: 'Markdown'
  });
});

// Admin Add Product Scene (Ager motoi ache)
const addProductWizard = new Scenes.WizardScene(
  'ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('Product Name?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('Price? (e.g. 30$)'); return ctx.wizard.next(); },
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

// --- ADMIN APPROVE/REJECT ACTIONS ---

bot.action(/approve_(.+)/, async (ctx) => {
  const depositId = parseInt(ctx.match[1]);
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId }, include: { user: true } });

  if (deposit && deposit.status === 'PENDING') {
    const rate = await getExchangeRate();
    const usdAmount = deposit.amountBdt / rate; // Convert Taka to Dollar

    // Update Balance & Status
    await prisma.user.update({
      where: { id: deposit.userId },
      data: { balanceUsd: { increment: usdAmount } }
    });
    await prisma.deposit.update({
      where: { id: depositId },
      data: { status: 'APPROVED' }
    });

    // Notify User & Admin
    ctx.editMessageText(`✅ *Deposit Approved!*\nTrxID: ${deposit.trxId}\nAdded: $${usdAmount.toFixed(2)} to user.`, { parse_mode: 'Markdown' });
    bot.telegram.sendMessage(deposit.user.telegramId, `🎉 *Deposit Approved!*\nYour fund of ${deposit.amountBdt} BDT has been converted to $${usdAmount.toFixed(2)} and added to your wallet!`, { parse_mode: 'Markdown' });
  }
});

bot.action(/reject_(.+)/, async (ctx) => {
  const depositId = parseInt(ctx.match[1]);
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId }, include: { user: true } });

  if (deposit && deposit.status === 'PENDING') {
    await prisma.deposit.update({ where: { id: depositId }, data: { status: 'REJECTED' } });
    ctx.editMessageText(`❌ *Deposit Rejected!*\nTrxID: ${deposit.trxId}`, { parse_mode: 'Markdown' });
    bot.telegram.sendMessage(deposit.user.telegramId, `❌ *Deposit Rejected!*\nYour deposit request for TrxID ${deposit.trxId} was rejected. Please contact admin.`, { parse_mode: 'Markdown' });
  }
});

// --- API ROUTES FOR WEBSITE ---

app.get('/api/rate', async (req, res) => {
  const rate = await getExchangeRate();
  res.json({ rate });
});

app.get('/api/products', async (req, res) => {
  const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(products);
});

// User Login/Fetch details
app.get('/api/user/:telegramId', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { telegramId: req.params.telegramId } });
  if (user) {
    res.json({ success: true, user });
  } else {
    res.json({ success: false });
  }
});

// Fund Add Request Submit API
app.post('/api/deposit', async (req, res) => {
  const { telegramId, method, amountBdt, senderNumber, trxId } = req.body;
  
  try {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const deposit = await prisma.deposit.create({
      data: { userId: user.id, method, amountBdt: parseFloat(amountBdt), senderNumber, trxId }
    });

    // Send Admin Notification
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
  } catch (error) {
    res.status(500).json({ error: 'TrxID may already exist or invalid data.' });
  }
});

// Web routes
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  bot.launch().then(() => console.log('Bot is running...'));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
