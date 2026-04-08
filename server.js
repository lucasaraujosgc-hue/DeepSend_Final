import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import QRCode from 'qrcode';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const port = process.env.PORT || 3000;

// Configuração de diretórios
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const LOG_FILE = path.join(DATA_DIR, 'debug_whatsapp.log');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- SYSTEM: Logger ---
const log = (message, error = null) => {
    const timestamp = new Date().toISOString();
    let errorDetail = '';
    
    if (error) {
        errorDetail = `\nERROR: ${error.message}`;
        if (error.stack) errorDetail += `\nSTACK: ${error.stack}`;
    }

    const logMessage = `[${timestamp}] ${message}${errorDetail}\n`;
    console.log(`[APP] ${message}`);
    if (error) console.error(error);

    try {
        fs.appendFileSync(LOG_FILE, logMessage);
    } catch (e) {
        console.error("Falha crítica ao escrever no arquivo de log:", e);
    }
};

log("Servidor iniciando...");
log(`Diretório de dados: ${DATA_DIR}`);

// --- AI CONFIGURATION ---
let ai = null;
if (process.env.GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    log("AI: Google GenAI (v3 Flash Preview) inicializado.");
} else {
    log("AI: GEMINI_API_KEY não encontrada. O assistente inteligente estará desativado.");
}

// --- CONFIGURAÇÃO DO EXPRESS ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Servir arquivos estáticos do frontend (pasta dist criada pelo Vite)
// Importante: Isso deve vir antes das rotas de API para garantir performance
app.use(express.static(path.join(__dirname, 'dist')));

// --- HELPER: Puppeteer Lock Cleaner ---
const cleanPuppeteerLocks = (dir) => {
    const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    if (fs.existsSync(dir)) {
        locks.forEach(lock => {
            const lockPath = path.join(dir, lock);
            if (fs.existsSync(lockPath)) {
                try {
                    fs.unlinkSync(lockPath);
                    log(`[Puppeteer Fix] Trava removida: ${lockPath}`);
                } catch (e) {}
            }
        });
        const defaultDir = path.join(dir, 'Default');
        if (fs.existsSync(defaultDir)) {
             locks.forEach(lock => {
                const lockPath = path.join(defaultDir, lock);
                if (fs.existsSync(lockPath)) {
                    try { fs.unlinkSync(lockPath); } catch (e) {}
                }
            });
        }
    }
};

// --- HELPER: Robust WhatsApp Send ---
const safeSendMessage = async (client, chatId, content, options = {}) => {
    log(`[WhatsApp] Tentando enviar mensagem para: ${chatId}`);
    try {
        if (!client) throw new Error("Client é null");

        const safeOptions = { 
            ...options, 
            sendSeen: false 
        };

        let finalChatId = chatId;
        
        if (!finalChatId.includes('@')) {
             if (/^\d+$/.test(finalChatId)) {
                 finalChatId = `${finalChatId}@c.us`;
             } else {
                 throw new Error("ChatId mal formatado: " + chatId);
             }
        }

        try {
            if (finalChatId.endsWith('@c.us')) {
                const numberPart = finalChatId.replace('@c.us', '').replace(/\D/g, '');
                const contactId = await client.getNumberId(numberPart);
                
                if (contactId && contactId._serialized) {
                    finalChatId = contactId._serialized;
                }
            }
        } catch (idErr) {
            log(`[WhatsApp] Erro não bloqueante ao resolver getNumberId: ${idErr.message}`);
        }

        try {
            const chat = await client.getChatById(finalChatId);
            const msg = await chat.sendMessage(content, safeOptions);
            return msg;
        } catch (chatError) {
            const msg = await client.sendMessage(finalChatId, content, safeOptions);
            return msg;
        }

    } catch (error) {
        log(`[WhatsApp] FALHA CRÍTICA NO ENVIO para ${chatId}`, error);
        throw error;
    }
};

// --- MULTI-TENANCY: Database Management ---
const dbInstances = {};

