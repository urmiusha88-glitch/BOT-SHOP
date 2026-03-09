require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const prisma = new PrismaClient();

const mainBot = new Telegraf(process.env.BOT_TOKEN); 
const logBot = process.env.LOG_BOT_TOKEN ? new Telegraf(process.env.LOG_BOT_TOKEN) : mainBot; 
const feedbackBot = process.env.FEEDBACK_BOT_TOKEN ? new Telegraf(process.env.FEEDBACK_BOT_TOKEN) : logBot; 

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.set('trust proxy', true);

const ADMIN_ID = process.env.ADMIN_ID; 
let isMaintenance = false;
const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });

app.use((req, res, next) => {
  if (req.path.startsWith('/api/admin') || req.path === '/admin' || req.path === '/manifest.json' || req.path === '/sw.js') return next();
  if (isMaintenance) { 
      if (req.path.startsWith('/api/')) return res.status(503).json({ success: false, message: 'Maintenance Active' }); 
      res.setHeader('Cache-Control', 'no-store, no-cache'); return res.status(200).sendFile(__dirname + '/maintenance.html'); 
  }
  next();
});

const generateRefCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// ================= TELEGRAM WIZARDS =================
const addProductWizard = new Scenes.WizardScene('ADD_PRODUCT_SCENE',
  (ctx) => { ctx.reply('🛍️ 1. Product Name?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.name = ctx.message.text; ctx.reply('🗂️ 2. Category? (e.g. T-Shirt, Premium, Accessories)'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.category = ctx.message.text; ctx.reply('💵 3. Price in BDT (৳)?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.price = parseFloat(ctx.message.text) || 0; ctx.reply('🪄 4. Description?'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.abilities = ctx.message.text; ctx.reply('📦 5. Stock Quantity? (e.g. 50)'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.stock = parseInt(ctx.message.text) || 1; ctx.reply('📏 6. Sizes? (Comma separated or "none")'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.sizes = ctx.message.text.toLowerCase() === 'none' ? [] : ctx.message.text.split(',').map(s=>s.trim()); ctx.reply('🎨 7. Colors? (Comma separated or "none")'); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.colors = ctx.message.text.toLowerCase() === 'none' ? [] : ctx.message.text.split(',').map(s=>s.trim()); ctx.wizard.state.imageIds = []; ctx.reply('📸 8. Send Photos one by one.\n✅ Type /finish when done.'); return ctx.wizard.next(); },
  async (ctx) => { 
      if (ctx.message.text === '/finish') {
          if (ctx.wizard.state.imageIds.length === 0) { ctx.reply('❌ Send at least 1 photo!'); return; }
          const { name, category, price, abilities, stock, sizes, colors, imageIds } = ctx.wizard.state; 
          try { 
              await prisma.product.create({ 
                  data: { 
                      name: name || "Premium Item", 
                      category: category || "Premium", 
                      price: price || 0, 
                      abilities: abilities || "Best quality product.", 
                      stock: stock || 1, 
                      sizes: sizes || [], 
                      colors: colors || [], 
                      imageIds: imageIds 
                  } 
              }); 
              ctx.reply(`🎉 *Product Added Successfully!*`, { parse_mode: 'Markdown' }); 
          } catch(e) { ctx.reply(`❌ DB Error: ${e.message}`); }
          return ctx.scene.leave(); 
      }
      if (ctx.message.photo) { ctx.wizard.state.imageIds.push(ctx.message.photo[ctx.message.photo.length - 1].file_id); ctx.reply(`🖼️ Photo received! (${ctx.wizard.state.imageIds.length} total). Send another or type /finish`); return; }
  }
);
const addNoticeWizard = new Scenes.WizardScene('ADD_NOTICE_SCENE', (ctx) => { ctx.reply('📢 *Type Notice:*', { parse_mode: 'Markdown' }); return ctx.wizard.next(); }, async (ctx) => { if(ctx.message.text) { await prisma.notice.create({ data: { text: ctx.message.text } }); ctx.reply('✅ *Notice live.*', { parse_mode: 'Markdown' }); } return ctx.scene.leave(); });
const flashSaleWizard = new Scenes.WizardScene('FLASH_SALE_SCENE', (ctx) => { ctx.reply('⚡ *Duration in HOURS (e.g. 24):*', { parse_mode: 'Markdown' }); return ctx.wizard.next(); }, (ctx) => { ctx.wizard.state.hours = parseInt(ctx.message.text); ctx.reply('💰 Discount Percentage (e.g. 20):'); return ctx.wizard.next(); }, async (ctx) => { const discount = parseInt(ctx.message.text); const endTime = new Date(); endTime.setHours(endTime.getHours() + ctx.wizard.state.hours); let fs = await prisma.flashSale.findFirst(); if (fs) await prisma.flashSale.update({ where: { id: fs.id }, data: { isActive: true, endTime, discountPercent: discount } }); else await prisma.flashSale.create({ data: { id: 1, isActive: true, endTime, discountPercent: discount } }); ctx.reply(`✅ *FLASH SALE ACTIVATED!*`, { parse_mode: 'Markdown' }); return ctx.scene.leave(); });

const stage = new Scenes.Stage([addProductWizard, addNoticeWizard, flashSaleWizard]); 
mainBot.use(session()); mainBot.use(stage.middleware());

function sendAdminMenu(ctx) { if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('❌ Unauthorized.'); const mStatus = isMaintenance ? '🔴 ON' : '🟢 OFF'; ctx.reply(`🌟 *MASTER CONTROL*\nSelect an action:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: '🛍️ Add Product', callback_data: 'menu_add_product' }, { text: '⚡ Flash Sale', callback_data: 'menu_flash_sale' }], [{ text: `🛠️ Maintenance Mode: ${mStatus}`, callback_data: 'toggle_maintenance' }], [{ text: '📢 Add Notice', callback_data: 'menu_add_notice' }, { text: '🗑️ Clear Notices', callback_data: 'menu_clear_notices' }], [{ text: '📊 View Store Stats', callback_data: 'menu_stats' }] ] } }); }
mainBot.start((ctx) => sendAdminMenu(ctx)); mainBot.command('admin', (ctx) => sendAdminMenu(ctx));
mainBot.action('menu_add_product', (ctx) => { ctx.answerCbQuery(); ctx.scene.enter('ADD_PRODUCT_SCENE'); });
mainBot.action('menu_add_notice', (ctx) => { ctx.answerCbQuery(); ctx.scene.enter('ADD_NOTICE_SCENE'); });
mainBot.action('menu_flash_sale', async (ctx) => { let fs = await prisma.flashSale.findFirst(); if(fs && fs.isActive) { await prisma.flashSale.update({ where: { id: fs.id }, data: { isActive: false } }); ctx.answerCbQuery('Flash Sale Stopped!'); ctx.reply('🛑 Flash Sale OFF.'); } else { ctx.answerCbQuery(); ctx.scene.enter('FLASH_SALE_SCENE'); } });
mainBot.action('menu_clear_notices', async (ctx) => { await prisma.notice.deleteMany({}); ctx.answerCbQuery('🗑️ Notices deleted!'); ctx.reply('✅ *Notices cleared.*', { parse_mode: 'Markdown' }); });
mainBot.action('toggle_maintenance', async (ctx) => { isMaintenance = !isMaintenance; const mStatus = isMaintenance ? '🔴 ON' : '🟢 OFF'; await ctx.editMessageReplyMarkup({ inline_keyboard: [ [{ text: '🛍️ Add Product', callback_data: 'menu_add_product' }, { text: '⚡ Flash Sale', callback_data: 'menu_flash_sale' }], [{ text: `🛠️ Maintenance Mode: ${mStatus}`, callback_data: 'toggle_maintenance' }], [{ text: '📢 Add Notice', callback_data: 'menu_add_notice' }, { text: '🗑️ Clear Notices', callback_data: 'menu_clear_notices' }], [{ text: '📊 View Store Stats', callback_data: 'menu_stats' }] ] }).catch(e=>{}); ctx.answerCbQuery(`Maintenance ${isMaintenance ? 'ON' : 'OFF'}`); });
mainBot.action('menu_stats', async (ctx) => { ctx.answerCbQuery('Loading Stats...'); const users = await prisma.user.count(); const orders = await prisma.purchase.count(); const revAggr = await prisma.purchase.aggregate({ _sum: { advancePaid: true } }); ctx.reply(`📊 *LIVE STATS*\n👥 Users: ${users}\n📦 Orders: ${orders}\n💰 Advance: ৳${revAggr._sum.advancePaid || 0}`, { parse_mode: 'Markdown' }); });

async function processDeposit(id, action) { const dep = await prisma.deposit.findUnique({ where: { id }, include: { user: true } }); if (dep && dep.status === 'PENDING') { if (action === 'APPROVE') { if (dep.user.referredBy && !dep.user.referralRewardPaid) { const pastDeps = await prisma.deposit.findMany({ where: { userId: dep.userId, status: 'APPROVED' } }); const totalDeps = pastDeps.reduce((sum, d) => sum + d.amountBdt, 0) + dep.amountBdt; if (totalDeps >= 500.0) { const referrer = await prisma.user.findUnique({ where: { refCode: dep.user.referredBy } }); if (referrer) await prisma.user.update({ where: { id: referrer.id }, data: { balanceBdt: { increment: 100.0 } } }); await prisma.user.update({ where: { id: dep.userId }, data: { referralRewardPaid: true } }); } } await prisma.user.update({ where: { id: dep.userId }, data: { balanceBdt: { increment: dep.amountBdt } } }); await prisma.deposit.update({ where: { id }, data: { status: 'APPROVED' } }); return { success: true, msg: `Approved: ৳${dep.amountBdt}` }; } else { await prisma.deposit.update({ where: { id }, data: { status: 'REJECTED' } }); return { success: true, msg: 'Rejected' }; } } return { success: false, msg: 'Error' }; }
logBot.action(/approve_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'APPROVE'); ctx.editMessageText(`✅ ${res.msg}`); }); logBot.action(/reject_(.+)/, async (ctx) => { const res = await processDeposit(parseInt(ctx.match[1]), 'REJECT'); ctx.editMessageText(`❌ ${res.msg}`); });
async function updateOrderTelegram(ctx, status, icon) { const id = parseInt(ctx.match[1]); await prisma.purchase.update({ where: { id }, data: { status } }); const msgText = ctx.callbackQuery.message.text; ctx.editMessageText(`${msgText}\n\n${icon} *STATUS UPDATED: ${status}*`, { parse_mode: 'Markdown' }).catch(()=>{}); ctx.answerCbQuery(`Marked as ${status}`); }
logBot.action(/receive_(.+)/, (ctx) => updateOrderTelegram(ctx, 'RECEIVED', '📥')); logBot.action(/ship_(.+)/, (ctx) => updateOrderTelegram(ctx, 'SHIPPED', '🚚')); logBot.action(/deliver_(.+)/, (ctx) => updateOrderTelegram(ctx, 'DELIVERED', '✅'));

const emailHeader = `<div style="max-width: 600px; margin: 0 auto; background-color: #0b1121; border-radius: 10px; overflow: hidden; border: 1px solid #1e293b; font-family: Arial, sans-serif;"><div style="background-color: #2563eb; padding: 20px; text-align: center;"><h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">AURA STORE</h1></div><div style="padding: 30px; color: #e2e8f0;">`;
const emailFooter = `</div><div style="background-color: #0f172a; padding: 15px; text-align: center; border-top: 1px solid #1e293b;"><p style="color: #64748b; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} AURA STORE.</p></div></div>`;

// ================= EXPRESS APIs =================
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (!process.env.DEEPSEEK_API_KEY) return res.json({ reply: "Bhaiya, backend e DeepSeek API key setup kora nai. Please admin ke janan!" });
    const systemPrompt = `You are a friendly Customer Support AI for "AURA STORE". Reply in naturally conversational Banglish or Bengali. Keep answers very concise, helpful, and polite. Store Knowledge: We sell premium physical collections. Delivery Time: Inside Dhaka 2-3 days, Outside Dhaka 3-5 days. Payment System: Customers MUST pay exactly ৳200 advance via bKash or Nagad. Contact Support: Telegram @minato_namikaze143 or Facebook fb.com/yours.ononto.`;
    try {
        const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }] }) });
        const data = await response.json(); res.json({ reply: data.choices[0].message.content });
    } catch (error) { res.json({ reply: "Dukkito! Amar server e ektu shomossha hocche. Apni ektu pore abar try korun." }); }
});

