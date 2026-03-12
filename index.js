require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const prisma = new PrismaClient();

// Telegram Bots Setup
const mainBot = new Telegraf(process.env.BOT_TOKEN); 
const logBot = process.env.LOG_BOT_TOKEN ? new Telegraf(process.env.LOG_BOT_TOKEN) : mainBot; 
const feedbackBot = process.env.FEEDBACK_BOT_TOKEN ? new Telegraf(process.env.FEEDBACK_BOT_TOKEN) : logBot; 

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.set('trust proxy', true);

const ADMIN_ID = process.env.ADMIN_ID; 

// 🔥 OWNER EMAIL FIX: Checks MAIN_EMAIL or ADMIN_EMAIL from Railway
const OWNER_EMAIL = process.env.MAIN_EMAIL || process.env.ADMIN_EMAIL || process.env.EMAIL_USER; 
const OWNER_PASS = process.env.ADMIN_PASSWORD || 'Ananto01@$';

let isMaintenance = false;

const transporter = nodemailer.createTransport({ 
    service: 'gmail', 
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } 
});

const emailHeader = `<div style="max-width: 600px; margin: 0 auto; background-color: #0b1121; border-radius: 12px; overflow: hidden; border: 1px solid #1e293b; font-family: Arial, sans-serif; box-shadow: 0 10px 25px rgba(0,0,0,0.5);"><div style="background: linear-gradient(135deg, #2563eb, #4f46e5); padding: 25px; text-align: center;"><h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 900; letter-spacing: 2px;">AURA STORE</h1></div><div style="padding: 40px; color: #e2e8f0; background: #0f172a;">`;
const emailFooter = `</div><div style="background-color: #0b1121; padding: 20px; text-align: center; border-top: 1px solid #1e293b;"><p style="color: #64748b; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} AURA STORE. All rights reserved.</p><p style="color: #475569; font-size: 10px; margin-top: 5px;">This is an automated security email.</p></div></div>`;

// Middleware
app.use((req, res, next) => {
    if (req.path.startsWith('/api/admin') || req.path === '/admin' || req.path === '/manifest.json' || req.path === '/sw.js') {
        return next();
    }
    if (isMaintenance) { 
        res.setHeader('Cache-Control', 'no-store, no-cache'); 
        return res.status(200).sendFile(__dirname + '/maintenance.html'); 
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
                    data: { name: name || "Premium Item", category: category || "Premium", price: price || 0, abilities: abilities || "Best quality product.", stock: stock || 1, sizes: sizes || [], colors: colors || [], imageIds: imageIds } 
                }); 
                ctx.reply(`🎉 *Product Added Successfully!*`, { parse_mode: 'Markdown' }); 
            } catch(e) { ctx.reply(`❌ DB Error: ${e.message}`); }
            return ctx.scene.leave(); 
        }
        if (ctx.message.photo) { 
            ctx.wizard.state.imageIds.push(ctx.message.photo[ctx.message.photo.length - 1].file_id); 
            ctx.reply(`🖼️ Photo received! (${ctx.wizard.state.imageIds.length} total). Send another or type /finish`); 
            return; 
        }
    }
);

const addNoticeWizard = new Scenes.WizardScene('ADD_NOTICE_SCENE', 
    (ctx) => { ctx.reply('📢 *Type Notice:*', { parse_mode: 'Markdown' }); return ctx.wizard.next(); }, 
    async (ctx) => { 
        if(ctx.message.text) { 
            await prisma.notice.create({ data: { text: ctx.message.text } }); 
            ctx.reply('✅ *Notice live.*', { parse_mode: 'Markdown' }); 
        } 
        return ctx.scene.leave(); 
    }
);

const flashSaleWizard = new Scenes.WizardScene('FLASH_SALE_SCENE', 
    (ctx) => { ctx.reply('⚡ *Duration in HOURS:*', { parse_mode: 'Markdown' }); return ctx.wizard.next(); }, 
    (ctx) => { ctx.wizard.state.hours = parseInt(ctx.message.text); ctx.reply('💰 Discount Percentage:'); return ctx.wizard.next(); }, 
    async (ctx) => { 
        const discount = parseInt(ctx.message.text); 
        const endTime = new Date(); endTime.setHours(endTime.getHours() + ctx.wizard.state.hours); 
        let fs = await prisma.flashSale.findFirst(); 
        if (fs) await prisma.flashSale.update({ where: { id: fs.id }, data: { isActive: true, endTime, discountPercent: discount } }); 
        else await prisma.flashSale.create({ data: { id: 1, isActive: true, endTime, discountPercent: discount } }); 
        ctx.reply(`✅ *FLASH SALE ACTIVATED!*`, { parse_mode: 'Markdown' }); return ctx.scene.leave(); 
    }
);