const getDb = (username) => {
    if (!username) return null;
    if (dbInstances[username]) return dbInstances[username];

    const userDbPath = path.join(DATA_DIR, `${username}.db`);
    const db = new sqlite3.Database(userDbPath);
    
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, docNumber TEXT, type TEXT, email TEXT, whatsapp TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, status TEXT, priority TEXT, color TEXT, dueDate TEXT, companyId INTEGER, recurrence TEXT, dayOfWeek TEXT, recurrenceDate TEXT, targetCompanyType TEXT, createdAt TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS document_status (id INTEGER PRIMARY KEY AUTOINCREMENT, companyId INTEGER, category TEXT, competence TEXT, status TEXT, UNIQUE(companyId, category, competence))`);
        db.run(`CREATE TABLE IF NOT EXISTS sent_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, companyName TEXT, docName TEXT, category TEXT, sentAt TEXT, channels TEXT, status TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS user_settings (id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS scheduled_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, message TEXT, nextRun TEXT, recurrence TEXT, active INTEGER, type TEXT, channels TEXT, targetType TEXT, selectedCompanyIds TEXT, attachmentFilename TEXT, attachmentOriginalName TEXT, documentsPayload TEXT, createdBy TEXT)`);
        
        // Tabelas para RAG e Histórico do Assistente
        db.run(`CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, timestamp TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS personal_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, content TEXT, created_at TEXT, updated_at TEXT)`);

        // Tabelas para Kanban do WhatsApp
        db.run(`CREATE TABLE IF NOT EXISTS kanban_columns (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, color TEXT DEFAULT '#e2e8f0')`);
        db.run(`CREATE TABLE IF NOT EXISTS kanban_chats (id TEXT PRIMARY KEY, name TEXT, phone TEXT, column_id TEXT, last_message TEXT, last_message_time INTEGER, unread_count INTEGER DEFAULT 0, profile_pic TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS kanban_tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL)`);
        db.run(`CREATE TABLE IF NOT EXISTS kanban_chat_tags (chat_id TEXT, tag_id TEXT, PRIMARY KEY (chat_id, tag_id))`);
        db.run(`CREATE TABLE IF NOT EXISTS kanban_messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, body TEXT, from_me INTEGER, timestamp INTEGER, media_url TEXT, media_type TEXT, media_name TEXT, transcription TEXT)`);

        db.get("SELECT COUNT(*) as count FROM kanban_columns", (err, row) => {
            if (row && row.count === 0) {
                const stmt = db.prepare("INSERT INTO kanban_columns (id, name, position) VALUES (?, ?, ?)");
                stmt.run('col-1', 'Novos', 0);
                stmt.run('col-2', 'Em Atendimento', 1);
                stmt.run('col-3', 'Aguardando Cliente', 2);
                stmt.run('col-4', 'Finalizados', 3);
                stmt.finalize();
            }
        });

        db.all("PRAGMA table_info(scheduled_messages)", [], (err, rows) => {
            if (rows && !rows.some(col => col.name === 'documentsPayload')) {
                db.run("ALTER TABLE scheduled_messages ADD COLUMN documentsPayload TEXT", () => {});
            }
        });
        db.all("PRAGMA table_info(tasks)", [], (err, rows) => {
            if (rows && !rows.some(col => col.name === 'createdAt')) {
                const today = new Date().toISOString().split('T')[0];
                db.run("ALTER TABLE tasks ADD COLUMN createdAt TEXT", () => db.run("UPDATE tasks SET createdAt = ?", [today]));
            }
        });
    });

    dbInstances[username] = db;
    return db;
};

// --- EMAIL CONFIGURATION ---
const emailPort = parseInt(process.env.EMAIL_PORT || '465');
const emailTransporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: emailPort,
    secure: emailPort === 465,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// --- AI LOGIC: Tools & Handler ---

const assistantTools = [
    {
        name: "consult_tasks",
        description: "Lista as tarefas cadastradas.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                status: { type: Type.STRING, enum: ["pendente", "em_andamento", "concluida", "todas"], description: "Filtro. Use 'todas' se o usuario pedir 'todas'." }
            }
        }
    },
    {
        name: "update_task_status",
        description: "Marca uma tarefa como concluída ou muda status.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                task_id_or_title: { type: Type.STRING, description: "ID numérico ou Título aproximado da tarefa." },
                new_status: { type: Type.STRING, enum: ["pendente", "em_andamento", "concluida"], description: "Novo status." }
            },
            required: ["task_id_or_title", "new_status"]
        }
    },
    {
        name: "add_task",
        description: "Cria uma nova tarefa.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                title: { type: Type.STRING, description: "Título da tarefa" },
                description: { type: Type.STRING },
                priority: { type: Type.STRING, enum: ["alta", "media", "baixa"] }
            },
            required: ["title"]
        }
    },
    {
        name: "set_personal_reminder",
        description: "Define um lembrete pessoal para o usuário. Use para 'me lembre de X em Y minutos' ou 'todo dia X'.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                message: { type: Type.STRING, description: "O que deve ser lembrado." },
                datetime: { type: Type.STRING, description: "Data e hora exata ISO 8601 (ex: 2024-05-10T14:30:00). Calcule baseando-se na hora atual informada no system prompt." },
                recurrence: { type: Type.STRING, enum: ["unico", "diaria", "semanal", "mensal", "anual"], description: "Padrão: unico." }
            },
            required: ["message", "datetime"]
        }
    },
    {
        name: "send_message_to_company",
        description: "ENVIA uma mensagem REAL (Email e/ou WhatsApp) para uma empresa cadastrada.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                company_name_search: { type: Type.STRING, description: "Nome aproximado da empresa para buscar." },
                message_body: { type: Type.STRING, description: "Conteúdo da mensagem a ser enviada." },
                channels: { 
                    type: Type.OBJECT, 
                    properties: {
                        whatsapp: { type: Type.BOOLEAN },
                        email: { type: Type.BOOLEAN }
                    }
                }
            },
            required: ["company_name_search", "message_body"]
        }
    },
    {
        name: "search_company",
        description: "Consulta dados de leitura de uma empresa.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                name_or_doc: { type: Type.STRING }
            },
            required: ["name_or_doc"]
        }
    },
    {
        name: "manage_memory",
        description: "Salva/Busca informações gerais (treinos, estudos).",
        parameters: {
            type: Type.OBJECT,
            properties: {
                action: { type: Type.STRING, enum: ["save", "search"] },
                topic: { type: Type.STRING },
                content: { type: Type.STRING }
            },
            required: ["action", "topic"]
        }
    }
];

// --- EXECUÇÃO DAS TOOLS ---
const executeTool = async (name, args, db, username) => {
    log(`[AI Tool] Executando ${name} com args: ${JSON.stringify(args)}`);
    
    // 1. Consultar Tarefas (Sem Limite Rígido se pedir todas)
    if (name === "consult_tasks") {
        return new Promise((resolve) => {
            let sql = "SELECT id, title, priority, status, dueDate FROM tasks";
            const params = [];
            
            if (args.status && args.status !== 'todas') {
                sql += " WHERE status = ?";
                params.push(args.status);
            } else {
                sql += " ORDER BY CASE WHEN status = 'pendente' THEN 1 WHEN status = 'em_andamento' THEN 2 ELSE 3 END, id DESC";
            }
            
            db.all(sql, params, (err, rows) => {
                if (err) resolve("Erro ao listar: " + err.message);
                if (!rows || rows.length === 0) resolve("Nenhuma tarefa encontrada.");
                else resolve(JSON.stringify(rows));
            });
        });
    }

    // 2. Atualizar Status (Marcar como Concluída)
    if (name === "update_task_status") {
        return new Promise((resolve) => {
            const isId = /^\d+$/.test(args.task_id_or_title);
            const sqlCheck = isId ? "SELECT id FROM tasks WHERE id = ?" : "SELECT id FROM tasks WHERE title LIKE ?";
            const paramCheck = isId ? args.task_id_or_title : `%${args.task_id_or_title}%`;

            db.all(sqlCheck, [paramCheck], (err, rows) => {
                if (err || !rows || rows.length === 0) {
                    resolve(`Tarefa "${args.task_id_or_title}" não encontrada.`);
                    return;
                }
                
                const ids = rows.map(r => r.id);
                const placeholders = ids.map(() => '?').join(',');
                
                db.run(`UPDATE tasks SET status = ? WHERE id IN (${placeholders})`, [args.new_status, ...ids], function(err2) {
                    if (err2) resolve("Erro ao atualizar.");
                    else resolve(`Atualizado ${this.changes} tarefa(s) para '${args.new_status}'.`);
                });
            });
        });
    }

    // 3. Adicionar Tarefa
    if (name === "add_task") {
        const today = new Date().toISOString().split('T')[0];
        return new Promise(resolve => {
            db.run(`INSERT INTO tasks (title, description, status, priority, color, recurrence, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [args.title, args.description || '', 'pendente', args.priority || 'media', '#45B7D1', 'nenhuma', today], 
            function(err) { resolve(err ? "Erro: " + err.message : `Tarefa criada (ID ${this.lastID}).`); });
        });
    }

    // 4. Lembrete Pessoal (Agendamento no Cron)
    if (name === "set_personal_reminder") {
        return new Promise(resolve => {
            db.run(`INSERT INTO scheduled_messages (title, message, nextRun, recurrence, active, type, channels, targetType, createdBy) VALUES (?, ?, ?, ?, 1, 'message', ?, 'personal', ?)`,
            ["Lembrete Pessoal", args.message, args.datetime, args.recurrence || 'unico', JSON.stringify({whatsapp: true, email: false}), username],
            function(err) { 
                resolve(err ? "Erro ao agendar lembrete: " + err.message : `Lembrete agendado para ${args.datetime}. O sistema enviará automaticamente.`); 
            });
        });
    }

    // 5. Enviar Mensagem para Empresa (Disparo Real)
    if (name === "send_message_to_company") {
        return new Promise(async (resolve) => {
            db.all("SELECT * FROM companies WHERE name LIKE ? LIMIT 5", [`%${args.company_name_search}%`], async (err, rows) => {
                if (err) { resolve("Erro no banco de dados."); return; }
                if (!rows || rows.length === 0) { resolve(`Empresa com nome similar a "${args.company_name_search}" não encontrada.`); return; }
                if (rows.length > 1) { 
                    const names = rows.map(r => r.name).join(", ");
                    resolve(`Encontrei várias empresas: ${names}. Seja mais específico no nome.`); 
                    return; 
                }

                const company = rows[0];
                const channels = args.channels || { whatsapp: true, email: true };
                let logMsg = [];

                if (channels.email && company.email) {
                    try {
                        const emailList = company.email.split(',').map(e => e.trim());
                        await emailTransporter.sendMail({
                            from: process.env.EMAIL_USER,
                            to: emailList[0],
                            cc: emailList.slice(1),
                            subject: "Comunicado Contabilidade",
                            text: args.message_body, 
                            html: buildEmailHtml(args.message_body, [], "Atenciosamente,\nContabilidade")
                        });
                        logMsg.push("E-mail enviado");
                    } catch (e) { logMsg.push("Falha no E-mail"); }
                }

                if (channels.whatsapp && company.whatsapp) {
                    const waWrapper = getWaClientWrapper(username);
                    if (waWrapper && waWrapper.status === 'connected') {
                        try {
                            let number = company.whatsapp.replace(/\D/g, '');
                            if (!number.startsWith('55')) number = '55' + number;
                            const chatId = `${number}@c.us`;
                            await safeSendMessage(waWrapper.client, chatId, args.message_body);
                            logMsg.push("WhatsApp enviado");
                        } catch (e) { logMsg.push("Falha no WhatsApp"); }
                    } else {
                        logMsg.push("WhatsApp desconectado");
                    }
                }

                resolve(`Ação executada para ${company.name}: ${logMsg.join(", ")}.`);
            });
        });
    }

    if (name === "search_company") {
        return new Promise(resolve => {
            db.all("SELECT id, name, docNumber, email, whatsapp FROM companies WHERE name LIKE ? OR docNumber LIKE ? LIMIT 5",
            [`%${args.name_or_doc}%`, `%${args.name_or_doc}%`], (err, rows) => {
                if(err) resolve("Erro na busca.");
                else resolve(rows.length ? JSON.stringify(rows) : "Nenhuma empresa encontrada.");
            });
        });
    }

    if (name === "manage_memory") {
        if (args.action === "save") {
            const now = new Date().toISOString();
            return new Promise(resolve => {
                db.run("INSERT INTO personal_notes (topic, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
                [args.topic, args.content, now, now], (err) => resolve(err ? "Erro." : "Memória salva."));
            });
        }
        if (args.action === "search") {
            return new Promise(resolve => {
                const term = args.content || args.topic || "";
                db.all("SELECT topic, content FROM personal_notes WHERE topic LIKE ? OR content LIKE ? LIMIT 3",
                [`%${term}%`, `%${term}%`], (err, rows) => resolve(JSON.stringify(rows)));
            });
        }
    }

    return "Ferramenta desconhecida.";
};

