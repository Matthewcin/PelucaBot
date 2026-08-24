import 'dotenv/config';
import makeWASocket, { DisconnectReason, initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { GoogleGenAI } from '@google/genai';
import pg from 'pg';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import http from 'http';
import cron from 'node-cron';

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const userSessions = new Map();
let globalSock = null;

async function usePostgresAuthState(dbPool) {
    await dbPool.query(`CREATE TABLE IF NOT EXISTS auth_state (id VARCHAR(255) PRIMARY KEY, data TEXT NOT NULL)`);

    const readData = async (id) => {
        const res = await dbPool.query('SELECT data FROM auth_state WHERE id = $1', [id]);
        if (res.rowCount > 0) {
            return JSON.parse(res.rows[0].data, BufferJSON.reviver);
        }
        return null;
    };

    const writeData = async (id, data) => {
        const str = JSON.stringify(data, BufferJSON.replacer);
        await dbPool.query(
            'INSERT INTO auth_state (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
            [id, str]
        );
    };

    const removeData = async (id) => {
        await dbPool.query('DELETE FROM auth_state WHERE id = $1', [id]);
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(key, value));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    };
}

async function initUser(phone) {
    await pool.query(
        `INSERT INTO users (phone_number) VALUES ($1) ON CONFLICT (phone_number) DO NOTHING`,
        [phone]
    );
}

async function getFinancialState(phone) {
    await initUser(phone);
    const userRes = await pool.query(`SELECT available_balance, emergency_fund_pct FROM users WHERE phone_number = $1`, [phone]);
    const debtsRes = await pool.query(
        `SELECT id, name, total_amount, monthly_installment, interest_rate, due_date FROM debts WHERE phone_number = $1 AND is_paid = FALSE ORDER BY interest_rate DESC`,
        [phone]
    );
    const expensesRes = await pool.query(
        `SELECT id, name, amount, due_date FROM expenses WHERE phone_number = $1 AND is_paid = FALSE`,
        [phone]
    );
    const subsRes = await pool.query(
        `SELECT id, name, amount, due_day FROM subscriptions WHERE phone_number = $1`,
        [phone]
    );
    const goalsRes = await pool.query(
        `SELECT id, name, target_amount, saved_amount FROM goals WHERE phone_number = $1`,
        [phone]
    );

    const balance = parseFloat(userRes.rows[0]?.available_balance) || 0;
    const emergencyFundPct = parseFloat(userRes.rows[0]?.emergency_fund_pct) || 10;
    
    const totalDebts = debtsRes.rows.reduce((acc, d) => acc + parseFloat(d.total_amount), 0);
    const monthlyDebtPayments = debtsRes.rows.reduce((acc, d) => acc + parseFloat(d.monthly_installment), 0);
    const totalExpenses = expensesRes.rows.reduce((acc, e) => acc + parseFloat(e.amount), 0);
    const totalSubs = subsRes.rows.reduce((acc, s) => acc + parseFloat(s.amount), 0);
    
    const totalObligations = monthlyDebtPayments + totalExpenses + totalSubs;
    const emergencyReserve = balance * (emergencyFundPct / 100);
    const realSurplus = balance - totalObligations - emergencyReserve;

    return {
        balance,
        debts: debtsRes.rows,
        expenses: expensesRes.rows,
        subscriptions: subsRes.rows,
        goals: goalsRes.rows,
        totalDebts,
        monthlyDebtPayments,
        totalExpenses,
        totalSubs,
        totalObligations,
        emergencyReserve,
        realSurplus
    };
}

function getMainMenu() {
    return `*ORGANIZADOR DE DINERO* 🦁📊\n\n` +
           `Elegí una opción enviando el número:\n\n` +
           `1️⃣ *Anotar cuánta plata tengo ahora*\n` +
           `2️⃣ *Anotar una deuda (con fecha límite)*\n` +
           `3️⃣ *Anotar un gasto fijo (luz, agua, etc.)*\n` +
           `4️⃣ *Anotar una suscripción (Netflix, Spotify)*\n` +
           `5️⃣ *Anotar un sueño o meta (viaje, regalo)*\n` +
           `6️⃣ *Marcar algo que ya pagué*\n` +
           `7️⃣ *Ver resumen de mis cuentas*\n` +
           `8️⃣ *Pedir un consejo económico*\n` +
           `9️⃣ *🆘 Me siento estresada con la plata*\n\n` +
           `_Enviá 0 para volver a este menú._`;
}

