const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');

// ==========================================
// 🛑 GESTOR DE PAUSAS EN MEMORIA (60 MINUTOS)
// ==========================================
const usuariosPausados = new Map();
const TIEMPO_PAUSA_MS = 60 * 60 * 1000;

const silencedUsers = new Set(); 

const N8N_WEBHOOK_URL = 'https://n8n-production-115e.up.railway.app/webhook/whatsapp';

async function startBot() {
    console.log('--- Iniciando Bot de RRHH (v5 - QR en Navegador) ---');

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🔌 Conectando con WhatsApp Web v${version.join('.')} (Última: ${isLatest})`);

    // 🔴 SALTAMOS A V5 PARA UNA SESIÓN 100% VIRGEN
    const { state, saveCreds } = await useMultiFileAuthState('auth_session_v5');

    const sock = makeWASocket({
        version: version, 
        auth: state,
        logger: pino({ level: 'silent' }), 
        browser: ["Macxito Bot", "Chrome", "1.0.0"],
        printQRInTerminal: false, // Apagamos el dibujo roto de la terminal
        syncFullHistory: false,   
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            // 🌟 MAGIA PURA: CONVERTIMOS EL QR EN UN ENLACE WEB
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log('\n===========================================================================');
            console.log('🔗 HAZ CLIC EN ESTE ENLACE O CÓPIALO EN TU NAVEGADOR PARA VER EL QR:');
            console.log(qrImageUrl);
            console.log('===========================================================================\n');
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
                console.log('🛑 Sesión cerrada (Logged Out). Borra la carpeta de sesión actual.');
            }
        } else if (connection === 'open') {
            console.clear();
            console.log('✅ ✅ ✅ Macxito Bot CONECTADO y LISTO ✅ ✅ ✅');
            console.log('Esperando mensajes en la nube...');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) return; 

        const senderJid = msg.key.remoteJidAlt || msg.key.remoteJid; 
        const pushName = msg.pushName || 'Usuario';
        const incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if(incomingText === "") return; 

        const textToEvaluate = incomingText.trim().toLowerCase();

        if (textToEvaluate === "!pausar") {
            silencedUsers.add(senderJid);
            console.log(`🔇 Bot silenciado manualmente para: ${senderJid}`);
            await sock.sendMessage(senderJid, { text: "✅ Un representante de RRHH ha tomado el chat. El bot está pausado." });
            return; 
        }

        if (textToEvaluate === "!activar") {
            silencedUsers.delete(senderJid);
            console.log(`🔊 Bot reactivado para: ${senderJid}`);
            await sock.sendMessage(senderJid, { text: "🤖 Macxito vuelve a estar operativo en este chat." });
            return; 
        }

        if (silencedUsers.has(senderJid)) {
            console.log(`[Modo Silencioso] Mensaje ignorado de ${pushName}: ${incomingText}`);
            return; 
        }

        console.log(`📩 Mensaje de ${pushName} (${senderJid}): ${incomingText}`);

        try {
            console.log(`➡️  Consultando cerebro (n8n)...`);

            if (usuariosPausados.has(senderJid)) {
                const tiempoInicioPausa = usuariosPausados.get(senderJid);
                const tiempoTranscurrido = Date.now() - tiempoInicioPausa;

                if (tiempoTranscurrido < TIEMPO_PAUSA_MS) {
                    const minutosRestantes = ((TIEMPO_PAUSA_MS - tiempoTranscurrido) / 60000).toFixed(0);
                    console.log(`⏳ [BOT PAUSADO] Ignorando mensaje de ${senderJid}. Restan: ${minutosRestantes} min.`);
                    return; 
                } else {
                    console.log(`✅ [PAUSA TERMINADA] El tiempo expiró. Reactivando bot para ${senderJid}.`);
                    usuariosPausados.delete(senderJid);
                }
            }

            const comandoUsuario = incomingText.trim().toUpperCase();
            if (comandoUsuario === '3' || comandoUsuario === 'B') {
                usuariosPausados.set(senderJid, Date.now());
                console.log(`🛑 [NUEVA PAUSA ACTIVADA] El usuario ${senderJid} se derivó a un humano. Bot silenciado por 60 min.`);
            }
            
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

process.on('uncaughtException', (err) => {
    console.error('⚠️ Error global capturado (uncaughtException):', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Promesa no manejada (unhandledRejection):', reason);
});