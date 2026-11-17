async function validateTelegramData(initData, botToken) {
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    if (!hash) return false;
    urlParams.delete('hash');
    const dataCheckString = [...urlParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(dataCheckString));
    const hashHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hash === hashHex;
  } catch (e) { return false; }
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Установка вебхука
    if (url.pathname === '/api/setup-webhook') {
      const webhookUrl = `https://${url.host}/api/webhook`;
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      return new Response(JSON.stringify(await res.json()), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Лидерборд
    if (url.pathname === '/api/leaderboard') {
      try {
        const list = await env.FOREST_DB.list({ prefix: 'user_' });
        let users = [];
        for (let key of list.keys) {
          let bal = await env.FOREST_DB.get(key.name);
          let name = await env.FOREST_DB.get(`name_${key.name.replace('user_', '')}`);
          if (bal) users.push({ id: key.name.replace('user_', ''), balance: parseInt(bal), name: name || 'Игрок' });
        }
        users.sort((a, b) => b.balance - a.balance);
        return new Response(JSON.stringify(users.slice(0, 10)), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch(e) { return new Response('[]', { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
    }

    // Баланс
    if (url.pathname === '/api/balance' && request.method === 'POST') {
      try {
        const { initData, startParam } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403, headers: corsHeaders });
        const userObj = JSON.parse(new URLSearchParams(initData).get('user'));
        const userId = userObj.id;
        
        if (userObj.first_name) await env.FOREST_DB.put(`name_${userId}`, userObj.first_name);

        let balance = await env.FOREST_DB.get(`user_${userId}`);
        
        if (balance === null) {
          balance = 1000;
          await env.FOREST_DB.put(`user_${userId}`, balance.toString());
          
          if (startParam && startParam.startsWith('ref_')) {
            const referrerId = startParam.replace('ref_', '');
            if (referrerId !== userId.toString()) {
              let refBal = parseInt(await env.FOREST_DB.get(`user_${referrerId}`) || '0');
              await env.FOREST_DB.put(`user_${referrerId}`, (refBal + 5000).toString());
            }
          }
        }
        
        let jackpot = await env.FOREST_DB.get('global_jackpot');
        if (jackpot === null) { jackpot = 500000; await env.FOREST_DB.put('global_jackpot', jackpot.toString()); }

        return new Response(JSON.stringify({ 
          balance: parseInt(balance), 
          jackpot: parseInt(jackpot)
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders }); }
    }

    // Спин
    if (url.pathname === '/api/spin' && request.method === 'POST') {
      try {
        let { initData, newBalance, betAmount } = await request.json(); // ИСПОЛЬЗУЕМ let
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403, headers: corsHeaders });
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;
        
        let jackpot = parseInt(await env.FOREST_DB.get('global_jackpot') || '500000');
        if (betAmount > 0) jackpot += Math.floor(betAmount * 0.02); 
        
        let jackpotWon = false;
        let winAmount = 0;
        if (Math.random() < 0.001) { 
          jackpotWon = true;
          winAmount = jackpot;
          newBalance += jackpot;
          jackpot = 500000; 
        }
        
        await env.FOREST_DB.put(`user_${userId}`, newBalance.toString());
        await env.FOREST_DB.put('global_jackpot', jackpot.toString());

        return new Response(JSON.stringify({ ok: true, jackpot, jackpotWon, winAmount, newBalance }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders }); }
    }

    // Ежедневный бонус
    if (url.pathname === '/api/daily-bonus' && request.method === 'POST') {
      try {
        const { initData } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403, headers: corsHeaders });
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;
        
        const lastClaim = parseInt(await env.FOREST_DB.get(`daily_${userId}`) || '0');
        const now = Date.now();
        if (now - lastClaim < 24 * 60 * 60 * 1000) {
           return new Response(JSON.stringify({ ok: false, error: 'Ждите 24 часа' }), { status: 400, headers: corsHeaders });
        }

        let balance = parseInt(await env.FOREST_DB.get(`user_${userId}`) || '0');
        balance += 100;
        
        await env.FOREST_DB.put(`user_${userId}`, balance.toString());
        await env.FOREST_DB.put(`daily_${userId}`, now.toString());

        return new Response(JSON.stringify({ ok: true, balance }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders }); }
    }

    // Инвойс для Stars
    if (url.pathname === '/api/invoice' && request.method === 'POST') {
      try {
        const { initData, packageId } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403, headers: corsHeaders });
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;
        
        const ALLOWED = { p100: { s: 100, c: 1000 }, p500: { s: 500, c: 6000 }, p2000: { s: 2000, c: 30000 }, p10000: { s: 10000, c: 200000 } };
        const pkg = ALLOWED[packageId];
        if (!pkg) return new Response('Invalid', { status: 400, headers: corsHeaders });
        
        const tgResponse = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createInvoiceLink`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: `${pkg.c} монет`, description: 'Пакет монет Forest Fortune', payload: JSON.stringify({ userId, coins: pkg.c }), currency: 'XTR', prices: [{ label: 'Монеты', amount: pkg.s }] })
        });
        const data = await tgResponse.json();
        return new Response(JSON.stringify({ invoiceLink: data.result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders }); }
    }

    // ВЕБХУК БОТА
    if (url.pathname === '/api/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();

        if (update.message && update.message.text && update.message.text.startsWith('/start')) {
          const chatId = update.message.chat.id;
          const gameUrl = `https://i-field.github.io/forest-fortune/`; 
          const replyMarkup = { inline_keyboard: [[{ text: "🦔 Открыть Forest Fortune", web_app: { url: gameUrl } }]] };

          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: "🌿 **Добро пожаловать в Forest Fortune!**\n\nЖми кнопку ниже и испытай удачу!", parse_mode: 'Markdown', reply_markup: replyMarkup })
          });
        }

        if (update.pre_checkout_query) {
          const pq = update.pre_checkout_query;
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerPreCheckoutQuery`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pre_checkout_query_id: pq.id, ok: true })
          });
        }

        if (update.message?.successful_payment) {
          const payload = JSON.parse(update.message.successful_payment.invoice_payload);
          let balance = parseInt(await env.FOREST_DB.get(`user_${payload.userId}`) || '0');
          await env.FOREST_DB.put(`user_${payload.userId}`, (balance + payload.coins).toString());
        }
        
        return new Response('ok', { headers: corsHeaders });
      } catch(e) { return new Response('ok', { headers: corsHeaders }); }
    }

    return env.ASSETS.fetch(request);
  }
};