const stage = new Scenes.Stage([addProductWizard, addNoticeWizard, flashSaleWizard]); 
mainBot.use(session()); 
mainBot.use(stage.middleware());

mainBot.start((ctx) => { 
    if(ctx.from.id.toString() !== ADMIN_ID) return; 
    const mStatus = isMaintenance ? '🔴 ON' : '🟢 OFF';
    ctx.reply(`🌟 *MASTER CONTROL*\nOwner Authority Granted.`, { 
        parse_mode: 'Markdown', 
        reply_markup: { 
            inline_keyboard: [ 
                [{ text: '🛍️ Add Product', callback_data: 'menu_add_product' }, { text: '⚡ Flash Sale', callback_data: 'menu_flash_sale' }], 
                [{ text: `🛠️ Maintenance Mode: ${mStatus}`, callback_data: 'toggle_maintenance' }], 
                [{ text: '📢 Add Notice', callback_data: 'menu_add_notice' }, { text: '🗑️ Clear Notices', callback_data: 'menu_clear_notices' }],
                [{ text: '📊 View Store Stats', callback_data: 'menu_stats' }]
            ] 
        } 
    }); 
});

mainBot.action('menu_add_product', (ctx) => { ctx.answerCbQuery(); ctx.scene.enter('ADD_PRODUCT_SCENE'); });
mainBot.action('menu_add_notice', (ctx) => { ctx.answerCbQuery(); ctx.scene.enter('ADD_NOTICE_SCENE'); });
mainBot.action('menu_clear_notices', async (ctx) => { await prisma.notice.deleteMany({}); ctx.answerCbQuery('Notices Cleared!'); ctx.reply('✅ Notices cleared.'); });
mainBot.action('menu_flash_sale', async (ctx) => { let fs = await prisma.flashSale.findFirst(); if(fs && fs.isActive) { await prisma.flashSale.update({ where: { id: fs.id }, data: { isActive: false } }); ctx.answerCbQuery('Flash Sale Stopped!'); ctx.reply('🛑 Flash Sale OFF.'); } else { ctx.answerCbQuery(); ctx.scene.enter('FLASH_SALE_SCENE'); } });
mainBot.action('toggle_maintenance', async (ctx) => { isMaintenance = !isMaintenance; ctx.answerCbQuery(`Maintenance ${isMaintenance ? 'ON' : 'OFF'}`); ctx.reply(`Maintenance mode is now ${isMaintenance ? 'ON' : 'OFF'}`);});

// Telegram Action Buttons for Approvals
logBot.action(/approve_adm_(.+)/, async (ctx) => { 
    await prisma.user.update({ where: { id: parseInt(ctx.match[1]) }, data: { role: 'ADMIN' } }); 
    ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ *ADMIN APPROVED BY OWNER*', { parse_mode: 'Markdown' }).catch(()=>{}); 
    ctx.answerCbQuery('Admin Approved'); 
});
logBot.action(/reject_adm_(.+)/, async (ctx) => { 
    await prisma.user.delete({ where: { id: parseInt(ctx.match[1]) } }); 
    ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ *ADMIN REJECTED*', { parse_mode: 'Markdown' }).catch(()=>{}); 
    ctx.answerCbQuery('Admin Rejected'); 
});
logBot.action(/approve_(.+)/, async (ctx) => { 
    const id = parseInt(ctx.match[1]);
    const dep = await prisma.deposit.findUnique({ where: { id }, include: { user: true } }); 
    if (dep && dep.status === 'PENDING') {
        await prisma.user.update({ where: { id: dep.userId }, data: { balanceBdt: { increment: dep.amountBdt } } }); 
        await prisma.deposit.update({ where: { id }, data: { status: 'APPROVED' } }); 
        ctx.editMessageText(`✅ Approved: ৳${dep.amountBdt}`); 
    }
}); 
logBot.action(/reject_(.+)/, async (ctx) => { 
    const id = parseInt(ctx.match[1]);
    const dep = await prisma.deposit.findUnique({ where: { id } });
    if(dep && dep.status === 'PENDING') {
        await prisma.deposit.update({ where: { id }, data: { status: 'REJECTED' } }); 
        ctx.editMessageText(`❌ Rejected Deposit`); 
    }
});
logBot.action(/receive_(.+)/, async (ctx) => { await prisma.purchase.update({ where: { id: parseInt(ctx.match[1]) }, data: { status: 'RECEIVED' } }); ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n📥 *RECEIVED & PACKING*`, { parse_mode: 'Markdown' }).catch(()=>{}); ctx.answerCbQuery(); });
logBot.action(/ship_(.+)/, async (ctx) => { await prisma.purchase.update({ where: { id: parseInt(ctx.match[1]) }, data: { status: 'SHIPPED' } }); ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🚚 *SHIPPED TO RIDER*`, { parse_mode: 'Markdown' }).catch(()=>{}); ctx.answerCbQuery(); });
logBot.action(/rw_app_(.+)/, async (ctx) => {
    const id = parseInt(ctx.match[1]);
    const rw = await prisma.riderWithdraw.findUnique({ where: { id } });
    if(rw && rw.status === 'PENDING') {
        await prisma.riderWithdraw.update({ where: { id }, data: { status: 'APPROVED' } });
        ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ *PAYMENT SENT & APPROVED*', { parse_mode: 'Markdown' }).catch(()=>{});
        ctx.answerCbQuery('Withdraw Approved');
    }
});
logBot.action(/rw_rej_(.+)/, async (ctx) => {
    const id = parseInt(ctx.match[1]);
    const rw = await prisma.riderWithdraw.findUnique({ where: { id } });
    if(rw && rw.status === 'PENDING') {
        await prisma.riderWithdraw.update({ where: { id }, data: { status: 'REJECTED' } });
        await prisma.rider.update({ where: { id: rw.riderId }, data: { walletBalance: { increment: rw.amount } } }); // Refund to wallet
        ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ *REJECTED & REFUNDED*', { parse_mode: 'Markdown' }).catch(()=>{});
        ctx.answerCbQuery('Withdraw Rejected & Refunded');
    }
});


