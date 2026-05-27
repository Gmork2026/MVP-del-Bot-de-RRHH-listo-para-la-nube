const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const axios = require('axios');

// ==========================================
// 🛑 GESTOR DE PAUSAS EN MEMORIA (60 MINUTOS)
// ==========================================
const usuariosPausados = new Map();
const TIEMPO_PAUSA_MS = 60 * 60 * 1000; // 60 minutos exactos en milisegundos

const silencedUsers = new Set(); // Memoria temporal para el Modo Silencioso
const mensajesDelBot = new Set();

const N8N_WEBHOOK_URL = 'https://n8n-production-115e.up.railway.app/webhook/whatsapp';

async function startBot() {
    console.log('--- Iniciando Bot de RRHH (v2) ---');

    // 1. OBTENER LA ÚLTIMA VERSIÓN DE WHATSAPP (ESTO EVITA EL ERROR 405)
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🔌 Conectando con WhatsApp Web v${version.join('.')} (Última: ${isLatest})`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_session_v4');

    const sock = makeWASocket({
        version: version, 
        auth: state,
        logger: pino({ level: 'silent' }), 
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        printQRInTerminal: false, // 🔴 APAGAMOS EL QR
        syncFullHistory: false,   // 🟢 Hacemos que cargue más rápido
        generateHighQualityLinkPreview: true
    });

    // ========================================================
    // 🔑 MAGIA DE VINCULACIÓN EN LA NUBE (CÓDIGO DE 8 DÍGITOS)
    // ========================================================
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            // ⚠️ REEMPLAZA ESTE NÚMERO POR EL DEL BOT (Ej: 5491123456789)
            let numeroBot = "5491121895719"; 
            
            try {
                let code = await sock.requestPairingCode(numeroBot);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`\n========================================`);
                console.log(`🔑 TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
                console.log(`========================================\n`);
            } catch (error) {
                console.log("Error pidiendo código de vinculación: ", error.message);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        /*if (qr) {
            console.clear();
            console.log('🔽 ESCANEA ESTE QR CON TU WHATSAPP (MODO MULTIDISPOSITIVO) 🔽');
            qrcode.generate(qr, { small: true });
        }*/

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || 'Motivo desconocido';
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`\n❌ Conexión cerrada. Error: ${errorMsg} (Código: ${statusCode})`);

            if (shouldReconnect) {
                console.log('⏳ Reconectando en 5 segundos...');
                setTimeout(startBot, 5000); 
            } else {
                console.log('🛑 Sesión cerrada (Logged Out). Debes borrar la carpeta auth_session_v4 y volver a escanear el QR.');
            }
        } else if (connection === 'open') {
            console.clear();
            console.log('✅ ✅ ✅ Macxito Bot CONECTADO y LISTO ✅ ✅ ✅');
            console.log('Esperando mensajes...');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        
        // 1. Filtros iniciales de seguridad
        if (!msg.message || msg.key.remoteJid.includes('@g.us')) return; 

        const senderJid = msg.key.remoteJidAlt || msg.key.remoteJid; 
        const pushName = msg.pushName || 'Usuario';
        const incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // 2. REGLA: AUTO-SILENCIO POR INTERVENCIÓN HUMANA
        if (msg.key.fromMe) {
            if (mensajesDelBot.has(msg.key.id)) return; // Ignora el eco del bot
            
            usuariosPausados.set(senderJid, Date.now());
            console.log(`👤 [ASESOR AL MANDO] Registrando respuesta humana para ${senderJid}`);
            
            if (incomingText !== "") {
                // Envío de registro silencioso (Lo que escribe RRHH)
                axios.post(N8N_WEBHOOK_URL, {
                    sender: senderJid, message: incomingText, name: pushName,
                    silentLogOnly: true, clasificacion: "Respuesta de RRHH", atendidoPor: "Humano"
                }).catch(()=>{}); 
            }
            return; 
        }

        if(incomingText === "") return; 

        // 3. COMANDOS MANUALES (Modo silencioso)
        const textToEvaluate = incomingText.trim().toLowerCase();
        if (textToEvaluate === "!pausar") {
            silencedUsers.add(senderJid);
            await sock.sendMessage(senderJid, { text: "✅ Un representante de RRHH ha tomado el chat. Bot pausado." });
            return;
        }
        if (textToEvaluate === "!activar") {
            silencedUsers.delete(senderJid);
            await sock.sendMessage(senderJid, { text: "🤖 Macxito reactivado." });
            return;
        }
        if (silencedUsers.has(senderJid)) return;

        // 4. VERIFICACIÓN DE PAUSA AUTOMÁTICA
        if (usuariosPausados.has(senderJid)) {
            const tiempoInicioPausa = usuariosPausados.get(senderJid);
            if (Date.now() - tiempoInicioPausa < TIEMPO_PAUSA_MS) {
                console.log(`⏳ [EN PROCESO] Registrando mensaje de ${senderJid} en modo silencioso.`);
                
                // Envío de registro silencioso (Lo que escribe el postulante/empleado)
                axios.post(N8N_WEBHOOK_URL, {
                    sender: senderJid, message: incomingText, name: pushName,
                    silentLogOnly: true, clasificacion: "Mensaje (En Proceso)", atendidoPor: "Humano"
                }).catch(()=>{});
                
                return; 
            } else {
                usuariosPausados.delete(senderJid);
            }
        }

        // 5. PROCESAMIENTO Y ENVÍO NORMAL A N8N
        console.log(`📩 Mensaje de ${pushName} (${senderJid}): ${incomingText}`);

        try {
            const n8nResponse = await axios.post(N8N_WEBHOOK_URL, {
                sender: senderJid,
                message: incomingText.trim(), 
                name: pushName,
                silentLogOnly: false, // 🟢 Etiqueta normal
                clasificacion: "Mensaje Entrante",
                atendidoPor: "Bot"
            }, { timeout: 10000 }); 

            if (n8nResponse.data && n8nResponse.data.reply) {
                const replyText = n8nResponse.data.reply;
                
                const sentMsg = await sock.sendMessage(senderJid, { text: replyText });
                if (sentMsg?.key?.id) {
                    mensajesDelBot.add(sentMsg.key.id);
                    setTimeout(() => mensajesDelBot.delete(sentMsg.key.id), 60000); 
                }
                
                if (n8nResponse.data.pausar === true) {
                    usuariosPausados.set(senderJid, Date.now());
                    console.log(`🛑 [PAUSA ACTIVADA POR N8N] para ${senderJid}`);
                }
            }
        } catch (error) {
            console.error('❌ Error comunicando con n8n:', error.message);
        }
    });
}

startBot().catch(err => console.error("Error crítico al arrancar:", err));

// ==========================================
// 🛡️ ESCUDO ANTI-CAÍDAS (ERRORES GLOBALES)
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('⚠️ Error global capturado (uncaughtException):', err.message);
    // No apagamos el bot, dejamos que Baileys se reconecte solo
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Promesa no manejada (unhandledRejection):', reason);
});