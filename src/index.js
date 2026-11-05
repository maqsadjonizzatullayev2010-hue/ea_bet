require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

const token = process.env.BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI;
const adminId = Number(process.env.ADMIN_TELEGRAM_ID);

const LIVE_CHANNEL_URL = process.env.LIVE_CHANNEL_URL;

if (!LIVE_CHANNEL_URL) {
    console.error("❌ Xatolik: LIVE_CHANNEL_URL .env'da topilmadi!");
    process.exit(1);
}

if (!token) {
  console.error("❌ Xatolik: BOT_TOKEN topilmadi!");
  process.exit(1);
}

const bot = new Telegraf(token);

// MongoDB Ulanish
mongoose.connect(mongoUri)
  .then(() => console.log('✅ MongoDB bazasiga muvaffaqiyatli ulandi!'))
  .catch(err => console.error('❌ MongoDB ulanish xatoligi:', err));

// Modellar
const UserSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: String,
  balance: { type: Number, default: Number(process.env.START_BALANCE || 1000000) }
});
const User = mongoose.model('User', UserSchema);

const MatchSchema = new mongoose.Schema({
  homeTeam: String,
  awayTeam: String,
  oddsHome: Number,
  oddsDraw: Number,
  oddsAway: Number,
  date: String,
  time: String,
  photo: String,
  status: { type: String, default: 'active' },
  winner: String,
  score: String
});
const Match = mongoose.model('Match', MatchSchema);

const BetSchema = new mongoose.Schema({
  userId: Number,
  matchId: mongoose.Schema.Types.ObjectId,
  choice: String,
  amount: Number,
  odds: Number,
  status: { type: String, default: 'pending' }
});
const Bet = mongoose.model('Bet', BetSchema);

const DepositSchema = new mongoose.Schema({
  userId: Number,
  amount: Number,
  cardNumber: String,
  status: { type: String, default: 'pending' }
});
const Deposit = mongoose.model('Deposit', DepositSchema);

const WithdrawalSchema = new mongoose.Schema({
  userId: Number,
  amount: Number,
  userCard: String,
  status: { type: String, default: 'pending' }
});
const Withdrawal = mongoose.model('Withdrawal', WithdrawalSchema);

// Start komandasi
bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;

  let user = await User.findOne({ telegramId });
  if (!user) {
    user = new User({
      telegramId,
      username,
      balance: Number(process.env.START_BALANCE || 1000000)
    });
    await user.save();
  }

  await ctx.reply(
    `🎮 eFootball Prediction & Betting Botga xush kelibsiz!\n\nSizning shaxsiy balansingiz: **${user.balance.toLocaleString()} UZS**`,
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([
        ['⚽️ Jonli Oyinlar (Live)', '💳 Hisobni Toldirish'],
        ['📺 Jonli Efir', '💰 Balansim'],
        ['💸 Pul Yechish', '📊 Garovlar tarixi']
      ]).resize()
    }
  );
}); // <--- Mana bu yerda bot.start oxiri to'liq va bitta yopilishi shart!

bot.hears('📺 Jonli Efir', async (ctx) => {
  await ctx.reply(
    `📺 **EA.BET Jonli Efir Kanali**\n\n` +
    `Barcha eFootball o'yinlarini jonli efirda kuzatish uchun pastdagi tugmani bosing va kanalimizga o'ting!`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('🔗 Kanalga O\'tish', LIVE_CHANNEL_URL)]
      ])
    }
  );
});

// Balansni tekshirish
bot.hears('💰 Balansim', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  const bal = user ? user.balance : 0;
  await ctx.reply(`💳 Sizning joriy balansingiz: **${bal.toLocaleString()} UZS**`, { parse_mode: 'Markdown' });
});

const pendingDeposits = new Map();
const pendingWithdrawals = new Map();

bot.hears('💳 Hisobni Toldirish', async (ctx) => {
  pendingDeposits.set(ctx.from.id, { step: 'awaiting_amount' });
  pendingWithdrawals.delete(ctx.from.id);
  await ctx.reply('💳 Hisobingizni toldirish uchun qancha summa (UZS) kiritmoqchisiz? Faqat raqamlarda yozing (masalan: 50000):');
});