app.get('/api/flashsale', async (req, res) => { const fs = await prisma.flashSale.findFirst(); res.json(fs || { isActive: false }); });
app.post('/api/admin/flashsale', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); const { isActive, endTime, discountPercent } = req.body; let fs = await prisma.flashSale.findFirst(); if (fs) { await prisma.flashSale.update({ where: { id: fs.id }, data: { isActive, endTime: new Date(endTime), discountPercent: parseInt(discountPercent) }}); } else { await prisma.flashSale.create({ data: { id: 1, isActive, endTime: new Date(endTime), discountPercent: parseInt(discountPercent) }}); } res.json({ success: true }); });
app.post('/api/promo/validate', async (req, res) => { const { code } = req.body; const promo = await prisma.promo.findUnique({ where: { code } }); if(promo && promo.isActive) return res.json({ success: true, discount: promo.discount }); return res.json({ success: false, error: 'Invalid Promo Code' }); });
app.post('/api/feedback', async (req, res) => { const { userId, subject, message } = req.body; res.json({ success: true }); try { const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } }); if (!user) return; if (ADMIN_ID) { const tgMsg = `📢 *NEW FEEDBACK*\n\n👤 *User:* ${user.firstName} (${user.email})\n📌 *Subject:* ${subject}\n\n📝 *Details:*\n${message}`; feedbackBot.telegram.sendMessage(ADMIN_ID, tgMsg, { parse_mode: 'Markdown' }).catch(()=>{}); } } catch(e) {} });

