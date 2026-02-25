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

async function getExchangeRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    return data.rates.BDT; 
  } catch (e) {
    return 120; 
  }
}

// --- BOT SCENES & COMMANDS ---
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
bot.command('start', (ctx) => ctx.reply('Welcome Admin! Your bot is running.'));

// --- AUTHENTICATION APIS (NEW) ---

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  // Ekhan theke securely check hobe (Front-end e keu dekhbe na)
  const adminEmail = process.env.ADMIN_EMAIL || 'mdananto01@gmail.com';
  const adminPass = process.env.ADMIN_PASSWORD || 'Ananto01@$';

  if (email === adminEmail && password === adminPass) {
    res.json({ success: true, token: 'admin_auth_success' });
  } else {
    res.status(401).json({ success: false, error: 'Invalid Admin Credentials' });
  }
});

// User Register
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ success: false, error: 'Email already registered' });

    await prisma.user.create({ data: { firstName: name, email, password } });
    res.json({ success: true, message: 'Registration Successful' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// User Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.password === password) {
      res.json({ success: true, user: { id: user.id, name: user.firstName, email: user.email, balanceUsd: user.balanceUsd } });
    } else {
      res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// --- EXISTING APIS ---
app.get('/api/rate', async (req, res) => { res.json({ rate: await getExchangeRate() }); });
app.get('/api/products', async (req, res) => {
  const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(products);
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