async function askMileiAI(userQuery, state) {
    const systemInstruction = `
Sos Javier Milei actuando como asesor financiero.
Tu alumna/cliente es una chica colombiana que quiere ordenar su dinero.

Reglas de respuesta:
1. Usá modismos de Javier Milei, pero EXPLICA TODO DE FORMA MUY SIMPLE y humana.
2. Si la 'Plata libre' es menor a 0: RECHAZÁ el gasto. Decile cuánta plata falta en su liquidez mensual.
3. Si la 'Plata libre' es positiva, dale permiso. Si tiene metas en sus DATOS REALES, decile que esa plata libre la acerca a sus sueños.
4. Sé breve, divertido y directo.
`;

    const promptContext = `
DATOS REALES ACTUALES:
- Plata total disponible: $${state.balance}
- Deuda total acumulada a largo plazo: $${state.totalDebts}
- Cuotas de deudas de este mes: $${state.monthlyDebtPayments} (Detalle: ${JSON.stringify(state.debts)})
- Gastos fijos del mes: $${state.totalExpenses}
- Metas de felicidad: ${JSON.stringify(state.goals)}
- Total de plata comprometida este mes: $${state.totalObligations}
- Plata guardada para urgencias: $${state.emergencyReserve}
- PLATA LIBRE PARA GASTAR ESTE MES (Flujo de Caja): $${state.realSurplus}

CONSULTA: "${userQuery}"
`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: promptContext,
        config: { systemInstruction }
    });

    return response.text;
}

async function askEmpatheticAI() {
    const systemInstruction = `
Sos un asistente súper dulce, empático y contenedor. 
La usuaria es una chica colombiana que se siente estresada por el dinero. 
Tu objetivo es calmarla. Recuérdale que los números se arreglan de a poco, que está dando grandes pasos al organizarse, y que su novio la ama profundamente y armó esto para cuidarla. 
Sé muy tierno, breve y dale paz mental. No actúes como Javier Milei.
`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: "Tengo mucha ansiedad por las deudas y la plata, me siento mal.",
        config: { systemInstruction }
    });

    return response.text;
}

async function sendAiWithLoading(sock, jid, userQuery, state) {
    const frames = [
        '🦁 *Revisando tus números...*',
        '🦁 *Calculando cuánta plata libre queda...*',
        '🦁 *Revisando las deudas...*',
        '🦁 *Preparando el consejo...*',
        '🦁 *Respuesta lista...*'
    ];

    const initialMsg = await sock.sendMessage(jid, { text: frames[0] });
    let currentFrame = 1;

    const interval = setInterval(async () => {
        if (currentFrame < frames.length) {
            await sock.sendMessage(jid, {
                text: frames[currentFrame],
                edit: initialMsg.key
            });
            currentFrame++;
        }
    }, 600);

    try {
        const advice = await askMileiAI(userQuery, state);
        clearInterval(interval);
        await sock.sendMessage(jid, {
            text: `${advice}\n\n${getMainMenu()}`,
            edit: initialMsg.key
        });
    } catch (err) {
        clearInterval(interval);
        await sock.sendMessage(jid, {
            text: '❌ Ocurrió un error leyendo los datos.',
            edit: initialMsg.key
        });
    }
}

async function sendPanicAiWithLoading(sock, jid) {
    const frames = [
        '❤️ *Leyendo tu mensaje...*',
        '❤️ *Buscando las palabras correctas...*',
        '❤️ *Enviando un abrazo virtual...*'
    ];

    const initialMsg = await sock.sendMessage(jid, { text: frames[0] });
    let currentFrame = 1;

    const interval = setInterval(async () => {
        if (currentFrame < frames.length) {
            await sock.sendMessage(jid, {
                text: frames[currentFrame],
                edit: initialMsg.key
            });
            currentFrame++;
        }
    }, 600);

    try {
        const advice = await askEmpatheticAI();
        clearInterval(interval);
        await sock.sendMessage(jid, {
            text: `${advice}\n\n${getMainMenu()}`,
            edit: initialMsg.key
        });
    } catch (err) {
        clearInterval(interval);
    }
}

