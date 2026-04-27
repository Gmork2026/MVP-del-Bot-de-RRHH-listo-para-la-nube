const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const axios = require('axios');

const N8N_WEBHOOK_URL = 'http://localhost:5678/webhook/whatsapp';

async function startBot() {
    console.log('--- Iniciando Bot de RRHH (v2) ---');

    // 1. OBTENER LA ÚLTIMA VERSIÓN DE WHATSAPP (ESTO EVITA EL ERROR 405)
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🔌 Conectando con WhatsApp Web v${version.join('.')} (Última: ${isLatest})`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_session_v2');

    const sock = makeWASocket({
        version: version, // <-- AQUÍ PASAMOS LA VERSIÓN
        auth: state,
        logger: pino({ level: 'silent' }), 
        browser: ["Macxito Bot", "Chrome", "1.0.0"],
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log('🔽 ESCANEA ESTE QR CON TU WHATSAPP (MODO MULTIDISPOSITIVO) 🔽');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || 'Motivo desconocido';
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`\n❌ Conexión cerrada. Error: ${errorMsg} (Código: ${statusCode})`);

            if (shouldReconnect) {
                console.log('⏳ Reconectando en 5 segundos...');
                setTimeout(startBot, 5000); 
            } else {
                console.log('🛑 Sesión cerrada (Logged Out). Debes borrar la carpeta auth_session_v2 y volver a escanear el QR.');
            }
        } else if (connection === 'open') {
            console.clear();
            console.log('✅ ✅ ✅ Macxito Bot CONECTADO y LISTO ✅ ✅ ✅');
            console.log('Esperando mensajes...');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) return; 

        const senderJid = msg.key.remoteJid; 
        const pushName = msg.pushName || 'Usuario';
        const incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if(incomingText === "") return; 

        console.log(`📩 Mensaje de ${pushName} (${senderJid}): ${incomingText}`);

        try {
            console.log(`➡️  Consultando cerebro (n8n)...`);
            
            const n8nResponse = await axios.post(N8N_WEBHOOK_URL, {
                sender: senderJid,
                message: incomingText.trim(), 
                name: pushName
            }, { timeout: 10000 }); 

            if (n8nResponse.data && n8nResponse.data.reply) {
                const replyText = n8nResponse.data.reply;
                console.log(`⬅️  n8n respondió: [${replyText.substring(0, 20)}...]`);
                
                await sock.sendMessage(senderJid, { text: replyText });
                console.log('✅ Mensaje enviado al usuario.');
            } else {
                console.error('❌ n8n respondió, pero no incluyó el campo "reply" en el JSON.');
            }
            
        } catch (error) {
            console.error('❌ Error comunicando con n8n:', error.message);
        }
    });
}

startBot().catch(err => console.error("Error crítico al arrancar:", err));