const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

const INSTRUCTIONS = 'Eres el asistente tecnico oficial de INVT Iberica, especializado en variadores de frecuencia para bombeo solar, con amplio conocimiento de electricidad, electronica industrial y automatizacion. Trabajas principalmente con los modelos GD100, BPD y SP100. REGLAS: 1) Si el usuario no ha mencionado el modelo del variador y la pregunta es especifica de parametros o configuracion, pregunta primero: cual es tu modelo, GD100, BPD o SP100? Pero si la pregunta es general (electricidad, bombas, sensores, cableado, conceptos tecnicos), responde directamente sin preguntar el modelo. 2) Una vez conoces el modelo, recuerdalo para toda la conversacion. 3) Para preguntas de parametros, usa los documentos y da valores exactos. Para preguntas generales, usa tu conocimiento tecnico amplio. 4) Los codigos de error pueden escribirse con o sin guion: ALS es A-LS, OC1, OV1, PVOV, etc. 5) Puedes responder preguntas sobre electricidad, cableado, bombas, motores, sensores, paneles solares, presostatos, transductores, automatizacion y cualquier tema tecnico relacionado con instalaciones de bombeo. 6) NUNCA menciones ni recomiendes marcas competidoras de variadores (Siemens, ABB, Schneider, Danfoss, WEG, etc.). 7) Solo deriva a tecnico humano si hay riesgo electrico grave, dano fisico evidente, o si el problema requiere mediciones en campo. 8) Responde siempre en espanol, de forma clara, con pasos numerados cuando sea util y con parametros concretos cuando los conozcas.';

// Memoria por usuario: { chatId: lastResponseId }
const userSessions = {};

let offset = 0;

function apiRequest(url, method, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const options = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    };
    const req = https.request(url, options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  return apiRequest(url, 'POST', {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  });
}

function sendTyping(chatId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`;
  return apiRequest(url, 'POST', { chat_id: chatId, action: 'typing' });
}

async function askOpenAI(chatId, userMessage) {
  const lastResponseId = userSessions[chatId] || null;

  const body = {
    model: 'gpt-4o-mini',
    input: userMessage,
    instructions: INSTRUCTIONS,
    tools: [{ type: 'file_search', vector_store_ids: [VECTOR_STORE_ID] }],
    include: ['file_search_call.results']
  };

  if (lastResponseId) {
    body.previous_response_id = lastResponseId;
  }

  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.id) userSessions[chatId] = data.id;
          let reply = 'No pude obtener respuesta. Intentalo de nuevo.';
          if (data.output) {
            const msgBlock = data.output.find(o => o.type === 'message');
            if (msgBlock && msgBlock.content && msgBlock.content.length > 0) {
              reply = msgBlock.content[0].text || reply;
            }
          }
          if (data.error) reply = 'Error OpenAI: ' + data.error.message;
          resolve(reply);
        } catch(e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getUpdates() {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
  try {
    const data = await apiRequest(url);
    if (!data.result) return;

    for (const update of data.result) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = msg.chat.id;
      const text = msg.text.trim();

      if (text === '/start') {
        delete userSessions[chatId];
        await sendMessage(chatId,
          '👋 Hola! Soy el asistente técnico de *INVT Ibérica*.\n\n' +
          'Puedo ayudarte con los variadores *GD100*, *BPD* y *SP100*.\n\n' +
          'Dime tu modelo y cuéntame tu consulta. Si quieres reiniciar la conversación escribe /nuevo'
        );
        continue;
      }

      if (text === '/nuevo') {
        delete userSessions[chatId];
        await sendMessage(chatId, '🔄 Conversación reiniciada. Cuéntame tu nueva consulta.');
        continue;
      }

      await sendTyping(chatId);

      try {
        const reply = await askOpenAI(chatId, text);
        await sendMessage(chatId, reply);
      } catch(e) {
        console.error('Error OpenAI:', e);
        await sendMessage(chatId, 'Ha ocurrido un error. Intentalo de nuevo en unos segundos.');
      }
    }
  } catch(e) {
    console.error('Error getUpdates:', e);
  }
}

async function poll() {
  console.log('Bot INVT Iberica iniciado...');
  while (true) {
    await getUpdates();
  }
}

poll();