// --- HELPER: Retry Logic for 429 Errors ---
const runWithRetry = async (fn, retries = 3, delay = 2000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            const isRateLimit = error.message?.includes('429') || error.status === 429;
            if (!isRateLimit || i === retries - 1) throw error;
            const waitTime = delay * Math.pow(2, i);
            log(`[AI Retry] Aguardando ${waitTime/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
};

// --- AI PROCESSOR ---
const processAI = async (username, userMessage, mediaPart = null) => {
    const db = getDb(username);
    if (!db || !ai) return "Sistema de IA indisponível.";

    const greetingRegex = /^(oi|ola|olá|bom dia|boa tarde|boa noite|opa|eai|tudo bem|ajuda)\??$/i;
    if (!mediaPart && greetingRegex.test(userMessage.trim())) {
        return "Olá! Sou seu assistente. Posso consultar empresas, anotar tarefas, enviar mensagens e lembrar você de coisas. Como ajudo?";
    }

    const history = await new Promise(resolve => {
        db.all("SELECT role, content FROM chat_history ORDER BY id DESC LIMIT 6", (err, rows) => {
            resolve(rows ? rows.reverse().map(r => ({ role: r.role === 'user' ? 'user' : 'model', parts: [{ text: r.content }] })) : []);
        });
    });

    const now = new Date();
    const currentTimeStr = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const currentISO = now.toISOString();

    const systemInstruction = `Você é o assistente operacional interno de um sistema de atendimento e gestão de clientes de um escritório contábil integrado ao WhatsApp.

Seu papel NÃO é agir como um chatbot genérico.
Seu papel é interpretar comandos do usuário, entender intenções operacionais, organizar informações, resumir conversas, sugerir respostas e auxiliar automações com segurança.

Você deve funcionar como um “copiloto” do dashboard.

==================================================
OBJETIVO PRINCIPAL
==================================================

Seu objetivo é ajudar o operador humano a:

1. Consultar dados de mensagens, contatos, tags e kanban
2. Resumir conversas ou grupos de conversas em lote
3. Sugerir respostas para clientes
4. Classificar contextos operacionais
5. Identificar pendências, urgências e ações sugeridas
6. Traduzir pedidos em linguagem natural para intenções estruturadas
7. Apoiar automações, SEM executar ações perigosas sem confirmação

Você NÃO deve inventar dados.
Você NÃO deve assumir que tem acesso direto ao banco.
Você NÃO deve responder como se soubesse números, quantidades ou registros se eles não forem fornecidos pelo sistema.

==================================================
COMPORTAMENTO GERAL
==================================================

Sempre que receber uma solicitação do usuário, você deve identificar qual é o tipo da solicitação.

Os principais tipos são:

- CONSULTA
- RESUMO
- AÇÃO
- SUGESTÃO DE RESPOSTA
- CLASSIFICAÇÃO
- FOLLOW-UP
- TRIAGEM
- COMANDO OPERACIONAL

Você deve interpretar o pedido do usuário e responder de forma objetiva, útil, operacional e profissional.

Você deve sempre priorizar:
- clareza
- precisão
- segurança
- economia de tokens
- utilidade prática no contexto de escritório contábil

==================================================
REGRA MAIS IMPORTANTE
==================================================

VOCÊ NÃO DEVE “ADIVINHAR” RESULTADOS DO SISTEMA.

Se o usuário pedir algo que depende de dados reais do sistema, como:

- “quantas mensagens recebi ontem?”
- “quem está sem tag?”
- “quais clientes da tag fiscal responderam?”
- “eu enviei a mensagem X para os clientes da tag Y?”

Você deve converter isso em uma intenção estruturada para o sistema executar.

Ou seja:
Você interpreta o pedido, mas NÃO inventa a resposta final se os dados ainda não foram consultados.

==================================================
MODO DE FUNCIONAMENTO
==================================================

Você deve operar em dois modos principais:

--------------------------------------------------
MODO 1 — INTERPRETAÇÃO DE COMANDO
--------------------------------------------------

Quando o usuário fizer uma pergunta ou ordem relacionada a dados do sistema, você deve retornar uma estrutura JSON clara e objetiva representando a intenção.

Exemplo:
Usuário: "Quantas mensagens recebi ontem?"

Saída esperada:
{
  "mode": "system_query",
  "intent": "count_messages",
  "filters": {
    "date": "yesterday",
    "from_me": false
  },
  "response_style": "short"
}

Outro exemplo:
Usuário: "Me resuma as mensagens recebidas no dia 08/04 que estão sem tag"

Saída esperada:
{
  "mode": "system_query",
  "intent": "summarize_messages",
  "filters": {
    "date": "2026-04-08",
    "tag": null,
    "from_me": false
  },
  "response_style": "summary"
}

Outro exemplo:
Usuário: "Enviei a mensagem de solicitação de extrato bancário para os contatos da tag fiscal?"

Saída esperada:
{
  "mode": "system_query",
  "intent": "check_sent_message",
  "filters": {
    "tag": "fiscal",
    "message_contains": "solicitação de extrato bancário",
    "from_me": true
  },
  "response_style": "verification"
}

IMPORTANTE:
Sempre que o pedido depender de dados do sistema, você deve preferir retornar JSON estruturado para que o backend execute a consulta.

--------------------------------------------------
MODO 2 — ANÁLISE / RESUMO / RESPOSTA
--------------------------------------------------

Quando o sistema já fornecer os dados para análise, você deve responder em linguagem natural útil, clara e operacional.

Exemplo:
Se o sistema fornecer mensagens agrupadas por cliente, você deve:

- resumir o conteúdo relevante
- identificar pendências
- identificar urgência
- sugerir ações
- organizar por prioridade quando fizer sentido

==================================================
CASOS DE USO PRINCIPAIS
==================================================

Você deve ser excelente nos seguintes casos:

1. CONTAGEM E CONSULTA
Exemplos:
- Quantas mensagens recebi ontem?
- Quantos contatos falaram hoje?
- Quantos chats estão sem tag?
- Quantos clientes estão na coluna “Aguardando Cliente”?

2. RESUMO EM LOTE
Exemplos:
- Me resuma as mensagens da tag fiscal de hoje
- Me diga o que os contatos sem tag falaram ontem
- Resuma os clientes que mandaram mensagem nas últimas 24h
- Quais pendências surgiram hoje?

3. SUGESTÃO DE RESPOSTA
Exemplos:
- Sugira uma resposta educada
- Responda de forma formal
- Crie uma resposta curta cobrando documentos
- Sugira uma resposta acolhedora

4. CLASSIFICAÇÃO
Exemplos:
- Classifique esse contato
- Isso parece fiscal ou departamento pessoal?
- Essa conversa indica urgência?
- Essa conversa sugere envio de documentos?

5. AUTOMAÇÕES ASSISTIDAS
Exemplos:
- Quem está sem resposta há mais de 2 dias?
- Quais clientes da tag fiscal ainda não enviaram extrato?
- Gere uma mensagem de follow-up
- Sugira quais tags aplicar

==================================================
SEGURANÇA E CONTROLE
==================================================

Você NUNCA deve executar automaticamente ações críticas sem confirmação explícita.

Ações que exigem confirmação:
- envio em massa
- mudança em lote de tags
- movimentação em lote no kanban
- criação de tarefa em lote
- alteração de status em lote
- respostas automáticas em lote

Quando o usuário pedir uma ação em lote, você deve:
1. estruturar a intenção
2. sugerir a ação
3. recomendar confirmação antes da execução

==================================================
RESPOSTAS AUTOMÁTICAS
==================================================

Você pode ajudar a identificar perguntas seguras para automação, como:

- horário de atendimento
- confirmação de recebimento
- onde enviar documentos
- se pode mandar por WhatsApp
- confirmação de canal de atendimento

Você NÃO deve recomendar resposta automática livre para temas sensíveis como:
- cálculo de imposto
- interpretação tributária
- demissão
- rescisão
- admissão
- multa
- enquadramento fiscal
- obrigações legais específicas

Nesses casos, você deve preferir:
- triagem
- resposta de encaminhamento
- resposta de acolhimento sem assumir conteúdo técnico

==================================================
ESTILO DE RESPOSTA
==================================================

Seu estilo deve ser:

- profissional
- objetivo
- claro
- operacional
- útil para ambiente de escritório contábil
- sem floreios desnecessários
- sem respostas genéricas de chatbot

Evite:
- respostas longas demais
- explicações desnecessárias
- linguagem excessivamente robótica
- frases vagas como “talvez”, “quem sabe”, “parece que”
- inventar dados ausentes

==================================================
FORMATO DE SAÍDA
==================================================

Você deve escolher o formato correto conforme o contexto:

1. Se for pedido operacional que depende do sistema:
RETORNE JSON E NADA MAIS

2. Se for pedido de análise de dados já fornecidos:
RETORNE TEXTO CLARO E ÚTIL

3. Se for pedido de sugestão de resposta:
RETORNE SOMENTE A SUGESTÃO DE RESPOSTA

4. Se for pedido de classificação:
RETORNE JSON ESTRUTURADO

==================================================
PADRÕES DE JSON
==================================================

Use sempre estruturas simples, consistentes e previsíveis.

Exemplo para consulta:
{
  "mode": "system_query",
  "intent": "count_messages",
  "filters": {
    "date": "yesterday",
    "from_me": false,
    "tag": null
  },
  "response_style": "short"
}

Exemplo para resumo:
{
  "mode": "system_query",
  "intent": "summarize_messages",
  "filters": {
    "date": "2026-04-08",
    "tag": "fiscal",
    "from_me": false
  },
  "response_style": "summary"
}

Exemplo para classificação:
{
  "mode": "classification",
  "category": "fiscal",
  "sub_category": "envio_documentos",
  "priority": "normal",
  "urgent": false,
  "suggested_tags": ["fiscal", "documentos"],
  "suggested_column": "Aguardando Conferência"
}

Exemplo para ação:
{
  "mode": "system_action",
  "intent": "send_bulk_message",
  "filters": {
    "tag": "fiscal"
  },
  "payload": {
    "message": "Olá! Estamos aguardando o envio do extrato bancário."
  },
  "requires_confirmation": true
}

==================================================
ECONOMIA DE TOKENS
==================================================

Você deve agir de forma econômica.

Portanto:
- não peça histórico inteiro sem necessidade
- trabalhe bem com resumos incrementais
- prefira analisar lotes resumidos em vez de mensagens cruas demais
- foque em contexto útil
- ignore ruído conversacional irrelevante quando estiver resumindo

Ruídos comuns que devem ser tratados como pouco relevantes:
- “ok”
- “bom dia”
- “boa tarde”
- “obrigado”
- “valeu”
- emojis isolados
- confirmações muito curtas

==================================================
REGRA FINAL
==================================================

Você é um assistente operacional de CRM/WhatsApp para contabilidade.

Você deve ajudar o usuário a:
- entender o que aconteceu
- encontrar informações rapidamente
- resumir o dia
- identificar pendências
- agir com mais velocidade
- automatizar com segurança

Você não é um atendente do cliente final.
Você é um copiloto interno do operador do sistema.

DATA/HORA ATUAL: ${currentTimeStr} (ISO: ${currentISO}).
Use essa data para calcular vencimentos ou agendamentos relativos (ex: "daqui a 20 min" = somar 20 min ao ISO).`;

    const currentParts = [];
    if (mediaPart) currentParts.push(mediaPart);
    if (userMessage) currentParts.push({ text: userMessage });

    try {
        const chat = ai.chats.create({ 
            model: "gemini-3-flash-preview", 
            config: {
                systemInstruction: systemInstruction,
                tools: [{ functionDeclarations: assistantTools }]
            },
            history: history
        });

        let response = await runWithRetry(() => chat.sendMessage({ message: currentParts }));
        let functionCalls = response.functionCalls;
        let loopCount = 0;

        while (functionCalls && functionCalls.length > 0 && loopCount < 5) {
            loopCount++;
            const call = functionCalls[0];
            const result = await executeTool(call.name, call.args, db, username);
            response = await runWithRetry(() => chat.sendMessage({
                message: [{ functionResponse: { name: call.name, response: { result: result } } }]
            }));
            functionCalls = response.functionCalls;
        }

        const finalText = response.text || "Comando processado.";
        db.run("INSERT INTO chat_history (role, content, timestamp) VALUES (?, ?, ?)", ['user', userMessage, new Date().toISOString()]);
        db.run("INSERT INTO chat_history (role, content, timestamp) VALUES (?, ?, ?)", ['model', finalText, new Date().toISOString()]);

        return finalText;

    } catch (e) {
        log("[AI Error]", e);
        if (e.message?.includes('404')) return "Erro: O modelo gemini-3-flash-preview ainda não está disponível na sua região ou chave. Tente reverter para gemini-2.0-flash.";
        return "Desculpe, tive um problema momentâneo.";
    }
};

// --- MULTI-TENANCY: WhatsApp Management ---
const waClients = {}; 

const getWaClientWrapper = (username) => {
    if (!username) return null;
    
    if (!waClients[username]) {
        log(`[WhatsApp Init] Inicializando cliente para usuário: ${username}`);
        
        waClients[username] = {
            client: null,
            qr: null,
            status: 'disconnected',
            info: null
        };

        const authPath = path.join(DATA_DIR, `whatsapp_auth_${username}`);
        if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

        const sessionPath = path.join(authPath, `session-${username}`);
        cleanPuppeteerLocks(sessionPath);

        const puppeteerExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
        
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: username, dataPath: authPath }), 
            puppeteer: {
                headless: true,
                executablePath: puppeteerExecutablePath,
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox', 
                    '--disable-dev-shm-usage', 
                    '--disable-accelerated-2d-canvas', 
                    '--no-first-run', 
                    '--no-zygote', 
                    '--disable-gpu', 
                    '--disable-software-rasterizer',
                    '--single-process'
                ],
            }
        });

        // --- KANBAN MESSAGE HANDLER ---
        client.on('message_create', async (msg) => {
            if (msg.isStatus) return;
            
            try {
                const chat = await msg.getChat();
                if (chat.isGroup) return; // Ignore groups for now

                const chatId = chat.id._serialized;
                const contact = await chat.getContact();
                const name = contact.name || contact.pushname || contact.number;
                const phone = contact.number;
                let body = msg.body;
                const timestamp = msg.timestamp * 1000;
                const fromMe = msg.fromMe ? 1 : 0;

                let mediaUrl = null;
                let mediaType = null;
                let mediaName = null;
                let transcription = null;

                const db = getDb(username);

                if (msg.hasMedia) {
                    try {
                        const media = await msg.downloadMedia();
                        if (media) {
                            const ext = media.mimetype.split('/')[1].split(';')[0];
                            const filename = `${msg.id.id}.${ext}`;
                            const filepath = path.join(UPLOADS_DIR, filename);
                            fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));
                            
                            mediaUrl = `/uploads/${filename}`;
                            mediaType = media.mimetype;
                            mediaName = media.filename || filename;
                        }
                    } catch (err) {
                        log('Error downloading media:', err);
                    }
                }

                const displayBody = body || (mediaType ? `[Media: ${mediaType}]` : '');
                let profilePic = null;

                db.get("SELECT id FROM kanban_messages WHERE id = ?", [msg.id.id], (err, row) => {
                    if (row) return; // Message already processed

                    db.get("SELECT id, profile_pic FROM kanban_chats WHERE id = ? OR (phone = ? AND phone IS NOT NULL AND phone != '')", [chatId, phone], (err, chatRow) => {
                        if (!chatRow) {
                            db.get("SELECT id FROM kanban_columns ORDER BY position ASC LIMIT 1", (err, colRow) => {
                                const colId = colRow ? colRow.id : 'col-1';
                                const unreadCount = fromMe ? 0 : 1;
                                db.run("INSERT INTO kanban_chats (id, name, phone, column_id, last_message, last_message_time, unread_count, profile_pic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                    [chatId, name, phone, colId, displayBody, timestamp, unreadCount, profilePic], () => {
                                        io.emit('new_chat', { id: chatId, name, phone, column_id: colId, last_message: displayBody, last_message_time: timestamp, unread_count: unreadCount, profile_pic: profilePic });
                                    });
                            });
                        } else {
                            const unreadUpdate = fromMe ? "" : ", unread_count = unread_count + 1";
                            const finalProfilePic = profilePic || chatRow.profile_pic;
                            
                            db.serialize(() => {
                                if (chatRow.id !== chatId) {
                                    db.run("UPDATE kanban_chats SET id = ? WHERE id = ?", [chatId, chatRow.id]);
                                    db.run("UPDATE kanban_messages SET chat_id = ? WHERE chat_id = ?", [chatId, chatRow.id]);
                                    db.run("UPDATE kanban_chat_tags SET chat_id = ? WHERE chat_id = ?", [chatId, chatRow.id]);
                                    io.emit('chat_deleted', { id: chatRow.id });
                                    
                                    db.get("SELECT * FROM kanban_chats WHERE id = ?", [chatId], (err, updatedChatRow) => {
                                        if (updatedChatRow) {
                                            io.emit('new_chat', updatedChatRow);
                                        }
                                    });
                                }
                                
                                db.run(`UPDATE kanban_chats SET last_message = ?, last_message_time = ?, profile_pic = ?, name = ?${unreadUpdate} WHERE id = ?`,
                                    [displayBody, timestamp, finalProfilePic, name, chatId], () => {
                                        io.emit('chat_updated', { id: chatId, last_message: displayBody, last_message_time: timestamp, profile_pic: finalProfilePic, name });
                                    });
                            });
                        }
                    });

                    db.run("INSERT INTO kanban_messages (id, chat_id, body, from_me, timestamp, media_url, media_type, media_name, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        [msg.id.id, chatId, body, fromMe, timestamp, mediaUrl, mediaType, mediaName, transcription], () => {
                            io.emit('new_message', { id: msg.id.id, chat_id: chatId, body, from_me: fromMe, timestamp, media_url: mediaUrl, media_type: mediaType, media_name: mediaName, transcription });
                        });
                });
            } catch (err) {
                log('Error processing message for Kanban:', err);
            }
        });

        // --- INTERCEPTADOR DE MENSAGENS (IA) ---
        client.on('message', async (msg) => {
            const sender = msg.from;
            log(`[WhatsApp Inbound] Mensagem recebida de: ${sender} | Body: ${msg.body?.substring(0, 30)}...`);

            try {
                if (msg.from.includes('@g.us') || msg.isStatus) {
                    return;
                }

                const db = getDb(username);
                const settings = await new Promise(resolve => {
                    db.get("SELECT settings FROM user_settings WHERE id = 1", (e, r) => resolve(r ? JSON.parse(r.settings) : null));
                });

                if (!settings || !settings.dailySummaryNumber) {
                    return;
                }

                const authorizedNumber = settings.dailySummaryNumber.replace(/\D/g, ''); 
                const senderNumber = msg.from.replace('@c.us', '').replace(/\D/g, '');

                if (!senderNumber.endsWith(authorizedNumber)) {
                    return; 
                }

                log(`[AI Trigger] ACESSO PERMITIDO! Iniciando processamento IA...`);

                let mediaPart = null;
                let textContent = msg.body;

                if (msg.hasMedia) {
                    try {
                        const media = await msg.downloadMedia();
                        if (media) {
                            mediaPart = {
                                inlineData: {
                                    mimeType: media.mimetype,
                                    data: media.data
                                }
                            };
                            if (media.mimetype.startsWith('audio/')) {
                                textContent = "Por favor, analise este áudio. " + (msg.body || "");
                            } else {
                                textContent += " [Mídia anexa]";
                            }
                        }
                    } catch (mediaErr) {
                        log("Erro download media", mediaErr);
                    }
                }

                const response = await processAI(username, textContent, mediaPart);
                await safeSendMessage(client, msg.from, response);

            } catch (e) {
                log("Erro no handler de mensagem IA", e);
            }
        });

        client.on('qr', (qr) => { 
            log(`[WhatsApp Event] QR Code gerado para ${username}`);
            QRCode.toDataURL(qr, (err, url) => { 
                if (err) log(`[WhatsApp Event] Erro QR`, err);
                waClients[username].qr = url; 
                waClients[username].status = 'generating_qr';
            }); 
        });
        
        client.on('ready', () => { 
            log(`[WhatsApp Event] CLIENTE PRONTO (${username})`);
            waClients[username].status = 'connected';
            waClients[username].qr = null;
            waClients[username].info = client.info;
        });
        
        client.on('authenticated', () => {
            log(`[WhatsApp Event] Autenticado (${username})`);
        });

        client.on('auth_failure', (msg) => {
            log(`[WhatsApp Event] FALHA DE AUTENTICAÇÃO (${username}): ${msg}`);
            waClients[username].status = 'error';
        });
        
        client.on('disconnected', (reason) => { 
            log(`[WhatsApp Event] Desconectado (${username}). Razão: ${reason}`);
            waClients[username].status = 'disconnected';
            waClients[username].info = null;
        });

        client.initialize().catch((err) => {
            log(`[WhatsApp Init] ERRO FATAL (${username})`, err);
            waClients[username].status = 'error';
        });
        
        waClients[username].client = client;
    }

    return waClients[username];
};

// --- LOGIC: Send Daily Summary Helper ---
const sendDailySummaryToUser = async (user) => {
    const db = getDb(user);
    if (!db) return;

    const waWrapper = getWaClientWrapper(user);
    if (waWrapper.status !== 'connected') {
        return { success: false, message: 'WhatsApp desconectado' };
    }

    return new Promise((resolve, reject) => {
        db.get("SELECT settings FROM user_settings WHERE id = 1", (e, r) => {
            if (e || !r) { resolve({ success: false, message: 'Configurações não encontradas' }); return; }
            
            const settings = JSON.parse(r.settings);
            if (!settings.dailySummaryNumber) { resolve({ success: false, message: 'Número para resumo não configurado' }); return; }

            const sql = `SELECT t.*, c.name as companyName FROM tasks t LEFT JOIN companies c ON t.companyId = c.id WHERE t.status != 'concluida'`;

            db.all(sql, [], async (err, tasks) => {
                if (err) { resolve({ success: false, message: 'Erro ao buscar tarefas' }); return; }
                if (!tasks || tasks.length === 0) { resolve({ success: true, message: 'Nenhuma tarefa pendente' }); return; }

                const priorityMap = { 'alta': 1, 'media': 2, 'baixa': 3 };
                const sortedTasks = tasks.sort((a, b) => (priorityMap[a.priority] || 99) - (priorityMap[b.priority] || 99));

                let message = `*📅 Resumo Diário de Tarefas*\n\nVocê tem *${sortedTasks.length}* tarefas pendentes.\n\n`;
                sortedTasks.forEach(task => {
                    let icon = task.priority === 'alta' ? '🔴' : task.priority === 'media' ? '🟡' : '🔵';
                    message += `${icon} *${task.title}*\n`;
                    if (task.companyName) message += `   🏢 ${task.companyName}\n`;
                    if (task.dueDate) message += `   📅 Vence: ${task.dueDate}\n`;
                    message += `\n`;
                });
                message += `_Gerado automaticamente pelo Contábil Manager Pro_`;

                try {
                    let number = settings.dailySummaryNumber.replace(/\D/g, '');
                    if (!number.startsWith('55')) number = '55' + number;
                    const chatId = `${number}@c.us`;
                    
                    await safeSendMessage(waWrapper.client, chatId, message);
                    resolve({ success: true, message: 'Enviado com sucesso' });
                } catch (sendErr) {
                    log(`[Summary] Erro envio`, sendErr);
                    resolve({ success: false, message: 'Erro no envio do WhatsApp' });
                }
            });
        });
    });
};

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    const parts = token.split('-');
    if (parts.length < 3) return res.status(403).json({ error: 'Token inválido' });
    const user = parts.slice(2).join('-'); 
    const envUsers = (process.env.USERS || '').split(',');
    if (!envUsers.includes(user)) return res.status(403).json({ error: 'Usuário não autorizado' });
    req.user = user;
    next();
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, UPLOADS_DIR) },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    cb(null, uniqueSuffix + '-' + cleanName)
  }
})
const upload = multer({ storage: storage });

// --- HTML Builder Helper ---
const buildEmailHtml = (messageBody, documents, emailSignature) => {
    let docsTable = '';
    if (documents && documents.length > 0) {
        const sortedDocs = [...documents].sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
        let rows = '';
        sortedDocs.forEach(doc => {
            rows += `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #333;">${doc.docName}</td><td style="padding: 10px; color: #555;">${doc.category}</td><td style="padding: 10px; color: #555;">${doc.dueDate || 'N/A'}</td><td style="padding: 10px; color: #555;">${doc.competence}</td></tr>`;
        });
        docsTable = `<h3 style="color: #2c3e50; border-bottom: 2px solid #eff6ff; padding-bottom: 10px; margin-top: 30px; font-size: 16px;">Documentos em Anexo:</h3><table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;"><thead><tr style="background-color: #f8fafc; color: #64748b;"><th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Documento</th><th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Categoria</th><th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Vencimento</th><th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Competência</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    return `<html><body style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 20px;"><div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);"><div style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; border-left: 4px solid #2563eb; margin-bottom: 25px;">${messageBody.replace(/\n/g, '<br>')}</div>${docsTable}<div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 14px; color: #64748b;">${emailSignature || ''}</div></div></body></html>`;
};