app.post('/api/checkout', async (req, res) => {
    const { userId, cartItems, address, promoCode } = req.body;
    try {
      const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } }); if(user.isBanned) return res.status(403).json({ success: false, error: 'Account Banned!' });
      const ADVANCE_FEE = 200; if(user.balanceBdt < ADVANCE_FEE) return res.json({ success: false, error: 'Insufficient Balance! You need at least ৳200 advance booking money.' });
      
      let promoDiscount = 0; if (promoCode) { const prm = await prisma.promo.findUnique({where: {code: promoCode}}); if (prm && prm.isActive) promoDiscount = prm.discount; }
      let total = 0; let itemsToBuy = []; let receiptItemsHtml = '';
      for (let item of cartItems) { const prod = await prisma.product.findUnique({ where: { id: parseInt(item.id) } }); if(!prod || prod.stock <= 0) continue; let itemFinalPrice = item.price - (item.price * promoDiscount / 100); total += itemFinalPrice; itemsToBuy.push({ prod, size: item.size, color: item.color, finalPrice: itemFinalPrice }); let varTxt = []; if(item.size) varTxt.push(item.size); if(item.color) varTxt.push(item.color); receiptItemsHtml += `<p style="margin: 5px 0; color: #cbd5e1;">• ${prod.name} ${varTxt.length>0 ? `[${varTxt.join(', ')}]` : ''} - <b>৳${itemFinalPrice}</b></p>`; }
      if(itemsToBuy.length === 0) return res.json({ success: false, error: 'Items out of stock.' });
      let actualAdvance = Math.min(ADVANCE_FEE, total); let totalDue = total - actualAdvance;
      const pointsEarned = Math.floor(total / 100); 
      await prisma.user.update({ where: { id: user.id }, data: { balanceBdt: { decrement: actualAdvance }, loyaltyPoints: { increment: pointsEarned }, savedAddress: JSON.stringify(address) } });
      
      let adminOrderMsg = `📦 *NEW ORDER RECEIVED*\n\n👤 *Customer:* ${user.firstName}\n📞 *Phone:* ${address.phone}\n🏠 *Address:* ${address.street}, ${address.city} - ${address.postcode}\n\n🛒 *Items Ordered:*\n`;
      let purchaseRecords = [];
      for (let itm of itemsToBuy) { 
          let itemAdvance = actualAdvance / itemsToBuy.length; let itemDue = totalDue / itemsToBuy.length;
          let p = await prisma.purchase.create({ data: { userId: user.id, productId: itm.prod.id, selectedSize: itm.size, selectedColor: itm.color, priceTotal: itm.finalPrice, advancePaid: itemAdvance, dueCod: itemDue, promoApplied: promoCode, phone: address.phone, street: address.street, city: address.city, postcode: address.postcode, status: 'PENDING' } }); 
          purchaseRecords.push(p.id); const updatedProd = await prisma.product.update({ where: { id: itm.prod.id }, data: { stock: { decrement: 1 } } }); 
          if (updatedProd.stock <= 5 && ADMIN_ID) { logBot.telegram.sendMessage(ADMIN_ID, `⚠️ *LOW STOCK ALERT*\nProduct: ${updatedProd.name}\nRemaining: ${updatedProd.stock} pcs`, { parse_mode: 'Markdown' }).catch(()=>{}); }
          adminOrderMsg += `- ${itm.prod.name} [Size: ${itm.size || 'N/A'}, Color: ${itm.color || 'N/A'}] (৳${itm.finalPrice})\n`;
      }
      adminOrderMsg += `\n💰 *Total:* ৳${total}\n✅ *Advance Paid:* ৳${actualAdvance}\n🚚 *Due (COD):* ৳${totalDue}`;
      if(ADMIN_ID) { logBot.telegram.sendMessage(ADMIN_ID, adminOrderMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: '📥 Receive Order', callback_data: `receive_${purchaseRecords[0]}` }], [{ text: '🚚 Mark Shipped', callback_data: `ship_${purchaseRecords[0]}` }, { text: '✅ Delivered', callback_data: `deliver_${purchaseRecords[0]}` }] ] } }).catch(e=>{}); }
      const receiptMail = { from: `"AURA STORE" <${process.env.EMAIL_USER}>`, to: user.email, subject: 'Order Confirmed - Your Receipt', html: `${emailHeader}<h2 style="color: #10b981; margin-bottom: 5px;">Order Confirmed! 🎉</h2><p style="color: #94a3b8; font-size: 14px;">Thank you for shopping with AURA STORE. Your order is now pending for review.</p><div style="background-color: #1e293b; padding: 20px; border-radius: 12px; margin: 25px 0;"><h3 style="color: #ffffff; margin-top: 0; border-bottom: 1px solid #334155; padding-bottom: 10px;">Order Details</h3>${receiptItemsHtml}<div style="margin-top: 15px; border-top: 1px dashed #334155; padding-top: 15px;"><p style="margin: 5px 0; color: #e2e8f0;"><strong>Total Price:</strong> ৳${total}</p><p style="margin: 5px 0; color: #34d399;"><strong>Advance Paid:</strong> ৳${actualAdvance}</p><p style="margin: 5px 0; color: #ef4444; font-size: 18px;"><strong>Due on Delivery (COD):</strong> ৳${totalDue}</p></div></div><div style="background-color: #0f172a; padding: 15px; border-radius: 8px;"><p style="margin: 0; color: #94a3b8; font-size: 12px;"><strong>Delivery Address:</strong><br>${address.street}, ${address.city} - ${address.postcode}<br>Phone: ${address.phone}</p></div>${emailFooter}` };
      if(process.env.EMAIL_USER && process.env.EMAIL_PASS) transporter.sendMail(receiptMail).catch(e=>{});
      res.json({ success: true, newBalance: user.balanceBdt - actualAdvance, advance: actualAdvance, due: totalDue });
    } catch(e) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

