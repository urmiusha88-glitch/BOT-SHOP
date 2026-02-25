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
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin')) return next();
  if (isMaintenance && req.path !== '/maintenance.html') return res.sendFile(__dirname + '/maintenance.html');
  next();
});

async function getExchangeRate() {
  try { const res = await fetch('https://open.er-api.com/v6/latest/USD'); const data = await res.json(); return data.rates.BDT; } 
  catch (e) { return 120; }
}

// --- BOT SCENES: ADD PRODUCT WITH DRIVE LINK ---
const addProductWizard = new Scenes.WizardScene(
  'ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('1. Product er Nam ki?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('2. Price koto? (e.g. 30)'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = ctx.message.text; ctx.reply('3. Abilities ki ki?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.abilities = ctx.message.text; ctx.reply('4. Ekta sundor Photo pathan (Send as Photo):'); return ctx.wizard.next(); },
  (ctx) => {
    if (!ctx.message.photo) { ctx.reply('❌ Apni photo denni. Abar /addproduct theke shuru korun.'); return ctx.scene.leave(); }
    ctx.wizard.state.imageId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    ctx.reply('5. Google Drive Link ta din (Jeta buy korle pabe):'); return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.driveLink = ctx.message.text;
    const { name, price, abilities, imageId, driveLink } = ctx.wizard.state;
    try {
      await prisma.product.create({ data: { name, price, abilities, imageId, driveLink } });
      ctx.reply('✅ Product added successfully with Photo & Drive Link!');
    } catch (error) { ctx.reply('❌ Error saving product.'); }
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([addProductWizard]);
bot.use(session()); bot.use(stage.middleware());

bot.command('start', (ctx) => ctx.reply(`Welcome! Your Telegram ID is: ${ctx.from.id}`));
bot.command('addproduct', (ctx) => ctx.scene.enter('ADD_PRODUCT_SCENE'));

// Helper function to process deposit
async function processDeposit(depositId, action) {
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId }, include: { user: true } });
  if (deposit && deposit.status === 'PENDING') {
    if (action === 'APPROVE') {
      const rate = await getExchangeRate();
      const usdAmount = deposit.amountBdt / rate; 
      await prisma.user.update({ where: { id: deposit.userId }, data: { balanceUsd: { increment: usdAmount } } });
      await prisma.deposit.update({ where: { id: depositId }, data: { status: 'APPROVED' } });
      return { success: true, msg: `Approved: $${usdAmount.toFixed(2)}` };
    } else {
      await prisma.deposit.update({ where: { id: depositId }, data: { status: 'REJECTED' } });
      return { success: true, msg: 'Rejected' };
    }
  }
  return { success: false, msg: 'Already processed' };
}

bot.action(/approve_(.+)/, async (ctx) => {
  const res = await processDeposit(parseInt(ctx.match[1]), 'APPROVE');
  ctx.editMessageText(res.success ? `✅ ${res.msg}` : `⚠️ ${res.msg}`);
});
bot.action(/reject_(.+)/, async (ctx) => {
  const res = await processDeposit(parseInt(ctx.match[1]), 'REJECT');
  ctx.editMessageText(res.success ? `❌ ${res.msg}` : `⚠️ ${res.msg}`);
});

// --- PUBLIC APIs ---
app.get('/api/rate', async (req, res) => res.json({ rate: await getExchangeRate() }));
app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } })));
app.get('/api/photo/:fileId', async (req, res) => {
  try { const link = await bot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } 
  catch(e) { res.status(404).send('Not found'); }
});

// Products (Drive link hide kora ache security er jonno)
app.get('/api/products', async (req, res) => {
  const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
  const safeProducts = products.map(p => ({ id: p.id, name: p.name, price: p.price, abilities: p.abilities, imageId: p.imageId }));
  res.json(safeProducts);
});

// Instant Buy API
app.post('/api/buy', async (req, res) => {
  const { userId, productId } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    const product = await prisma.product.findUnique({ where: { id: parseInt(productId) } });
    const priceNum = parseFloat(product.price.replace(/[^0-9.]/g, ''));

    if (user.balanceUsd >= priceNum) {
      // Deduct balance
      await prisma.user.update({ where: { id: user.id }, data: { balanceUsd: { decrement: priceNum } } });
      res.json({ success: true, link: product.driveLink, newBalance: user.balanceUsd - priceNum });
    } else {
      res.json({ success: false, error: 'Insufficient Balance' });
    }
  } catch (e) { res.status(500).json({ success: false, error: 'Server error' }); }
});

// Auth & History
app.post('/api/register', async (req, res) => {
  try { await prisma.user.create({ data: { firstName: req.body.name, email: req.body.email, password: req.body.password } }); res.json({ success: true }); } 
  catch (e) { res.status(400).json({ success: false, error: 'Email exists' }); }
});
app.post('/api/login', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email } });
  if (user && user.password === req.body.password) res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd } });
  else res.status(401).json({ success: false, error: 'Invalid login' });
});
app.get('/api/user/:id', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
  if (user) res.json({ success: true, balanceUsd: user.balanceUsd }); else res.json({ success: false });
});
app.get('/api/history/:userId', async (req, res) => { res.json(await prisma.deposit.findMany({ where: { userId: parseInt(req.params.userId) }, orderBy: { createdAt: 'desc' } })); });

// Deposit Request
app.post('/api/deposit', async (req, res) => {
  const { userId, method, amountBdt, senderNumber, trxId } = req.body;
  try {
    const deposit = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } });
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    if (ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `💰 *New Deposit*\nUser: ${user.firstName}\nAmount: ৳${amountBdt}\nTrxID: \`${trxId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${deposit.id}` }, { text: '❌ Reject', callback_data: `reject_${deposit.id}` }]]}});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Duplicate TrxID.' }); }
});

// --- ADMIN APIs ---
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === (process.env.ADMIN_PASSWORD || 'Ananto01@$')) res.json({ success: true, token: 'auth' });
  else res.status(401).json({ success: false });
});
app.get('/api/admin/stats', async (req, res) => {
  const users = await prisma.user.count();
  const deposits = await prisma.deposit.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { user: true } });
  const userList = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  res.json({ users, deposits, userList });
});
// Admin Web theke Deposit Approve/Reject kora
app.post('/api/admin/deposit/action', async (req, res) => {
  if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' });
  const result = await processDeposit(parseInt(req.body.id), req.body.action);
  res.json(result);
});
app.post('/api/admin/notice', async (req, res) => { await prisma.notice.create({ data: { text: req.body.text } }); res.json({ success: true }); });
app.post('/api/admin/notice/delete/:id', async (req, res) => { await prisma.notice.delete({ where: { id: parseInt(req.params.id) } }); res.json({ success: true }); });
app.get('/api/admin/settings', (req, res) => res.json({ isMaintenance }));
app.post('/api/admin/settings', (req, res) => { isMaintenance = req.body.status; res.json({ success: true }); });

// Routing
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/maintenance.html', (req, res) => res.sendFile(__dirname + '/maintenance.html'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running`));
bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