// ================= PUBLIC EXPRESS APIs =================

app.get('/api/notices', async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const notices = await prisma.notice.findMany({ where: { isActive: true } });
    res.json(notices); 
});

app.get('/api/products', async (req, res) => {
    const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(products);
}); 

app.get('/api/photo/:fileId', async (req, res) => { 
    try { const link = await mainBot.telegram.getFileLink(req.params.fileId); res.redirect(link.href); } catch(e) { res.status(404).send('Not found'); } 
});

app.get('/api/store-config', async (req, res) => {
    let conf = await prisma.storeConfig.findUnique({ where: { id: 1 } });
    if (!conf) { conf = await prisma.storeConfig.create({ data: { id: 1 } }); }
    const admins = await prisma.user.findMany({ where: { role: { in: ['ADMIN', 'OWNER'] } }, select: { firstName: true, location: true, email: true, phone: true } });
    res.json({ owner: conf, admins: admins });
});

// Live Chat API
app.post('/api/chat', async (req, res) => { 
    try { 
        const response = await fetch('https://api.deepseek.com/chat/completions', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }, 
            body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: `You are a helpful Support AI for AURA STORE.` }, { role: 'user', content: req.body.message }] }) 
        }); 
        const data = await response.json(); 
        res.json({ reply: data.choices[0].message.content }); 
    } catch (error) { res.json({ reply: "Our AI is currently taking a break. Please try again in a moment." }); } 
});

// ================= DUAL ADMIN & OWNER APIs =================

app.post('/api/admin/login', async (req, res) => { 
    const { email, password } = req.body;
    
    // 🔥 OWNER LOGIN LOGIC: Checks exact Email & Password
    if (email === OWNER_EMAIL && password === OWNER_PASS) {
        // Sync Owner in User table for Main Website login
        const owner = await prisma.user.upsert({
            where: { email },
            update: { role: 'OWNER', password },
            create: { email, password, role: 'OWNER', firstName: 'Store Owner', isVerified: true }
        });
        return res.json({ success: true, role: 'OWNER', name: owner.firstName, email });
    }
    
    // Check if Normal Admin
    const admin = await prisma.user.findFirst({ where: { email, password, role: { in: ['ADMIN', 'OWNER'] } } });
    if (admin) {
        return res.json({ success: true, role: admin.role, name: admin.firstName, email });
    }
    
    res.status(401).json({ success: false, error: 'Invalid Access Credentials' }); 
});

// Admin Registration via Location & OTP
app.post('/api/admin/register/otp', async (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    const mailOptions = { 
        from: `"AURA SECURITY" <${process.env.EMAIL_USER}>`, to: email, subject: 'Admin Access Request Verification', 
        html: `${emailHeader}<h2 style="color: #3b82f6;">Admin Application</h2><p>Use this OTP to verify your application.</p><h1 style="font-size:40px; letter-spacing:10px; color:#10b981; text-align:center;">${otp}</h1>${emailFooter}` 
    };
    try {
        await transporter.sendMail(mailOptions);
        res.json({ success: true, otp }); 
    } catch(e) { res.json({ success: false, error: 'Email service error' }); }
});

