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

// --- MAINTENANCE MIDDLEWARE ---
app.use((req, res, next) => {
  // Apnar secret admin route, fake admin route ar admin api gulo bypass korbe
  if (req.path.startsWith('/auraminato') || req.path.startsWith('/api/admin') || req.path === '/admin') {
    return next();
  }
  
  if (isMaintenance) {
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ success: false, error: 'Maintenance Mode is ON' });
    }
    return res.sendFile(__dirname + '/maintenance.html');
  }
  
  next();
});

// Exchange Rate
async function getAllRates() {
  try { const res = await fetch('https://open.er-api.com/v6/latest/USD'); const data = await res.json(); return data.rates; } 
  catch (e) { return { BDT: 120, INR: 83, PKR: 278 }; }
}

// --- BOT SCENES ---
const addProductWizard = new Scenes.WizardScene(
  'ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('1. Product Name?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('2. Price in USD? (e.g. 10)'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = ctx.message.text; ctx.reply('3. Abilities?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.abilities = ctx.message.text; ctx.reply('4. Stock Quantity? (e.g. 5)'); return ctx.wizard.next(); },
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
bot.command('deleteproduct', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const products = await prisma.product.findMany();
  if (products.length === 0) return ctx.reply("❌ No products available.");
  const buttons = products.map((p, index) => ([{ text: `❌ ${index + 1}. ${p.name}`, callback_data: `delprod_${p.id}` }]));
  ctx.reply("Select a product to delete:", { reply_markup: { inline_keyboard: buttons } });
});
bot.action(/delprod_(.+)/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  await prisma.product.delete({ where: { id: parseInt(ctx.match[1]) } });
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
app.get('/api/products', async (req, res) => { const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } }); res.json(products.map(p => ({ id: p.id, name: p.name, price: p.price, abilities: p.abilities, imageId: p.imageId, stock: p.stock }))); });

app.post('/api/checkout', async (req, res) => {
  const { userId, cartItems } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    let totalCost = 0; let productsToBuy = [];
    for (let pId of cartItems) {
      const product = await prisma.product.findUnique({ where: { id: parseInt(pId) } });
      if (!product || product.stock <= 0) return res.json({ success: false, error: `${product?.name || 'A product'} is out of stock!` });
      const priceNum = parseFloat(product.price.replace(/[^0-9.]/g, ''));
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
app.get('/api/admin/stats', async (req, res) => { const users = await prisma.user.count(); const deposits = await prisma.deposit.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { user: true } }); const userList = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }); const allProducts = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } }); res.json({ users, deposits, userList, products: allProducts }); });
app.post('/api/admin/deposit/action', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); const result = await processDeposit(parseInt(req.body.id), req.body.action); res.json(result); });
app.post('/api/admin/notice', async (req, res) => { await prisma.notice.create({ data: { text: req.body.text } }); res.json({ success: true }); });
app.post('/api/admin/notice/delete/:id', async (req, res) => { await prisma.notice.delete({ where: { id: parseInt(req.params.id) } }); res.json({ success: true }); });
app.get('/api/admin/settings', (req, res) => res.json({ isMaintenance }));
app.post('/api/admin/settings', (req, res) => { isMaintenance = req.body.status; res.json({ success: true }); });
app.post('/api/admin/product', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); try { const { name, price, abilities, stock, driveLink } = req.body; await prisma.product.create({ data: { name, price, abilities, stock: parseInt(stock), driveLink } }); res.json({ success: true }); } catch(e) { res.status(500).json({ success: false }); } });
app.delete('/api/admin/product/:id', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); try { await prisma.product.delete({ where: { id: parseInt(req.params.id) } }); res.json({ success: true }); } catch(e) { res.status(500).json({ success: false }); } });

// --- ROUTING ---
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/maintenance.html', (req, res) => res.sendFile(__dirname + '/maintenance.html'));

// 🔒 SECRET ADMIN ROUTE
app.get('/auraminato', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

// ⛔ FAKE ADMIN ROUTE (HONEYPOT) - Returns a matching Access Denied UI
app.get('/admin', (req, res) => {
  // Capture User IP to scare them
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown IP';
  
  res.status(403).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Access Denied - Security Alert</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    </head>
    <body class="bg-[#0b1121] h-screen flex flex-col justify-center items-center px-4 text-center selection:bg-red-500 selection:text-white font-sans">
        
        <div class="max-w-md w-full bg-slate-800 p-10 rounded-3xl shadow-[0_0_50px_rgba(239,68,68,0.2)] border border-red-500/30 relative overflow-hidden">
            <div class="absolute top-0 left-0 w-full h-1 bg-red-500 shadow-[0_0_15px_#ef4444]"></div>
            
            <div class="w-20 h-20 bg-red-500/10 rounded-full flex justify-center items-center mx-auto mb-6 border border-red-500/20">
                <i class="fa-solid fa-shield-halved text-4xl text-red-500 animate-pulse"></i>
            </div>
            
            <h1 class="text-3xl font-black text-white mb-2 tracking-wider">ACCESS DENIED</h1>
            <p class="text-red-400 font-bold mb-6 uppercase text-sm tracking-[0.2em]">Restricted Area</p>
            
            <div class="bg-slate-900 rounded-xl p-5 border border-slate-700 mb-8 shadow-inner">
                <p class="text-slate-400 text-sm font-mono leading-relaxed">
                    Security protocol triggered.<br>
                    Your IP address <span class="text-red-400 font-bold px-1">${clientIp}</span> has been logged and reported.
                </p>
            </div>
            
            <a href="/" class="inline-block w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-3.5 px-8 rounded-xl transition-colors shadow-lg active:scale-95">
                Return to Home
            </a>
        </div>
        
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running`));
bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