bot.hears('💸 Pul Yechish', async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ telegramId: userId });
  const currentBalance = user ? user.balance : 0;

  if (currentBalance <= 0) {
    return ctx.reply('❌ Balansingizda yechib olish uchun mablag mavjud emas.');
  }

  pendingDeposits.delete(userId);
  pendingWithdrawals.set(userId, { step: 'awaiting_withdraw_amount', balance: currentBalance });

  await ctx.reply(
    `💸 **Pul yechib olish**\n\n` +
    `Sizning jami balansingiz: **${currentBalance.toLocaleString()} UZS**\n\n` +
    `Qancha miqdorda pul yechmoqchisiz? Summani raqamlarda kiriting:`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  if (pendingWithdrawals.has(userId)) {
    const state = pendingWithdrawals.get(userId);

    if (state.step === 'awaiting_withdraw_amount') {
      const amount = Number(text.replace(/\s+/g, ''));
      if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Iltimos, togri raqam kiriting:');
      if (amount > state.balance) {
        return ctx.reply(`❌ Xato! Sizning balansingizda faqat **${state.balance.toLocaleString()} UZS** bor. Qaytadan kiriting:`, { parse_mode: 'Markdown' });
      }

      state.amount = amount;
      state.step = 'awaiting_withdraw_card';
      return ctx.reply('💳 Pulni qaysi kartaga otkazib berish kerak? Karta raqamini va bank nomini yozing (masalan: 8600 0000 1111 2222, Uzcard):');
    }

    if (state.step === 'awaiting_withdraw_card') {
      const userCard = text.trim();
      const amount = state.amount;
      const totalBalance = state.balance;

      pendingWithdrawals.delete(userId);

      const withdrawal = new Withdrawal({ userId, amount, userCard, status: 'pending' });
      await withdrawal.save();

      await ctx.reply('✅ Pul yechish sorovingiz adminga yuborildi! Tez orada korib chiqiladi.');

      return bot.telegram.sendMessage(
        adminId,
        `💸 **Yangi pul yechish sorovi!**\n\n` +
        `👤 Foydalanuvchi ID: \`${userId}\`\n` +
        `💰 Jami balansi: **${totalBalance.toLocaleString()} UZS**\n` +
        `📤 Yechishni sorayotgan summa: **${amount.toLocaleString()} UZS**\n` +
        `💳 Karta raqami: \`${userCard}\`\n\n` +
        `Tasdiqlaysizmi?`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Tasdiqlash', `w_approve_${withdrawal._id}`),
              Markup.button.callback('❌ Rad etish', `w_reject_${withdrawal._id}`)
            ]
          ])
        }
      );
    }
  }

  if (pendingDeposits.has(userId)) {
    const state = pendingDeposits.get(userId);

    if (state.step === 'awaiting_amount') {
      const amount = Number(text.replace(/\s+/g, ''));
      if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Iltimos, togri raqam kiriting (masalan: 50000):');

      const cards = [
        { number: '9860 1766 2166 0941', holder: 'NAR...  ROZ... (Humo)' },
        { number: '9860 3566 4697 2691', holder: 'NAR...  ROZ... (Humo)' }
      ];
      const selectedCard = cards[Math.floor(Math.random() * cards.length)];

      state.amount = amount;
      state.step = 'awaiting_screenshot';
      state.card = selectedCard;

      return ctx.reply(
        `💳 **Tolov uchun karta malumotlari:**\n\n` +
        `Karta raqami: \`${selectedCard.number}\`\n` +
        `Karta egasi: ${selectedCard.holder}\n` +
        `Summa: **${amount.toLocaleString()} UZS**\n\n` +
        `Iltimos, pulni otkazgandan song tolov chekini shu chatga yuboring!`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  return next();
});

bot.action(/^w_approve_(.+)$/, async (ctx) => {
  if (ctx.from.id !== adminId) return ctx.answerCbQuery('Siz admin emassiz!');
  const withdrawal = await Withdrawal.findById(ctx.match[1]);
  if (!withdrawal || withdrawal.status !== 'pending') return ctx.answerCbQuery('Allaqachon korib chiqilgan!');

  const user = await User.findOne({ telegramId: withdrawal.userId });
  if (!user || user.balance < withdrawal.amount) return ctx.answerCbQuery('Mablag yetarli emas!');

  user.balance -= withdrawal.amount;
  await user.save();
  withdrawal.status = 'approved';
  await withdrawal.save();

  await ctx.editMessageText(`✅ Tasdiqlandi! ${withdrawal.amount.toLocaleString()} UZS yechildi.`, { parse_mode: 'Markdown' });
  await bot.telegram.sendMessage(withdrawal.userId, `🎉 Tabriklaymiz! **${withdrawal.amount.toLocaleString()} UZS** kartangizga otkazib berildi.`, { parse_mode: 'Markdown' });
});

bot.action(/^w_reject_(.+)$/, async (ctx) => {
  if (ctx.from.id !== adminId) return ctx.answerCbQuery('Siz admin emassiz!');
  const withdrawal = await Withdrawal.findById(ctx.match[1]);
  if (!withdrawal || withdrawal.status !== 'pending') return ctx.answerCbQuery('Allaqachon korib chiqilgan!');

  withdrawal.status = 'rejected';
  await withdrawal.save();
  await ctx.editMessageText(`❌ Rad etildi.`);
  await bot.telegram.sendMessage(withdrawal.userId, `❌ Afsuski, pul yechish sorovingiz rad etildi.`);
});

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const state = pendingDeposits.get(userId);

  if (state && state.step === 'awaiting_screenshot') {
    const amount = state.amount;
    const photo = ctx.message.photo[ctx.message.photo.length - 1].file_id;

    const deposit = new Deposit({ userId, amount, cardNumber: state.card.number, status: 'pending' });
    await deposit.save();
    pendingDeposits.delete(userId);

    await ctx.reply('✅ Tolov chekingiz adminga yuborildi! Tez orada tasdiqlanadi.');

    await bot.telegram.sendPhoto(adminId, photo, {
      caption: `🔔 **Yangi tolov sorovi!**\n\nFoydalanuvchi ID: \`${userId}\`\nSumma: **${amount.toLocaleString()} UZS**`,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Tasdiqlash', `approve_${deposit._id}`), Markup.button.callback('❌ Rad etish', `reject_${deposit._id}`)]
      ])
    });
  }
});