app.post('/api/admin/register/verify', async (req, res) => {
    const { name, email, password, location } = req.body;
    try {
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            await prisma.user.update({ where: { email }, data: { firstName: name, password, location, role: 'PENDING_ADMIN' } });
        } else {
            await prisma.user.create({ data: { firstName: name, email, password, location, role: 'PENDING_ADMIN', isVerified: true } });
        }
        
        const newAdmin = await prisma.user.findUnique({ where: { email } });
        if(ADMIN_ID) {
            const msg = `🛡️ *NEW ADMIN REQUEST*\n\n👤 Name: ${name}\n📧 Email: ${email}\n📍 Location: ${location}`;
            logBot.telegram.sendMessage(ADMIN_ID, msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_adm_${newAdmin.id}` }, { text: '❌ Reject', callback_data: `reject_adm_${newAdmin.id}` }]] } }).catch(()=>{});
        }
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: 'Registration failed.' }); }
});

// Admin Panel Master Fetch Data
app.get('/api/admin/stats', async (req, res) => { 
    res.json({ 
        users: await prisma.user.count(), 
        deposits: await prisma.deposit.findMany({ include: { user: true }, orderBy: { createdAt: 'desc' } }), 
        products: await prisma.product.findMany({ orderBy: { createdAt: 'desc' } }), 
        userList: await prisma.user.findMany({ orderBy: { createdAt: 'desc' } }), 
        riderList: await prisma.rider.findMany(), 
        orders: await prisma.purchase.findMany({ include: { user: true, product: true }, orderBy: { createdAt: 'desc' } }), 
        riderWithdraws: await prisma.riderWithdraw.findMany({ include: { rider: true }, orderBy: { createdAt: 'desc' } }),
        pendingAdmins: await prisma.user.findMany({ where: { role: 'PENDING_ADMIN' } }),
        activeAdmins: await prisma.user.findMany({ where: { role: { in: ['ADMIN', 'OWNER'] } } })
    }); 
});

// Admin Control Panel Actions
app.post('/api/admin/action', async (req, res) => {
    const { action, id, email, password } = req.body;
    
    // Owner Verification for Sensitive Actions
    if(action === 'approve_admin' || action === 'reject_admin' || action === 'delete_admin' || action === 'add_product' || action === 'delete_product' || action === 'toggle_maintenance') {
        if(email !== OWNER_EMAIL || password !== OWNER_PASS) return res.status(403).json({success: false, error: 'Owner verification required'});
    }

    if (action === 'approve_admin') {
        await prisma.user.update({ where: { id }, data: { role: 'ADMIN' } });
    } else if (action === 'reject_admin' || action === 'delete_admin') {
        await prisma.user.update({ where: { id }, data: { role: 'USER' } });
    } else if (action === 'add_product') {
        const { pName, pCat, pPrice, pStock, pImage } = req.body;
        await prisma.product.create({ data: { name: pName, category: pCat, price: parseFloat(pPrice), stock: parseInt(pStock), abilities: 'Premium Item', imageIds: [pImage] } });
    } else if (action === 'delete_product') {
        await prisma.product.delete({ where: { id } });
    } else if (action === 'toggle_maintenance') {
        isMaintenance = !isMaintenance;
    } else if (action === 'add_notice') {
        await prisma.notice.create({ data: { text: req.body.text } });
    } else if (action === 'clear_notices') {
        await prisma.notice.deleteMany({});
    } else if (action === 'order_status') {
        await prisma.purchase.update({ where: { id }, data: { status: req.body.status } });
    } else if (action === 'deposit_status') {
        const dep = await prisma.deposit.findUnique({ where: { id } });
        if(dep && dep.status === 'PENDING') {
            if(req.body.status === 'APPROVED') {
                await prisma.user.update({ where: { id: dep.userId }, data: { balanceBdt: { increment: dep.amountBdt } } });
            }
            await prisma.deposit.update({ where: { id }, data: { status: req.body.status } });
        }
    } else if (action === 'withdraw_status') {
        const rw = await prisma.riderWithdraw.findUnique({ where: { id } });
        if(rw && rw.status === 'PENDING') {
            if(req.body.status === 'REJECTED') {
                await prisma.rider.update({ where: { id: rw.riderId }, data: { walletBalance: { increment: rw.amount } } });
            }
            await prisma.riderWithdraw.update({ where: { id }, data: { status: req.body.status } });
        }
    } else if (action === 'update_balance') {
        await prisma.user.update({ where: { id }, data: { balanceBdt: parseFloat(req.body.amount) } });
    } else if (action === 'toggle_ban') {
        const u = await prisma.user.findUnique({ where: { id } });
        await prisma.user.update({ where: { id }, data: { isBanned: !u.isBanned } });
    } else if (action === 'make_owner') {
        if(email !== OWNER_EMAIL || password !== OWNER_PASS) return res.status(403).json({error: 'Unauthorized'});
        await prisma.user.update({ where: { id }, data: { role: 'OWNER' } });
    }

    res.json({ success: true });
});

app.post('/api/admin/store-config', async (req, res) => {
    if (req.body.email !== OWNER_EMAIL || req.body.password !== OWNER_PASS) return res.status(403).json({ error: 'Unauthorized' });
    const { ownerName, ownerPhone, ownerBio, fbLink, tgLink } = req.body;
    await prisma.storeConfig.upsert({ 
        where: { id: 1 }, update: { ownerName, ownerPhone, ownerBio, fbLink, tgLink }, create: { id: 1, ownerName, ownerPhone, ownerBio, fbLink, tgLink } 
    });
    res.json({ success: true });
});

// ================= AUTHENTICATION & USER APIs =================

app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json({ success: false, error: 'Account not found.' });
    
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const token = crypto.randomBytes(20).toString('hex');
    await prisma.user.update({ where: { id: user.id }, data: { resetCode: otp, resetToken: token, resetExpiry: new Date(Date.now() + 15 * 60000) } });
    
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const resetLink = `https://${host}/reset-password?token=${token}`;
    
    const mailOptions = { 
        from: `"AURA SECURITY" <${process.env.EMAIL_USER}>`, to: email, subject: 'Security: Password Reset / Change', 
        html: `${emailHeader}<p style="font-size: 16px; margin-bottom: 20px;">Hello ${user.firstName || ''},</p><p>Use the 6-digit OTP code below to verify your password change request.</p><div style="text-align:center; margin: 40px 0; background: rgba(0,0,0,0.3); padding: 20px; border-radius: 12px; border: 1px dashed #3b82f6;"><p style="color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 2px;">Verification Code</p><h1 style="font-size:48px; letter-spacing:15px; color:#10b981; margin: 0;">${otp}</h1></div><p style="text-align: center; color: #94a3b8;">Or click below to reset directly:</p><div style="text-align:center; margin: 20px 0;"><a href="${resetLink}" style="display: inline-block; background: #3b82f6; color: #ffffff; padding: 15px 35px; text-decoration: none; border-radius: 8px; font-weight: 900;">DIRECT RESET LINK</a></div>${emailFooter}` 
    };
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) { await transporter.sendMail(mailOptions); res.json({ success: true }); } else { res.json({ success: false, error: 'Email offline.'}); }
});

app.post('/api/auth/send-profile-otp', async (req, res) => {
    const { userId } = req.body;
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    if (!user) return res.json({ success: false });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await prisma.user.update({ where: { id: user.id }, data: { resetCode: otp, resetExpiry: new Date(Date.now() + 15 * 60000) } });
    const mailOptions = { from: `"AURA SECURITY" <${process.env.EMAIL_USER}>`, to: user.email, subject: 'Profile Update Security Code', html: `${emailHeader}<h2 style="color: #facc15;">Security Alert</h2><p>An attempt was made to change your account password. Use this OTP to verify.</p><h1 style="text-align:center; font-size:40px; letter-spacing:10px; color:#3b82f6;">${otp}</h1>${emailFooter}` };
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) { await transporter.sendMail(mailOptions); }
    res.json({ success: true });
});

