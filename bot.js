const https = require('https');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const PORT = process.env.PORT || 3000;

const INSTRUCTIONS = 'Eres el asistente tecnico oficial de INVT Iberica, especializado en variadores de frecuencia para bombeo solar, con amplio conocimiento de electricidad, electronica industrial y automatizacion. Trabajas principalmente con los modelos GD100, BPD y SP100. REGLAS: 1) Si el usuario no ha mencionado el modelo del variador y la pregunta es especifica de parametros o configuracion, pregunta primero cual es su modelo. Si la pregunta es general responde directamente. 2) Una vez conoces el modelo recuerdalo para toda la conversacion. 3) Los codigos de error pueden escribirse con o sin guion: ALS es A-LS, OC1, OV1, PVOV, etc. 4) Puedes responder sobre electricidad, cableado, bombas, motores, sensores, paneles solares, presostatos y automatizacion. 5) NUNCA menciones marcas competidoras de variadores. 6) Solo deriva a tecnico si hay riesgo electrico grave o dano fisico. 7) Responde en espanol con pasos numerados y parametros concretos.';

const userSessions = {};
let offset = 0;

// Servidor HTTP para Railway
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => console.log('Puerto ' + PORT + ' activo'));

function tgGet(method, params) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams(params || {}).toString();
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}${qs ? '?' + qs : ''}`;
    https.get(url, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
    }).on('error', () => resolve({}));
  });
}

function tgPost(method, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text) {
  return tgPost('sendMessage', { chat_id: chatId, text: text });
}

function sendTyping(chatId) {
  return tgPost('sendChatAction', { chat_id: chatId, action: 'typing' });
}

async function askOpenAI(chatId, userMessage) {
  const body = {
    model: 'gpt-4o-mini',
    input: userMessage,
    instructions: INSTRUCTIONS,
    tools: [{ type: 'file_search', vector_store_ids: [VECTOR_STORE_ID] }]
  };
  if (userSessions[chatId]) body.previous_response_id = userSessions[chatId];

  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/responses', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.id) userSessions[chatId] = data.id;
          if (data.error) {
            if (data.error.message && data.error.message.includes('context')) {
              delete userSessions[chatId];
              return resolve('Conversacion reiniciada por ser muy larga. Repite tu pregunta.');
            }
            return resolve('Error: ' + data.error.message);
          }
          const msg = data.output && data.output.find(o => o.type === 'message');
          resolve(msg && msg.content && msg.content[0] ? msg.content[0].text : 'Sin respuesta.');
        } catch(e) { resolve('Error procesando respuesta.'); }
      });
    });
    req.on('error', () => resolve('Error de conexion con OpenAI.'));
    req.write(bodyStr);
    req.end();
  });
}

async function poll() {
  console.log('Bot INVT iniciado');
  while (true) {
    try {
      const data = await tgGet('getUpdates', { offset, timeout: 20 });
      if (data.result && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg || !msg.text) continue;
          const chatId = msg.chat.id;
          const text = msg.text.trim();
          console.log('Mensaje recibido de ' + chatId + ': ' + text.substring(0, 50));

          if (text === '/start') {
            delete userSessions[chatId];
            await sendMessage(chatId, 'Hola! Soy el asistente tecnico de INVT Iberica. Puedo ayudarte con GD100, BPD y SP100. Escribe /nuevo para reiniciar la conversacion.');
            continue;
          }
          if (text === '/nuevo') {
            delete userSessions[chatId];
            await sendMessage(chatId, 'Conversacion reiniciada. Cual es tu consulta?');
            continue;
          }

          await sendTyping(chatId);
          const reply = await askOpenAI(chatId, text);
          await sendMessage(chatId, reply);
          console.log('Respuesta enviada a ' + chatId);
        }
      }
    } catch(e) {
      console.error('Error poll: ' + e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

poll();