bot.action(/^approve_(.+)$/, async (ctx) => {
  if (ctx.from.id !== adminId) return ctx.answerCbQuery('Siz admin emassiz!');
  const deposit = await Deposit.findById(ctx.match[1]);
  if (!deposit || deposit.status !== 'pending') return ctx.answerCbQuery('Allaqachon korib chiqilgan!');

  deposit.status = 'approved';
  await deposit.save();
  await User.updateOne({ telegramId: deposit.userId }, { $inc: { balance: deposit.amount } });

  await ctx.editMessageCaption(`✅ Tasdiqlandi! ${deposit.amount.toLocaleString()} UZS qoshildi.`);
  await bot.telegram.sendMessage(deposit.userId, `🎉 Tabriklaymiz! ${deposit.amount.toLocaleString()} UZS depozitingiz tasdiqlandi!`);
});

bot.action(/^reject_(.+)$/, async (ctx) => {
  if (ctx.from.id !== adminId) return ctx.answerCbQuery('Siz admin emassiz!');
  const deposit = await Deposit.findById(ctx.match[1]);
  if (!deposit || deposit.status !== 'pending') return ctx.answerCbQuery('Allaqachon korib chiqilgan!');

  deposit.status = 'rejected';
  await deposit.save();
  await ctx.editMessageCaption(`❌ Rad etildi.`);
  await bot.telegram.sendMessage(deposit.userId, `❌ Depozit sorovingiz rad etildi.`);
});

// Jonli Oyinlar tugmasi (Faqat aktiv o'yinlar ro'yxati, jonli efir tugmasisiz)
bot.hears('⚽️ Jonli Oyinlar (Live)', async (ctx) => {
  const matches = await Match.find({ status: 'active' });
  if (matches.length === 0) {
    return ctx.reply('Hozirda faol jonli oyinlar mavjud emas.');
  }

  for (const match of matches) {
    const caption = `⚽️ **${match.homeTeam} vs ${match.awayTeam}**\n` +
                    `📅 Sana: ${match.date} | ⏰ Vaqt: ${match.time}\n` +
                    `🆔 ID: \`${match._id}\`\n\n` +
                    `Koefitsiyentlar:\n` +
                    `🏠 1: ${match.oddsHome} | 🤝 X: ${match.oddsDraw} | ✈️ 2: ${match.oddsAway}`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(`${match.homeTeam} (${match.oddsHome})`, `bet_${match._id}_home`),
        Markup.button.callback(`Durang (${match.oddsDraw})`, `bet_${match._id}_draw`),
        Markup.button.callback(`${match.awayTeam} (${match.oddsAway})`, `bet_${match._id}_away`)
      ]
    ]);

    if (match.photo) {
      await ctx.replyWithPhoto(match.photo, { caption, parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(caption, { parse_mode: 'Markdown', ...keyboard });
    }
  }
});

const userStakes = new Map();