app.get('/api/notices', async (req, res) => res.json(await prisma.notice.findMany({ where: { isActive: true } }))); 
app.get('/api/products', async (req, res) => res.json(await prisma.product.findMany({ orderBy: { createdAt: 'desc' } }))); 
app.get('/api/photo/:fileId', async (req, res) => { try { const link = await mainBot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } catch(e) { res.status(404).send('Not found'); } });
app.get('/api/user/:id', async (req, res) => { const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } }); if(user) res.json({ success: true, balanceBdt: user.balanceBdt, refCode: user.refCode, role: user.role, avatar: user.avatar, refCount: user.refCount, loyaltyPoints: user.loyaltyPoints, savedAddress: user.savedAddress }); else res.json({ success: false }); });
app.post('/api/user/update', async (req, res) => { const { userId, email, password, avatar } = req.body; try { const data = {}; if (email) data.email = email; if (password) data.password = password; if (avatar !== undefined) data.avatar = avatar; await prisma.user.update({ where: { id: parseInt(userId) }, data }); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'Update failed.' }); } });
app.get('/api/library/:userId', async (req, res) => { res.json(await prisma.purchase.findMany({ where: { userId: parseInt(req.params.userId) }, include: { product: true }, orderBy: { createdAt: 'desc' } })); });
app.get('/api/history/:userId', async (req, res) => { res.json(await prisma.deposit.findMany({ where: { userId: parseInt(req.params.userId) }, orderBy: { createdAt: 'desc' } })); });
app.post('/api/deposit', async (req, res) => { const { userId, method, amountBdt, senderNumber, trxId } = req.body; try { const dep = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } }); const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } }); if(ADMIN_ID) logBot.telegram.sendMessage(ADMIN_ID, `💰 *FUND REQUEST*\n\n👤 User: ${user.firstName}\n💵 Amount: ৳${amountBdt}\n💳 Gateway: ${method.toUpperCase()}\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${dep.id}` }, { text: '❌ Reject', callback_data: `reject_${dep.id}` }]] } }).catch(e=>{}); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'TrxID already exists' }); } });