app.post('/api/auth/reset', async (req, res) => {
    const { email, code, token, newPassword } = req.body;
    let user;
    if (token) user = await prisma.user.findFirst({ where: { resetToken: token } });
    else user = await prisma.user.findFirst({ where: { email: email, resetCode: code } });
    
    if (!user || !user.resetExpiry || user.resetExpiry < new Date()) return res.json({ success: false, error: 'Invalid or expired code/token.' });
    await prisma.user.update({ where: { id: user.id }, data: { password: newPassword, resetCode: null, resetToken: null, resetExpiry: null } });
    res.json({ success: true });
});

app.post('/api/user/update', async (req, res) => { 
    const { userId, email, password, avatar, otp } = req.body; 
    try { 
        const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
        const data = {}; if (email) data.email = email; if (avatar !== undefined) data.avatar = avatar; 
        if (password) {
            if (!otp || user.resetCode !== otp || (user.resetExpiry && user.resetExpiry < new Date())) return res.json({ success: false, error: 'Invalid or expired OTP.' });
            data.password = password; data.resetCode = null; data.resetExpiry = null;
        }
        await prisma.user.update({ where: { id: parseInt(userId) }, data }); 
        res.json({ success: true }); 
    } catch(e) { res.json({ success: false, error: 'Update failed.' }); } 
});