import { setupKanbanRoutes } from './server-kanban.js';

// --- ROUTES ---

app.post('/api/login', (req, res) => {
    const { user, password } = req.body;
    const envUsers = (process.env.USERS || 'admin').split(',');
    const envPasss = (process.env.PASSWORDS || 'admin').split(',');
    const userIndex = envUsers.indexOf(user);

    if (userIndex !== -1 && envPasss[userIndex] === password) {
        getWaClientWrapper(user);
        res.json({ success: true, token: `session-${Date.now()}-${user}` });
    } else {
        res.status(401).json({ error: 'Credenciais inválidas' });
    }
});

app.use('/api', authenticateToken);

setupKanbanRoutes(app, io, getDb, getWaClientWrapper);

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
    res.json({ filename: req.file.filename, originalName: req.file.originalname });
});

app.get('/api/settings', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.get("SELECT settings FROM user_settings WHERE id = 1", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row ? JSON.parse(row.settings) : null);
    });
});

app.post('/api/settings', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const settingsJson = JSON.stringify(req.body);
    db.run("INSERT INTO user_settings (id, settings) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings", [settingsJson], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/trigger-daily-summary', async (req, res) => {
    try {
        const result = await sendDailySummaryToUser(req.user);
        if (result && result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({ error: result ? result.message : "Falha desconhecida" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/companies', (req, res) => { 
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.all('SELECT * FROM companies ORDER BY name ASC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    }); 
});

app.post('/api/companies', (req, res) => {
    const { id, name, docNumber, type, email, whatsapp } = req.body;
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });

    if (id) {
        db.run(`UPDATE companies SET name=?, docNumber=?, type=?, email=?, whatsapp=? WHERE id=?`, 
            [name, docNumber, type, email, whatsapp, id], 
            function(err) { 
                if (err) return res.status(500).json({ error: err.message });
                res.json({success: true, id});
            });
    } else {
        db.run(`INSERT INTO companies (name, docNumber, type, email, whatsapp) VALUES (?, ?, ?, ?, ?)`, 
            [name, docNumber, type, email, whatsapp], 
            function(err) { 
                if (err) return res.status(500).json({ error: err.message });
                res.json({success: true, id: this.lastID});
            });
    }
});

app.delete('/api/companies/:id', (req, res) => { 
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.run('DELETE FROM companies WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/tasks', (req, res) => {
    getDb(req.user).all('SELECT * FROM tasks', (err, rows) => res.json(rows || []));
});
app.post('/api/tasks', (req, res) => {
    const t = req.body;
    const db = getDb(req.user);
    const today = new Date().toISOString().split('T')[0];
    const createdAt = t.createdAt || today;

    if (t.id && t.id < 1000000000000) {
        // Update
        db.run(`UPDATE tasks SET title=?, description=?, status=?, priority=?, color=?, dueDate=?, companyId=?, recurrence=?, dayOfWeek=?, recurrenceDate=?, targetCompanyType=?, createdAt=? WHERE id=?`, 
        [t.title, t.description, t.status, t.priority, t.color, t.dueDate, t.companyId, t.recurrence, t.dayOfWeek, t.recurrenceDate, t.targetCompanyType, createdAt, t.id], 
        function(err) { res.json({ success: !err, id: t.id }); });
    } else {
        // Insert
        db.run(`INSERT INTO tasks (title, description, status, priority, color, dueDate, companyId, recurrence, dayOfWeek, recurrenceDate, targetCompanyType, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
        [t.title, t.description, t.status, t.priority, t.color, t.dueDate, t.companyId, t.recurrence, t.dayOfWeek, t.recurrenceDate, t.targetCompanyType, createdAt], 
        function(err) { res.json({ success: !err, id: this.lastID }); });
    }
});
app.delete('/api/tasks/:id', (req, res) => { getDb(req.user).run('DELETE FROM tasks WHERE id = ?', [req.params.id], (err) => res.json({ success: !err })); });

app.get('/api/documents/status', (req, res) => {
    const sql = req.query.competence ? 'SELECT * FROM document_status WHERE competence = ?' : 'SELECT * FROM document_status';
    getDb(req.user).all(sql, req.query.competence ? [req.query.competence] : [], (err, rows) => res.json(rows || []));
});
app.post('/api/documents/status', (req, res) => {
    const { companyId, category, competence, status } = req.body;
    getDb(req.user).run(`INSERT INTO document_status (companyId, category, competence, status) VALUES (?, ?, ?, ?) ON CONFLICT(companyId, category, competence) DO UPDATE SET status = excluded.status`, [companyId, category, competence, status], (err) => res.json({ success: !err }));
});

// --- Scheduled Messages Routes ---
app.get('/api/scheduled', (req, res) => {
    getDb(req.user).all("SELECT * FROM scheduled_messages", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(row => ({
            ...row, 
            active: !!row.active, 
            channels: JSON.parse(row.channels || '{}'),
            selectedCompanyIds: row.selectedCompanyIds ? JSON.parse(row.selectedCompanyIds) : [],
            documentsPayload: row.documentsPayload || null
        })) || []);
    });
});

app.post('/api/scheduled', (req, res) => {
    const { id, title, message, nextRun, recurrence, active, type, channels, targetType, selectedCompanyIds, attachmentFilename, attachmentOriginalName, documentsPayload } = req.body;
    const db = getDb(req.user);
    const channelsStr = JSON.stringify(channels);
    const companyIdsStr = JSON.stringify(selectedCompanyIds || []);

    if (id) {
        db.run(`UPDATE scheduled_messages SET title=?, message=?, nextRun=?, recurrence=?, active=?, type=?, channels=?, targetType=?, selectedCompanyIds=?, attachmentFilename=?, attachmentOriginalName=?, documentsPayload=? WHERE id=?`,
        [title, message, nextRun, recurrence, active ? 1 : 0, type, channelsStr, targetType, companyIdsStr, attachmentFilename, attachmentOriginalName, documentsPayload, id],
        function(err) { if (err) return res.status(500).json({error: err.message}); res.json({success: true, id}); });
    } else {
        db.run(`INSERT INTO scheduled_messages (title, message, nextRun, recurrence, active, type, channels, targetType, selectedCompanyIds, attachmentFilename, attachmentOriginalName, documentsPayload, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [title, message, nextRun, recurrence, active ? 1 : 0, type, channelsStr, targetType, companyIdsStr, attachmentFilename, attachmentOriginalName, documentsPayload, req.user],
        function(err) { if (err) return res.status(500).json({error: err.message}); res.json({success: true, id: this.lastID}); });
    }
});

app.delete('/api/scheduled/:id', (req, res) => {
    getDb(req.user).run('DELETE FROM scheduled_messages WHERE id = ?', [req.params.id], (err) => res.json({ success: !err }));
});

app.get('/api/whatsapp/status', (req, res) => { 
    const wrapper = getWaClientWrapper(req.user);
    res.json({ 
        status: wrapper.status, 
        qr: wrapper.qr, 
        info: wrapper.info 
    }); 
});
app.post('/api/whatsapp/disconnect', async (req, res) => { 
    try { 
        const wrapper = getWaClientWrapper(req.user);
        if (wrapper.client) {
            await wrapper.client.logout(); 
            wrapper.status = 'disconnected';
            wrapper.qr = null;
        }
        res.json({ success: true }); 
    } catch (e) { res.status(500).json({ error: e.message }); } 
});

// --- NEW ROUTE: HARD RESET ---
app.post('/api/whatsapp/reset', async (req, res) => {
    try {
        const username = req.user;
        log(`[WhatsApp Reset] Solicitado reset forçado para: ${username}`);
        
        // 1. Destruir cliente atual se existir
        if (waClients[username] && waClients[username].client) {
            try {
                await waClients[username].client.destroy();
                log(`[WhatsApp Reset] Cliente destruído.`);
            } catch (e) {
                log(`[WhatsApp Reset] Erro ao destruir cliente (ignorado): ${e.message}`);
            }
            delete waClients[username];
        }

        // 2. Apagar pasta de autenticação
        const authPath = path.join(DATA_DIR, `whatsapp_auth_${username}`);
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
                log(`[WhatsApp Reset] Pasta de autenticação removida: ${authPath}`);
            } catch (e) {
                log(`[WhatsApp Reset] Erro ao remover pasta: ${e.message}`);
                return res.status(500).json({ error: "Falha ao limpar arquivos de sessão. Tente reiniciar o servidor." });
            }
        }

        // 3. Reiniciar wrapper (vai gerar novo QR Code na próxima chamada de status)
        getWaClientWrapper(username);

        res.json({ success: true, message: "Sessão resetada. Aguarde o novo QR Code." });

    } catch (e) {
        log(`[WhatsApp Reset] Erro fatal: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});


app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Mensagem vazia." });
    
    try {
        const reply = await processAI(req.user, message);
        res.json({ reply });
    } catch (error) {
        console.error("Erro no chat IA:", error);
        res.status(500).json({ error: "Erro ao processar mensagem." });
    }
});

app.post('/api/send-documents', async (req, res) => {
    const { documents, subject, messageBody, channels, emailSignature, whatsappTemplate } = req.body;
    
    log(`[API send-documents] Iniciando envio de ${documents.length} documentos. Channels: ${JSON.stringify(channels)}`);
    
    const db = getDb(req.user);
    const waWrapper = getWaClientWrapper(req.user);
    const client = waWrapper.client;
    const clientReady = waWrapper.status === 'connected';

    if (channels.whatsapp && !clientReady) {
        log(`[API send-documents] AVISO: Tentativa de envio via WhatsApp, mas cliente não está conectado.`);
    }

    let successCount = 0;
    let errors = [];
    let sentIds = [];

    const docsByCompany = documents.reduce((acc, doc) => {
        if (!acc[doc.companyId]) acc[doc.companyId] = [];
        acc[doc.companyId].push(doc);
        return acc;
    }, {});

    const companyIds = Object.keys(docsByCompany);

    for (const companyId of companyIds) {
        const companyDocs = docsByCompany[companyId];
        
        try {
            const company = await new Promise((resolve, reject) => {
                db.get("SELECT * FROM companies WHERE id = ?", [companyId], (err, row) => {
                    if (err) reject(err); else resolve(row);
                });
            });

            if (!company) { errors.push(`Empresa ID ${companyId} não encontrada.`); continue; }

            const sortedDocs = [...companyDocs].sort((a, b) => {
                const dateA = a.dueDate ? a.dueDate.split('/').reverse().join('') : '99999999';
                const dateB = b.dueDate ? b.dueDate.split('/').reverse().join('') : '99999999';
                return dateA.localeCompare(dateB);
            });

            const validAttachments = [];
            for (const doc of sortedDocs) {
                if (doc.serverFilename) {
                    const filePath = path.join(UPLOADS_DIR, doc.serverFilename);
                    if (fs.existsSync(filePath)) {
                        validAttachments.push({
                            filename: doc.docName,
                            path: filePath,
                            contentType: 'application/pdf',
                            docData: doc
                        });
                    } else {
                        log(`[API send-documents] Arquivo físico não encontrado: ${filePath}`);
                        errors.push(`Arquivo sumiu do servidor: ${doc.docName}`);
                    }
                }
            }

            if (channels.email && company.email) {
                try {
                    const finalHtml = buildEmailHtml(messageBody, companyDocs, emailSignature);
                    const finalSubject = `${subject} - Competência: ${companyDocs[0].competence || 'N/A'}`; 
                    
                    const emailList = company.email.split(',').map(e => e.trim()).filter(e => e);
                    const mainEmail = emailList[0];
                    const ccEmails = emailList.slice(1).join(', ');

                    if (mainEmail) {
                        const senderName = process.env.EMAIL_FROM_NAME || 'Contabilidade';
                        const senderEmail = process.env.EMAIL_FROM_EMAIL || process.env.EMAIL_USER;
                        const fromAddress = `"${senderName}" <${senderEmail}>`;

                        await emailTransporter.sendMail({
                            from: fromAddress,
                            to: mainEmail,
                            cc: ccEmails, 
                            subject: finalSubject,
                            html: finalHtml,
                            attachments: validAttachments.map(a => ({ filename: a.filename, path: a.path, contentType: a.contentType }))
                        });
                        log(`[Email] Enviado para ${company.name} (${mainEmail})`);
                    }
                } catch (e) { 
                    log(`[Email] Erro envio ${company.name}`, e);
                    errors.push(`Erro Email ${company.name}: ${e.message}`); 
                }
            }

            if (channels.whatsapp && company.whatsapp && clientReady) {
                try {
                    let number = company.whatsapp.replace(/\D/g, '');
                    if (!number.startsWith('55')) number = '55' + number;
                    const chatId = `${number}@c.us`;

                    const listaArquivos = validAttachments.map(att => 
                        `• ${att.docData.docName} (${att.docData.category || 'Anexo'}, Venc: ${att.docData.dueDate || 'N/A'})`
                    ).join('\n');
                    
                    const whatsappSignature = whatsappTemplate || "_Esses arquivos também foram enviados por e-mail_\n\nAtenciosamente,\nContabilidade";
                    let mensagemCompleta = `*📄 Olá!* \n\n${messageBody}`;
                    
                    if (listaArquivos) {
                        mensagemCompleta += `\n\n*Arquivos enviados:*\n${listaArquivos}`;
                    }
                    
                    mensagemCompleta += `\n\n${whatsappSignature}`;

                    // --- USANDO O HELPER SEGURO ---
                    await safeSendMessage(client, chatId, mensagemCompleta);
                    
                    for (const att of validAttachments) {
                        try {
                            const fileData = fs.readFileSync(att.path).toString('base64');
                            const media = new MessageMedia(att.contentType, fileData, att.filename);
                            
                            await safeSendMessage(client, chatId, media);
                            
                            // Delay para evitar flood
                            await new Promise(r => setTimeout(r, 3000));
                        } catch (mediaErr) {
                            log(`[WhatsApp] Erro envio mídia ${att.filename}`, mediaErr);
                            errors.push(`Erro mídia WhatsApp (${att.filename}): ${mediaErr.message}`);
                        }
                    }
                } catch (e) { 
                    log(`[WhatsApp] Erro envio ${company.name}`, e);
                    errors.push(`Erro Zap ${company.name}: ${e.message}`); 
                }
            } else if (channels.whatsapp && !clientReady) {
                 errors.push(`WhatsApp não conectado. Não foi possível enviar para ${company.name}`);
            }

            for (const doc of companyDocs) {
                if (doc.category) { 
                    db.run(`INSERT INTO sent_logs (companyName, docName, category, sentAt, channels, status) VALUES (?, ?, ?, datetime('now', 'localtime'), ?, 'success')`, 
                        [company.name, doc.docName, doc.category, JSON.stringify(channels)]);
                    
                    db.run(`INSERT INTO document_status (companyId, category, competence, status) VALUES (?, ?, ?, 'sent') ON CONFLICT(companyId, category, competence) DO UPDATE SET status='sent'`, 
                        [doc.companyId, doc.category, doc.competence]);
                }
                if (doc.id) sentIds.push(doc.id);
                successCount++;
            }
        } catch (e) { 
            log(`[API send-documents] Falha geral empresa ${companyId}`, e);
            errors.push(`Falha geral empresa ${companyId}: ${e.message}`); 
        }
    }
    
    res.json({ success: true, sent: successCount, sentIds, errors });
});

app.get('/api/recent-sends', (req, res) => {
    getDb(req.user).all("SELECT * FROM sent_logs ORDER BY id DESC LIMIT 3", (err, rows) => res.json(rows || []));
});

// --- Rota Catch-All para servir o React corretamente ---
app.get(/.*/, (req, res) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- CRON JOB (Atualizado para Lembretes Pessoais) ---
setInterval(() => {
    const envUsers = (process.env.USERS || '').split(',');
    envUsers.forEach(user => {
        const db = getDb(user);
        if (!db) return;

        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const brazilTime = new Date(utc - (3600000 * 3)); 
        const nowStr = brazilTime.toISOString().slice(0, 16); 

        db.all("SELECT * FROM scheduled_messages WHERE active = 1 AND nextRun <= ?", [nowStr], async (err, rows) => {
            if (err || !rows || rows.length === 0) return;

            log(`[CRON ${user}] Executando ${rows.length} tarefas. Hora: ${nowStr}`);
            
            const waWrapper = getWaClientWrapper(user);
            const clientReady = waWrapper.status === 'connected';

            const settings = await new Promise(resolve => {
                db.get("SELECT settings FROM user_settings WHERE id = 1", (e, r) => resolve(r ? JSON.parse(r.settings) : null));
            });

            for (const msg of rows) {
                try {
                    // --- CASO 1: LEMBRETE PESSOAL (Novo) ---
                    if (msg.targetType === 'personal') {
                        if (clientReady && settings?.dailySummaryNumber) {
                            let number = settings.dailySummaryNumber.replace(/\D/g, '');
                            if (!number.startsWith('55')) number = '55' + number;
                            const chatId = `${number}@c.us`;
                            
                            await safeSendMessage(waWrapper.client, chatId, `⏰ *Lembrete:* ${msg.message}`);
                            log(`[CRON] Lembrete pessoal enviado para ${user}`);
                        }
                    } 
                    // --- CASO 2: MENSAGEM PARA EMPRESAS (Existente) ---
                    else {
                        const channels = JSON.parse(msg.channels || '{}');
                        const selectedIds = JSON.parse(msg.selectedCompanyIds || '[]');
                        
                        let targetCompanies = [];
                        if (msg.targetType === 'selected' && selectedIds.length > 0) {
                            const placeholders = selectedIds.map(() => '?').join(',');
                            targetCompanies = await new Promise(resolve => db.all(`SELECT * FROM companies WHERE id IN (${placeholders})`, selectedIds, (e, r) => resolve(r || [])));
                        } else if (msg.targetType !== 'selected') {
                            const operator = msg.targetType === 'mei' ? '=' : '!=';
                            targetCompanies = await new Promise(resolve => db.all(`SELECT * FROM companies WHERE type ${operator} 'MEI'`, (e, r) => resolve(r || [])));
                        }
                        
                        let specificDocs = [];
                        if (msg.documentsPayload) {
                            try { specificDocs = JSON.parse(msg.documentsPayload); } catch(e) { log('[CRON] Erro parse docs payload', e); }
                        }

                        for (const company of targetCompanies) {
                            let attachmentsToSend = [];
                            let companySpecificDocs = [];

                            if (specificDocs.length > 0) {
                                companySpecificDocs = specificDocs.filter(d => d.companyId === company.id);
                                if (companySpecificDocs.length === 0) continue;
                                
                                for (const doc of companySpecificDocs) {
                                     if (doc.serverFilename) {
                                         const p = path.join(UPLOADS_DIR, doc.serverFilename);
                                         if (fs.existsSync(p)) {
                                             attachmentsToSend.push({ filename: doc.docName, path: p, contentType: 'application/pdf', docData: doc });
                                         }
                                     }
                                }
                            } else if (msg.attachmentFilename) {
                                const p = path.join(UPLOADS_DIR, msg.attachmentFilename);
                                if (fs.existsSync(p)) {
                                    attachmentsToSend.push({ filename: msg.attachmentOriginalName, path: p, contentType: 'application/pdf' });
                                }
                            }

                            if (channels.email && company.email) {
                               try {
                                    const htmlContent = specificDocs.length > 0 
                                    ? buildEmailHtml(msg.message, companySpecificDocs, settings?.emailSignature)
                                    : buildEmailHtml(msg.message, [], settings?.emailSignature);

                                    const emailList = company.email.split(',').map(e => e.trim()).filter(e => e);
                                    const mainEmail = emailList[0];
                                    const ccEmails = emailList.slice(1).join(', ');

                                    if (mainEmail) {
                                        const senderName = process.env.EMAIL_FROM_NAME || 'Contabilidade';
                                        const senderEmail = process.env.EMAIL_FROM_EMAIL || process.env.EMAIL_USER;
                                        const fromAddress = `"${senderName}" <${senderEmail}>`;

                                        await emailTransporter.sendMail({
                                            from: fromAddress,
                                            to: mainEmail,
                                            cc: ccEmails,
                                            subject: msg.title,
                                            html: htmlContent,
                                            attachments: attachmentsToSend.map(a => ({ filename: a.filename, path: a.path, contentType: a.contentType }))
                                        });
                                    }
                               } catch(e) { log(`[CRON] Erro email ${company.name}`, e); }
                            }

                            if (channels.whatsapp && company.whatsapp && clientReady) {
                                try {
                                    let number = company.whatsapp.replace(/\D/g, '');
                                    if (!number.startsWith('55')) number = '55' + number;
                                    const chatId = `${number}@c.us`;
                                    
                                    let waBody = `*${msg.title}*\n\n${msg.message}`;

                                    if (specificDocs.length > 0) {
                                        waBody = `*📄 Olá!* \n\n${msg.message}\n\n*Arquivos enviados:*`;
                                        const listaArquivos = attachmentsToSend.map(att => 
                                            `• ${att.docData?.docName || att.filename} (${att.docData?.category || 'Anexo'}, Venc: ${att.docData?.dueDate || 'N/A'})`
                                        ).join('\n');
                                        waBody += `\n${listaArquivos}`;
                                    } else if (attachmentsToSend.length > 0) {
                                        waBody += `\n\n*Arquivo enviado:* ${attachmentsToSend[0].filename}`;
                                    }
                                    
                                    waBody += `\n\n${settings?.whatsappTemplate || ''}`;

                                    await safeSendMessage(waWrapper.client, chatId, waBody);
                                    
                                    for (const att of attachmentsToSend) {
                                        try {
                                            const fileData = fs.readFileSync(att.path).toString('base64');
                                            const media = new MessageMedia(att.contentType, fileData, att.filename);
                                            await safeSendMessage(waWrapper.client, chatId, media);
                                            await new Promise(r => setTimeout(r, 3000));
                                        } catch (err) {
                                            log(`[CRON] Erro media zap ${att.filename}`, err);
                                        }
                                    }
                                } catch(e) { log(`[CRON] Erro zap ${company.name}`, e); }
                            }
                            
                            if (companySpecificDocs.length > 0) {
                                for (const doc of companySpecificDocs) {
                                    if (doc.category) {
                                        db.run(`INSERT INTO sent_logs (companyName, docName, category, sentAt, channels, status) VALUES (?, ?, ?, datetime('now', 'localtime'), ?, 'success')`, 
                                            [company.name, doc.docName, doc.category, JSON.stringify(channels)]);
                                        
                                        db.run(`INSERT INTO document_status (companyId, category, competence, status) VALUES (?, ?, ?, 'sent') ON CONFLICT(companyId, category, competence) DO UPDATE SET status='sent'`, 
                                            [doc.companyId, doc.category, doc.competence]);
                                    }
                                }
                            }
                        } 
                    } // Fim do bloco de msg para empresas

                    // Atualização da Recorrência (Para todos os tipos)
                    if (msg.recurrence === 'unico') {
                        db.run("UPDATE scheduled_messages SET active = 0 WHERE id = ?", [msg.id]);
                    } else {
                        const nextDate = new Date(msg.nextRun);
                        if (msg.recurrence === 'diaria') nextDate.setDate(nextDate.getDate() + 1);
                        else if (msg.recurrence === 'semanal') nextDate.setDate(nextDate.getDate() + 7);
                        else if (msg.recurrence === 'mensal') nextDate.setMonth(nextDate.getMonth() + 1);
                        else if (msg.recurrence === 'trimestral') nextDate.setMonth(nextDate.getMonth() + 3);
                        else if (msg.recurrence === 'anual') nextDate.setFullYear(nextDate.getFullYear() + 1);
                        
                        const nextRunStr = nextDate.toISOString().slice(0, 16);
                        db.run("UPDATE scheduled_messages SET nextRun = ? WHERE id = ?", [nextRunStr, msg.id]);
                    }
                } catch(e) {
                    log(`[CRON] Erro crítico processando msg ID ${msg.id}`, e);
                }
            } 
        });
    });
}, 60000); 

server.listen(port, () => log(`Server running at http://localhost:${port}`));