// 🔥 MISSING ROUTE RESTORED: VERIFY EMAIL
app.post('/api/register', async (req, res) => { try { const { name, email, password, country, refCode } = req.body; let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress; if(ip && ip.includes(',')) ip = ip.split(',')[0]; const ipCount = await prisma.user.count({ where: { ipAddress: ip } }); if (ipCount >= 5) return res.status(400).json({ success: false, error: 'Device limit reached.' }); let referredBy = null; if (refCode) { const r = await prisma.user.findUnique({ where: { refCode: refCode.toUpperCase() } }); if (r) { referredBy = r.refCode; await prisma.user.update({ where: { id: r.id }, data: { refCount: { increment: 1 } } }); } } const verifyToken = crypto.randomBytes(20).toString('hex'); await prisma.user.create({ data: { firstName: name, email, password, country, refCode: generateRefCode(), referredBy, ipAddress: ip, verifyToken, isVerified: false } }); if(ADMIN_ID) logBot.telegram.sendMessage(ADMIN_ID, `🆕 *NEW USER*\nName: ${name}\nEmail: ${email}`, { parse_mode: 'Markdown' }).catch(e => {}); const host = req.headers['x-forwarded-host'] || req.get('host'); const verifyLink = `https://${host}/api/verify-email/${verifyToken}`; const mailOptions = { from: `"AURA STORE" <${process.env.EMAIL_USER}>`, to: email, subject: 'Verify Your Identity', html: `${emailHeader}<h2 style="color: #ffffff;">Welcome, ${name}!</h2><p>Please verify your email:</p><div style="text-align: center; margin: 30px 0;"><a href="${verifyLink}" style="display: inline-block; background-color: #3b82f6; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">VERIFY ACCOUNT</a></div>${emailFooter}` }; if(process.env.EMAIL_USER && process.env.EMAIL_PASS) transporter.sendMail(mailOptions).catch(e=>{}); res.json({ success: true, message: 'Check email to verify account.' }); } catch(e) { res.status(400).json({ success: false, error: 'Email exists or invalid.' }); } });