bot.action(/^bet_(.+)_([a-z]+)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const choice = ctx.match[2];
  const userId = ctx.from.id;

  const match = await Match.findById(matchId);
  if (!match || match.status !== 'active') return ctx.answerCbQuery('Oyin topilmadi yoki yakunlangan!');

  userStakes.set(userId, { matchId, choice, odds: choice === 'home' ? match.oddsHome : choice === 'away' ? match.oddsAway : match.oddsDraw });

  await ctx.reply(
    `🎯 Tanlandi: **${choice === 'home' ? match.homeTeam : choice === 'away' ? match.awayTeam : 'Durang'}**\n` +
    `Koefitsiyent: **${userStakes.get(userId).odds}**\n\n` +
    `Iltimos, tikmoqchi bolgan summangizni kiriting (1,000 - 16,000,000 UZS):`,
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCbQuery();
});

bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  if (!userStakes.has(userId)) return next();

  const stakeData = userStakes.get(userId);
  const text = ctx.message.text.trim();
  const amount = Number(text.replace(/\s+/g, ''));

  if (isNaN(amount) || amount < 1000 || amount > 16000000) {
    return ctx.reply('❌ Minimal garov: 1,000 UZS, Maksimal: 16,000,000 UZS. Qaytadan kiriting:', { parse_mode: 'Markdown' });
  }

  const user = await User.findOne({ telegramId: userId });
  if (!user || user.balance < amount) {
    userStakes.delete(userId);
    return ctx.reply('❌ Balansingizda yetarli mablag mavjud emas!');
  }

  user.balance -= amount;
  await user.save();

  const bet = new Bet({ userId, matchId: stakeData.matchId, choice: stakeData.choice, amount, odds: stakeData.odds });
  await bet.save();

  userStakes.delete(userId);
  await ctx.reply(`✅ Garovingiz qabul qilindi! Summa: **${amount.toLocaleString()} UZS**`, { parse_mode: 'Markdown' });
});

