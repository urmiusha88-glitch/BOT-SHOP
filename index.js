require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const express = require('express');

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

// Pro setup: JSON body parse korar jonno
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Bot er Start Command
bot.command('start', (ctx) => {
  ctx.reply('Welcome to the Premium Source Code Store!\n\nDeveloper: Ononto Hasan\n\nUse /addproduct to add a new source code to the database.');
});

// Step-by-step data neyar jonno Wizard Scene
const addProductWizard = new Scenes.WizardScene(
  'ADD_PRODUCT_SCENE',
  (ctx) => {
    ctx.reply('Notun product (bot source code) er nam ki?');
    return ctx.wizard.next();
  },
  (ctx) => {
    ctx.wizard.state.name = ctx.message.text;
    ctx.reply('Product er price koto? (e.g. 30$)');
    return ctx.wizard.next();
  },
  (ctx) => {
    ctx.wizard.state.price = ctx.message.text;
    ctx.reply('Product er abilities/features ki ki? (Comma diye likhun)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.abilities = ctx.message.text;
    const { name, price, abilities } = ctx.wizard.state;

    try {
      await prisma.product.create({
        data: { name, price, abilities }
      });
      ctx.reply(`✅ Product successfully added!\n\n📦 Name: ${name}\n💰 Price: ${price}\n⚙️ Abilities: ${abilities}\n\nLive on Website now!`);
    } catch (error) {
      console.error(error);
      ctx.reply('❌ Database e save korte shomossha hoyeche.');
    }
    return ctx.scene.leave();
  }
);

// Bot er middleware setup
const stage = new Scenes.Stage([addProductWizard]);
bot.use(session());
bot.use(stage.middleware());

bot.command('addproduct', (ctx) => ctx.scene.enter('ADD_PRODUCT_SCENE'));

// ----- WEB & API ROUTES -----

// 1. Website theke shob product anar API
app.get('/api/products', async (req, res) => {
  try {
    // Sobcheye notun product aage dekhabe
    const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Database theke data anhte shomossha hocche' });
  }
});

// 2. Admin Panel theke Product Delete korar API
app.delete('/api/admin/delete/:id', async (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'ononto123'; // Default password jodi .env te na thake
  
  if (password !== adminPassword) {
    return res.status(403).json({ error: 'Incorrect Admin Password!' });
  }

  try {
    const productId = parseInt(req.params.id);
    await prisma.product.delete({ where: { id: productId } });
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// 3. Web Server - Main file gulo serve korbe
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Port & Bot Launch
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  bot.launch().then(() => console.log('Bot is running...'));
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