app.get('/api/verify-email/:token', async (req, res) => { 
    try {
        const user = await prisma.user.findFirst({ where: { verifyToken: req.params.token } }); 
        if (!user) return res.status(400).send('<body style="background:#050b14;color:white;font-family:sans-serif;text-align:center;padding-top:20%;"><h2 style="color:#ef4444;">❌ Invalid or Expired Token!</h2></body>'); 
        await prisma.user.update({ where: { id: user.id }, data: { isVerified: true, verifyToken: null } }); 
        res.send('<body style="background:#050b14;color:white;font-family:sans-serif;text-align:center;padding-top:20%;"><h2 style="color:#10b981;">✅ Email Verified Successfully!</h2><p>Redirecting to login...</p><script>setTimeout(()=>window.location.href="/login", 2000);</script></body>'); 
    } catch(e) { res.status(500).send('Error verifying email.'); }
});

app.post('/api/login', async (req, res) => { try { const user = await prisma.user.findUnique({ where: { email: req.body.email } }); if (user && user.password === req.body.password) { if(user.isBanned) return res.status(403).json({ success: false, error: 'Account is Banned' }); if(!user.isVerified) return res.status(403).json({ success: false, error: 'Please check your email and verify your account first.' }); res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceBdt: user.balanceBdt, refCode: user.refCode, role: user.role, avatar: user.avatar, refCount: user.refCount, loyaltyPoints: user.loyaltyPoints, savedAddress: user.savedAddress } }); } else { res.status(401).json({ success: false, error: 'Invalid credentials' }); } } catch(e) { res.status(500).json({ success: false, error: 'Database error' }); } });