app.post('/api/checkout', async (req, res) => {
    const { userId, cartItems, address, promoCode } = req.body;
    try {
      const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } }); if(user.isBanned) return res.status(403).json({ success: false, error: 'Account Banned!' });
      const ADVANCE_FEE = 200; if(user.balanceBdt < ADVANCE_FEE) return res.json({ success: false, error: 'Insufficient Balance! You need at least ৳200 advance booking money.' });
      
      let promoDiscount = 0; if (promoCode) { const prm = await prisma.promo.findUnique({where: {code: promoCode}}); if (prm && prm.isActive) promoDiscount = prm.discount; }
      let total = 0; let itemsToBuy = []; let receiptItemsHtml = '';
      for (let item of cartItems) { const prod = await prisma.product.findUnique({ where: { id: parseInt(item.id) } }); if(!prod || prod.stock <= 0) continue; let itemFinalPrice = item.price - (item.price * promoDiscount / 100); total += itemFinalPrice; itemsToBuy.push({ prod, size: item.size, color: item.color, finalPrice: itemFinalPrice }); let varTxt = []; if(item.size) varTxt.push(item.size); if(item.color) varTxt.push(item.color); receiptItemsHtml += `<p style="margin: 5px 0; color: #cbd5e1;">• ${prod.name} ${varTxt.length>0 ? `[${varTxt.join(', ')}]` : ''} - <b>৳${itemFinalPrice}</b></p>`; }
      if(itemsToBuy.length === 0) return res.json({ success: false, error: 'Items out of stock.' });
      let actualAdvance = Math.min(ADVANCE_FEE, total); let totalDue = total - actualAdvance; const pointsEarned = Math.floor(total / 100); 
      await prisma.user.update({ where: { id: user.id }, data: { balanceBdt: { decrement: actualAdvance }, loyaltyPoints: { increment: pointsEarned }, savedAddress: JSON.stringify(address) } });
      
      let adminOrderMsg = `📦 *NEW ORDER RECEIVED*\n\n👤 *Customer:* ${user.firstName}\n📞 *Phone:* ${address.phone}\n🏠 *Address:* ${address.street}, ${address.city}\n\n🛒 *Total:* ৳${total}\n✅ *Advance Paid:* ৳${actualAdvance}\n🚚 *Due (COD):* ৳${totalDue}`;
      let purchaseRecords = [];
      for (let itm of itemsToBuy) { 
          let itemAdvance = actualAdvance / itemsToBuy.length; let itemDue = totalDue / itemsToBuy.length;
          let p = await prisma.purchase.create({ data: { userId: user.id, productId: itm.prod.id, selectedSize: itm.size, selectedColor: itm.color, priceTotal: itm.finalPrice, advancePaid: itemAdvance, dueCod: itemDue, promoApplied: promoCode, phone: address.phone, street: address.street, city: address.city, postcode: address.postcode, status: 'PENDING' } }); 
          purchaseRecords.push(p.id); await prisma.product.update({ where: { id: itm.prod.id }, data: { stock: { decrement: 1 } } }); 
      }
      if(ADMIN_ID) { logBot.telegram.sendMessage(ADMIN_ID, adminOrderMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: '📥 Receive Order', callback_data: `receive_${purchaseRecords[0]}` }], [{ text: '🚚 Mark Shipped', callback_data: `ship_${purchaseRecords[0]}` }] ] } }).catch(e=>{}); }
      const qrData = encodeURIComponent(`AURA STORE RECEIPT\nOrder ID: #${purchaseRecords[0]}\nTotal: BDT ${total}\nAdvance: BDT ${actualAdvance}\nDue(COD): BDT ${totalDue}\nStatus: Pending`);
      const qrHtml = `<div style="text-align: center; margin: 30px 0;"><p style="color: #94a3b8; font-size: 12px; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px;">Scan Receipt QR</p><div style="background: white; padding: 10px; display: inline-block; border-radius: 10px;"><img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${qrData}" width="120" height="120" alt="QR Code"></div></div>`;
      const receiptMail = { from: `"AURA STORE" <${process.env.EMAIL_USER}>`, to: user.email, subject: 'Order Confirmed - Your Receipt', html: `${emailHeader}<h2 style="color: #10b981; margin-bottom: 5px;">Order Confirmed! 🎉</h2><p style="color: #94a3b8; font-size: 14px;">Thank you for shopping with AURA STORE. Your order is now pending for review.</p><div style="background-color: #1e293b; padding: 20px; border-radius: 12px; margin: 25px 0;"><h3 style="color: #ffffff; margin-top: 0; border-bottom: 1px solid #334155; padding-bottom: 10px;">Order Details</h3>${receiptItemsHtml}<div style="margin-top: 15px; border-top: 1px dashed #334155; padding-top: 15px;"><p style="margin: 5px 0; color: #e2e8f0;"><strong>Total Price:</strong> ৳${total}</p><p style="margin: 5px 0; color: #34d399;"><strong>Advance Paid:</strong> ৳${actualAdvance}</p><p style="margin: 5px 0; color: #ef4444; font-size: 18px;"><strong>Due on Delivery (COD):</strong> ৳${totalDue}</p></div></div><div style="background-color: #0f172a; padding: 15px; border-radius: 8px;"><p style="margin: 0; color: #94a3b8; font-size: 12px;"><strong>Delivery Address:</strong><br>${address.street}, ${address.city} - ${address.postcode}<br>Phone: ${address.phone}</p></div>${qrHtml}${emailFooter}` };
      if(process.env.EMAIL_USER && process.env.EMAIL_PASS) transporter.sendMail(receiptMail).catch(e=>{});
      res.json({ success: true, newBalance: user.balanceBdt - actualAdvance, advance: actualAdvance, due: totalDue });
    } catch(e) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

