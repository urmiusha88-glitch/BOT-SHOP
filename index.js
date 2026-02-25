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

async function getAllRates() {
  try { const res = await fetch('https://open.er-api.com/v6/latest/USD'); const data = await res.json(); return data.rates; } 
  catch (e) { return { BDT: 120, INR: 83, PKR: 278 }; }
}

// --- BOT SCENES: ADD PRODUCT WITH STOCK ---
const addProductWizard = new Scenes.WizardScene(
  'ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('1. Product Name?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('2. Price in USD? (e.g. 10)'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = ctx.message.text; ctx.reply('3. Abilities?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.abilities = ctx.message.text; ctx.reply('4. Stock Quantity? (Koto jon kinte parbe? e.g. 5)'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.stock = parseInt(ctx.message.text) || 1; ctx.reply('5. Send a Photo:'); return ctx.wizard.next(); },
  (ctx) => {
    if (!ctx.message.photo) { ctx.reply('❌ Photo missing!'); return ctx.scene.leave(); }
    ctx.wizard.state.imageId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    ctx.reply('6. Google Drive Link:'); return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.driveLink = ctx.message.text;
    const { name, price, abilities, stock, imageId, driveLink } = ctx.wizard.state;
    try {
      await prisma.product.create({ data: { name, price, abilities, stock, imageId, driveLink } });
      ctx.reply(`✅ Product added!\n📦 Stock: ${stock}`);
    } catch (error) { ctx.reply('❌ Error saving product.'); }
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([addProductWizard]);
bot.use(session()); bot.use(stage.middleware());

bot.command('start', (ctx) => ctx.reply(`Welcome! Your Telegram ID is: ${ctx.from.id}`));
bot.command('addproduct', (ctx) => ctx.scene.enter('ADD_PRODUCT_SCENE'));

// NEW: BOT DELETE COMMAND
bot.command('deleteproduct', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const products = await prisma.product.findMany();
  if (products.length === 0) return ctx.reply("❌ No products available.");
  
  const buttons = products.map((p, index) => ([{ text: `❌ ${index + 1}. ${p.name}`, callback_data: `delprod_${p.id}` }]));
  ctx.reply("Select a product to delete:", { reply_markup: { inline_keyboard: buttons } });
});

bot.action(/delprod_(.+)/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const prodId = parseInt(ctx.match[1]);
  await prisma.product.delete({ where: { id: prodId } });
  ctx.editMessageText("✅ Product deleted successfully!");
});

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
  }
  return { success: false, msg: 'Already processed' };
}

bot.action(/approve_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'APPROVE'); ctx.editMessageText(res.success ? `✅ ${res.msg}` : `⚠️ ${res.msg}`); });
bot.action(/reject_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'REJECT'); ctx.editMessageText(res.success ? `❌ ${res.msg}` : `⚠️ ${res.msg}`); });

// --- PUBLIC APIs ---
app.get('/api/rate', async (req, res) => res.json({ rates: await getAllRates() }));
app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } })));
app.get('/api/photo/:fileId', async (req, res) => { try { const link = await bot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } catch(e) { res.status(404).send('Not found'); } });

app.get('/api/products', async (req, res) => {
  const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(products.map(p => ({ id: p.id, name: p.name, price: p.price, abilities: p.abilities, imageId: p.imageId, stock: p.stock })));
});

// BUY API with Stock Logic
app.post('/api/buy', async (req, res) => {
  const { userId, productId } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    const product = await prisma.product.findUnique({ where: { id: parseInt(productId) } });
    const priceNum = parseFloat(product.price.replace(/[^0-9.]/g, ''));
    
    if (product.stock <= 0) return res.json({ success: false, error: 'Out of Stock!' });
    if (user.balanceUsd >= priceNum) {
      await prisma.user.update({ where: { id: user.id }, data: { balanceUsd: { decrement: priceNum } } });
      await prisma.product.update({ where: { id: product.id }, data: { stock: { decrement: 1 } } });
      res.json({ success: true, link: product.driveLink, newBalance: user.balanceUsd - priceNum });
    } else { res.json({ success: false, error: 'Insufficient Balance' }); }
  } catch (e) { res.status(500).json({ success: false, error: 'Server error' }); }
});

// Auth & Deposit APIs...
app.post('/api/register', async (req, res) => { try { await prisma.user.create({ data: { firstName: req.body.name, email: req.body.email, password: req.body.password, country: req.body.country } }); res.json({ success: true }); } catch (e) { res.status(400).json({ success: false, error: 'Email exists' }); } });
app.post('/api/login', async (req, res) => { const user = await prisma.user.findUnique({ where: { email: req.body.email } }); if (user && user.password === req.body.password) res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd, country: user.country } }); else res.status(401).json({ success: false, error: 'Invalid login' }); });
app.get('/api/user/:id', async (req, res) => { const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } }); if (user) res.json({ success: true, balanceUsd: user.balanceUsd, country: user.country }); else res.json({ success: false }); });
app.get('/api/history/:userId', async (req, res) => { res.json(await prisma.deposit.findMany({ where: { userId: parseInt(req.params.userId) }, orderBy: { createdAt: 'desc' } })); });
app.post('/api/deposit', async (req, res) => {
  const { userId, method, amountBdt, senderNumber, trxId } = req.body;
  try {
    const deposit = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } });
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    const currency = user.country === 'IN' ? 'INR' : (user.country === 'PK' ? 'PKR' : 'BDT');
    if (ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `💰 *New Deposit*\n👤 User: ${user.firstName} (${user.country})\n💵 Amount: ${amountBdt} ${currency}\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${deposit.id}` }, { text: '❌ Reject', callback_data: `reject_${deposit.id}` }]]}});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Duplicate TrxID.' }); }
});

// --- ADMIN APIs ---
app.post('/api/admin/login', (req, res) => { if (req.body.password === (process.env.ADMIN_PASSWORD || 'Ananto01@$')) res.json({ success: true, token: 'auth' }); else res.status(401).json({ success: false }); });
app.get('/api/admin/stats', async (req, res) => {
  const users = await prisma.user.count(); const deposits = await prisma.deposit.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { user: true } }); const userList = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  const allProducts = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } }); // Web admin e product list anar jonno
  res.json({ users, deposits, userList, products: allProducts });
});
app.post('/api/admin/deposit/action', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); const result = await processDeposit(parseInt(req.body.id), req.body.action); res.json(result); });
app.post('/api/admin/notice', async (req, res) => { await prisma.notice.create({ data: { text: req.body.text } }); res.json({ success: true }); });
app.post('/api/admin/notice/delete/:id', async (req, res) => { await prisma.notice.delete({ where: { id: parseInt(req.params.id) } }); res.json({ success: true }); });
app.get('/api/admin/settings', (req, res) => res.json({ isMaintenance }));
app.post('/api/admin/settings', (req, res) => { isMaintenance = req.body.status; res.json({ success: true }); });

// NEW: ADMIN ADD/DELETE PRODUCT FROM WEB
app.post('/api/admin/product', async (req, res) => {
  if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const { name, price, abilities, stock, driveLink } = req.body;
    await prisma.product.create({ data: { name, price, abilities, stock: parseInt(stock), driveLink } });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false }); }
});
app.delete('/api/admin/product/:id', async (req, res) => {
  if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' });
  try { await prisma.product.delete({ where: { id: parseInt(req.params.id) } }); res.json({ success: true }); } catch(e) { res.status(500).json({ success: false }); }
});

// Routing
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/maintenance.html', (req, res) => res.sendFile(__dirname + '/maintenance.html'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running`));
bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