async function sendPositiveFeedback(sock, jid, captionText) {
    try {
        if (process.env.SUCCESS_GIF_URL) {
            await sock.sendMessage(jid, {
                video: { url: process.env.SUCCESS_GIF_URL },
                gifPlayback: true,
                caption: captionText
            });
        } else {
            await sock.sendMessage(jid, { text: captionText });
        }
    } catch (error) {
        await sock.sendMessage(jid, { text: captionText });
    }
}

cron.schedule('0 10 * * *', async () => {
    if (!globalSock) return;
    try {
        const today = new Date().toISOString().split('T')[0];
        const usersRes = await pool.query(`SELECT DISTINCT phone_number FROM users`);

        for (const u of usersRes.rows) {
            const phone = u.phone_number;
            const jid = `${phone}@s.whatsapp.net`;

            const debtsDue = await pool.query(
                `SELECT id, name, monthly_installment FROM debts WHERE phone_number = $1 AND is_paid = FALSE AND due_date = $2`,
                [phone, today]
            );

            for (const d of debtsDue.rows) {
                await globalSock.sendMessage(jid, { 
                    text: `🚨 ¡HOY VENCE UNA DEUDA! 🦁\nTenés que pagar la cuota de *${d.name}* por *$${d.monthly_installment}*.` 
                });
            }

            const expDue = await pool.query(
                `SELECT id, name, amount FROM expenses WHERE phone_number = $1 AND is_paid = FALSE AND due_date = $2`,
                [phone, today]
            );

            for (const e of expDue.rows) {
                await globalSock.sendMessage(jid, { 
                    text: `⚠️ ¡ATENCIÓN! Hoy vence el pago de *${e.name}* por *$${e.amount}*.` 
                });
            }
        }
    } catch (error) {}
});

cron.schedule('0 22 * * *', async () => {
    if (!globalSock) return;
    try {
        const usersRes = await pool.query(`SELECT DISTINCT phone_number FROM users`);
        for (const u of usersRes.rows) {
            const phone = u.phone_number;
            const jid = `${phone}@s.whatsapp.net`;
            await globalSock.sendMessage(jid, { 
                text: `🌙 ¡Buenas noches!\n\nDescansá tranquila, los números están guardados y bajo control. Mañana es un nuevo día para seguir avanzando hacia tus metas y sueños. ¡Tu paz mental vale más que cualquier número! ✨` 
            });
        }
    } catch (error) {}
});