app.get('/api/user/:id', async (req, res) => { const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } }); if(user) res.json({ success: true, balanceBdt: user.balanceBdt, refCode: user.refCode, role: user.role, avatar: user.avatar, refCount: user.refCount, loyaltyPoints: user.loyaltyPoints, savedAddress: user.savedAddress }); else res.json({ success: false }); });
app.get('/api/library/:userId', async (req, res) => { res.json(await prisma.purchase.findMany({ where: { userId: parseInt(req.params.userId) }, include: { product: true }, orderBy: { createdAt: 'desc' } })); });
app.get('/api/history/:userId', async (req, res) => { res.json(await prisma.deposit.findMany({ where: { userId: parseInt(req.params.userId) }, orderBy: { createdAt: 'desc' } })); });
app.post('/api/deposit', async (req, res) => { const { userId, method, amountBdt, senderNumber, trxId } = req.body; try { const dep = await prisma.deposit.create({ data: { userId: parseInt(userId), method, amountBdt: parseFloat(amountBdt), senderNumber, trxId } }); const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } }); if(ADMIN_ID) logBot.telegram.sendMessage(ADMIN_ID, `💰 *FUND REQUEST*\n\n👤 User: ${user.firstName}\n💵 Amount: ৳${amountBdt}\n💳 Gateway: ${method.toUpperCase()}\n📱 Sender: ${senderNumber}\n🔢 TrxID: \`${trxId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${dep.id}` }, { text: '❌ Reject', callback_data: `reject_${dep.id}` }]] } }).catch(e=>{}); res.json({ success: true }); } catch(e) { res.json({ success: false, error: 'TrxID already exists' }); } });

app.post('/api/register', async (req, res) => { try { const { name, email, password } = req.body; await prisma.user.create({ data: { firstName: name, email, password, refCode: generateRefCode(), isVerified: true } }); res.json({ success: true, message: 'Account created!' }); } catch(e) { res.status(400).json({ success: false, error: 'Email exists.' }); } });
app.post('/api/login', async (req, res) => { try { const user = await prisma.user.findUnique({ where: { email: req.body.email } }); if (user && user.password === req.body.password) { if(user.isBanned) return res.status(403).json({ success: false, error: 'Account Banned' }); res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceBdt: user.balanceBdt, role: user.role, avatar: user.avatar, loyaltyPoints: user.loyaltyPoints } }); } else { res.status(401).json({ success: false, error: 'Invalid credentials' }); } } catch(e) { res.status(500).json({ success: false }); } });

// Main Feedback 
app.post('/api/feedback', async (req, res) => { 
    try { 
        const { userId, subject, message } = req.body; 
        res.json({ success: true }); 
        
        // Find owner to send feedback
        let ownerConfig = await prisma.storeConfig.findUnique({where:{id:1}});
        if (ADMIN_ID) { 
            const u = await prisma.user.findUnique({where:{id:parseInt(userId)}}); 
            feedbackBot.telegram.sendMessage(ADMIN_ID, `📢 *NEW FEEDBACK*\n\n👤 User: ${u.firstName}\n📌 Subject: ${subject}\n📝 Message:\n${message}`, { parse_mode: 'Markdown' }).catch(()=>{}); 
        } 
    } catch(e){} 
});

