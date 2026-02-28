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

// Middleware
app.use((req, res, next) => {
  if (req.path.startsWith('/auraminato') || req.path.startsWith('/api/admin') || req.path === '/admin') return next();
  if (isMaintenance) return res.status(503).sendFile(__dirname + '/maintenance.html');
  next();
});

async function getAllRates() {
  try { const res = await fetch('https://open.er-api.com/v6/latest/USD'); const data = await res.json(); return data.rates; } 
  catch (e) { return { BDT: 120, INR: 83, PKR: 278 }; }
}

const generateRefCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// --- 🤖 BOT WIZARD: ADD PRODUCT WITH PHOTO ---
const addProductWizard = new Scenes.WizardScene('ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('🛒 1. Product Name?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('💵 2. Price in USD? (e.g. 15)'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = ctx.message.text; ctx.reply('🪄 3. Abilities/Description?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.abilities = ctx.message.text; ctx.reply('📦 4. Stock Count? (e.g. 10)'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.stock = parseInt(ctx.message.text) || 1; ctx.reply('📸 5. Send a Photo of the product:'); return ctx.wizard.next(); },
  (ctx) => {
    if (!ctx.message.photo) return ctx.reply('❌ Please send a valid photo!');
    ctx.wizard.state.imageId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    ctx.reply('🔗 6. Google Drive / Download Link:'); return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.driveLink = ctx.message.text;
    const { name, price, abilities, stock, imageId, driveLink } = ctx.wizard.state;
    try {
      await prisma.product.create({ data: { name, price, abilities, stock, imageId, driveLink } });
      ctx.reply(`✅ *Success!*\nProduct "${name}" is now live in AURA STORE.`, { parse_mode: 'Markdown' });
    } catch (e) { ctx.reply('❌ Database Error.'); }
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([addProductWizard]);
bot.use(session()); bot.use(stage.middleware());

// --- BOT COMMANDS ---
bot.start((ctx) => {
    ctx.reply(`🌟 *AURA STORE OFFICIAL* 🌟\n\nHello ${ctx.from.first_name}!\nYour Telegram ID: \`${ctx.from.id}\``, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🌐 Open Web Store', url: 'https://onontorshop.up.railway.app/' }],
                [{ text: '📦 View Recent', callback_data: 'bot_products' }],
                [{ text: '👨‍💻 Admin', url: 'https://t.me/minato_namikaze143' }]
            ]
        }
    });
});

bot.command('addproduct', (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('🚫 Unauthorized.');
    ctx.scene.enter('ADD_PRODUCT_SCENE');
});

bot.action('bot_products', async (ctx) => {
    const products = await prisma.product.findMany({ take: 5, orderBy: { createdAt: 'desc' } });
    if(products.length === 0) return ctx.answerCbQuery('Store is empty!');
    let txt = '🔥 *Latest Source Codes:*\n\n';
    products.forEach(p => txt += `▪️ ${p.name} - $${p.price}\n`);
    ctx.reply(txt, { parse_mode: 'Markdown' });
    ctx.answerCbQuery();
});

// --- APIs ---
app.get('/api/rate', async (req, res) => res.json({ rates: await getAllRates() }));
app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } })));
app.get('/api/products', async (req, res) => res.json(await prisma.product.findMany({ orderBy: { createdAt: 'desc' } })));
app.get('/api/photo/:fileId', async (req, res) => { try { const link = await bot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } catch(e) { res.status(404).send('Not found'); } });

app.post('/api/checkout', async (req, res) => {
    const { userId, cartItems, promoCode } = req.body;
    try {
      const user = await prisma.user.findUnique({ where: { id: parseInt(userId) }, include: { purchases: true } });
      if(user.isBanned) return res.status(403).json({ success: false, error: 'BANNED' });
      const isVip = user.isVip && user.vipExpiry && new Date(user.vipExpiry) > new Date();
      let disc = 1;
      if(promoCode && !isVip) { const p = await prisma.promo.findUnique({ where: { code: promoCode.toUpperCase() } }); if(p) disc = 1 - (p.discount/100); }
      
      let total = 0; let items = [];
      for (let pId of [...new Set(cartItems)]) {
        const prod = await prisma.product.findUnique({ where: { id: parseInt(pId) } });
        if(!prod || prod.stock <= 0) continue;
        if(user.purchases.some(p => p.productId === prod.id)) continue;
        let pPrice = isVip ? 0 : parseFloat(prod.price) * disc;
        total += pPrice; items.push(prod);
      }
      if(user.balanceUsd < total) return res.json({ success: false, error: 'Insufficient Balance' });
      await prisma.user.update({ where: { id: user.id }, data: { balanceUsd: { decrement: total } } });
      for (let itm of items) {
          await prisma.purchase.create({ data: { userId: user.id, productId: itm.id, pricePaid: isVip?0:parseFloat(itm.price)*disc } });
          await prisma.product.update({ where: { id: itm.id }, data: { stock: { decrement: 1 } } });
      }
      res.json({ success: true, newBalance: user.balanceUsd - total });
    } catch(e) { res.status(500).json({ success: false }); }
});

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
        res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd, country: user.country, refCode: user.refCode, isVip: user.isVip } });
    } else res.status(401).json({ success: false });
});

app.get('/api/user/:id', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
    if(user) res.json({ success: true, balanceUsd: user.balanceUsd, country: user.country, refCode: user.refCode, isVip: user.isVip, isBanned: user.isBanned });
    else res.json({ success: false });
});

app.post('/api/deposit', async (req, res) => {
    const { userId, method, amountBdt, senderNumber, trxId } = req.body;
    try {
        const dep = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } });
        bot.telegram.sendMessage(ADMIN_ID, `💰 *Deposit Alert*\nUser ID: ${userId}\nAmt: ${amountBdt} BDT\nTrx: ${trxId}`, {
            reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${dep.id}` }, { text: '❌ Reject', callback_data: `reject_${dep.id}` }]] }
        });
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: 'TrxID used' }); }
});

app.get('/api/admin/stats', async (req, res) => { res.json({ users: await prisma.user.count(), deposits: await prisma.deposit.findMany({ include: { user: true }, take: 10 }), products: await prisma.product.findMany(), revenue: 0, promos: await prisma.promo.findMany() }); });
app.post('/api/admin/user/action', async (req, res) => {
    if(req.body.action === 'ban') { const u = await prisma.user.findUnique({where:{id:parseInt(req.body.id)}}); await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{isBanned:!u.isBanned}}); }
    else if(req.body.action === 'balance') { await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{balanceUsd:parseFloat(req.body.amount)}}); }
    res.json({success:true});
});

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/auraminato', (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/admin', (req, res) => res.status(403).sendFile(__dirname + '/admin_blocked.html'));

app.listen(8080);
bot.launch();