// --- RIDER APIs ---
app.post('/api/rider/register', async (req, res) => { try { const { name, email, phone, password } = req.body; const verifyToken = crypto.randomBytes(20).toString('hex'); await prisma.rider.create({ data: { name, email, phone, password, verifyToken, isVerified: true } }); res.json({ success: true, message: 'Rider Added' }); } catch(e) { res.status(400).json({ success: false, error: 'Email exists.' }); } });
app.post('/api/rider/login', async (req, res) => { try { const rider = await prisma.rider.findUnique({ where: { email: req.body.email } }); if (rider && rider.password === req.body.password) { res.json({ success: true, rider: { id: rider.id } }); } else { res.status(401).json({ success: false, error: 'Invalid credentials' }); } } catch(e) { res.status(500).json({ success: false }); } });
app.post('/api/rider/me', async (req, res) => { try { const rider = await prisma.rider.findUnique({ where: { id: parseInt(req.body.riderId) } }); if(rider) res.json({ success: true, rider: { id: rider.id, name: rider.name, email: rider.email, phone: rider.phone, avatar: rider.avatar, deliveryCount: rider.deliveryCount, walletBalance: rider.walletBalance, totalEarned: rider.totalEarned } }); else res.json({ success: false }); } catch(e) { res.json({ success: false }); } });
app.post('/api/rider/update', async (req, res) => { const { riderId, email, password, avatar } = req.body; try { const data = {}; if (email) data.email = email; if (password) data.password = password; if (avatar !== undefined) data.avatar = avatar; await prisma.rider.update({ where: { id: parseInt(riderId) }, data }); res.json({ success: true }); } catch(e) { res.json({ success: false }); } });
app.post('/api/rider/orders', async (req, res) => { try { const rider = await prisma.rider.findUnique({ where: { id: parseInt(req.body.riderId) } }); if(!rider) return res.status(403).json({ error: 'Unauthorized' }); const orders = await prisma.purchase.findMany({ where: { status: 'SHIPPED' }, include: { user: true, product: true }, orderBy: { createdAt: 'asc' } }); res.json({ success: true, orders }); } catch(e) { res.json({ success: false }); } });
app.post('/api/rider/history', async (req, res) => { try { const rider = await prisma.rider.findUnique({ where: { id: parseInt(req.body.riderId) } }); if(!rider) return res.json({success: false}); const history = await prisma.purchase.findMany({ where: { status: 'DELIVERED', deliveredBy: rider.name }, include: { user: true, product: true }, orderBy: { createdAt: 'desc' } }); res.json({ success: true, history }); } catch(e) { res.json({ success: false }); } });
app.post('/api/rider/location', async (req, res) => { try { const { riderId, lat, lng } = req.body; await prisma.rider.update({ where: { id: parseInt(riderId) }, data: { lastLat: parseFloat(lat), lastLng: parseFloat(lng), lastLocUpdate: new Date() } }); res.json({success: true}); } catch(e) { res.json({success: false}); } });
app.get('/api/rider/leaderboard', async (req, res) => { try { const topRiders = await prisma.rider.findMany({ orderBy: { deliveryCount: 'desc' }, take: 10, select: { id: true, name: true, deliveryCount: true, avatar: true } }); res.json({ success: true, leaderboard: topRiders }); } catch(e) { res.json({ success: false }); } });
app.post('/api/rider/send-otp', async (req, res) => { try { const rider = await prisma.rider.findUnique({ where: { id: parseInt(req.body.riderId) } }); if(!rider) return res.status(403).json({error: 'Unauthorized'}); const purchase = await prisma.purchase.findUnique({ where: { id: parseInt(req.body.orderId) }, include: { user: true, product: true } }); if (!purchase) return res.json({ success: false, error: 'Order not found' }); const otp = Math.floor(100000 + Math.random() * 900000).toString(); await prisma.purchase.update({ where: { id: purchase.id }, data: { deliveryOtp: otp } }); const varText = []; if(purchase.selectedSize) varText.push(purchase.selectedSize); if(purchase.selectedColor) varText.push(purchase.selectedColor); const varStr = varText.length > 0 ? `[${varText.join(', ')}]` : ''; const mailOptions = { from: `"AURA DELIVERY" <${process.env.EMAIL_USER}>`, to: purchase.user.email, subject: `Delivery Verification Code: ${otp}`, html: `${emailHeader}<h2 style="color: #10b981; margin-bottom: 5px;">Your Order is at your door! 📦</h2><p style="color: #94a3b8;">Our verified rider <b>${rider.name}</b> (Phone: ${rider.phone}) is waiting to deliver your order.</p><div style="background-color: #1e293b; padding: 20px; border-radius: 12px; margin: 20px 0;"><h3 style="color: #ffffff; margin-top: 0; border-bottom: 1px solid #334155; padding-bottom: 10px;">Receipt details</h3><p style="margin: 5px 0; color: #cbd5e1;">• ${purchase.product.name} ${varStr}</p><div style="margin-top: 15px; border-top: 1px dashed #334155; padding-top: 15px;"><p style="margin: 5px 0; color: #e2e8f0;">Total Price: ৳${purchase.priceTotal}</p><p style="margin: 5px 0; color: #34d399;">Advance Paid: ৳${purchase.advancePaid}</p><p style="margin: 5px 0; color: #ef4444; font-size: 18px;"><strong>Cash to Pay (COD): ৳${purchase.dueCod}</strong></p></div></div><p>Share this code with the rider to receive your product:</p><h1 style="color:#3b82f6;text-align:center;font-size:40px;letter-spacing:10px;">${otp}</h1><p style="color: #ef4444; font-size: 12px; text-align: center;">Do not share this code before receiving the product.</p>${emailFooter}` }; if(process.env.EMAIL_USER && process.env.EMAIL_PASS) await transporter.sendMail(mailOptions); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'Failed to send OTP' }); } });
app.post('/api/rider/order/action', async (req, res) => { try { const rider = await prisma.rider.findUnique({ where: { id: parseInt(req.body.riderId) } }); if(!rider) return res.status(403).json({error: 'Unauthorized'}); const purchase = await prisma.purchase.findUnique({ where: { id: parseInt(req.body.orderId) }, include: { user: true, product: true } }); if (purchase.deliveryOtp && purchase.deliveryOtp !== req.body.otp) { return res.json({ success: false, error: 'Invalid OTP Code!' }); } await prisma.purchase.update({ where: { id: parseInt(req.body.orderId) }, data: { status: 'DELIVERED', deliveryOtp: null, deliveredBy: rider.name } }); await prisma.rider.update({ where: { id: rider.id }, data: { deliveryCount: { increment: 1 }, walletBalance: { increment: 50.0 }, totalEarned: { increment: 50.0 } } }); if(ADMIN_ID) { const msg = `✅ *ORDER DELIVERED*\n\n📦 *Order ID:* #${purchase.id}\n🛒 *Product:* ${purchase.product.name}\n👤 *Customer:* ${purchase.user.firstName}\n🚴 *Delivered By:* ${rider.name} (${rider.phone})\n💰 *Cash Collected:* ৳${purchase.dueCod}`; logBot.telegram.sendMessage(ADMIN_ID, msg, { parse_mode: 'Markdown' }).catch(e=>{}); } res.json({ success: true }); } catch(e) { res.json({ success: false }); } });