// ================= 1-BUYRUQ: /newmatch (Yangi o'yin qo'shish va barchaga yuborish) =================
bot.command('newmatch', async (ctx) => {
  if (ctx.from.id !== adminId) return ctx.reply('Sizda bu huquq yoq!');

  const caption = ctx.message.caption || ctx.message.text || '';
  const args = caption.split(' ').slice(1);

  if (args.length < 7) {
    return ctx.reply('❌ Foydalanish: /newmatch HomeTeam AwayTeam OddsHome OddsDraw OddsAway Date Time\n(Masalan: /newmatch Real Barcelona 2.1 3.2 1.9 22.11.2026 18:00 - rasm bilan yuboring)');
  }

  const [homeTeam, awayTeam, oddsHome, oddsDraw, oddsAway, date, time] = args;
  const photo = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : null;

  const match = new Match({
    homeTeam,
    awayTeam,
    oddsHome: Number(oddsHome),
    oddsDraw: Number(oddsDraw),
    oddsAway: Number(oddsAway),
    date,
    time,
    photo,
    status: 'active'
  });
  await match.save();

  await ctx.reply(`✅ Yangi oyin yaratildi va barcha foydalanuvchilarga srazi yuborildi! ID: \`${match._id}\``, { parse_mode: 'Markdown' });

  // Barcha foydalanuvchilarga avtomatik yuborish (Broadcast)
  const users = await User.find({});
  const broadcastText = `⚽️ **Yangi Oyin E'loni!**\n\n` +
                        `🔥 **${homeTeam} vs ${awayTeam}**\n` +
                        `📅 Sana: ${date} | ⏰ Vaqt: ${time}\n` +
                        `🆔 ID: \`${match._id}\`\n\n` +
                        `Koefitsiyentlar:\n` +
                        `🏠 1: ${oddsHome} | 🤝 X: ${oddsDraw} | ✈️ 2: ${oddsAway}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`${homeTeam} (${oddsHome})`, `bet_${match._id}_home`),
      Markup.button.callback(`Durang (${oddsDraw})`, `bet_${match._id}_draw`),
      Markup.button.callback(`${awayTeam} (${oddsAway})`, `bet_${match._id}_away`)
    ]
  ]);

  for (const u of users) {
    try {
      if (photo) {
        await bot.telegram.sendPhoto(u.telegramId, photo, { caption: broadcastText, parse_mode: 'Markdown', ...keyboard });
      } else {
        await bot.telegram.sendMessage(u.telegramId, broadcastText, { parse_mode: 'Markdown', ...keyboard });
      }
    } catch (e) {}
  }
});

// ================= 2-BUYRUQ: /finishmatch (O'yinni yakunlash va g'olibni e'lon qilish) =================
bot.command('finishmatch', async (ctx) => {
  if (ctx.from.id !== adminId) return ctx.reply('Sizda bu huquq yoq!');

  const caption = ctx.message.caption || ctx.message.text || '';
  const args = caption.split(' ').slice(1);

  if (args.length < 3) {
    return ctx.reply('❌ Foydalanish: /finishmatch <matchId> <winner: home/away/draw> <score>\n(Masalan: /finishmatch 65f... home 2:1)');
  }

  const [matchId, winnerChoice, score] = args;
  const finishPhoto = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : null;

  const match = await Match.findById(matchId);
  if (!match || match.status === 'finished') {
    return ctx.reply('❌ Oyin topilmadi yoki allaqachon yakunlangan!');
  }

  match.status = 'finished';
  match.winner = winnerChoice;
  match.score = score;
  await match.save();

  const bets = await Bet.find({ matchId: match._id, status: 'pending' });

  let wonCount = 0;
  let lostCount = 0;

  for (const bet of bets) {
    if (bet.choice === winnerChoice) {
      const winnings = Math.round(bet.amount * bet.odds);
      bet.status = 'won';
      await bet.save();

      await User.updateOne({ telegramId: bet.userId }, { $inc: { balance: winnings } });
      wonCount++;

      await bot.telegram.sendMessage(
        bet.userId,
        `🎉 Tabriklaymiz! Siz tikkan garov yutdi!\n\n` +
        `⚽️ Oyin: **${match.homeTeam} vs ${match.awayTeam}**\n` +
        `📊 Hisob: **${score}**\n` +
        `🏆 G'olib: **${winnerChoice === 'home' ? match.homeTeam : winnerChoice === 'away' ? match.awayTeam : 'Durang'}**\n` +
        `💰 Yutuq: **+${winnings.toLocaleString()} UZS** balansingizga qo'shildi!`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } else {
      bet.status = 'lost';
      await bet.save();
      lostCount++;

      await bot.telegram.sendMessage(
        bet.userId,
        `❌ Afsuski, ${match.homeTeam} vs ${match.awayTeam} oyinidagi garovingiz yutqazdi (Hisob: ${score}). Balansingizga ta'siri: 0 UZS.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  }

  // Barcha foydalanuvchilarga natijani rasm bilan e'lon qilish
  const users = await User.find({});
  const resultText = `🏁 **Oyin yakunlandi! Natija:**\n\n` +
                     `⚽️ **${match.homeTeam} vs ${match.awayTeam}**\n` +
                     `📊 Hisob: **${score}**\n` +
                     `🏆 G'olib: **${winnerChoice.toUpperCase() === 'HOME' ? match.homeTeam : winnerChoice.toUpperCase() === 'AWAY' ? match.awayTeam : 'Durang'}**`;

  for (const u of users) {
    try {
      if (finishPhoto) {
        await bot.telegram.sendPhoto(u.telegramId, finishPhoto, { caption: resultText, parse_mode: 'Markdown' });
      } else {
        await bot.telegram.sendMessage(u.telegramId, resultText, { parse_mode: 'Markdown' });
      }
    } catch (e) {}
  }

  await ctx.reply(`✅ Oyin yakunlandi va natijalar barchaga tarqatildi! Yutganlar: ${wonCount} ta, Yutqazganlar: ${lostCount} ta.`);
});

bot.command('addcoins', async (ctx) => {
  if (ctx.from.id !== adminId) return ctx.reply('Sizda bu huquq yoq!');
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) return ctx.reply('❌ Foydalanish: /addcoins <telegramId> <amount>');

  const targetId = Number(args[0]);
  const amount = Number(args[1]);

  const user = await User.findOneAndUpdate({ telegramId: targetId }, { $inc: { balance: amount } }, { new: true });
  if (!user) return ctx.reply('❌ Foydalanuvchi topilmadi.');

  await ctx.reply(`✅ Foydalanuvchi (${targetId}) balansiga ${amount.toLocaleString()} UZS qoshildi.`);
  await bot.telegram.sendMessage(targetId, `🎁 Admin tomonidan balansingizga **${amount.toLocaleString()} UZS** qoshildi!`, { parse_mode: 'Markdown' });
});
// === MANA SHU YERGA HTTP SERVERNI QO'SHASIZ ===
const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!');
}).listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
// ============================================
bot.launch()
  .then(() => console.log('🤖 EA.BET Bot mukammal ishga tushdi!'))
  .catch(err => console.error('Botni ishga tushirishda xatolik:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