// Rider APIs
app.post('/api/rider/login', async (req, res) => { try { const rider = await prisma.rider.findUnique({ where: { email: req.body.email } }); if (rider && rider.password === req.body.password) { res.json({ success: true, rider: { id: rider.id } }); } else { res.status(401).json({ success: false, error: 'Invalid credentials' }); } } catch(e) { res.status(500).json({ success: false }); } });
app.post('/api/rider/me', async (req, res) => { try { const rider = await prisma.rider.findUnique({ where: { id: parseInt(req.body.riderId) } }); if(rider) res.json({ success: true, rider: { id: rider.id, name: rider.name, email: rider.email, phone: rider.phone, avatar: rider.avatar, deliveryCount: rider.deliveryCount, walletBalance: rider.walletBalance, totalEarned: rider.totalEarned } }); else res.json({ success: false }); } catch(e) { res.json({ success: false }); } });
app.post('/api/rider/orders', async (req, res) => { try { const rider = await prisma.rider.findUnique({ where: { id: parseInt(req.body.riderId) } }); if(!rider) return res.status(403).json({ error: 'Unauthorized' }); const orders = await prisma.purchase.findMany({ where: { status: { in: ['PENDING', 'RECEIVED', 'SHIPPED'] } }, include: { user: true, product: true }, orderBy: { createdAt: 'desc' } }); res.json({ success: true, orders }); } catch(e) { res.json({ success: false }); } });
app.post('/api/rider/history', async (req, res) => { try { const rider = await prisma.rider.findUnique({ where: { id: parseInt(req.body.riderId) } }); if(!rider) return res.json({success: false}); const history = await prisma.purchase.findMany({ where: { status: 'DELIVERED', deliveredBy: rider.name }, include: { user: true, product: true }, orderBy: { createdAt: 'desc' } }); res.json({ success: true, history }); } catch(e) { res.json({ success: false }); } });
app.post('/api/rider/location', async (req, res) => { try { const { riderId, lat, lng } = req.body; await prisma.rider.update({ where: { id: parseInt(riderId) }, data: { lastLat: parseFloat(lat), lastLng: parseFloat(lng), lastLocUpdate: new Date() } }); res.json({success: true}); } catch(e) { res.json({success: false}); } });
app.get('/api/rider/leaderboard', async (req, res) => { try { const topRiders = await prisma.rider.findMany({ orderBy: { deliveryCount: 'desc' }, take: 10, select: { id: true, name: true, deliveryCount: true, avatar: true } }); res.json({ success: true, leaderboard: topRiders }); } catch(e) { res.json({ success: false }); } });

// Direct Password Reset Page
app.get('/reset-password', (req, res) => {
    const token = req.query.token;
    if(!token) return res.send("Invalid Link");
    res.send(`<!DOCTYPE html><html class="dark"><head><title>Reset Password</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script></head><body class="bg-slate-950 flex justify-center items-center h-screen font-sans"><div class="bg-slate-900/80 p-10 rounded-3xl w-full max-w-md border border-slate-800 shadow-[0_0_50px_rgba(59,130,246,0.2)] text-center backdrop-blur-xl"><div class="w-16 h-16 bg-blue-600 rounded-full mx-auto flex items-center justify-center text-white text-2xl mb-6 shadow-[0_0_20px_rgba(59,130,246,0.5)]">🔒</div><h2 class="text-3xl font-black text-white mb-2">New Password</h2><p class="text-slate-400 text-sm mb-8">Secure your AURA STORE account.</p><input type="password" id="pass" placeholder="Enter new password" class="w-full bg-slate-950 border border-slate-700 text-white px-5 py-4 rounded-xl font-bold mb-6 outline-none focus:border-blue-500 transition-colors"><button onclick="savePass()" class="w-full bg-blue-600 text-white font-black py-4 rounded-xl hover:bg-blue-500 transition-transform active:scale-95 shadow-lg uppercase tracking-widest">Confirm & Login</button></div><script>async function savePass(){ const newPassword = document.getElementById('pass').value; if(!newPassword) return; const res = await fetch('/api/auth/reset', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token: '${token}', newPassword}) }); const data = await res.json(); if(data.success){ Swal.fire({title:'Success!', text:'Password Updated.', icon:'success', background:'#0f172a', color:'#fff', confirmButtonColor:'#3b82f6'}).then(()=>window.location.href='/login'); } else { Swal.fire({title:'Error', text:data.error, icon:'error', background:'#0f172a', color:'#fff'}); } }</script></body></html>`);
});

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