async function startBot() {
    const { state, saveCreds } = await usePostgresAuthState(pool);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    globalSock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        if (msg.key.remoteJid.includes('@g.us')) return;

        const sender = msg.key.remoteJid;
        const phone = sender.replace('@s.whatsapp.net', '');
        
        if (phone !== process.env.ALLOWED_PHONE) return;

        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        if (!text) return;

        const session = userSessions.get(phone) || { step: 'IDLE' };

        try {
            if (text === '0' || text.toLowerCase() === 'menu') {
                userSessions.set(phone, { step: 'IDLE' });
                await sock.sendMessage(sender, { text: getMainMenu() });
                return;
            }

            if (session.step === 'IDLE') {
                switch (text) {
                    case '1':
                        userSessions.set(phone, { step: 'WAITING_BALANCE' });
                        await sock.sendMessage(sender, { text: '💵 Escribí cuánta plata tenés disponible ahora:' });
                        return;

                    case '2':
                        userSessions.set(phone, { step: 'WAITING_DEBT' });
                        await sock.sendMessage(sender, { text: '📝 Escribí tu deuda así:\n[Nombre] [Deuda Total] [Cuota que pagás por mes] [Interés %] [AAAA-MM-DD]\nEjemplo: `Tarjeta 1500000 50000 12 2026-03-10`' });
                        return;

                    case '3':
                        userSessions.set(phone, { step: 'WAITING_EXPENSE' });
                        await sock.sendMessage(sender, { text: '💡 Escribí tu gasto fijo así:\n[Nombre] [Plata] [AAAA-MM-DD]\nEjemplo: `Luz 45000 2026-03-15`' });
                        return;

                    case '4':
                        userSessions.set(phone, { step: 'WAITING_SUB' });
                        await sock.sendMessage(sender, { text: '🔄 Escribí tu suscripción así:\n[Nombre] [Plata] [Día del mes]\nEjemplo: `Netflix 25000 15`' });
                        return;

                    case '5':
                        userSessions.set(phone, { step: 'WAITING_GOAL' });
                        await sock.sendMessage(sender, { text: '🌟 Escribí tu meta así:\n[Nombre del sueño] [Plata necesaria]\nEjemplo: `Viaje a la playa 150000`' });
                        return;

                    case '6':
                        const st = await getFinancialState(phone);
                        let list = '*SELECCIONÁ QUÉ PAGASTE*\n\n';
                        let idx = 1;
                        const pendingItems = [];

                        st.debts.forEach(d => {
                            list += `${idx}. [Deuda] ${d.name} - Cuota de $${d.monthly_installment}\n`;
                            pendingItems.push({ type: 'debt', id: d.id, name: d.name });
                            idx++;
                        });
                        st.expenses.forEach(e => {
                            list += `${idx}. [Servicio] ${e.name} - $${e.amount}\n`;
                            pendingItems.push({ type: 'expense', id: e.id, name: e.name });
                            idx++;
                        });

                        if (pendingItems.length === 0) {
                            await sock.sendMessage(sender, { text: '¡No tenés pagos pendientes anotados!' });
                            return;
                        }

                        userSessions.set(phone, { step: 'WAITING_PAY_SELECTION', items: pendingItems });
                        await sock.sendMessage(sender, { text: `${list}\nRespondé con el número de lo que ya pagaste.` });
                        return;

                    case '7':
                        const data = await getFinancialState(phone);
                        let goalsText = '';
                        data.goals.forEach(g => {
                            goalsText += `✨ ${g.name}: $${g.target_amount}\n`;
                        });

                        const statusMsg = `📊 *RESUMEN DE TUS CUENTAS*\n\n` +
                                          `💰 Plata en mano: $${data.balance}\n` +
                                          `⚠️ Deuda total acumulada: $${data.totalDebts}\n` +
                                          `🔴 Cuotas de deudas este mes: $${data.monthlyDebtPayments}\n` +
                                          `🟡 Gastos fijos del mes: $${data.totalExpenses}\n` +
                                          `🔄 Suscripciones: $${data.totalSubs}\n` +
                                          `🛡️ Plata para urgencias: $${data.emergencyReserve}\n` +
                                          `➖➖➖➖➖➖➖➖\n` +
                                          `🟢 Plata libre para gastar este mes: $${data.realSurplus}\n\n` +
                                          `🌟 *Tus Metas:*\n${goalsText || 'No hay metas anotadas.'}`;
                        await sock.sendMessage(sender, { text: statusMsg });
                        return;

                    case '8':
                        userSessions.set(phone, { step: 'WAITING_AI_QUERY' });
                        await sock.sendMessage(sender, { text: '🦁 ¿Qué querés comprar o qué duda tenés con tu plata?' });
                        return;

                    case '9':
                        userSessions.set(phone, { step: 'IDLE' });
                        await sendPanicAiWithLoading(sock, sender);
                        return;

                    default:
                        const stateNow = await getFinancialState(phone);
                        await sendAiWithLoading(sock, sender, text, stateNow);
                        return;
                }
            }

            if (session.step === 'WAITING_BALANCE') {
                const amount = parseFloat(text.replace(/[^0-9.]/g, ''));
                await pool.query(`UPDATE users SET available_balance = $1 WHERE phone_number = $2`, [amount, phone]);
                userSessions.set(phone, { step: 'IDLE' });
                await sock.sendMessage(sender, { text: `✅ Tu plata disponible se guardó.\n\n${getMainMenu()}` });
                return;
            }

            if (session.step === 'WAITING_DEBT') {
                const parts = text.split(' ');
                const date = parts[parts.length - 1];
                const interest = parseFloat(parts[parts.length - 2]);
                const monthly = parseFloat(parts[parts.length - 3]);
                const amount = parseFloat(parts[parts.length - 4]);
                const name = parts.slice(0, parts.length - 4).join(' ');

                await pool.query(
                    `INSERT INTO debts (phone_number, name, total_amount, monthly_installment, interest_rate, due_date) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [phone, name, amount, monthly, interest, date]
                );
                userSessions.set(phone, { step: 'IDLE' });
                await sock.sendMessage(sender, { text: `✅ Deuda anotada.\n\n${getMainMenu()}` });
                return;
            }

            if (session.step === 'WAITING_EXPENSE') {
                const parts = text.split(' ');
                const date = parts[parts.length - 1];
                const amount = parseFloat(parts[parts.length - 2]);
                const name = parts.slice(0, parts.length - 2).join(' ');

                await pool.query(
                    `INSERT INTO expenses (phone_number, name, amount, due_date) VALUES ($1, $2, $3, $4)`,
                    [phone, name, amount, date]
                );
                userSessions.set(phone, { step: 'IDLE' });
                await sock.sendMessage(sender, { text: `✅ Gasto anotado.\n\n${getMainMenu()}` });
                return;
            }

            if (session.step === 'WAITING_SUB') {
                const parts = text.split(' ');
                const day = parseInt(parts[parts.length - 1]);
                const amount = parseFloat(parts[parts.length - 2]);
                const name = parts.slice(0, parts.length - 2).join(' ');

                await pool.query(
                    `INSERT INTO subscriptions (phone_number, name, amount, due_day) VALUES ($1, $2, $3, $4)`,
                    [phone, name, amount, day]
                );
                userSessions.set(phone, { step: 'IDLE' });
                await sock.sendMessage(sender, { text: `✅ Suscripción anotada.\n\n${getMainMenu()}` });
                return;
            }

            if (session.step === 'WAITING_GOAL') {
                const parts = text.split(' ');
                const amount = parseFloat(parts[parts.length - 1]);
                const name = parts.slice(0, parts.length - 1).join(' ');

                await pool.query(
                    `INSERT INTO goals (phone_number, name, target_amount) VALUES ($1, $2, $3)`,
                    [phone, name, amount]
                );
                userSessions.set(phone, { step: 'IDLE' });
                
                const captionText = `🌟 ¡Qué hermoso sueño! Meta registrada.\n\n${getMainMenu()}`;
                await sendPositiveFeedback(sock, sender, captionText);
                return;
            }

            if (session.step === 'WAITING_PAY_SELECTION') {
                const choice = parseInt(text) - 1;
                const items = session.items || [];
                const item = items[choice];

                if (item.type === 'debt') {
                    await pool.query(`UPDATE debts SET is_paid = TRUE WHERE id = $1`, [item.id]);
                } else {
                    await pool.query(`UPDATE expenses SET is_paid = TRUE WHERE id = $1`, [item.id]);
                }

                userSessions.set(phone, { step: 'IDLE' });
                
                const captionText = `🎉 ¡VAMOOOS! Un peso menos de encima. ¡Sos una genia, a celebrar ese pequeño gran logro! 🥳🎊\n\n${getMainMenu()}`;
                await sendPositiveFeedback(sock, sender, captionText);
                return;
            }

            if (session.step === 'WAITING_AI_QUERY') {
                const currState = await getFinancialState(phone);
                userSessions.set(phone, { step: 'IDLE' });
                await sendAiWithLoading(sock, sender, text, currState);
                return;
            }

        } catch (error) {
            await sock.sendMessage(sender, { text: 'Ups, algo salió mal. Escribí 0 para volver al menú.' });
        }
    });
}

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot running');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    startBot();
});