// Admin APIs
app.get('/api/admin/settings', (req, res) => { res.json({ isMaintenance }); });
app.post('/api/admin/login', (req, res) => { if (req.body.password === (process.env.ADMIN_PASSWORD || 'Ananto01@$')) res.json({ success: true }); else res.status(401).json({ success: false }); });
app.get('/api/admin/stats', async (req, res) => { const recentPurchases = await prisma.purchase.findMany({ include: { user: true, product: true }, orderBy: { createdAt: 'desc' } }); let revenue = recentPurchases.reduce((acc, p) => acc + p.advancePaid, 0); res.json({ users: await prisma.user.count(), deposits: await prisma.deposit.findMany({ include: { user: true }, take: 20, orderBy: { createdAt: 'desc' } }), products: await prisma.product.findMany(), userList: await prisma.user.findMany({ take: 50, orderBy: { createdAt: 'desc' } }), riderList: await prisma.rider.findMany({ orderBy: { createdAt: 'desc' } }), orders: recentPurchases, revenue }); });
app.post('/api/admin/order/action', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); await prisma.purchase.update({ where: { id: parseInt(req.body.id) }, data: { status: req.body.status } }); res.json({success:true}); });
app.post('/api/admin/user/action', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); if(req.body.action === 'ban') { const u = await prisma.user.findUnique({where:{id:parseInt(req.body.id)}}); await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{isBanned:!u.isBanned}}); } else if(req.body.action === 'balance') { await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{balanceBdt:parseFloat(req.body.amount)}}); } else if(req.body.action === 'role') { await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{role:req.body.role}}); } else if(req.body.action === 'refCount') { await prisma.user.update({where:{id:parseInt(req.body.id)}, data:{refCount:parseInt(req.body.amount)}}); } res.json({success:true}); });
app.post('/api/admin/rider/action', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); try { if(req.body.action === 'delete') { await prisma.rider.delete({ where: { id: parseInt(req.body.id) } }); } else if(req.body.action === 'editCount') { await prisma.rider.update({ where: { id: parseInt(req.body.id) }, data: { deliveryCount: parseInt(req.body.count) } }); } else if(req.body.action === 'add') { await prisma.rider.create({ data: { name: req.body.name, email: req.body.email, phone: req.body.phone, password: req.body.riderPass, isVerified: true } }); } res.json({success:true}); } catch(e) { res.json({success:false, error: e.message}); } });
app.post('/api/admin/deposit/action', async (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); const result = await processDeposit(parseInt(req.body.id), req.body.action); res.json(result); });
app.delete('/api/admin/product/:id', async (req, res) => { try { await prisma.product.delete({ where: { id: parseInt(req.params.id) } }); res.json({ success: true }); } catch(e) { res.status(500).json({ success: false }); } });
app.post('/api/admin/notice', async (req, res) => { await prisma.notice.create({ data: { text: req.body.text } }); res.json({ success: true }); });
app.post('/api/admin/settings', (req, res) => { if (req.body.password !== (process.env.ADMIN_PASSWORD || 'Ananto01@$')) return res.status(403).json({ error: 'Unauthorized' }); isMaintenance = req.body.status; res.json({ success: true }); });
app.get('/api/admin/export-orders', async (req, res) => { try { const orders = await prisma.purchase.findMany({ include: { user: true, product: true }, orderBy: { createdAt: 'desc' } }); let csv = "Order ID,Customer Name,Phone,Address,Product Name,Size,Color,Total Price,Advance Paid,Due (COD),Status,Date\n"; orders.forEach(o => { const date = new Date(o.createdAt).toLocaleDateString(); csv += `"${o.id}","${o.user.firstName}","${o.phone || ''}","${o.street || ''} ${o.city || ''}","${o.product.name}","${o.selectedSize || ''}","${o.selectedColor || ''}","${o.priceTotal}","${o.advancePaid}","${o.dueCod}","${o.status}","${date}"\n`; }); res.header('Content-Type', 'text/csv'); res.attachment('AURA_ORDERS.csv'); return res.send(csv); } catch(e) { res.status(500).send("Error"); } });

app.get('/manifest.json', (req, res) => res.sendFile(__dirname + '/manifest.json'));
app.get('/sw.js', (req, res) => res.sendFile(__dirname + '/sw.js'));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html')); 
app.get('/rider', (req, res) => res.sendFile(__dirname + '/rider.html')); 

mainBot.launch();
if(process.env.LOG_BOT_TOKEN) logBot.launch(); 
if(process.env.FEEDBACK_BOT_TOKEN) feedbackBot.launch(); 

app.listen(8080);
